import { DATA_AGENT_URL, RAG_API_URL } from "./config.js";
import { TOOLS } from "./tools.js";
import { buildVisitRules, buildCompletenessRules, selectKnowledge } from "./documentAdapter.js";
import { validateCompletenessReport } from "./completenessReport.js";
import { isConnectionRefused, localPythonFallback } from "./pythonBridge.js";
import { paceGeneration, observeGenerationQuota } from "./llm.js";

const REQUIRED_ANALYSIS_PARAMETERS = {
  major_deviations_window: ["window_days", "min_count"],
  consecutive_missed: ["min_consecutive"],
  recruitment_target: ["threshold_percent", "consecutive_months"],
  query_aging_threshold: ["threshold_days"],
  completeness_threshold: ["attention_threshold_percent", "escalation_threshold_percent"],
};

const STUDY_SITE = ["study_id", "site_id"];
const VISIT_GROUPS = [...STUDY_SITE, "visit_name"];
const ANALYSIS_GROUPS = {
  portfolio_summary: STUDY_SITE, recruitment: [...STUDY_SITE, "month"],
  screening_failure: STUDY_SITE, retention: STUDY_SITE, visits: VISIT_GROUPS,
  completeness: VISIT_GROUPS, queries: VISIT_GROUPS, deviations: [...VISIT_GROUPS, "month"],
  monitoring: VISIT_GROUPS, efficacy: ["visit_name", "site_id"], safety: STUDY_SITE,
  out_of_window: VISIT_GROUPS, major_deviations_window: [], consecutive_missed: [],
  recruitment_target: [], query_aging_threshold: STUDY_SITE, completeness_threshold: STUDY_SITE,
};

function validateAnalysisScope(args) {
  if (args.filters !== undefined) {
    const fields = ["study_id", "site_id", "participant_id", "visit_name"];
    const limited = ["portfolio_summary", "recruitment", "screening_failure", "retention",
      "safety", "major_deviations_window", "recruitment_target"];
    const allowed = limited.includes(args.analysis) ? STUDY_SITE :
      args.analysis === "consecutive_missed" ? [...STUDY_SITE, "participant_id"] : fields;
    if (!args.filters || typeof args.filters !== "object" || Array.isArray(args.filters) ||
      Object.entries(args.filters).some(([key, value]) => !fields.includes(key) ||
        (value !== null && (typeof value !== "string" || !allowed.includes(key))))) {
      throw new Error(`Filtri non validi per ${args.analysis}: campi ammessi ${allowed.join(", ")}, ciascuno con una stringa scalare. Per più studi usa il portfolio o richieste separate.`);
    }
  }
  if (args.group_by !== undefined && (!Array.isArray(args.group_by) ||
    new Set(args.group_by).size !== args.group_by.length ||
    args.group_by.some(key => !ANALYSIS_GROUPS[args.analysis].includes(key)))) {
    throw new Error(`group_by non supportato per ${args.analysis}: ${ANALYSIS_GROUPS[args.analysis].join(", ") || "ometti group_by o usa []"}.`);
  }
}

function validateAnalysisParameters({ analysis, parameters }) {
  const required = REQUIRED_ANALYSIS_PARAMETERS[analysis];
  if (!required) return;

  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    throw new Error(
      `L'analisi ${analysis} richiede parameters con ${required.join(", ")}. Usa i valori già recuperati dalla Knowledge Base se disponibili nel contesto.`,
    );
  }
  const missing = required.filter(key => !Object.hasOwn(parameters, key) || parameters[key] == null);
  if (missing.length) {
    throw new Error(
      `Parametri mancanti per ${analysis}: ${missing.join(", ")}. Usa i valori già recuperati dalla Knowledge Base se disponibili nel contesto.`,
    );
  }

  if (analysis === "completeness_threshold") {
    const { attention_threshold_percent: attention, escalation_threshold_percent: escalation } = parameters;
    if (typeof attention !== "number" || typeof escalation !== "number" || escalation >= attention) {
      throw new Error(
        "Per completeness_threshold deve valere escalation_threshold_percent < attention_threshold_percent. Usa le soglie recuperate dalla Knowledge Base.",
      );
    }
  }
}

