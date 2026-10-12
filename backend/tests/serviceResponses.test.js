import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { executeTool } from "../src/toolExecutor.js";

const call = (name = "analyze_operations") => ({ id: "response", function: { name,
  arguments: JSON.stringify(name === "search_knowledge" ? { query: "Regola" } : { analysis: "portfolio_summary" }) } });
const report = { analysis: "portfolio_summary", scope: { study_id: null, site_id: null,
  participant_id: null, visit_name: null, group_by: [] }, parameters_applied: {},
  results: [{ screened_participants: 194, enrolled_participants: 154 }],
  data_quality: { duplicates_removed: 8, inconsistent_actual_dates: 15, inconsistent_query_rows: 3,
    excluded_records: 0, warnings: [], exclusions_by_reason: {} } };
beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each([[400, false], [400, true], [422, false], [422, true]])("preserva HTTP%s anche se il logger fallisce: %s", async (status, fails) => {
  vi.spyOn(console, "warn").mockImplementation(() => { if (fails) throw Error("logger privato"); });
  fetch.mockResolvedValue({ ok: false, status, json: async () => ({ detail: [
    { loc: ["body", "filters"], type: "dict_type", input: "dato privato" } ] }) });
  const result = await executeTool(call());
  expect(result.error).toContain(`HTTP ${status}`);
  expect(result.error).toContain("body.filters (dict_type)");
  expect(result.error).not.toMatch(/privato|non disponibile/);
});

it.each([null, [], 12, "testo", true, {}, { results: [] },
  { ...report, analysis: "visits" }, { ...report, scope: null },
  { ...report, parameters_applied: [] }, { ...report, results: null },
  { ...report, results: [null] }, { ...report, data_quality: null },
  { ...report, error: "dato privato" },
])("rifiuta un envelope analitico non valido senza TypeError: %j", async value => {
  fetch.mockResolvedValue({ ok: true, json: async () => value });
  await expect(executeTool(call())).resolves.toEqual({ error: "Risposta non valida del servizio Data Agent. Nessun risultato ottenuto." });
});

it.each([report, { ...report, results: [] }])("preserva il report valido, anche senza gruppi: %j", async value => {
  fetch.mockResolvedValue({ ok: true, json: async () => value });
  expect(await executeTool(call())).toEqual(value);
});

it.each([null, [], 3, {}, { results: null }])("rifiuta envelope RAG non validi: %j", async value => {
  fetch.mockResolvedValue({ ok: true, json: async () => value });
  await expect(executeTool(call("search_knowledge"))).resolves.toEqual({ error: "Risposta non valida del servizio RAG. Nessun risultato ottenuto." });
});

it("preserva una risposta RAG vuota valida", async () => {
  fetch.mockResolvedValue({ ok: true, json: async () => ({ results: [] }) });
  expect(await executeTool(call("search_knowledge"))).toEqual({ results: [] });
});

it("un envelope mancante non permette al backend di pubblicare KPI inventati", async () => {
  fetch.mockResolvedValue({ ok: true, json: async () => ({ results: [{ invented: 999 }] }) });
  const result = await executeTool(call());
  expect(result).toHaveProperty("error");
  expect(JSON.stringify(result)).not.toMatch(/invented|999|TypeError/);
});