import { generateCompletion } from "./llm.js";
import { APIError } from "groq-sdk";
import { SYSTEM_PROMPT } from "./systemPrompt.js";
import { executeTool } from "./toolExecutor.js";
import { presentCompletenessReports } from "./completenessReport.js";
import { presentRecruitmentReports } from "./recruitmentReport.js";
import { presentReferences, modelDocumentReference } from "./references.js";
import { controlDocumentScope, selectedUserStudies } from "./documentScope.js";
import { presentScheduleClaims } from "./scheduleClaims.js";

const MAX_TOOL_ROUNDS = 4;
const NO_ANALYTICAL_RESULT = "Non ho ottenuto nessun risultato analitico verificato dal Data Agent. Non posso fornire i KPI richiesti. Puoi riformulare la richiesta.";
const pick = (record, keys) => Object.fromEntries(keys.map(key => [key, record[key]]));

function compactToolResult(name, result) {
  if (name !== "analyze_operations" || !result || typeof result !== "object" || result.error) return result;

  const compact = pick(result, ["analysis", "scope", "parameters_applied", "results"]);
  if (result.analysis === "dynamic") compact.artifacts = result.artifacts;
  if (result.document_support) {
    compact.document_support = result.document_support;
    // Il modello riceve la regola applicata, non la tabella completa delle finestre.
    compact.parameters_applied = { ...result.parameters_applied };
    delete compact.parameters_applied.visit_windows;
  }

  if (result.data_quality) {
    compact.data_quality = pick(result.data_quality, ["duplicates_removed", "inconsistent_actual_dates",
      "inconsistent_query_rows", "excluded_records", "warnings", "exclusions_by_reason"]);
  }

  return compact;
}

function hasScheduleEvidence(chunk) {
  return chunk.source === "knowledge_base/reference/visit_schedule_windows.md" ||
    (/^knowledge_base\/protocols\/NNR-[A-Z]+-\d+\.md$/.test(chunk.source) && chunk.section === "Schedule") ||
    (chunk.source === "knowledge_base/faq.md" && /^Qual è la finestra della .+\?$/.test(chunk.section));
}