const VALIDATION_FIELDS = new Set(["body", "analysis", "filters", "group_by", "parameters",
  "study_id", "site_id", "participant_id", "visit_name", "threshold_percent", "consecutive_months",
  "threshold_days", "window_days", "min_count", "min_consecutive", "attention_threshold_percent",
  "escalation_threshold_percent", "rate_threshold_percent", "visit_windows"]);
const VALIDATION_TYPES = new Set(["string_type", "dict_type", "list_type", "enum", "extra_forbidden",
  "missing", "model_type", "int_type", "float_type", "finite_number", "greater_than",
  "greater_than_equal", "less_than", "less_than_equal", "string_too_short"]);
const SAFE_VALIDATION_MESSAGE = /^(?:Filtro (?:study_id|site_id|participant_id|visit_name) non valido|Filtri inesistenti o incompatibili nel perimetro richiesto\.|Raggruppamento duplicato o non supportato per questa analisi\.|Parametri non supportati per questa analisi\.|efficacy richiede un singolo study_id\.|efficacy non può combinare scale diverse\.|La soglia di escalation non può superare la soglia di attenzione\.|Finestra per studio\/visita inesistente o Screening non ammesso\.|Finestre duplicate per la stessa coppia studio\/visita\.)$/;

function validationDetail(payload) {
  const detail = payload?.detail;
  if (typeof detail === "string") {
    const value = detail.trim().replace(/\s+/g, " ");
    return SAFE_VALIDATION_MESSAGE.test(value) ? ` Dettaglio di validazione: ${value}.` : "";
  }
  if (!Array.isArray(detail)) return "";
  const issues = detail.slice(0, 3).flatMap(item => {
    if (!item || !Array.isArray(item.loc) || typeof item.type !== "string") return [];
    const field = item.loc.filter(part => typeof part === "string" && VALIDATION_FIELDS.has(part)).join(".");
    const type = VALIDATION_TYPES.has(item.type) ? item.type : "invalid";
    return field ? [`${field} (${type})`] : [];
  });
  return issues.length ? ` Campi non validi: ${issues.join("; ")}.` : "";
}

async function requestService(url, args, service) {
  const unavailable = `Servizio ${service} non disponibile o risposta non valida. Nessun risultato ottenuto.`;
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(args.analysis === "dynamic" ? 90000 : 60000),
    });
  } catch (error) {
    if (args.analysis !== "dynamic" && isConnectionRefused(error)) {
      const alternative = await localPythonFallback(url, args, service);
      if (alternative !== null) {
        if (alternative && typeof alternative.error === "string") return alternative;
        return validateResponse(alternative, args, service);
      }
    }
    return { error: unavailable };
  }
  try {
    if (response.ok) {
      const result = validateResponse(await response.json(), args, service);
      if (args.analysis === "dynamic") observeGenerationQuota(result.generation_usage?.quota, result.generation_usage);
      return result;
    }
    if (args.analysis === "dynamic") {
      let quota;
      try { quota = JSON.parse(response.headers?.get("x-trialpulse-generation-quota")); } catch { /* Header non disponibile. */ }
      observeGenerationQuota(quota);
    }
    let detail = "";
    if (service === "Data Agent" && [400, 422].includes(response.status)) {
      try { detail = validationDetail(await response.json()); } catch { /* Dettaglio non leggibile. */ }
      try {
        console.warn(`[TrialPulse] Data Agent HTTP ${response.status}; analysis=${args.analysis || "sconosciuta"}.${detail}`);
      } catch { /* Il logging non deve cambiare l'errore HTTP originale. */ }
    }
    return { error: `Il servizio ${service} ha rifiutato la richiesta (HTTP ${response.status}).${detail} Verifica gli argomenti.` };
  } catch {
    return { error: unavailable };
  }
}

