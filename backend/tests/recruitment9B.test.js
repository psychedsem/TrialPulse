import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../src/llm.js", () => ({ generateCompletion: vi.fn() }));
import { generateCompletion } from "../src/llm.js";
import { executeTool } from "../src/toolExecutor.js";
import { TOOLS } from "../src/tools.js";
import { orchestrate } from "../src/orchestrator.js";
import request from "supertest";
import { app } from "../src/app.js";

const tool = (args, id) => ({
  role: "assistant", content: null, tool_calls: [{
    id, type: "function", function: { name: "analyze_operations", arguments: JSON.stringify(args) },
  }],
});
const final = content => ({ role: "assistant", content });
const toolCall = (args, id) => tool(args, id).tool_calls[0];
const baseArgs = { analysis: "recruitment_target", filters: { site_id: "SITE_03" },
  parameters: { threshold_percent: 75, consecutive_months: 2 } };
const monthly = [{ study_id: "NNR-PSI-01", site_id: "SITE_03", monthly: [
  { month: "2026-03", actual_enrolled: 1, target_enrolled: 2, achievement_percent: 50, below_threshold: true },
], trigger_met: false, first_trigger_months: null }];
const monthlyReport = { analysis: "recruitment_target",
  scope: { study_id: null, site_id: "SITE_03", participant_id: null, visit_name: null, group_by: [] },
  parameters_applied: { threshold_percent: 75, consecutive_months: 2 }, results: monthly,
  data_quality: { duplicates_removed: 8, inconsistent_actual_dates: 15, inconsistent_query_rows: 3,
    excluded_records: 0, warnings: [], exclusions_by_reason: {} },
};
let fetchMock;

beforeEach(() => {
  vi.resetAllMocks();
  fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({
    ...monthlyReport,
  }) });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

it("lo schema espone soltanto filtri scalari e raggruppamenti tipizzati", () => {
  const schema = TOOLS.find(tool => tool.function.name === "analyze_operations").function.parameters;
  expect(schema.properties.filters.properties).toEqual({ study_id: { type: "string" }, site_id: { type: "string" },
    participant_id: { type: "string" }, visit_name: { type: "string" } });
  expect(schema.properties.filters.additionalProperties).toBe(false);
  expect(schema.properties.group_by.items.enum).toEqual(["site_id", "study_id", "visit_name", "month"]);
  expect(TOOLS.map(tool => tool.function.name)).toEqual(["search_knowledge", "analyze_operations"]);
});

it.each([
  { study_id: ["NNR-PSI-01", "NNR-SER-04"] }, { site_id: 3 },
  { site_id: { value: "SITE_03" } }, { arbitrary: "x" }, [], null,
].map(filters => ({ filters })))("rifiuta filtri incompatibili prima dell'HTTP: %j", async ({ filters }) => {
  await expect(executeTool(toolCall({ ...baseArgs, filters }, "bad"))).rejects.toThrow(/filtr/i);
  expect(fetchMock).not.toHaveBeenCalled();
});

it("preserva filtri scalari e null opzionali", async () => {
  const filters = { study_id: "NNR-PSI-01", site_id: "SITE_03", participant_id: null };
  await executeTool(toolCall({ analysis: "visits", filters }, "ok"));
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).filters).toEqual(filters);
});

it.each([["month"], ["study_id", "study_id"], "study_id", ["unknown"]].map(group_by => ({ group_by })))(
  "rifiuta group_by non supportato per visits: %j", async ({ group_by }) => {
    await expect(executeTool(toolCall({ analysis: "visits", group_by }, "bad"))).rejects.toThrow(/raggrupp|group_by/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

it("consente il raggruppamento mensile recruitment previsto da Python", async () => {
  await executeTool(toolCall({ analysis: "recruitment", group_by: ["study_id", "month"] }, "ok"));
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).group_by).toEqual(["study_id", "month"]);
});

it("rifiuta i filtri non applicabili a recruitment_target", async () => {
  await expect(executeTool(toolCall({ ...baseArgs, filters: { participant_id: "P1" } }, "bad"))).rejects.toThrow(/filtr/i);
  expect(fetchMock).not.toHaveBeenCalled();
});

it("la diagnostica provider conserva round/status/code/type senza payload privati", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  generateCompletion.mockResolvedValueOnce(tool(baseArgs, "a")).mockRejectedValueOnce(Object.assign(
    new Error("prompt privato e failed_generation"), { status: 400,
      error: { code: "tool_use_failed", type: "invalid_request_error", failed_generation: "contenuto privato" } }));
  const res = await request(app).post("/api/chat").send({ message: "Dettaglio recruitment" });
  expect(res.status).toBe(502);
  const log = warn.mock.calls.flat().join(" ");
  expect(log).toMatch(/status=400/);
  expect(log).toMatch(/code=tool_use_failed/);
  expect(log).toMatch(/type=invalid_request_error/);
  expect(log).toMatch(/round=2/);
  expect(log).not.toMatch(/prompt privato|failed_generation|contenuto privato/);
  expect(res.text).not.toMatch(/tool_use_failed|invalid_request_error/);
  warn.mockRestore();
});

