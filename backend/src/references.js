import { readFileSync } from "node:fs";

const plain = value => typeof value === "string" && value.trim() ? value.trim() : null;
const markdown = value => value.replace(/[\\`*_{}[\]<>#!|]/g, "\\$&").replace(/[\r\n]+/g, " ");

function reference(entry) {
  const source = plain(entry?.source);
  // Solo documenti operativi: nessun accesso a percorsi arbitrari ricevuti dai tool.
  if (!source || !/^knowledge_base\/(?:00_scope|faq|(?:protocols|operations|reference)\/[A-Za-z0-9_-]+)\.md$/.test(source)) return null;
  let title, document;
  try {
    document = readFileSync(new URL(`../../${source}`, import.meta.url), "utf8");
    title = document.match(/^#\s+(.+)$/m)?.[1]?.trim();
  } catch { return null; }
  if (!title) return null;
  const requested = plain(entry.section);
  const headings = [...document.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map(match => match[1].trim());
  const section = requested && headings.includes(requested) ? requested : null;
  return { key: JSON.stringify([source, section]), title, section };
}

export function modelDocumentReference(entry) {
  const item = reference(entry);
  return item ? { title: item.title, ...(item.section ? { section: item.section } : {}) } : {};
}

export function presentDataQuality(quality) {
  return [
    `Duplicati rimossi dalla vista analitica: ${quality.duplicates_removed}.`,
    `Date incoerenti segnalate: ${quality.inconsistent_actual_dates}. Righe query incoerenti segnalate: ${quality.inconsistent_query_rows}.`,
    `Record esclusi dalla specifica analisi: ${quality.excluded_records}.`,
    ...Object.entries(quality.exclusions_by_reason).map(([reason, value]) => `- Esclusioni ${JSON.stringify(reason)}: ${value}.`),
    ...quality.warnings.map(warning => `- Avviso: ${JSON.stringify(warning)}`),
  ].join("\n\n");
}

function uniqueReferences(entries) {
  const references = new Map();
  for (const entry of entries) {
    const item = reference(entry);
    if (item) references.set(item.key, item);
  }
  return [...references.values()];
}

export function presentReferences(reports = [], knowledge = []) {
  const analyzed = reports.filter(report => report && !report.error &&
    typeof report.analysis === "string" && Array.isArray(report.results));
  const applied = uniqueReferences(analyzed.flatMap(report =>
    Array.isArray(report.document_support?.sources) ? report.document_support.sources : []));
  const appliedKeys = new Set(applied.map(item => item.key));
  const consulted = uniqueReferences(knowledge).filter(item => !appliedKeys.has(item.key));
  const lines = [];
  if (analyzed.length) lines.push("**Dati analizzati:** CSV operativo TrialPulse (dati sintetici).");
  for (const [label, entries] of [
    ["Regole documentali attestate e applicate", applied],
    ["Documenti Novera consultati", consulted],
  ]) {
    if (!entries.length) continue;
    lines.push(`**${label}:**`);
    for (const item of entries) lines.push(`- ${markdown(item.title)}; ${item.section ?
      `sezione: ${markdown(item.section)}` : "Sezione non disponibile"}.`);
  }
  if (consulted.length) lines.push("La consultazione non attesta ogni affermazione della risposta né l'applicazione di una regola al calcolo.");
  if (analyzed.some(report => report.analysis === "recruitment_target")) {
    lines.push("**Prescrizioni e suggerimenti:** le azioni Novera richiedono supporto documentale. Eventuali ulteriori proposte sono suggerimenti operativi non vincolanti, non SOP attestate.");
  }
  return lines.join("\n\n");
}