function validateResponse(result, args, service) {
  const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
  if (record(result) && Object.hasOwn(result, "error")) {
    return { error: `Risposta non valida del servizio ${service}. Nessun risultato ottenuto.` };
  }
  if (args.analysis === "completeness_threshold") return result;
  const valid = record(result) && Array.isArray(result.results) && result.results.every(record) &&
    (service === "RAG" || (result.analysis === args.analysis && record(result.scope) &&
      record(result.parameters_applied) && record(result.data_quality)));
  if (!valid) return { error: `Risposta non valida del servizio ${service}. Nessun risultato ottenuto.` };
  if (args.analysis === "dynamic" && (!Array.isArray(result.artifacts) || result.artifacts.length !== 1 ||
    !validChart(result.artifacts[0]) || !result.results.length || result.results.length > 120 ||
    result.results.some(row => typeof row.label !== "string" || row.label.length > 100 ||
      typeof row.value !== "number" || !Number.isFinite(row.value) || Math.abs(row.value) > 1e12))) {
    return { error: "Risultato o grafico dell'analisi dinamica non valido." };
  }
  return result;
}

function validChart(artifact) {
  if (!artifact || artifact.type !== "image" || artifact.mime_type !== "image/png" ||
    typeof artifact.alt !== "string" || artifact.alt.length > 200 ||
    typeof artifact.data !== "string" || artifact.data.length > 1400000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(artifact.data)) return false;
  const png = Buffer.from(artifact.data, "base64");
  return png.length >= 33 && png.length <= 1048576 && png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) &&
    png.toString("ascii", 12, 16) === "IHDR" && png.readUInt32BE(16) > 0 && png.readUInt32BE(16) <= 1600 &&
    png.readUInt32BE(20) > 0 && png.readUInt32BE(20) <= 1200;
}

function parseToolCall(call) {
  const name = call.function?.name;
  const definition = TOOLS.find(tool => tool.function.name === name);
  if (!definition) throw new Error("Tool sconosciuto.");

  let args;
  try {
    args = JSON.parse(call.function.arguments);
  } catch {
    throw new Error("Argomenti tool JSON non validi.");
  }
  const schema = definition.function.parameters;
  if (
    !args || typeof args !== "object" || Array.isArray(args) ||
    Object.keys(args).some(key => !Object.hasOwn(schema.properties, key))
  ) {
    throw new Error("Payload tool non valido.");
  }
  return { name, args, schema };
}

function normalizedWindows(rows) {
  return JSON.stringify(rows.map(row =>
    JSON.stringify([row.study_id, row.visit_name, row.window_days])).sort());
}

async function retrieveKnowledge(query, where) {
  const response = await requestService(`${RAG_API_URL}/retrieve`, { query, where }, "RAG");
  if (response.error) throw new Error(response.error);
  return response.results;
}

async function completeCompletenessRules(args) {
  const supplied = args.parameters === undefined ? {} : args.parameters;
  const keys = REQUIRED_ANALYSIS_PARAMETERS.completeness_threshold;
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied) ||
    Object.entries(supplied).some(([key, value]) =>
      !keys.includes(key) || typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100)) {
    throw new Error("Parametri completeness non validi.");
  }
  if (keys.every(key => Object.hasOwn(supplied, key))) {
    validateAnalysisParameters(args);
  }
  if (args.rule_source === undefined) return;

  const document = await buildCompletenessRules(retrieveKnowledge);
  if (Object.entries(supplied).some(([key, value]) => value !== document.parameters[key])) {
    throw new Error("Soglie fornite in conflitto con la regola Novera richiesta.");
  }
  args.parameters = { ...document.parameters, ...supplied };
  delete args.rule_source;
  return document.support;
}

