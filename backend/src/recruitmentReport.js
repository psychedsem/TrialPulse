import { presentReferences, presentDataQuality } from "./references.js";
import { verifySection } from "./documentAdapter.js";

const month = value => typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const identifier = value => typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
const unavailable = value => value === null ? "non calcolabile" : String(value);

function valid(report) {
  const parameters = report.parameters_applied;
  if (!report.scope || !Array.isArray(report.scope.group_by) || report.scope.group_by.length ||
    !parameters || typeof parameters.threshold_percent !== "number" || !Number.isFinite(parameters.threshold_percent) ||
    parameters.threshold_percent < 0 || parameters.threshold_percent > 100 ||
    !Number.isSafeInteger(parameters.consecutive_months) || parameters.consecutive_months < 1 ||
    !Array.isArray(report.results)) return false;
  const groups = new Set();
  for (const group of report.results) {
    if (!group || !identifier(group.study_id) || !identifier(group.site_id) || !Array.isArray(group.monthly) ||
      !group.monthly.length || typeof group.trigger_met !== "boolean") return false;
    const key = `${group.study_id}/${group.site_id}`;
    if (groups.has(key)) return false;
    groups.add(key);
    for (const field of ["study_id", "site_id"]) {
      if (report.scope[field] != null && report.scope[field] !== group[field]) return false;
    }
    let previous = "";
    for (const row of group.monthly) {
      if (!row || !month(row.month) || row.month <= previous || !count(row.actual_enrolled) || !count(row.target_enrolled) ||
        (row.achievement_percent !== null && (typeof row.achievement_percent !== "number" ||
          !Number.isFinite(row.achievement_percent) || row.achievement_percent < 0)) ||
        ![true, false, null].includes(row.below_threshold) ||
        (row.achievement_percent === null) !== (row.below_threshold === null)) return false;
      previous = row.month;
    }
    if (group.trigger_met ? !Array.isArray(group.first_trigger_months) || !group.first_trigger_months.length ||
      group.first_trigger_months.some(value => !group.monthly.some(row => row.month === value)) :
      group.first_trigger_months !== null) return false;
  }
  const quality = report.data_quality;
  return quality && ["duplicates_removed", "inconsistent_actual_dates", "inconsistent_query_rows", "excluded_records"]
    .every(key => count(quality[key])) && Array.isArray(quality.warnings) &&
    quality.warnings.every(value => typeof value === "string") && quality.exclusions_by_reason &&
    typeof quality.exclusions_by_reason === "object" && !Array.isArray(quality.exclusions_by_reason) &&
    Object.values(quality.exclusions_by_reason).every(count) &&
    Object.values(quality.exclusions_by_reason).reduce((total, value) => total + value, 0) === quality.excluded_records;
}

async function recruitmentRule(knowledge, parameters) {
  const chunks = knowledge.filter(chunk => chunk.source === "knowledge_base/operations/deviation_escalation_rules.md" &&
    chunk.section === "Altre escalation operative");
  if (!chunks.length) return null;
  const rules = [];
  for (const chunk of chunks) {
    try { await verifySection(chunk); } catch { return null; }
    const matches = [...chunk.text.matchAll(/^- recruitment <(\d+(?:[.,]\d+)?)% del target mensile per (\d+) mesi consecutivi → ([A-Za-z ]+);\s*$/gm)];
    if (matches.length !== 1) return null;
    const match = matches[0];
    rules.push({ threshold: Number(match[1].replace(",", ".")), months: Number(match[2]), action: match[3].trim() });
  }
  const rule = rules[0];
  if (rules.some(value => JSON.stringify(value) !== JSON.stringify(rule)) ||
      rule.threshold !== parameters.threshold_percent || rule.months !== parameters.consecutive_months) return null;
  return { action: rule.action, sources: [{ source: chunks[0].source, section: chunks[0].section }] };
}

