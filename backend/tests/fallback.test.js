import { afterEach, beforeEach, expect, it, vi } from "vitest";
import request from "supertest";
import { readFileSync } from "node:fs";
import { completenessFixture } from "./fixtures/completeness.js";

const sdk = vi.hoisted(() => ({ create: vi.fn(), options: null }));
vi.mock("groq-sdk", async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, default: vi.fn(function (options) {
    sdk.options = options;
    return { chat: { completions: { create: sdk.create } } };
  }) };
});
vi.mock("../src/config.js", () => ({
  GROQ_API_KEY: "test-placeholder", GROQ_MODEL: "openai/gpt-oss-120b",
  GROQ_FALLBACK_MODEL: "openai/gpt-oss-20b",
  DATA_AGENT_URL: "http://127.0.0.1:8000", RAG_API_URL: "http://127.0.0.1:8001",
}));
import { APIError, RateLimitError } from "groq-sdk";
import { generateCompletion } from "../src/llm.js";
import { orchestrate } from "../src/orchestrator.js";
import { app } from "../src/app.js";
import { dataReport } from "./fixtures/report.js";

const primary = "openai/gpt-oss-120b", fallback = "openai/gpt-oss-20b";
const completion = message => ({ choices: [{ message }] });
const final = (content = "Risposta simulata.") => completion({ role: "assistant", content });
const tool = (name, args, id) => completion({ role: "assistant", content: null,
  tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});
const limited = () => new RateLimitError(429, { message: "Limite simulato" }, undefined, new Headers());
const models = () => sdk.create.mock.calls.map(([payload]) => payload.model);
let fetchMock;
beforeEach(() => {
  sdk.create.mockReset();
  fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [] }) });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

it.each([
  { body: { message: "contenuto privato" }, code: "non_disponibile", type: "non_disponibile", category: "non_disponibile" },
  { body: { message: "risposta finale privata" }, code: "non_disponibile", type: "non_disponibile", category: "non_disponibile" },
  { body: { error: { code: "tool_use_failed", type: "invalid_request_error", message: "contenuto privato",
    failed_generation: "generazione privata" } }, code: "tool_use_failed", type: "invalid_request_error", category: "tool_use_failed" },
  { body: { error: { code: "codice_privato", type: "tipo_privato", message: "contenuto privato" } },
    code: "non_disponibile", type: "non_disponibile", category: "non_disponibile" },
])("registra soltanto la diagnostica ammessa del JSON HTTP400 ricevuto dall'SDK: $code", async ({ body, code, type, category }) => {
  const { default: Groq } = await vi.importActual("groq-sdk");
  const transport = vi.fn(async () => new Response(JSON.stringify(body), {
    status: 400, headers: { "Content-Type": "application/json" },
  }));
  const client = new Groq({ ...sdk.options, fetch: transport });
  sdk.create.mockImplementation(payload => client.chat.completions.create(payload));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const response = await request(app).post("/api/chat").send({ message: "Domanda privata" });
    expect(response.status).toBe(502);
    const log = warn.mock.calls.flat().join(" ");
    expect(log).toContain(`status=400; round=1; code=${code}; type=${type}`);
    expect(log).toContain("model=primary");
    expect(log).toContain(`category=${category}`);
    expect(log).toContain("phase=before_successful_tool");
    expect(log + response.text).not.toMatch(/contenuto privato|risposta finale privata|generazione privata|codice_privato|tipo_privato|Domanda privata|Authorization/);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(models()).toEqual([primary]);
  } finally { warn.mockRestore(); }
});