async function completeVisitRules(args) {
  const supplied = args.parameters || {};
  if (typeof supplied !== "object" || Array.isArray(supplied)) {
    throw new Error("Parameters non valido.");
  }
  if (Object.keys(supplied).some(key => !["visit_windows", "rate_threshold_percent"].includes(key))) {
    throw new Error("Parametri non supportati per out_of_window. Ometti parameters: finestre e soglia vengono recuperate dalla KB dal servizio.");
  }

  const document = await buildVisitRules(args.filters || {}, retrieveKnowledge);
  if (
    supplied.rate_threshold_percent !== undefined &&
    supplied.rate_threshold_percent !== document.parameters.rate_threshold_percent
  ) {
    throw new Error("Soglia fornita in conflitto con la documentazione.");
  }
  if (supplied.visit_windows !== undefined) {
    const validRows = Array.isArray(supplied.visit_windows) && supplied.visit_windows.every(row =>
      row && typeof row === "object" &&
      Object.keys(row).sort().join(",") === "study_id,visit_name,window_days");
    if (
      !validRows || normalizedWindows(supplied.visit_windows) !== normalizedWindows(document.parameters.visit_windows)
    ) {
      throw new Error("Finestre fornite incomplete o in conflitto con la documentazione.");
    }
  }
  args.parameters = { ...supplied, ...document.parameters };
  return document.support;
}

export async function executeTool(call) {
  const { name, args, schema } = parseToolCall(call);
  if (name === "search_knowledge") {
    if (typeof args.query !== "string" || !args.query.trim()) {
      throw new Error("La query documentale deve essere un testo non vuoto.");
    }
    const result = await requestService(`${RAG_API_URL}/retrieve`, args, "RAG");
    return result.error ? result : { ...result, results: selectKnowledge(result.results) };
  }
  if (args.analysis === "dynamic") {
    if (Object.keys(args).some(key => !["analysis", "question", "chart", "filters"].includes(key)) ||
      typeof args.question !== "string" || args.question.trim().length < 3 || args.question.length > 1000 ||
      !["bar", "line"].includes(args.chart) || (args.filters !== undefined &&
        (!args.filters || typeof args.filters !== "object" || Array.isArray(args.filters) ||
          Object.entries(args.filters).some(([key, value]) => !["study_id", "site_id"].includes(key) ||
            typeof value !== "string" || !/^[A-Z0-9_-]{1,32}$/.test(value))))) {
      throw new Error("Richiesta dinamica non valida.");
    }
    await paceGeneration();
    return requestService(`${DATA_AGENT_URL}/analyze`, args, "Data Agent");
  }
  if (args.question !== undefined || args.chart !== undefined) throw new Error("question e chart sono ammessi solo per dynamic.");
  if (!schema.properties.analysis.enum.includes(args.analysis)) {
    throw new Error("Analisi non supportata.");
  }
  if (Object.hasOwn(args, "rule_source") &&
    (args.analysis !== "completeness_threshold" || args.rule_source !== "novera_kb")) {
    throw new Error("rule_source è ammesso solo come novera_kb per completeness_threshold.");
  }
  if (args.analysis === "major_deviations_window" && Array.isArray(args.group_by) &&
    args.group_by.length === 1 && args.group_by[0] === "site_id") delete args.group_by;
  if (args.analysis === "recruitment_target" && args.group_by !== undefined &&
    (!Array.isArray(args.group_by) || args.group_by.length !== 0)) {
    throw new Error("recruitment_target restituisce gia risultati per studio, sito e mese: ometti group_by.");
  }
  validateAnalysisScope(args);
  let documentSupport;
  if (args.analysis === "completeness_threshold") {
    if (!Array.isArray(args.group_by)) {
      throw new Error('completeness_threshold richiede group_by esplicito: [] per aggregare il perimetro, ["site_id"] per siti, ["study_id"] per studi o entrambi. Nessun raggruppamento predefinito.');
    }
    documentSupport = await completeCompletenessRules(args);
  }
  validateAnalysisParameters(args);
  if (args.analysis === "out_of_window") documentSupport = await completeVisitRules(args);
  const result = await requestService(`${DATA_AGENT_URL}/analyze`, args, "Data Agent");
  if (args.analysis === "completeness_threshold" &&
    (!result || typeof result !== "object" || Array.isArray(result))) validateCompletenessReport(result, args);
  if (result.error) return result;
  if (documentSupport) result.document_support = documentSupport;
  if (args.analysis === "completeness_threshold") validateCompletenessReport(result, args);
  return result;
}
