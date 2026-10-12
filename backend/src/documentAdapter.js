import { readFile } from "node:fs/promises";

const SCHEDULE_SOURCE = "knowledge_base/reference/visit_schedule_windows.md";
const SCOPE_SOURCE = "knowledge_base/00_scope.md";

export async function verifySection({ source, section, text }) {
  let document;
  try {
    document = (await readFile(new URL(`../../${source}`, import.meta.url), "utf8"))
      .replaceAll("\r\n", "\n");
  } catch {
    throw new Error(`Copertura non verificabile: ${source}.`);
  }

  const headings = [...document.matchAll(/^(#{1,6})\s+(.+?)\s*$/gm)];
  const matches = headings.flatMap((heading, index) =>
    heading[2].trim() === section
      ? [document.slice(heading.index, headings[index + 1]?.index ?? document.length).trim()]
      : [],
  );
  if (matches.length !== 1 || matches[0] !== text.replaceAll("\r\n", "\n").trim()) {
    throw new Error(`Copertura non verificata: indice non allineato alla KB per ${source}, ${section}.`);
  }
}

export function selectKnowledge(chunks) {
  if (!Array.isArray(chunks)) throw new Error("Risultati documentali non validi.");

  const unique = new Map();
  for (const chunk of chunks) {
    const key = chunk.id || JSON.stringify([chunk.source, chunk.section, chunk.text]);
    const previous = unique.get(key);
    if (previous && previous.text !== chunk.text) throw new Error("Chunk documentali conflittuali.");
    if (!previous) unique.set(key, chunk);
  }

  return [...unique.values()]
    .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity))
    .map(chunk =>
      typeof chunk.text === "string" && Number.isFinite(chunk.distance)
        ? { ...chunk, similarity: 1 - chunk.distance }
        : chunk,
    );
}

export async function buildCompletenessRules(retrieve) {
  const source = "knowledge_base/operations/clinical_operations_sop.md";
  const section = "Data completeness";
  const chunks = selectKnowledge(await retrieve("Regola Novera completeness attenzione escalation", {
    $and: [{ source }, { section }],
  }));
  if (!chunks.length || chunks.some(chunk =>
    chunk.source !== source || chunk.section !== section ||
    typeof chunk.text !== "string" || !chunk.text.trim() || !Number.isFinite(chunk.distance))) {
    throw new Error("Supporto documentale completeness mancante o non pertinente.");
  }
  if (new Set(chunks.map(chunk => chunk.text)).size !== 1) {
    throw new Error("Regole completeness conflittuali nella documentazione.");
  }
  await verifySection(chunks[0]);

  const text = chunks[0].text.replaceAll("**", "");
  const noAction = [...text.matchAll(/^- completeness ≥(\d+(?:[.,]\d+)?)%: nessuna azione;?\s*$/gm)];
  const attention = [...text.matchAll(/^- completeness (\d+(?:[.,]\d+)?)%-<(\d+(?:[.,]\d+)?)%: attenzione(?: operativa)?;?\s*$/gm)];
  const escalation = [...text.matchAll(/^- completeness <(\d+(?:[.,]\d+)?)%: escalation\.?\s*$/gm)];
  const rules = [...text.matchAll(/^- completeness\b.*$/gm)];
  if (rules.length !== 3 || noAction.length !== 1 || attention.length !== 1 || escalation.length !== 1) {
    throw new Error("Regola completeness incompleta o ambigua: richieste soglie strettamente inferiori.");
  }
  const number = value => Number(value.replace(",", "."));
  const upper = number(attention[0][2]);
  const lower = number(escalation[0][1]);
  if (lower < 0 || upper > 100 || lower >= upper ||
    number(attention[0][1]) !== lower || number(noAction[0][1]) !== upper) {
    throw new Error("Soglie completeness incoerenti nella documentazione.");
  }
  const { distance, similarity } = chunks[0];
  return {
    parameters: { attention_threshold_percent: upper, escalation_threshold_percent: lower },
    support: { sources: [{ source, section, distance, similarity }], comparison: "<" },
  };
}

function parseProtocolSchedule(study, protocol) {
  const expected = new Map();
  for (const match of protocol.matchAll(/^- (.+?) - Day ([+-]?\d+)\s*$/gm)) {
    if (expected.has(match[1])) throw new Error(`Visita duplicata nella schedule ${study}.`);
    expected.set(match[1], Number(match[2]));
  }
  if (!expected.size || !/^- Screening\s*$/m.test(protocol)) {
    throw new Error(`Copertura schedule incompleta per ${study}.`);
  }
  return expected;
}

function parseVisitWindows(study, table, expected) {
  const windows = new Map();
  for (const line of table.split(/\r?\n/).filter(line => line.startsWith("|"))) {
    const cells = line.split("|").slice(1, -1).map(cell => cell.replaceAll("**", "").trim());
    if (cells[0] === "Visita" || /^[-:]+$/.test(cells[0])) continue;
    if (cells.length !== 3 || !/^[+-]?\d+$/.test(cells[1])) {
      throw new Error(`Target day non valido per ${study}.`);
    }
    if (windows.has(cells[0])) throw new Error(`Visita duplicata nella tabella ${study}.`);

    const tolerance = /^±(\d+) giorn[oi]$/.exec(cells[2]);
    const days = cells[2] === "stesso giorno" ? 0 : tolerance ? Number(tolerance[1]) : NaN;
    if (!Number.isSafeInteger(days) || days < 0) {
      throw new Error(`Finestra non valida per ${study}, ${cells[0]}.`);
    }
    if (!expected.has(cells[0]) || expected.get(cells[0]) !== Number(cells[1])) {
      throw new Error(`Target incoerente tra protocollo e finestre: ${study}, ${cells[0]}.`);
    }
    windows.set(cells[0], days);
  }
  if (windows.size !== expected.size) throw new Error(`Copertura visite incompleta per ${study}.`);
  return windows;
}

export async function buildVisitRules(filters, retrieve) {
  if (
    !filters || typeof filters !== "object" || Array.isArray(filters) ||
    Object.values(filters).some(value => typeof value !== "string" || !value.trim())
  ) {
    throw new Error("Filtri documentali non validi.");
  }

  const sources = [];
  const retrievedSections = [];
  async function requiredSection(source, section, query) {
    const where = { $and: [{ source }, { section }] };
    const chunks = selectKnowledge(await retrieve(query, where));
    if (
      !chunks.length || chunks.some(chunk =>
        chunk.source !== source || chunk.section !== section ||
        !chunk.text || !Number.isFinite(chunk.distance))
    ) {
      throw new Error(`Copertura documentale mancante: ${source}, ${section}.`);
    }
    // Ogni sezione deve essere intera e coerente fra tutti i risultati dell'indice.
    if (new Set(chunks.map(chunk => chunk.text)).size !== 1) {
      throw new Error(`Documenti conflittuali: ${source}, ${section}.`);
    }
    const { distance, similarity, text } = chunks[0];
    sources.push({ source, section, distance, similarity });
    retrievedSections.push({ source, section, text });
    return text;
  }

  const scope = await requiredSection(SCOPE_SOURCE, "TrialPulse Knowledge Base - Ambito", "Portfolio studi Novera TrialPulse");
  const studies = [...new Set(scope.match(/NNR-[A-Z]+-\d{2}/g) || [])];
  if (!studies.length) throw new Error("Copertura documentale: portfolio non definito.");
  if (filters.study_id && !studies.includes(filters.study_id)) {
    throw new Error("Studio non presente nel portfolio documentale.");
  }
  const selectedStudies = filters.study_id ? [filters.study_id] : studies;

  const rule = await requiredSection(SCHEDULE_SOURCE, "Regola di calcolo", "Calcolo out-of-window soglia sito target_date limiti inclusivi");
  if (
    !rule.includes("target_date") || !/limiti sono inclusivi/i.test(rule) ||
    !/Screening escluso/i.test(rule) || !/date incoerenti o mancanti/i.test(rule)
  ) {
    throw new Error("Regola documentale sulle date incompleta o non supportata.");
  }
  const thresholds = [...rule.matchAll(/supera il\s+(\d+(?:[.,]\d+)?)%/gi)]
    .map(match => Number(match[1].replace(",", ".")));
  if (thresholds.length !== 1 || thresholds[0] < 0 || thresholds[0] > 100 || !/review di Clinical Operations/i.test(rule)) {
    throw new Error("Soglia out-of-window assente o conflittuale nella documentazione.");
  }

  const windows = [];
  const coverage = [];
  for (const study of selectedStudies) {
    const table = await requiredSection(SCHEDULE_SOURCE, study, `Visit windows tutte le visite ${study}`);
    const protocol = await requiredSection(`knowledge_base/protocols/${study}.md`, "Schedule", `Schedule visite target day ${study}`);
    const expected = parseProtocolSchedule(study, protocol);
    const found = parseVisitWindows(study, table, expected);

    coverage.push({ study_id: study, expected_visits: expected.size, documented_visits: found.size });
    for (const [visit, days] of found) {
      if (!filters.visit_name || filters.visit_name === visit) {
        windows.push({ study_id: study, visit_name: visit, window_days: days });
      }
    }
  }
  if (
    !windows.length || (filters.visit_name && selectedStudies.some(study =>
      !windows.some(window => window.study_id === study)))
  ) {
    throw new Error("Visita non documentata per tutto il perimetro richiesto.");
  }

  // La lettura locale verifica il retrieval; non sostituisce i valori documentali.
  for (const section of retrievedSections) await verifySection(section);
  return {
    parameters: { visit_windows: windows, rate_threshold_percent: thresholds[0] },
    support: {
      sources,
      coverage: { complete: true, studies: coverage, applied_windows: windows.length },
      action: "Clinical Operations review",
      date_basis: "target_date",
      inclusive_limits: true,
      warnings: ["Screening escluso; date inutilizzabili escluse dal calcolo dal Data Agent."],
    },
  };
}