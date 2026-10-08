import { generateCompletion } from "./llm.js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";
import { executeTool } from "./toolExecutor.js";

const MAX_TOOL_ROUNDS = 4;

function compactToolResult(name, result) {
  if (!result || typeof result !== "object" || result.error) return result;

  if (name === "search_knowledge" && Array.isArray(result.results)) {
    return { results: result.results.map(({ metadata, ...chunk }) => chunk) };
  }
  if (name !== "analyze_operations") return result;

  const compact = {
    analysis: result.analysis,
    scope: result.scope,
    parameters_applied: result.parameters_applied,
    results: result.results,
  };

  if (result.document_support) {
    compact.document_support = result.document_support;
    // Il modello riceve la regola applicata, non la tabella completa delle finestre.
    compact.parameters_applied = { ...result.parameters_applied };
    delete compact.parameters_applied.visit_windows;
  }

  if (result.data_quality) {
    const quality = result.data_quality;
    compact.data_quality = {
      duplicates_removed: quality.duplicates_removed,
      inconsistent_actual_dates: quality.inconsistent_actual_dates,
      inconsistent_query_rows: quality.inconsistent_query_rows,
      excluded_records: quality.excluded_records,
      warnings: quality.warnings,
      exclusions_by_reason: quality.exclusions_by_reason,
    };
  }

  return compact;
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

export async function orchestrate(message) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: message },
  ];
  const toolsUsed = new Set();
  const completedDataCalls = new Map();
  let rounds = 0;
  let forceFinalAnswer = false;

  while (true) {
    const reply = await generateCompletion([...messages], { allowTools: !forceFinalAnswer });
    const toolCalls = reply?.tool_calls || [];

    if (!toolCalls.length) {
      const answer = reply?.content?.trim();
      if (!answer) throw new Error("Il modello non ha restituito una risposta finale.");
      return { answer, tools_used: [...toolsUsed] };
    }

    if (forceFinalAnswer) {
      throw new Error("Il modello ha richiesto un tool quando era attesa la risposta finale.");
    }
    if (rounds >= MAX_TOOL_ROUNDS) {
      throw new Error("Raggiunto il limite di round dei tool. Richiesta interrotta in sicurezza.");
    }

    rounds++;
    messages.push({ role: "assistant", content: reply.content || null, tool_calls: toolCalls });
    let allCallsWereCachedData = true;

    for (const call of toolCalls) {
      const { result, cached } = await runTool(call, completedDataCalls, toolsUsed);
      if (!cached) allCallsWereCachedData = false;
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }

    if (allCallsWereCachedData) forceFinalAnswer = true;
  }
}