it("l'errore strutturato dopo un tool riuscito conserva il contesto e il numero completion", async () => {
  fetchMock.mockResolvedValue({ ok: true, json: async () => dataReport("visits", { results: [{ completed_visits: 7 }] }) });
  sdk.create.mockResolvedValueOnce(tool("analyze_operations", { analysis: "visits" }, "verified-id"))
    .mockRejectedValueOnce(APIError.generate(400, { error: { code: "tool_use_failed", type: "invalid_request_error",
      failed_generation: "privato" } }, undefined, new Headers()));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect((await request(app).post("/api/chat").send({ message: "Domanda", history: [
      { role: "user", content: "Contesto privato" }, { role: "assistant", content: "Risposta precedente" },
    ] })).status).toBe(502);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/round=2.*code=tool_use_failed.*model=primary.*phase=after_successful_tool/);
    expect(warn.mock.calls.flat().join(" ")).not.toContain("privato");
    const messages = sdk.create.mock.calls[1][0].messages;
    expect(messages.slice(1, 3)).toEqual([{ role: "user", content: "Contesto privato" }, { role: "assistant", content: "Risposta precedente" }]);
    expect(messages.at(-1).tool_call_id).toBe("verified-id");
    expect(JSON.parse(messages.at(-1).content).results).toEqual([{ completed_visits: 7 }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally { warn.mockRestore(); }
});

it("la diagnostica identifica il fallback quando anche il secondo modello fallisce", async () => {
  sdk.create.mockRejectedValueOnce(limited()).mockRejectedValueOnce(APIError.generate(400,
    { error: { code: "invalid_request", type: "invalid_request_error" } }, undefined, new Headers()));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect((await request(app).post("/api/chat").send({ message: "Domanda" })).status).toBe(502);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/status=400.*round=1.*code=invalid_request.*model=fallback/);
    expect(models()).toEqual([primary, fallback]);
  } finally { warn.mockRestore(); }
});

it("un logger non disponibile non impedisce l'errore HTTP controllato", async () => {
  sdk.create.mockRejectedValue(APIError.generate(400, {}, undefined, new Headers()));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => { throw new Error("logger indisponibile"); });
  try {
    const response = await request(app).post("/api/chat").send({ message: "Domanda" });
    expect(response.status).toBe(502);
    expect(response.body.error).toContain("Non è stato possibile completare");
    expect(response.text).not.toContain("logger indisponibile");
  } finally { warn.mockRestore(); }
});

it("l'SDK serializza i due tool, history e ID senza aggiungere contenuti interni", async () => {
  const { default: Groq } = await vi.importActual("groq-sdk");
  const wire = [];
  const response = tool("analyze_operations", { analysis: "visits", group_by: ["study_id"] }, "wire-id");
  response.choices[0].message.reasoning = "ragionamento privato";
  const transport = vi.fn(async (url, options) => {
    wire.push(JSON.parse(options.body));
    return new Response(JSON.stringify(wire.length === 1 ? response : final("Risultati verificati.")), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  });
  const client = new Groq({ ...sdk.options, fetch: transport });
  sdk.create.mockImplementation(payload => client.chat.completions.create(payload));
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ analysis: "visits",
    scope: { group_by: ["study_id"] }, parameters_applied: {}, data_quality: {}, results: [{ study_id: "NNR-PSI-01", completed_visits: 267 }] }) });
  const history = [{ role: "user", content: "Confronto operativo" }, { role: "assistant", content: "Quale KPI?" }];
  expect((await orchestrate("Visite per studio", history)).tools_used).toEqual(["analyze_operations"]);
  expect(wire).toHaveLength(2);
  expect(wire[0].messages.slice(1, 3)).toEqual(history);
  expect(wire[0].tools.map(item => item.function.name)).toEqual(["search_knowledge", "analyze_operations"]);
  const schema = wire[0].tools[1].function.parameters;
  expect(schema.properties.filters.properties.study_id).toEqual({ type: "string" });
  expect(schema.properties.filters.additionalProperties).toBe(false);
  expect(schema.required).toEqual(["analysis"]);
  expect(JSON.stringify(wire[0].tools)).not.toMatch(/"strict"|"oneOf"|"anyOf"/);
  expect(wire[0]).toMatchObject({ model: primary, tool_choice: "auto", temperature: 0.2,
    max_completion_tokens: 600, reasoning_effort: "low", include_reasoning: false });
  expect(wire[1].messages.at(-2)).toEqual({ role: "assistant", content: null,
    tool_calls: [{ id: "wire-id", type: "function", function: { name: "analyze_operations",
      arguments: '{"analysis":"visits","group_by":["study_id"]}' } }] });
  expect(wire[1].messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "wire-id" });
  expect(JSON.parse(wire[1].messages.at(-1).content).results).toEqual([{ study_id: "NNR-PSI-01", completed_visits: 267 }]);
  expect(JSON.stringify(wire[1].messages)).not.toContain("ragionamento privato");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("un errore tool non viene diagnosticato come tool riuscito prima del rifiuto provider", async () => {
  fetchMock.mockResolvedValue({ ok: false, status: 422, json: async () => ({ detail: [] }) });
  sdk.create.mockResolvedValueOnce(tool("analyze_operations", { analysis: "visits" }, "failed-id"))
    .mockRejectedValueOnce(APIError.generate(400, {}, undefined, new Headers()));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect((await request(app).post("/api/chat").send({ message: "Domanda" })).status).toBe(502);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/round=2.*phase=before_successful_tool/);
    expect(models()).toEqual([primary, primary]);
  } finally { warn.mockRestore(); }
});