it("recruitment_target rifiuta group_by non vuoto prima dell'HTTP", async () => {
  await expect(executeTool(toolCall({ ...baseArgs, group_by: ["site_id"] }, "bad"))).rejects.toThrow(/ometti group_by/i);
  expect(fetchMock).not.toHaveBeenCalled();
});

it("recruitment_target accetta l'assenza di group_by e l'array vuoto", async () => {
  await executeTool(toolCall(baseArgs, "a"));
  await executeTool(toolCall({ ...baseArgs, group_by: [] }, "b"));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(baseArgs);
});

it("conserva il dettaglio HTTP400 leggibile e controllato", async () => {
  fetchMock.mockResolvedValueOnce({ ok: false, status: 400,
    json: async () => ({ detail: "Filtro visit_name non valido" }) });
  const result = await executeTool(toolCall(baseArgs, "a"));
  expect(result.error).toContain("HTTP 400");
  expect(result.error).toContain("Filtro visit_name non valido");
});

it("non propaga un dettaglio HTTP400 con contenuto riservato", async () => {
  fetchMock.mockResolvedValueOnce({ ok: false, status: 400,
    json: async () => ({ detail: "Traceback: token segreto\nNon esporre" }) });
  const result = await executeTool(toolCall(baseArgs, "a"));
  expect(result.error).toContain("HTTP 400");
  expect(result.error).not.toMatch(/Traceback|token segreto|Non esporre/);
});

it("replay HTTP400 poi200: i risultati restano nel contesto e la finale non chiama altri tool", async () => {
  fetchMock.mockResolvedValueOnce({ ok: false, status: 400,
    json: async () => ({ detail: "Filtro visit_name non valido" }) })
    .mockResolvedValueOnce({ ok: true, json: async () => monthlyReport })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ ...monthlyReport,
      scope: { ...monthlyReport.scope, study_id: "NNR-PSI-01" } }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ ...monthlyReport,
      scope: { ...monthlyReport.scope, study_id: "NNR-SER-04" },
      results: monthly.map(row => ({ ...row, study_id: "NNR-SER-04" })) }) });
  generateCompletion.mockResolvedValueOnce(tool({ ...baseArgs, filters: { site_id: "SITE_INESISTENTE" } }, "a"))
    .mockResolvedValueOnce(tool(baseArgs, "b"))
    .mockResolvedValueOnce(tool({ ...baseArgs, filters: { ...baseArgs.filters, study_id: "NNR-PSI-01" } }, "c"))
    .mockResolvedValueOnce(tool({ ...baseArgs, filters: { ...baseArgs.filters, study_id: "NNR-SER-04" } }, "d"))
    .mockResolvedValueOnce(final("Risultati mensili verificati."));
  const result = await orchestrate("Quali sono i valori mensili?", [
    { role: "user", content: "Reclutamento SITE_03" },
    { role: "assistant", content: "PSI e SER richiedono review." },
  ]);
  expect(result.answer).toContain("| 2026-03 | 1 | 2 | 50 | sì |");
  expect(result.answer).toContain("NNR-SER-04");
  expect(fetchMock).toHaveBeenCalledTimes(4);
  expect(generateCompletion).toHaveBeenCalledTimes(5);
  expect(generateCompletion.mock.calls[4][1].allowTools).toBe(false);
  const priorMessages = generateCompletion.mock.calls[4][0];
  expect(priorMessages.filter(x => x.role === "tool")).toHaveLength(4);
  expect(JSON.parse(priorMessages.find(x => x.tool_call_id === "a").content).error).toContain("HTTP 400");
  expect(JSON.parse(priorMessages.find(x => x.tool_call_id === "b").content).results).toEqual(monthly);
  expect(priorMessages.slice(1,3)).toEqual([
    { role: "user", content: "Reclutamento SITE_03" },
    { role: "assistant", content: "PSI e SER richiedono review." },
  ]);
});

