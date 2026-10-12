import { afterEach, beforeEach, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("groq-sdk", async importOriginal => ({
  ...await importOriginal(),
  default: vi.fn(function () {
    return { chat: { completions: { create: sdk.create } } };
  })
}));
vi.mock("../src/config.js", () => ({ GROQ_API_KEY: "test-placeholder", GROQ_MODEL: "openai/gpt-oss-120b", GROQ_FALLBACK_MODEL: "openai/gpt-oss-20b" }));
import { generateCompletion } from "../src/llm.js";

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

it("invia i due tool nativi con scelta automatica senza ragionamento esposto", async () => {
  sdk.create.mockResolvedValue({ choices: [{ message: { role: "assistant", content: "Risposta." } }] });
  const messages = [{ role: "user", content: "Domanda" }];
  expect(await generateCompletion(messages)).toEqual({ role: "assistant", content: "Risposta." });
  const payload = sdk.create.mock.calls[0][0];
  expect(payload.model).toBe("openai/gpt-oss-120b");
  expect(payload.messages).toEqual(messages);
  expect(payload.tool_choice).toBe("auto");
  expect(payload.include_reasoning).toBe(false);
  expect(payload.tools.map(tool => tool.function.name)).toEqual(["search_knowledge", "analyze_operations"]);
});

it("espone al provider le due soglie numeriche senza obblighi globali o default", async () => {
  sdk.create.mockResolvedValue({ choices: [{ message: { content: "Risposta." } }] });
  await generateCompletion([{ role: "user", content: "Domanda" }]);
  const schema = sdk.create.mock.calls[0][0].tools.find(tool => tool.function.name === "analyze_operations").function.parameters;
  const parameters = schema.properties.parameters;
  expect(parameters.properties).toBeDefined();
  for (const key of ["attention_threshold_percent", "escalation_threshold_percent"]) {
    expect(parameters.properties[key].type).toBe("number");
    expect(parameters.properties[key].description).toBeTruthy();
    expect(parameters.properties[key]).not.toHaveProperty("default");
    expect(parameters.required || []).not.toContain(key);
  }
  expect(schema.required).not.toContain("parameters");
  expect(parameters.additionalProperties).toBe(true);
});

it("espone i nomi e i tipi recruitment senza soglie predefinite", async () => {
  sdk.create.mockResolvedValue({ choices: [{ message: { content: "Risposta." } }] });
  await generateCompletion([{ role: "user", content: "Domanda" }]);
  const parameters = sdk.create.mock.calls[0][0].tools[1].function.parameters.properties.parameters;
  expect(parameters.properties.threshold_percent).toMatchObject({ type: "number" });
  expect(parameters.properties.consecutive_months).toMatchObject({ type: "integer", minimum: 1 });
  for (const key of ["threshold_percent", "consecutive_months"]) {
    expect(parameters.properties[key]).not.toHaveProperty("default");
    expect(parameters.required || []).not.toContain(key);
  }
});

const message = { choices: [{ message: { role: "assistant", content: "Risposta." } }], usage: { prompt_tokens: 1000 } };
function withHeaders(values) {
  const request = Promise.resolve(message);
  request.withResponse = async () => ({ data: message, response: { headers: new Headers(values) } });
  return request;
}

it("attende il reset TPM quando la capacità osservata è inferiore alla completion precedente", async () => {
  vi.useFakeTimers();
  sdk.create.mockImplementationOnce(() => withHeaders({ "x-ratelimit-remaining-tokens": "100", "x-ratelimit-reset-tokens": "2s" }))
    .mockResolvedValue(message);
  const modelState = {}, messages = [{ role: "user", content: "Domanda" }];
  await generateCompletion(messages, { modelState });
  const pending = generateCompletion(messages, { modelState });
  expect(sdk.create).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2100);
  await pending;
  expect(sdk.create).toHaveBeenCalledTimes(2);
  expect(sdk.create.mock.calls[1][0]).toEqual(sdk.create.mock.calls[0][0]);
});

it.each([
  ["5000", "2s"], ["100", "invalid"], ["100", "2m"], ["100", "0s"], ["invalid", "2s"],
])("non attende con capacità sufficiente o segnali non utilizzabili: %s, %s", async (remaining, reset) => {
  vi.useFakeTimers();
  sdk.create.mockImplementationOnce(() => withHeaders({ "x-ratelimit-remaining-tokens": remaining, "x-ratelimit-reset-tokens": reset }))
    .mockResolvedValue(message);
  const modelState = {};
  await generateCompletion([], { modelState });
  await generateCompletion([], { modelState });
  expect(vi.getTimerCount()).toBe(0);
  expect(sdk.create).toHaveBeenCalledTimes(2);
});

it("non trasferisce il pacing a una nuova richiesta", async () => {
  vi.useFakeTimers();
  sdk.create.mockImplementationOnce(() => withHeaders({ "x-ratelimit-remaining-tokens": "100", "x-ratelimit-reset-tokens": "2s" }))
    .mockResolvedValue(message);
  await generateCompletion([], { modelState: {} });
  await generateCompletion([], { modelState: {} });
  expect(vi.getTimerCount()).toBe(0);
});