it("mantiene il principale quando riesce e disabilita i retry SDK", async () => {
  sdk.create.mockResolvedValue(final());
  expect((await orchestrate("Domanda")).answer).toBe("Risposta simulata.");
  expect(models()).toEqual([primary]);
  expect(sdk.options.maxRetries).toBe(0);
});

it("il client SDK reale con le opzioni di produzione non ripete un HTTP429", async () => {
  const { default: Groq } = await vi.importActual("groq-sdk");
  const transport = vi.fn(async () => new Response(JSON.stringify({ error: { message: "Limite simulato" } }), {
    status: 429, headers: { "Content-Type": "application/json" },
  }));
  const client = new Groq({ ...sdk.options, fetch: transport });
  await expect(client.chat.completions.create({ model: primary, messages: [{ role: "user", content: "Domanda" }] }))
    .rejects.toMatchObject({ status: 429 });
  expect(transport).toHaveBeenCalledTimes(1);
});

it("ripete la prima completion su 20B cambiando soltanto model", async () => {
  sdk.create.mockRejectedValueOnce(limited()).mockResolvedValueOnce(final());
  expect(await orchestrate("Domanda")).toEqual({ answer: "Risposta simulata.", tools_used: [] });
  expect(models()).toEqual([primary, fallback]);
  const [first, second] = sdk.create.mock.calls.map(([payload]) => payload);
  expect(second).toEqual({ ...first, model: fallback });
  expect(second.messages).toBe(first.messages);
  expect(first.tool_choice).toBe("auto");
});

it.each(["search_knowledge", "analyze_operations"])("conserva history, ID e risultato di %s senza rieseguire il tool", async name => {
  const args = name === "search_knowledge" ? { query: "Week 6 PSI" } : { analysis: "visits" };
  const report = name === "search_knowledge" ? { results: [{ text: "Query aging documentato.",
    source: "knowledge_base/faq.md", section: "Quando una query deve essere escalata?", distance: 0.12 }] } : dataReport("visits", { results: [{ value: 154 }] });
  const modelReport = name === "search_knowledge" ? { results: [{ text: "Query aging documentato.",
    title: "FAQ operative TrialPulse", section: "Quando una query deve essere escalata?" }] } : report;
  fetchMock.mockResolvedValue({ ok: true, json: async () => report });
  sdk.create.mockResolvedValueOnce(tool(name, args, "completed-id"))
    .mockRejectedValueOnce(limited()).mockResolvedValueOnce(final());
  const history = [{ role: "user", content: "Studio PSI" }, { role: "assistant", content: "NNR-PSI-01" }];
  expect((await orchestrate("E ora?", history)).tools_used).toEqual([name]);
  expect(models()).toEqual([primary, primary, fallback]);
  const failed = sdk.create.mock.calls[1][0], resumed = sdk.create.mock.calls[2][0];
  expect(resumed).toEqual({ ...failed, model: fallback });
  expect(resumed.messages.slice(1, 3)).toEqual(history);
  expect(resumed.messages.at(-2).tool_calls[0].id).toBe("completed-id");
  expect(resumed.messages.at(-1)).toEqual({ role: "tool", tool_call_id: "completed-id",
    content: JSON.stringify(modelReport) });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("resta sul 20B nella sequenza RAG e Data senza alterare le soglie", async () => {
  const parameters = { attention_threshold_percent: 95, escalation_threshold_percent: 90 };
  const rule = { results: [{ text: "Attenzione <95%; escalation <90%", source: "knowledge_base/operations/clinical_operations_sop.md", section: "Data completeness", distance: 0.1 }] };
  const report = completenessFixture(parameters);
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => rule }).mockResolvedValueOnce({ ok: true, json: async () => report });
  sdk.create.mockRejectedValueOnce(limited())
    .mockResolvedValueOnce(tool("search_knowledge", { query: "completeness" }, "rule-id"))
    .mockResolvedValueOnce(tool("analyze_operations", { analysis: "completeness_threshold", group_by: ["site_id"], parameters }, "data-id"))
    .mockResolvedValueOnce(final());
  expect((await orchestrate("Applica la regola.")).tools_used).toEqual(["search_knowledge", "analyze_operations"]);
  expect(models()).toEqual([primary, fallback, fallback, fallback]);
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ analysis: "completeness_threshold", group_by: ["site_id"], parameters });
  expect(JSON.parse(sdk.create.mock.calls[3][0].messages.at(-1).content)).toEqual(report);
});

