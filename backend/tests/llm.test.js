import { afterEach, beforeEach, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("groq-sdk", async importOriginal => ({
  ...await importOriginal(),
  default: vi.fn(function () {
    return { chat: { completions: { create: sdk.create } } };
  })
}));
vi.mock("../src/config.js", () => ({ GROQ_API_KEY: "test-placeholder", GROQ_MODEL: "openai/gpt-oss-120b", GROQ_FALLBACK_MODEL: "openai/gpt-oss-20b" }));
let generateCompletion;

it("coordina la generazione esterna e aggiorna la quota prima della sintesi", async () => {
  vi.useFakeTimers();
  const module = await import("../src/llm.js");
  expect(typeof module.observeGenerationQuota).toBe("function");
  expect(typeof module.paceGeneration).toBe("function");
  module.observeGenerationQuota({ model: "openai/gpt-oss-120b", remaining: 100, reset_seconds: 2 }, { total_tokens: 1800 });
  let complete = false;
  const pending = module.paceGeneration().then(() => { complete = true; });
  await vi.advanceTimersByTimeAsync(1999);
  expect(complete).toBe(false);
  await vi.advanceTimersByTimeAsync(101);
  await pending;
  expect(complete).toBe(true);
});

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  ({ generateCompletion } = await import("../src/llm.js"));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

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

it("conserva il reset TPM osservato fra richieste distinte sullo stesso modello", async () => {
  vi.useFakeTimers();
  sdk.create.mockImplementationOnce(() => withHeaders({ "x-ratelimit-remaining-tokens": "100", "x-ratelimit-reset-tokens": "2s" }))
    .mockResolvedValue(message);
  await generateCompletion([], { modelState: {} });
  const pending = generateCompletion([], { modelState: {} });
  expect(sdk.create).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2100);
  await pending;
  expect(sdk.create).toHaveBeenCalledTimes(2);
});

it("registra soltanto metadati chiusi della finale senza testo o reasoning", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  sdk.create.mockResolvedValue({ choices: [{ finish_reason: "length", message: {
    role: "assistant", content: "canary_riservata", reasoning: "reasoning_riservato",
  } }], usage: { prompt_tokens: 3200, completion_tokens: 600, total_tokens: 3800 } });
  expect((await generateCompletion([], { round: 2 })).content).toBe("canary_riservata");
  const logs = warn.mock.calls.flat().join(" ");
  expect(logs).toContain("finish_reason=length");
  expect(logs).toContain("prompt_tokens=3200");
  expect(logs).not.toMatch(/canary|reasoning_riservato/);
  warn.mockRestore();
});

it("la quota del primary non viene applicata al modello fallback", async () => {
  vi.useFakeTimers();
  sdk.create.mockImplementationOnce(() => withHeaders({ "x-ratelimit-remaining-tokens": "100", "x-ratelimit-reset-tokens": "2s" }))
    .mockResolvedValue(message);
  await generateCompletion([], { modelState: {} });
  await generateCompletion([], { modelState: { fallback: true } });
  expect(vi.getTimerCount()).toBe(0);
  expect(sdk.create.mock.calls[1][0].model).toBe("openai/gpt-oss-20b");
});

it("il reset già trascorso non ritarda il successivo turno", async () => {
  vi.useFakeTimers();
  sdk.create.mockImplementationOnce(() => withHeaders({ "x-ratelimit-remaining-tokens": "100", "x-ratelimit-reset-tokens": "2s" }))
    .mockResolvedValue(message);
  await generateCompletion([], { modelState: {} });
  await vi.advanceTimersByTimeAsync(2200);
  await generateCompletion([], { modelState: {} });
  expect(vi.getTimerCount()).toBe(0);
});

it("un logger indisponibile non altera la completion", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => { throw Error("Logger indisponibile"); });
  sdk.create.mockResolvedValue(message);
  expect(await generateCompletion([])).toEqual(message.choices[0].message);
});
