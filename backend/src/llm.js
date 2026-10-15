import Groq, { APIError } from "groq-sdk";
import { GROQ_API_KEY, GROQ_MODEL, GROQ_FALLBACK_MODEL } from "./config.js";
import { TOOLS } from "./tools.js";

const groq = new Groq({
  apiKey: GROQ_API_KEY,
  timeout: 60_000,
  maxRetries: 0,
});
// La quota del modello non riparte da zero al successivo turno conversazionale.
const observedCapacity = new Map();

export async function paceGeneration() {
  const capacity = observedCapacity.get(GROQ_MODEL);
  const wait = capacity?.resetAt - Date.now();
  // Stima prudente della piccola generazione di codice, non una misura di consumo.
  if (capacity?.remaining < 2500 && wait > 0) {
    if (wait > 60000) throw new Error("Quota del generatore non ancora disponibile.");
    await new Promise(resolve => setTimeout(resolve, wait));
  }
}

export function observeGenerationQuota(quota, usage = {}) {
  if (quota?.model !== GROQ_MODEL || !Number.isFinite(quota.remaining) || quota.remaining < 0 ||
    !Number.isFinite(quota.reset_seconds) || quota.reset_seconds <= 0 || quota.reset_seconds > 3600) {
    observedCapacity.delete(GROQ_MODEL);
    return;
  }
  const previous = observedCapacity.get(GROQ_MODEL)?.previousCost ?? 2500;
  observedCapacity.set(GROQ_MODEL, { remaining: quota.remaining, resetAt: Date.now() + quota.reset_seconds * 1000 + 100,
    previousCost: Math.max(previous, Number.isSafeInteger(usage.total_tokens) ? usage.total_tokens + 600 : 2500) });
}

async function complete(payload, modelState) {
  const capacity = observedCapacity.get(payload.model) ?? modelState.capacity?.[payload.model];
  const wait = capacity?.resetAt - Date.now();
  if (capacity?.remaining < capacity?.previousCost && wait > 0 && wait <= 60_000) {
    await new Promise(resolve => setTimeout(resolve, wait));
  }
  const request = groq.chat.completions.create(payload);
  if (typeof request.withResponse !== "function") return request;
  const { data, response } = await request.withResponse();
  const remainingHeader = response.headers.get("x-ratelimit-remaining-tokens");
  const reset = response.headers.get("x-ratelimit-reset-tokens")?.match(/^(\d+(?:\.\d+)?)s$/);
  const remaining = remainingHeader !== null ? Number(remainingHeader) : NaN;
  const duration = reset ? Number(reset[1]) * 1000 : NaN;
  const promptTokens = data.usage?.prompt_tokens;
  if (Number.isFinite(remaining) && remaining >= 0 && Number.isFinite(duration) && duration > 0 &&
      duration <= 59_900 && Number.isSafeInteger(promptTokens) && promptTokens > 0) {
    modelState.capacity ??= {};
    modelState.capacity[payload.model] = { remaining, resetAt: Date.now() + duration + 100,
      previousCost: promptTokens + payload.max_completion_tokens };
    observedCapacity.set(payload.model, modelState.capacity[payload.model]);
  } else {
    observedCapacity.delete(payload.model);
    if (modelState.capacity) delete modelState.capacity[payload.model];
  }
  return data;
}

function logCompletion(completion, modelState, { allowTools, round }) {
  try {
    const choice = completion.choices?.[0];
    const content = choice?.message?.content;
    let packet;
    try { packet = JSON.parse(content); } catch { /* Nessun contenuto nei log. */ }
    const category = !content ? "content_absent" : packet && Object.hasOwn(packet, "schedule_facts") ?
      "schedule_packet" : packet ? "other_json" : "prose_or_invalid_json";
    const finish = ["stop", "length", "tool_calls", "content_filter"].includes(choice?.finish_reason) ?
      choice.finish_reason : "non_disponibile";
    const usage = ["prompt_tokens", "completion_tokens", "total_tokens"].map(key =>
      `${key}=${Number.isSafeInteger(completion.usage?.[key]) && completion.usage[key] >= 0 ? completion.usage[key] : "non_disponibile"}`);
    console.warn(`[TrialPulse] provider_completion; model=${modelState.fallback ? "fallback" : "primary"}; round=${round}; completion=${allowTools ? "intermedia" : "finale"}; finish_reason=${finish}; output_category=${category}; ${usage.join("; ")}`);
  } catch { /* Il logging non deve interferire con la risposta. */ }
}