it("riparte dal principale per una richiesta successiva", async () => {
  sdk.create.mockRejectedValueOnce(limited()).mockResolvedValueOnce(final()).mockResolvedValueOnce(final());
  await orchestrate("Prima");
  await orchestrate("Seconda");
  expect(models()).toEqual([primary, fallback, primary]);
});

it("conserva il completamento documentale senza rieseguirlo dopo il fallback", async () => {
  const source = "knowledge_base/operations/clinical_operations_sop.md";
  const text = readFileSync(new URL(`../../${source}`, import.meta.url), "utf8")
    .split(/(?=^#{1,6} )/m).find(part => part.startsWith("## Data completeness")).trim();
  fetchMock.mockImplementation(async (url, options) => ({ ok: true, json: async () =>
    url.endsWith("/retrieve") ? { results: [{ source, section: "Data completeness", text, distance: 0.15 }] } : {
      ...completenessFixture(JSON.parse(options.body).parameters),
    },
  }));
  sdk.create.mockResolvedValueOnce(tool("analyze_operations", {
    analysis: "completeness_threshold", group_by: ["site_id"], rule_source: "novera_kb", parameters: {},
  }, "documental-id")).mockRejectedValueOnce(limited()).mockResolvedValueOnce(final());
  expect((await orchestrate("Applica le regole Novera.")).tools_used).toEqual(["analyze_operations"]);
  expect(models()).toEqual([primary, primary, fallback]);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ analysis: "completeness_threshold", group_by: ["site_id"],
    parameters: { attention_threshold_percent: 95, escalation_threshold_percent: 90 } });
  const failed = sdk.create.mock.calls[1][0], resumed = sdk.create.mock.calls[2][0];
  expect(resumed).toEqual({ ...failed, model: fallback });
  const report = JSON.parse(resumed.messages.at(-1).content);
  expect(resumed.messages.at(-1).tool_call_id).toBe("documental-id");
  expect(report.document_support.sources[0]).toEqual({ title: "SOP sintetica - Clinical Operations", section: "Data completeness" });
  expect(report.parameters_applied).toEqual({ attention_threshold_percent: 95, escalation_threshold_percent: 90 });
});

it("isola il fallback anche tra richieste concorrenti", async () => {
  sdk.create.mockImplementation(async payload => {
    if (payload.model === primary && payload.messages.at(-1).content === "Limitata") throw limited();
    return final();
  });
  await Promise.all([orchestrate("Limitata"), orchestrate("Normale")]);
  expect(sdk.create.mock.calls.filter(([p]) => p.messages.at(-1).content === "Normale").map(([p]) => p.model)).toEqual([primary]);
  expect(sdk.create.mock.calls.filter(([p]) => p.messages.at(-1).content === "Limitata").map(([p]) => p.model)).toEqual([primary, fallback]);
});

it.each([429, 500])("termina con errore controllato se il 20B restituisce %i", async status => {
  sdk.create.mockRejectedValueOnce(limited()).mockRejectedValueOnce(new APIError(status, { message: "Errore riservato" }, undefined, new Headers()));
  const response = await request(app).post("/api/chat").send({ message: "Domanda" });
  expect(response.status).toBe(502);
  expect(response.text).not.toContain("riservato");
  expect(models()).toEqual([primary, fallback]);
});

it.each([400, 401, 500, undefined])("non attiva fallback per errore provider diverso da 429: %s", async status => {
  const error = status ? new APIError(status, {}, undefined, new Headers()) : new Error("Timeout simulato");
  sdk.create.mockRejectedValue(error);
  await expect(orchestrate("Domanda")).rejects.toBe(error);
  expect(models()).toEqual([primary]);
});