function modelToolResult(name, result) {
  if (!result || result.error) return result;
  if (name === "analyze_operations" && result.analysis === "dynamic") {
    const { artifacts, ...context } = result;
    return context;
  }
  if (name === "search_knowledge" && Array.isArray(result.results)) {
    return { results: result.results.map(chunk => ({ text: chunk.text, ...modelDocumentReference(chunk),
      ...(hasScheduleEvidence(chunk) ?
        { schedule_evidence: { source: chunk.source, section: chunk.section } } : {}),
    })) };
  }
  if (name === "analyze_operations" && result.document_support) {
    return { ...result, document_support: { ...result.document_support,
      sources: Array.isArray(result.document_support.sources) ?
        result.document_support.sources.map(modelDocumentReference).filter(source => source.title) : [],
    } };
  }
  return result;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function dataCallKey(call) {
  if (call.function?.name !== "analyze_operations") return null;
  try {
    return stableStringify(JSON.parse(call.function.arguments));
  } catch {
    return null;
  }
}

function dataReports(cache) {
  return [...new Map([...cache.values()].map(report => [stableStringify(report), report])).values()];
}

async function runTool(call, cache, toolsUsed) {
  const key = dataCallKey(call);
  if (key && cache.has(key)) {
    return { result: cache.get(key), cached: true };
  }

  try {
    let result = await executeTool(call);
    toolsUsed.add(call.function.name);
    result = compactToolResult(call.function.name, result);
    if (key && result && typeof result === "object" && !result.error) {
      cache.set(key, result);
    }
    return { result, cached: false };
  } catch (error) {
    return { result: { error: error.message }, cached: false };
  }
}

export async function orchestrate(message, history = []) {
  const selected = selectedUserStudies(message, history);
  const studyContext = selected.length ? `\n\nStudi identificati nel contesto utente: ${selected.join(", ")}. Gli alias ufficiali corrispondenti sono già risolti: non chiedere di nuovo l'ID completo. Questa identificazione è contesto operativo, non evidenza di calendario o regole; usa i tool necessari.` : "";
  const messages = [
    { role: "system", content: SYSTEM_PROMPT + studyContext },
    ...history.map(({ role, content }) => ({ role, content })),
    { role: "user", content: message },
  ];
  const toolsUsed = new Set();
  const completedDataCalls = new Map();
  const modelState = {};
  const knowledge = [];
  let cachedOnly = false;
  let hasVerifiedToolResult = false;
  let attemptedDataAnalysis = false;
  let hasSuccessfulTool = false;
  let hasKnowledgeResult = false;

  for (let round = 1; round <= MAX_TOOL_ROUNDS + 1; round++) {
    const forceFinalAnswer = cachedOnly || round > MAX_TOOL_ROUNDS;
    let reply;
    try {
      reply = await generateCompletion([...messages], { allowTools: !forceFinalAnswer, modelState,
        hasKnowledgeResult, round });
    } catch (error) {
      const known = new Set(["tool_use_failed", "invalid_request_error", "invalid_request",
        "rate_limit_exceeded", "rate_limit_error", "context_length_exceeded", "authentication_error"]);
      const value = name => [error?.error?.error?.[name], error?.error?.[name], error?.[name]]
        .find(candidate => known.has(candidate)) ?? "non_disponibile";
      if (error && typeof error === "object") {
        const code = value("code"), type = value("type");
        error.providerDiagnostics = { round, code, type,
          model: modelState.fallback ? "fallback" : "primary",
          category: [code, type].includes("tool_use_failed") ? "tool_use_failed" : "non_disponibile",
          phase: hasSuccessfulTool ? "after_successful_tool" : "before_successful_tool" };
      }
      if (forceFinalAnswer && error instanceof APIError && error.status === 400 && value("code") === "tool_use_failed") {
        const answer = await presentRecruitmentReports(dataReports(completedDataCalls), knowledge, { recovery: true });
        if (answer) return { answer, tools_used: [...toolsUsed] };
      }
      throw error;
    }
    const toolCalls = reply?.tool_calls || [];

    if (!toolCalls.length) {
      const reports = dataReports(completedDataCalls);
      const controlled = presentCompletenessReports(reports, knowledge) ?? await presentRecruitmentReports(reports, knowledge);
      let answer = attemptedDataAnalysis && !reports.length ? NO_ANALYTICAL_RESULT : controlled ?? reply?.content?.trim();
      if (!answer) throw new Error("Il modello non ha restituito una risposta finale.");
      if (controlled === null) {
        const schedule = await presentScheduleClaims(answer, knowledge, message, history);
        if (schedule !== null) answer = schedule;
        else if (!reports.length) answer = controlDocumentScope(answer, knowledge, message, history);
        const references = presentReferences(reports, knowledge);
        if (references) answer += `\n\n${references}`;
      }
      const artifacts = reports.filter(report => report.analysis === "dynamic").flatMap(report => report.artifacts ?? []).slice(0, 1);
      return { answer, tools_used: [...toolsUsed], ...(artifacts.length ? { artifacts } : {}) };
    }

    if (forceFinalAnswer) {
      throw new Error("Il modello ha richiesto un tool quando era attesa la risposta finale.");
    }

    messages.push({ role: "assistant", content: reply.content || null, tool_calls: toolCalls });
    let allCallsWereCachedData = true;

    for (const call of toolCalls) {
      if (call.function.name === "analyze_operations") attemptedDataAnalysis = true;
      const { result, cached } = await runTool(call, completedDataCalls, toolsUsed);
      if (call.function.name === "search_knowledge" && Array.isArray(result?.results)) {
        for (const chunk of result.results) {
          if (!result.error && typeof chunk?.text === "string" && chunk.text.trim()) hasKnowledgeResult = true;
          if (typeof chunk.source === "string" &&
            !knowledge.some(source => source.source === chunk.source && source.section === chunk.section && source.text === chunk.text)) knowledge.push(chunk);
        }
      }
      if (!cached) allCallsWereCachedData = false;
      if (!result?.error && Array.isArray(result?.results)) {
        hasSuccessfulTool = true;
        if (result.results.length) hasVerifiedToolResult = true;
      }
      messages.push({ role: "tool", tool_call_id: call.id,
        content: JSON.stringify(modelToolResult(call.function.name, result)) });
    }

    if (round === MAX_TOOL_ROUNDS && (!hasVerifiedToolResult ||
      (attemptedDataAnalysis && !completedDataCalls.size))) {
      return {
        answer: attemptedDataAnalysis ? NO_ANALYTICAL_RESULT : "Non sono riuscito a ottenere risultati verificabili per completare la richiesta. Puoi riformularla o riprovare.",
        tools_used: [...toolsUsed],
      };
    }
    cachedOnly = allCallsWereCachedData;
  }
}
