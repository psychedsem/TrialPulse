import { presentReferences, presentDataQuality } from "./references.js";

const FILTERS = ["study_id", "site_id", "participant_id", "visit_name"];
const COUNTS = ["required_assessments_total", "missing_assessments_total", "completed_assessments_total"];
const QUALITY_COUNTS = ["duplicates_removed", "inconsistent_actual_dates", "inconsistent_query_rows", "excluded_records"];
const count = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === "string" && value.trim().length > 0;

export function validateCompletenessReport(report, request) {
  const fail = () => { throw new Error("Report completeness incompleto o incoerente. Nessuna conclusione verificata disponibile."); };
  if (!report || report.analysis !== "completeness_threshold" || !report.scope ||
    JSON.stringify(report.scope.group_by) !== JSON.stringify(request.group_by)) fail();
  for (const key of FILTERS) {
    if (!Object.hasOwn(report.scope, key) || report.scope[key] !== (request.filters?.[key] ?? null)) fail();
  }
  if (!report.parameters_applied ||
    Object.keys(report.parameters_applied).length !== Object.keys(request.parameters).length ||
    Object.keys(request.parameters).some(key => report.parameters_applied[key] !== request.parameters[key])) fail();
  if (!Array.isArray(report.results) || !report.results.length ||
    (!request.group_by.length && report.results.length !== 1)) fail();
  const identifiers = new Set();
  for (const row of report.results) {
    if (!row || COUNTS.some(key => !count(row[key])) ||
      row.missing_assessments_total + row.completed_assessments_total !== row.required_assessments_total) fail();
    const rate = row.completeness_rate;
    if (rate === null) {
      if (row.classification !== null || row.required_assessments_total !== 0) fail();
    } else if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0 || rate > 100 ||
      !["no_action", "attention", "escalation"].includes(row.classification) || row.required_assessments_total === 0) fail();
    for (const key of request.group_by) {
      if (!text(row[key]) || (report.scope[key] !== null && row[key] !== report.scope[key])) fail();
    }
    if (["site_id", "study_id"].some(key => !request.group_by.includes(key) && Object.hasOwn(row, key))) fail();
    const id = JSON.stringify(request.group_by.map(key => row[key]));
    if (identifiers.has(id)) fail();
    identifiers.add(id);
  }
  const quality = report.data_quality;
  if (!quality || QUALITY_COUNTS.some(key => !count(quality[key])) ||
    !Array.isArray(quality.warnings) || quality.warnings.some(value => !text(value)) ||
    !quality.exclusions_by_reason || typeof quality.exclusions_by_reason !== "object" ||
    Array.isArray(quality.exclusions_by_reason) || Object.values(quality.exclusions_by_reason).some(value => !count(value)) ||
    Object.values(quality.exclusions_by_reason).reduce((sum, value) => sum + value, 0) !== quality.excluded_records) fail();
  const support = report.document_support;
  if (Object.hasOwn(report, "document_support") && (!support || support.comparison !== "<" || !Array.isArray(support.sources) || !support.sources.length ||
    support.sources.some(source => !source || !text(source.source) || !text(source.section)))) fail();
}

const literal = value => JSON.stringify(value);
const labels = { study_id: "Studio", site_id: "Sito", participant_id: "Partecipante", visit_name: "Visita" };

function presentCompleteness(report) {
  const groups = report.scope.group_by;
  const label = groups.length === 2 ? "studio/sito" : groups[0] === "site_id" ? "sito" :
    groups[0] === "study_id" ? "studio" : "portfolio (aggregato del perimetro selezionato)";
  const filters = FILTERS.filter(key => report.scope[key] !== null)
    .map(key => `${labels[key]}: ${literal(report.scope[key])}`).join("; ");
  const parameters = report.parameters_applied;
  const lines = ["**Data completeness - dati sintetici**", `Granularità: ${label}.`,
    `Filtri: ${filters || "nessuno"}.`,
    `Attenzione: completeness < ${parameters.attention_threshold_percent}%. Escalation: completeness < ${parameters.escalation_threshold_percent}%.`];
  for (const row of report.results) {
    const id = groups.map(key => `${labels[key]}: ${literal(row[key])}`).join("; ") || "Aggregato";
    lines.push(`- ${id}: completeness ${row.completeness_rate === null ? "non calcolabile" : `${row.completeness_rate}%`}; classificazione ${row.classification ?? "non disponibile"}; assessment richiesti ${row.required_assessments_total}, mancanti ${row.missing_assessments_total}, completati ${row.completed_assessments_total}.`);
  }
  lines.push(groups.length ?
    "Le classificazioni riguardano soltanto i gruppi restituiti nel perimetro analizzato, non gruppi assenti o altre aggregazioni." :
    "Il risultato aggregato non consente di valutare separatamente i singoli siti o studi.");
  lines.push(presentDataQuality(report.data_quality));
  if (!report.document_support?.sources) lines.push("Soglie fornite nella richiesta analitica; nessuna fonte documentale attestata nel report.");
  return lines.join("\n\n");
}

export function presentCompletenessReports(reports, knowledge = []) {
  if (!reports.some(report => report.analysis === "completeness_threshold")) return null;
  const sections = reports.map(report => report.analysis === "completeness_threshold" ?
    presentCompleteness(report) : `**Report ${literal(report.analysis)} - dati sintetici**\n\n${literal({
      Perimetro: report.scope, "Parametri applicati": report.parameters_applied,
      Risultati: report.results, "Qualità dei dati": report.data_quality,
    })}`);
  if (reports.length > 1) sections.unshift(
    "Sono disponibili più report analitici, presentati separatamente. Non viene prodotta una sintesi unica non verificata. Per una conclusione unica, richiedi un solo perimetro e una sola analisi.");
  sections.push(presentReferences(reports, knowledge));
  return sections.filter(Boolean).join("\n\n");
}