it("non interpreta come rate limit provider un errore generico con status 429", async () => {
  const error = Object.assign(new Error("Errore non SDK"), { status: 429 });
  sdk.create.mockRejectedValue(error);
  await expect(orchestrate("Domanda")).rejects.toBe(error);
  expect(models()).toEqual([primary]);
});

it("non attiva fallback per una risposta SDK senza message", async () => {
  sdk.create.mockResolvedValue({ choices: [] });
  await expect(orchestrate("Domanda")).rejects.toThrow();
  expect(models()).toEqual([primary]);
});

it.each([
  ["search_knowledge", { query: "Regola" }],
  ["analyze_operations", { analysis: "visits" }],
])("non attiva fallback per errori Node o HTTP429 di %s", async (name, args) => {
  fetchMock.mockResolvedValue({ ok: false, status: 429 });
  sdk.create.mockResolvedValueOnce(tool("analyze_operations", { analysis: "completeness_threshold", group_by: [], parameters: {} }, "invalid-id"))
    .mockResolvedValueOnce(tool(name, args, "service-id"))
    .mockResolvedValueOnce(final());
  await orchestrate("Domanda");
  expect(models()).toEqual([primary, primary, primary]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(JSON.parse(sdk.create.mock.calls[1][0].messages.at(-1).content).error).toContain("Parametri mancanti");
  expect(JSON.parse(sdk.create.mock.calls[2][0].messages.at(-1).content).error).toContain("429");
});

it.each([429, undefined])("non ritenta un errore successivo del 20B: %s", async status => {
  const error = status ? limited() : new Error("Timeout simulato");
  sdk.create.mockRejectedValueOnce(limited())
    .mockResolvedValueOnce(tool("search_knowledge", { query: "Regola" }, "completed-id"))
    .mockRejectedValueOnce(error);
  await expect(orchestrate("Domanda")).rejects.toBe(error);
  expect(models()).toEqual([primary, fallback, fallback]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("mantiene entrambi i risultati già completati quando il fallback arriva tardi", async () => {
  sdk.create.mockResolvedValueOnce(tool("search_knowledge", { query: "Regola" }, "rule-id"))
    .mockResolvedValueOnce(tool("analyze_operations", { analysis: "visits" }, "data-id"))
    .mockRejectedValueOnce(limited()).mockResolvedValueOnce(final());
  expect((await orchestrate("Domanda")).tools_used).toEqual(["search_knowledge", "analyze_operations"]);
  expect(models()).toEqual([primary, primary, primary, fallback]);
  expect(sdk.create.mock.calls[3][0]).toEqual({ ...sdk.create.mock.calls[2][0], model: fallback });
  expect(sdk.create.mock.calls[3][0].messages.filter(m => m.role === "tool").map(m => m.tool_call_id)).toEqual(["rule-id", "data-id"]);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("mantiene quattro round massimi e astensione senza evidenze anche dopo il fallback", async () => {
  sdk.create.mockRejectedValueOnce(limited());
  for (let i = 0; i < 5; i++) sdk.create.mockResolvedValueOnce(tool("search_knowledge", { query: "Ruoli" }, `id-${i}`));
  const result = await orchestrate("Domanda");
  expect(result.answer).toMatch(/risultati verificabili/i);
  expect(fetchMock).toHaveBeenCalledTimes(4);
  expect(models()).toEqual([primary, fallback, fallback, fallback, fallback]);
});

it("preserva la completion finale senza tool nel fallback", async () => {
  sdk.create.mockRejectedValueOnce(limited()).mockResolvedValueOnce(final());
  await generateCompletion([{ role: "user", content: "Concludi" }], { allowTools: false });
  const [first, second] = sdk.create.mock.calls.map(([p]) => p);
  expect(second).toEqual({ ...first, model: fallback });
  expect(second).not.toHaveProperty("tools");
  expect(second).not.toHaveProperty("tool_choice");
});

const recruitmentArgs = { analysis: "recruitment_target", filters: { site_id: "SITE_03" },
  parameters: { threshold_percent: 75, consecutive_months: 2 } };
const recruitmentReport = () => ({
  analysis: "recruitment_target", scope: { study_id: null, site_id: "SITE_03", group_by: [] },
  parameters_applied: { threshold_percent: 75, consecutive_months: 2 },
  results: [
    { study_id: "NNR-PSI-01", site_id: "SITE_03", monthly: [
      ["2026-02", 2, 2, 100, false], ["2026-03", 1, 2, 50, true], ["2026-04", 1, 2, 50, true],
      ["2026-05", 0, 2, 0, true], ["2026-06", 1, 2, 50, true],
    ], trigger_met: true, first_trigger_months: ["2026-03", "2026-04"] },
    { study_id: "NNR-SER-04", site_id: "SITE_03", monthly: [
      ["2026-02", 3, 3, 100, false], ["2026-03", 1, 3, 33.33, true],
      ["2026-04", 1, 3, 33.33, true], ["2026-05", 1, 3, 33.33, true],
    ], trigger_met: true, first_trigger_months: ["2026-03", "2026-04"] },
  ].map(group => ({ ...group, monthly: group.monthly.map(([month, actual_enrolled, target_enrolled,
    achievement_percent, below_threshold]) => ({ month, actual_enrolled, target_enrolled, achievement_percent, below_threshold })) })),
  data_quality: { duplicates_removed: 8, inconsistent_actual_dates: 15, inconsistent_query_rows: 3,
    excluded_records: 0, warnings: ["15 actual_date incoerenti."], exclusions_by_reason: {} },
});
const finalToolError = () => APIError.generate(400, { error: { code: "tool_use_failed",
  type: "invalid_request_error", failed_generation: "generazione riservata" } }, undefined, new Headers());
const recruitmentRules = () => {
  const source = "knowledge_base/operations/deviation_escalation_rules.md";
  const text = readFileSync(new URL(`../../${source}`, import.meta.url), "utf8")
    .split(/(?=^#{1,6} )/m).find(part => part.startsWith("## Altre escalation operative")).trim();
  return [{ source, section: "Altre escalation operative", text, distance: 0.1 }];
};

function fourRecruitmentRounds(reports = [recruitmentReport()], chunks = [], analyses = []) {
  let reportIndex = 0;
  fetchMock.mockImplementation(async url => ({ ok: true, json: async () =>
    url.endsWith("/retrieve") ? { results: chunks } : reports[reportIndex++],
  }));
  for (let i = 0; i < 3; i++) sdk.create.mockResolvedValueOnce(tool("search_knowledge", { query: "Recruitment" }, `rag-${i}`));
  sdk.create.mockResolvedValueOnce(completion({ role: "assistant", content: null, tool_calls: reports.map((report, i) =>
    tool("analyze_operations", { ...recruitmentArgs,
      ...(analyses[i] ? { analysis: analyses[i], parameters: reports[i].parameters_applied } : {}),
      filters: { ...recruitmentArgs.filters, ...(report.scope?.study_id ? { study_id: report.scope.study_id } : {}) },
    }, `report-${i}`).choices[0].message.tool_calls[0]) }));
}

it("recupera nove righe dopo quattro round e HTTP400 finale usando il vero SDK su trasporto simulato", async () => {
  const { default: Groq } = await vi.importActual("groq-sdk");
  const chunks = recruitmentRules(), report = recruitmentReport(), wire = [];
  const replies = [tool("search_knowledge", { query: "Recruitment Novera" }, "rag-0"),
    tool("search_knowledge", { query: "Recruitment SITE_03" }, "rag-1"),
    tool("search_knowledge", { query: "Recruitment PSI SER" }, "rag-2"),
    tool("analyze_operations", recruitmentArgs, "report-0")];
  const transport = vi.fn(async (url, options) => {
    wire.push(JSON.parse(options.body));
    return new Response(JSON.stringify(wire.length <= 4 ? replies[wire.length - 1] : {
      error: { code: "tool_use_failed", type: "invalid_request_error", failed_generation: "generazione riservata" },
    }), { status: wire.length <= 4 ? 200 : 400, headers: { "Content-Type": "application/json" } });
  });
  const client = new Groq({ ...sdk.options, fetch: transport });
  sdk.create.mockImplementation(payload => client.chat.completions.create(payload));
  fetchMock.mockImplementation(async url => ({ ok: true, json: async () =>
    url.endsWith("/retrieve") ? { results: chunks } : report }));
  const history = [{ role: "user", content: "Recruitment SITE_03" }, { role: "assistant", content: "Quale periodo?" }];
  const response = await request(app).post("/api/chat").send({
    message: "Analizza PSI e SER da febbraio a giugno 2026, senza stimare valori mancanti.", history,
  });
  expect(response.status).toBe(200);
  expect(Object.keys(response.body).sort()).toEqual(["answer", "tools_used"]);
  const answer = response.body.answer;
  expect(answer).toMatch(/sintesi generativa non.*disponibile/i);
  expect(answer).toMatch(/perimetro richiesto.*non.*verificat/i);
  expect(answer.split("\n").filter(line => /^\| 2026-/.test(line))).toEqual([
    "| 2026-02 | 2 | 2 | 100 | no |", "| 2026-03 | 1 | 2 | 50 | sì |", "| 2026-04 | 1 | 2 | 50 | sì |",
    "| 2026-05 | 0 | 2 | 0 | sì |", "| 2026-06 | 1 | 2 | 50 | sì |", "| 2026-02 | 3 | 3 | 100 | no |",
    "| 2026-03 | 1 | 3 | 33.33 | sì |", "| 2026-04 | 1 | 3 | 33.33 | sì |", "| 2026-05 | 1 | 3 | 33.33 | sì |",
  ]);
  expect(answer).toContain("2026-06. Nessun valore assegnato.");
  expect(answer.match(/Azione Novera attestata: site review/g)).toHaveLength(2);
  expect(answer).toContain("Regole documentali attestate e applicate");
  expect(answer).toContain("Duplicati rimossi dalla vista analitica: 8");
  expect(answer).toContain("Date incoerenti segnalate: 15. Righe query incoerenti segnalate: 3");
  expect(answer).toContain("Record esclusi dalla specifica analisi: 0");
  expect(answer).toContain("dati sintetici");
  expect(response.text).not.toMatch(/generazione riservata|failed_generation/);
  expect(response.body.tools_used).toEqual(["search_knowledge", "analyze_operations"]);
  expect(wire).toHaveLength(5);
  expect(wire[4]).not.toHaveProperty("tools");
  expect(wire[4].messages.slice(1, 3)).toEqual(history);
  expect(wire[4].messages.filter(m => m.role === "tool").map(m => m.tool_call_id)).toEqual(["rag-0", "rag-1", "rag-2", "report-0"]);
  expect(fetchMock).toHaveBeenCalledTimes(4);
});

it("recupera un report parziale senza inventare gli studi o i mesi assenti", async () => {
  const report = recruitmentReport();
  report.results = [report.results[0]];
  fourRecruitmentRounds([report]);
  sdk.create.mockRejectedValueOnce(finalToolError());
  const result = await orchestrate("Confronta quattro studi per tutto l'anno");
  expect(result.answer).toMatch(/perimetro richiesto.*non.*verificat/i);
  expect(result.answer).not.toMatch(/NNR-SER-04|NNR-ESK-02|NNR-DXB-03|site review/);
  expect(result.answer).toContain("Azione Novera non attestata");
  expect(result.answer).toContain("soltanto i mesi restituiti");
});

it.each(["misto", "invalido", "vuoto", "identificativo_assente", "parametri_assenti", "altro_report"])("non recupera la finale con report %s", async kind => {
  const data = recruitmentReport();
  if (kind === "invalido") delete data.data_quality;
  if (kind === "vuoto") data.results = [];
  if (kind === "identificativo_assente") delete data.results[0].study_id;
  if (kind === "parametri_assenti") delete data.parameters_applied;
  if (kind === "altro_report") data.analysis = "queries";
  const reports = [data];
  if (kind === "misto") reports.push(dataReport("queries", { scope: { study_id: "NNR-PSI-01", group_by: [] }, results: [{ open_queries: 12 }] }));
  fourRecruitmentRounds(reports, recruitmentRules(), kind === "misto" ? ["recruitment_target", "queries"] : []);
  sdk.create.mockRejectedValueOnce(finalToolError());
  if (["invalido", "parametri_assenti", "altro_report"].includes(kind)) {
    const result = await orchestrate("Recruitment e query");
    expect(result.answer).toContain("Non ho ottenuto nessun risultato analitico verificato");
    expect(result.answer).not.toMatch(/2026-|site review|sintesi generativa/);
    expect(sdk.create).toHaveBeenCalledTimes(4);
  } else await expect(orchestrate("Recruitment e query")).rejects.toMatchObject({ status: 400 });
});

it("non recupera un errore finale RAG-only senza report analitici", async () => {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ results: recruitmentRules() }) });
  for (let i = 0; i < 4; i++) sdk.create.mockResolvedValueOnce(tool("search_knowledge", { query: "Recruitment" }, `rag-${i}`));
  sdk.create.mockRejectedValueOnce(finalToolError());
  await expect(orchestrate("Regola recruitment")).rejects.toMatchObject({ status: 400 });
  expect(fetchMock).toHaveBeenCalledTimes(4);
});

it("recupera entrambi i report per studio senza scartarne i risultati", async () => {
  const reports = recruitmentReport().results.map(group => ({ ...recruitmentReport(),
    scope: { study_id: group.study_id, site_id: "SITE_03", group_by: [] }, results: [group],
  }));
  fourRecruitmentRounds(reports);
  sdk.create.mockRejectedValueOnce(finalToolError());
  const result = await orchestrate("Recruitment mensile PSI e SER");
  expect(result.answer).toContain("Report presentati separatamente");
  expect(result.answer.split("\n").filter(line => /^\| 2026-/.test(line))).toHaveLength(9);
  expect(result.answer).toContain("NNR-PSI-01");
  expect(result.answer).toContain("NNR-SER-04");
  expect(result.answer).toContain("2026-06. Nessun valore assegnato.");
});

it("una fonte alterata non attesta site review nel recupero", async () => {
  const chunks = recruitmentRules();
  chunks[0].text = chunks[0].text.replace("site review", "azione inventata");
  fourRecruitmentRounds([recruitmentReport()], chunks);
  sdk.create.mockRejectedValueOnce(finalToolError());
  const result = await orchestrate("Applica la regola Novera");
  expect(result.answer).not.toMatch(/Azione Novera attestata|azione inventata|Regole documentali attestate e applicate/);
  expect(result.answer).toContain("Azione Novera non attestata");
});

it.each(["429", "500", "422", "400_altro", "tipo_senza_code", "non_sdk", "timeout"])("non recupera un errore finale %s", async kind => {
  fourRecruitmentRounds();
  const error = kind === "429" ? limited() : ["500", "422"].includes(kind) ? APIError.generate(Number(kind),
    { error: { code: "tool_use_failed" } }, undefined, new Headers()) : kind === "400_altro" ? APIError.generate(400,
    { error: { code: "invalid_request", type: "invalid_request_error" } }, undefined, new Headers()) :
    kind === "tipo_senza_code" ? APIError.generate(400, { error: { type: "tool_use_failed" } }, undefined, new Headers()) :
    kind === "non_sdk" ? Object.assign(new Error("Errore locale"), { status: 400, code: "tool_use_failed" }) : new Error("Timeout");
  sdk.create.mockRejectedValueOnce(error);
  if (kind === "429") sdk.create.mockRejectedValueOnce(limited());
  await expect(orchestrate("Recruitment")).rejects.toThrow();
  expect(sdk.create).toHaveBeenCalledTimes(kind === "429" ? 6 : 5);
});

it("recupera il rifiuto finale del fallback senza nuovi tentativi o riesecuzione dei tool", async () => {
  fourRecruitmentRounds();
  sdk.create.mockRejectedValueOnce(limited()).mockRejectedValueOnce(finalToolError());
  const result = await orchestrate("Recruitment");
  expect(result.answer).toMatch(/sintesi generativa non.*disponibile/i);
  expect(result.answer.split("\n").filter(line => /^\| 2026-/.test(line))).toHaveLength(9);
  expect(models()).toEqual([primary, primary, primary, primary, primary, fallback]);
  const original = sdk.create.mock.calls[4][0], resumed = sdk.create.mock.calls[5][0];
  expect(resumed).toEqual({ ...original, model: fallback });
  expect(resumed).not.toHaveProperty("tools");
  expect(fetchMock).toHaveBeenCalledTimes(4);
});

it("non recupera un HTTP400 intermedio anche con un report recruitment valido", async () => {
  fetchMock.mockResolvedValue({ ok: true, json: async () => recruitmentReport() });
  sdk.create.mockResolvedValueOnce(tool("analyze_operations", recruitmentArgs, "report"))
    .mockRejectedValueOnce(finalToolError());
  await expect(orchestrate("Recruitment")).rejects.toMatchObject({ status: 400 });
  expect(sdk.create).toHaveBeenCalledTimes(2);
});