it("espone soltanto campi e tipi approvati degli errori strutturati HTTP422", async () => {
  fetchMock.mockResolvedValueOnce({ ok: false, status: 422,
    json: async () => ({ detail: [
      { loc: ["body", "parameters"], type: "dict_type", msg: "messaggio privato", input: "dato sensibile" },
      { loc: ["body", "group_by", 0], type: "enum", input: "nome segreto" },
    ] }) });
  const result = await executeTool(toolCall(baseArgs, "a"));
  expect(result.error).toContain("HTTP 422");
  expect(result.error).toContain("body.parameters (dict_type)");
  expect(result.error).toContain("body.group_by (enum)");
  expect(result.error).not.toMatch(/messaggio privato|dato sensibile|nome segreto/);
});

it("non propaga nomi di campi sconosciuti o valori contenuti nei dettagli HTTP422", async () => {
  fetchMock.mockResolvedValueOnce({ ok: false, status: 422,
    json: async () => ({ detail: [
      { loc: ["body", "filters", "credenziale_supersegreta"], type: "extra_forbidden", input: "valore_segreto" },
    ] }) });
  const result = await executeTool(toolCall(baseArgs, "a"));
  expect(result.error).toContain("body.filters (extra_forbidden)");
  expect(result.error).not.toMatch(/credenziale_supersegreta|valore_segreto/);
});

it("non propaga dettagli liberi o codici 422 non riconosciuti", async () => {
  fetchMock.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ detail: "contenuto riservato" }) })
    .mockResolvedValueOnce({ ok: false, status: 422, json: async () => ({ detail: [
      { loc: ["body", "filters"], type: "credenziale_privata", input: "privato" },
    ] }) });
  const first = await executeTool(toolCall(baseArgs, "a"));
  const second = await executeTool(toolCall(baseArgs, "b"));
  expect(first.error).not.toContain("contenuto riservato");
  expect(second.error).not.toContain("credenziale_privata");
  expect(second.error).toContain("body.filters (invalid)");
});

it("quattro round con solo supporto RAG e analisi rifiutate non pubblicano KPI inventati", async () => {
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ results: [
    { source: "knowledge_base/operations/deviation_escalation_rules.md", text: "Regola recruitment documentale", section: "Recruitment", distance: 0.1 },
  ] }) }).mockResolvedValue({ ok: false, status: 422, json: async () => ({ detail: [] }) });
  generateCompletion.mockResolvedValueOnce({ tool_calls: [{ id: "rag", type: "function", function: {
    name: "search_knowledge", arguments: JSON.stringify({ query: "Recruitment Novera" }),
  } }] });
  for (let i = 0; i < 3; i++) generateCompletion.mockResolvedValueOnce(tool(baseArgs, `bad${i}`));
  generateCompletion.mockResolvedValueOnce(final("PSI 99%: calcolo completato."));
  const result = await orchestrate("Recruitment mensile SITE_03");
  expect(result.answer).toMatch(/nessun risultato analitico verificato/i);
  expect(result.answer).not.toContain("99%");
  expect(generateCompletion).toHaveBeenCalledTimes(4);
});

it("un errore senza report impedisce una finale numerica non verificata anche prima del limite", async () => {
  fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({ detail: "Filtri inesistenti o incompatibili nel perimetro richiesto." }) });
  generateCompletion.mockResolvedValueOnce(tool(baseArgs, "a")).mockResolvedValueOnce(final("PSI 99%"));
  const result = await orchestrate("Recruitment mensile SITE_03");
  expect(result.answer).toMatch(/nessun risultato analitico verificato/i);
  expect(result.answer).not.toContain("99%");
});