function present(report, observedMonths, rule) {
  const parameters = report.parameters_applied;
  const filters = ["study_id", "site_id"].filter(key => report.scope[key] != null)
    .map(key => `${key === "study_id" ? "Studio" : "Sito"}: ${JSON.stringify(report.scope[key])}`).join("; ");
  const lines = ["**Recruitment mensile - dati sintetici**", `Filtri: ${filters || "nessuno"}.`,
    `Criterio applicato: sotto ${parameters.threshold_percent}% per ${parameters.consecutive_months} mesi consecutivi.`,
    "Copertura verificata: soltanto i mesi restituiti dal Data Agent, non necessariamente l'intervallo richiesto."];
  if (!report.results.length) lines.push("Nessun gruppo restituito; nessuna conclusione sui mesi o sugli arruolamenti.");
  for (const group of report.results) {
    const months = group.monthly.map(row => row.month);
    const absent = observedMonths.filter(value => !months.includes(value));
    lines.push(`**Studio ${group.study_id}; sito ${group.site_id}**`, `Mesi restituiti: ${months.join(", ")}.`);
    if (absent.length) lines.push(`Mesi presenti negli altri risultati, non in questo gruppo: ${absent.join(", ")}. Nessun valore assegnato.`);
    const table = ["| Mese | Arruolati | Target | Raggiungimento (%) | Sotto soglia |", "|---|---:|---:|---:|---|"];
    for (const row of group.monthly) table.push(`| ${row.month} | ${row.actual_enrolled} | ${row.target_enrolled} | ${unavailable(row.achievement_percent)} | ${row.below_threshold === null ? "non calcolabile" : row.below_threshold ? "sì" : "no"} |`);
    lines.push(table.join("\n"));
    lines.push(`Criterio di consecutività restituito: ${group.trigger_met ? "soddisfatto" : "non soddisfatto"}.`);
    if (group.first_trigger_months) lines.push(`Prima sequenza restituita: ${group.first_trigger_months.join(", ")}.`);
    if (rule) lines.push(group.trigger_met ? `Azione Novera attestata: ${rule.action}.` :
      "Il criterio documentale non è soddisfatto; nessuna azione assegnata in base a questa regola.");
  }
  if (!rule) lines.push("Azione Novera non attestata: manca una regola recuperata e verificata coerente con i parametri applicati.");
  lines.push("Uno zero riportato in tabella è un risultato dell'analisi. Un mese non restituito non viene convertito in zero e non attesta da solo un dato mancante o un periodo fuori calendario. Il report non espone il calendario previsto né una verifica dell'intervallo della domanda.");
  lines.push("Questi KPI operativi sintetici non consentono di valutare la superiorità clinica dei trattamenti o raccomandare una terapia a un paziente.");
  lines.push(presentDataQuality(report.data_quality));
  return lines.join("\n\n");
}

export async function presentRecruitmentReports(reports, knowledge = [], { recovery = false } = {}) {
  if (recovery && (!reports.length || reports.some(report => report.analysis !== "recruitment_target" ||
    !valid(report) || !report.results.length))) return null;
  const recruitment = reports.filter(report => report.analysis === "recruitment_target");
  if (!recruitment.length) return null;
  if (recruitment.some(report => !valid(report))) return [
    "Report recruitment incompleto o incoerente. Nessuna conclusione temporale verificata disponibile.",
    presentReferences(reports, knowledge),
  ].filter(Boolean).join("\n\n");
  const observedMonths = [...new Set(recruitment.flatMap(report => report.results.flatMap(group =>
    group.monthly.map(row => row.month))))].sort();
  const rules = await Promise.all(reports.map(report => report.analysis === "recruitment_target" ?
    recruitmentRule(knowledge, report.parameters_applied) : null));
  const sections = reports.map((report, index) => report.analysis === "recruitment_target" ? present(report, observedMonths, rules[index]) :
    `**Report ${JSON.stringify(report.analysis)} - dati sintetici**\n\n${JSON.stringify({
      Perimetro: report.scope, "Parametri applicati": report.parameters_applied,
      Risultati: report.results, "Qualità dei dati": report.data_quality,
    })}`);
  if (reports.length > 1) sections.unshift("Report presentati separatamente, senza una sintesi unica non verificata.");
  if (recovery) sections.unshift("La sintesi generativa non è disponibile. Sono presentati soltanto i report recruitment verificati del Data Agent. La copertura del perimetro richiesto non è verificata integralmente: studi, siti o periodi non restituiti non autorizzano conclusioni.");
  sections.push(presentReferences(reports.map((report, index) => rules[index] ?
    { ...report, document_support: { sources: rules[index].sources } } : report), knowledge));
  return sections.filter(Boolean).join("\n\n");
}