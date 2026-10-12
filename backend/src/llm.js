import Groq, { APIError } from "groq-sdk";
import { GROQ_API_KEY, GROQ_MODEL, GROQ_FALLBACK_MODEL } from "./config.js";
import { TOOLS } from "./tools.js";

const groq = new Groq({
  apiKey: GROQ_API_KEY,
  timeout: 60_000,
  maxRetries: 0,
});

async function complete(payload, modelState) {
  const capacity = modelState.capacity?.[payload.model];
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
  } else if (modelState.capacity) delete modelState.capacity[payload.model];
  return data;
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
      `generation_category=non_disponibile; retry400=${retry ? "utilizzato" : "non_utilizzato"}; retry_outcome=${outcome}`,
    ].join("; "));
  } catch { /* La diagnostica non deve impedire la completion o l'errore controllato. */ }
}

async function completeWithToolRetry(payload, modelState, context) {
  try {
    return await complete(payload, modelState);
  } catch (error) {
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

  if (!reply) {
    throw new Error("Il modello non ha restituito una risposta.");
  }

  return reply;
}