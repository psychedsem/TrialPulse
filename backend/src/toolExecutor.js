import { DATA_AGENT_URL, RAG_API_URL } from "./config.js";
import { TOOLS } from "./tools.js";
import { buildVisitRules, selectKnowledge } from "./documentAdapter.js";

const REQUIRED_ANALYSIS_PARAMETERS = {
  major_deviations_window: ["window_days", "min_count"],
  consecutive_missed: ["min_consecutive"],
  recruitment_target: ["threshold_percent", "consecutive_months"],
  query_aging_threshold: ["threshold_days"],
  completeness_threshold: ["attention_threshold_percent", "escalation_threshold_percent"],
};

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

async function requestService(url, args, service) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) {
      return { error: `Il servizio ${service} ha rifiutato la richiesta (HTTP ${response.status}). Verifica gli argomenti.` };
    }
    return await response.json();
  } catch {
    return { error: `Servizio ${service} non disponibile o risposta non valida. Nessun risultato ottenuto.` };
  }
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

async function completeVisitRules(args) {
  const supplied = args.parameters || {};
  if (typeof supplied !== "object" || Array.isArray(supplied)) {
    throw new Error("Parameters non valido.");
  }
  if (Object.keys(supplied).some(key => !["visit_windows", "rate_threshold_percent"].includes(key))) {
    throw new Error("Parametri non supportati per out_of_window. Ometti parameters: finestre e soglia vengono recuperate dalla KB dal servizio.");
  }

  const document = await buildVisitRules(args.filters || {}, async (query, where) => {
    const response = await requestService(`${RAG_API_URL}/retrieve`, { query, where }, "RAG");
    if (response.error) throw new Error(response.error);
    return response.results;
  });
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

  if (name === "search_knowledge" && (typeof args.query !== "string" || !args.query.trim())) {
    throw new Error("La query documentale deve essere un testo non vuoto.");
  }
  if (name === "analyze_operations") {
    if (!schema.properties.analysis.enum.includes(args.analysis)) {
      throw new Error("Analisi non supportata.");
    }
    if (
      args.analysis === "major_deviations_window" &&
      Array.isArray(args.group_by) && args.group_by.length === 1 && args.group_by[0] === "site_id"
    ) {
      delete args.group_by;
    }
    validateAnalysisParameters(args);
  }

  const isKnowledgeSearch = name === "search_knowledge";
  const url = isKnowledgeSearch ? `${RAG_API_URL}/retrieve` : `${DATA_AGENT_URL}/analyze`;
  const service = isKnowledgeSearch ? "RAG" : "Data Agent";
  const documentSupport = args.analysis === "out_of_window" ? await completeVisitRules(args) : undefined;
  const result = await requestService(url, args, service);

  if (result.error) return result;
  if (documentSupport) return { ...result, document_support: documentSupport };
  if (isKnowledgeSearch && Array.isArray(result.results)) {
    return { ...result, results: selectKnowledge(result.results) };
  }
  return result;
}