function toolFailureFields(error) {
  return error?.error?.error ?? error?.error;
}

function quotaValue(raw, duration = false) {
  if (typeof raw !== "string" || raw.length > 64) return "non_disponibile";
  let value;
  if (duration) {
    const parts = raw.match(/^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?$/);
    if (!parts || !parts.slice(1).some(part => part !== undefined)) return "non_disponibile";
    value = parts.slice(1).reduce((total, part, index) => total + Number(part ?? 0) * [86400, 3600, 60, 1, 0.001][index], 0);
  } else {
    if (!/^\d+(?:\.\d+)?$/.test(raw)) return "non_disponibile";
    value = Number(raw);
  }
  return Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : "non_disponibile";
}

function logRateLimit(error, payload, modelState, { allowTools, round }) {
  if (!(error instanceof APIError) || error.status !== 429) return;
  try {
    const suppliedCode = toolFailureFields(error)?.code;
    const code = ["rate_limit_exceeded", "rate_limit_error"].includes(suppliedCode) ? suppliedCode : "non_disponibile";
    const read = (header, duration = false) => quotaValue(error.headers?.get?.(header), duration);
    const counts = ["limit-tokens", "remaining-tokens", "limit-requests", "remaining-requests"].map(name => {
      const value = read(`x-ratelimit-${name}`);
      return `${name.replaceAll("-", "_")}=${Number.isSafeInteger(value) ? value : "non_disponibile"}`;
    });
    console.warn([
      `[TrialPulse] provider_rate_limit; status=429; code=${code}; model=${payload.model === GROQ_FALLBACK_MODEL ? "fallback" : "primary"}`,
      `round=${round}; completion=${allowTools ? "intermedia" : "finale"}; retry400_precedente=${Boolean(modelState.toolRetryUsed)}`,
      `retry_after_seconds=${read("retry-after")}`, ...counts,
      `reset_tokens_seconds=${read("x-ratelimit-reset-tokens", true)}`,
      `reset_requests_seconds=${read("x-ratelimit-reset-requests", true)}`,
    ].join("; "));
  } catch { /* Nessun errore diagnostico deve modificare la gestione del provider. */ }
}

function observeErrorCapacity(error, payload, modelState) {
  if (!(error instanceof APIError)) return;
  const previous = observedCapacity.get(payload.model) ?? modelState.capacity?.[payload.model];
  const remaining = quotaValue(error.headers?.get?.("x-ratelimit-remaining-tokens"));
  const duration = quotaValue(error.headers?.get?.("x-ratelimit-reset-tokens"), true) * 1000;
  if (!previous || !Number.isSafeInteger(remaining) || !Number.isFinite(duration) || duration <= 0 || duration > 59_900) return;
  const capacity = { ...previous, remaining, resetAt: Date.now() + duration + 100 };
  modelState.capacity ??= {};
  modelState.capacity[payload.model] = capacity;
  observedCapacity.set(payload.model, capacity);
}

function generationCategory(raw) {
  if (typeof raw !== "string" || raw.length > 65_536) return "non_disponibile";
  try {
    const packet = JSON.parse(raw);
    if (!packet || typeof packet !== "object" || Array.isArray(packet)) return "json_other_value";
    if (Object.hasOwn(packet, "schedule_facts")) return "json_schedule_packet";
    if (Array.isArray(packet.tool_calls)) return "json_tool_calls";
    if (typeof packet.name === "string" && Object.hasOwn(packet, "arguments")) {
      return TOOLS.some(tool => tool.function.name === packet.name) ? "json_known_function" : "json_unknown_function";
    }
    return "json_other_object";
  } catch { return "non_json"; }
}

function logToolFailure(error, payload, { allowTools, round }, retry, outcome) {
  const fields = toolFailureFields(error);
  const present = fields && typeof fields === "object" && Object.hasOwn(fields, "failed_generation");
  const generation = present ? fields.failed_generation : undefined;
  const generationType = !present ? "non_disponibile" : generation === null ? "null" :
    Array.isArray(generation) ? "array" : typeof generation;
  const code = fields?.code === "tool_use_failed" ? "tool_use_failed" : "non_disponibile";
  const type = fields?.type === "invalid_request_error" ? "invalid_request_error" : "non_disponibile";
  try {
    console.warn([
      `[TrialPulse] provider_tool_error; status=${Number.isInteger(error?.status) ? error.status : "non_disponibile"}`,
      `code=${code}; type=${type}; model=${payload.model === GROQ_FALLBACK_MODEL ? "fallback" : "primary"}`,
      `round=${round}; completion=${allowTools ? "intermedia" : "finale"}`,
      `failed_generation_present=${Boolean(present)}; failed_generation_type=${generationType}`,
      `generation_category=${generationCategory(generation)}; retry400=${retry ? "utilizzato" : "non_utilizzato"}; retry_outcome=${outcome}`,
    ].join("; "));
  } catch { /* La diagnostica non deve impedire la completion o l'errore controllato. */ }
}

async function completeWithToolRetry(payload, modelState, context) {
  try {
    return await complete(payload, modelState);
  } catch (error) {
    observeErrorCapacity(error, payload, modelState);
    logRateLimit(error, payload, modelState, context);
    const fields = toolFailureFields(error);
    const eligible = error instanceof APIError && error.status === 400 &&
      fields?.code === "tool_use_failed" && fields?.type === "invalid_request_error" &&
      context.allowTools && context.hasKnowledgeResult && !modelState.toolRetryUsed;
    if (error instanceof APIError && fields?.code === "tool_use_failed") {
      logToolFailure(error, payload, context, eligible || modelState.toolRetryUsed, eligible ? "avviato" : "non_eseguito");
    }
    if (!eligible) throw error;

    modelState.toolRetryUsed = true;
    try {
      const completion = await complete(payload, modelState);
      logToolFailure(error, payload, context, true, "riuscito");
      return completion;
    } catch (retryError) {
      observeErrorCapacity(retryError, payload, modelState);
      logRateLimit(retryError, payload, modelState, context);
      logToolFailure(retryError, payload, context, true, "fallito");
      throw retryError;
    }
  }
}

export async function generateCompletion(messages, { allowTools = true, modelState = {},
  hasKnowledgeResult = false, round = 1 } = {}) {
  if (!GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY non configurata.");
  }

  const payload = {
    model: modelState.fallback ? GROQ_FALLBACK_MODEL : GROQ_MODEL,
    messages,
    reasoning_effort: "low",
    include_reasoning: false,
    temperature: 0.2,
    max_completion_tokens: 600,
  };

  if (allowTools) {
    payload.tools = TOOLS;
    payload.tool_choice = "auto";
  }

  let completion;
  const context = { allowTools, hasKnowledgeResult, round };
  try {
    completion = await completeWithToolRetry(payload, modelState, context);
  } catch (error) {
    if (!(error instanceof APIError) || error.status !== 429 || modelState.fallback) throw error;
    modelState.fallback = true;
    completion = await completeWithToolRetry({ ...payload, model: GROQ_FALLBACK_MODEL }, modelState, context);
  }

  const reply = completion.choices[0]?.message;
  logCompletion(completion, modelState, context);

  if (!reply) {
    throw new Error("Il modello non ha restituito una risposta.");
  }

  return reply;
}
