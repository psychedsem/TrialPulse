import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { executeTool } from "../src/toolExecutor.js";
import { orchestrate } from "../src/orchestrator.js";
import { generateCompletion } from "../src/llm.js";

vi.mock("../src/llm.js", () => ({ generateCompletion: vi.fn() }));
const parameters = { attention_threshold_percent: 95, escalation_threshold_percent: 90 };
const args = (group_by = []) => ({ analysis: "completeness_threshold", group_by, parameters });
const call = (input, id = "data") => ({ id, type: "function", function: {
  name: "analyze_operations", arguments: JSON.stringify(input),
} });
const row = { required_assessments_total: 100, missing_assessments_total: 2, completed_assessments_total: 98,
  completeness_rate: 98, classification: "no_action" };
const report = (groups = [], rows = [row], filters = {}) => ({ analysis: "completeness_threshold",
  scope: { study_id: null, site_id: null, participant_id: null, visit_name: null, ...filters, group_by: groups },
  parameters_applied: parameters, results: rows,
  document_support: { comparison: "<", sources: [{ source: "knowledge_base/operations/clinical_operations_sop.md",
    section: "Data completeness", distance: 0.15, similarity: 0.85 }] },
  data_quality: { duplicates_removed: 8, inconsistent_actual_dates: 15, inconsistent_query_rows: 3,
    excluded_records: 0, exclusions_by_reason: {}, warnings: ["Avviso originale."] },
});
let response;
beforeEach(() => {
  response = report();
  generateCompletion.mockReset();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => response })));
});
afterEach(() => vi.unstubAllGlobals());
async function answer(input = args()) {
  generateCompletion.mockResolvedValueOnce({ tool_calls: [call(input)] })
    .mockResolvedValueOnce({ content: "Tutti i siti sono conformi. Testo non verificato." });
  return (await orchestrate("Domanda sui siti")).answer;
}

it.each([undefined, null, "site_id", ["site_id", "site_id"], ["month"], ["visit_name"]])(
  "blocca granularità assente o invalida prima di RAG e Data: %j", async group_by => {
    const input = { ...args(), rule_source: "novera_kb", group_by };
    await expect(executeTool(call(input))).rejects.toThrow(/group_by/);
    expect(fetch).not.toHaveBeenCalled();
  });
it("blocca il replay osservato e consente autocorrezione per sito", async () => {
  response = report(["site_id"], [{ ...row, site_id: "SITE_01" }]);
  generateCompletion.mockResolvedValueOnce({ tool_calls: [call({ analysis: "completeness_threshold", rule_source: "novera_kb" })] })
    .mockResolvedValueOnce({ tool_calls: [call(args(["site_id"]), "corrected")] })
    .mockResolvedValueOnce({ content: "Inferenza impropria." });
  const result = await orchestrate("Quali siti richiedono attenzione o escalation per data completeness secondo Novera?");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetch.mock.calls[0][1].body).group_by).toEqual(["site_id"]);
  expect(result.answer).toContain("SITE_01");
  expect(result.answer).not.toContain("Inferenza impropria");
  expect(JSON.parse(generateCompletion.mock.calls[1][0].at(-1).content).error).toMatch(/group_by/);
});
it("non deduce conformità dei siti dall'aggregato, anche se un sito è sotto soglia", async () => {
  const siteRows = [
    { site_id: "SITE_A", required_assessments_total: 10, missing_assessments_total: 2,
      completed_assessments_total: 8, completeness_rate: 80, classification: "escalation" },
    { site_id: "SITE_B", required_assessments_total: 90, missing_assessments_total: 0,
      completed_assessments_total: 90, completeness_rate: 100, classification: "no_action" },
  ];
  // Stesso totale 100/2/98: il report per sito rende visibile ciò che l'aggregato nasconde.
  const text = await answer();
  expect(text).toContain("98");
  expect(text).toMatch(/sintetici/);
  expect(text).toMatch(/non consente.*singoli siti/i);
  expect(text).not.toContain("Tutti i siti sono conformi");
  expect(text).not.toContain("SITE_");
  response = report(["site_id"], siteRows);
  const perSite = await answer(args(["site_id"]));
  expect(perSite).toContain('Sito: "SITE_A": completeness 80%; classificazione escalation');
  expect(perSite).toContain('Sito: "SITE_B": completeness 100%; classificazione no_action');
});
it.each([
  [["site_id"], { site_id: "SITE_03" }, "sito"],
  [["study_id"], { study_id: "NNR-PSI-01" }, "studio"],
  [["study_id", "site_id"], { study_id: "NNR-PSI-01", site_id: "SITE_03" }, "studio/sito"],
  [["site_id", "study_id"], { study_id: "NNR-PSI-01", site_id: "SITE_03" }, "studio/sito"],
])("preserva raggruppamento e identificativi %j", async (groups, identifiers, label) => {
  response = report(groups, [{ ...row, ...identifiers }]);
  const text = await answer(args(groups));
  expect(text).toContain(label);
  for (const value of Object.values(identifiers)) expect(text).toContain(value);
  expect(text).toContain("gruppi restituiti");
});
it("preserva filtri, KPI, fonti e distinzione dei warning", async () => {
  const filters = { study_id: "NNR-ESK-02", site_id: "SITE_06", visit_name: "Week 6" };
  response = report([], [row], filters);
  const text = await answer({ ...args(), filters });
  for (const value of Object.values(filters)) expect(text).toContain(value);
  for (const value of ["100", "2", "98", "95", "90", "no_action", "Data completeness", "Avviso originale."])
    expect(text).toContain(value);
  expect(text).toMatch(/Duplicati rimossi.*8/);
  expect(text).toMatch(/Date incoerenti segnalate.*15/);
  expect(text).toMatch(/query incoerenti segnalate.*3/);
  expect(text).toMatch(/Record esclusi.*0/);
});
it.each([
  r => { r.scope.group_by = ["study_id"]; },
  r => { delete r.results[0].site_id; },
  r => { delete r.results[0].required_assessments_total; },
  r => { r.results[0].completeness_rate = "98"; },
  r => { r.results[0].classification = "invented"; },
  r => { r.parameters_applied.attention_threshold_percent = 94; },
  r => { r.results = []; },
  r => { r.results.push({ ...r.results[0] }); },
  r => { r.scope.site_id = "SITE_08"; },
  r => { r.document_support.sources = [{}]; },
  r => { delete r.data_quality; },
  r => { delete r.scope.participant_id; },
  r => { r.results[0].completed_assessments_total = 99; },
  r => { r.results[0].completeness_rate = null; },
  r => { r.data_quality.excluded_records = 2; },
  r => { r.parameters_applied.extra = 1; },
  r => { r.document_support.sources = [null]; },
  r => { r.document_support = false; },
  r => { r.analysis = "completeness"; },
])("blocca report incompleti o incoerenti %$", async mutate => {
  response = structuredClone(report(["site_id"], [{ ...row, site_id: "SITE_01" }]));
  mutate(response);
  await expect(executeTool(call(args(["site_id"])))).rejects.toThrow(/report/i);
});
it("blocca un identificativo discordante con il filtro richiesto", async () => {
  response = report(["site_id"], [{ ...row, site_id: "SITE_02" }], { site_id: "SITE_01" });
  await expect(executeTool(call({ ...args(["site_id"]), filters: { site_id: "SITE_01" } })))
    .rejects.toThrow(/Report completeness/);
});
it("presenta esclusioni e motivi originali senza confonderli con anomalie", async () => {
  response.data_quality.excluded_records = 2;
  response.data_quality.exclusions_by_reason = { "Motivo riportato dal servizio": 2 };
  const text = await answer();
  expect(text).toContain("Record esclusi dalla specifica analisi: 2");
  expect(text).toContain('Esclusioni "Motivo riportato dal servizio": 2');
  expect(text).toContain("Date incoerenti segnalate: 15");
});
it("blocca una risposta JSON nulla con un errore controllato", async () => {
  response = null;
  await expect(executeTool(call(args()))).rejects.toThrow(/Report completeness/);
});
it("presenta il denominatore nullo senza inventare una classificazione", async () => {
  response = report([], [{ required_assessments_total: 0, missing_assessments_total: 0,
    completed_assessments_total: 0, completeness_rate: null, classification: null }]);
  const text = await answer();
  expect(text).toContain("non calcolabile");
  expect(text).toContain("non disponibile");
  expect(text).not.toContain("no_action");
});
it("la cache non trasforma una ripetizione identica in report distinti", async () => {
  generateCompletion.mockResolvedValueOnce({ tool_calls: [call(args())] })
    .mockResolvedValueOnce({ tool_calls: [call(args(), "repeat")] })
    .mockResolvedValueOnce({ content: "Testo libero" });
  const result = await orchestrate("Domanda");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(generateCompletion.mock.calls[2][1].allowTools).toBe(false);
  expect(result.answer).not.toMatch(/più report/);
  expect(result.answer).not.toContain("Testo libero");
});
it("la sola ricerca di supporto non rende misto il report analitico", async () => {
  fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ results: [{
    source: "knowledge_base/faq.md", section: "Completeness", text: "Regola", distance: 0.1,
  }] }) });
  const search = { id: "search", type: "function", function: { name: "search_knowledge",
    arguments: JSON.stringify({ query: "Completeness" }) } };
  delete response.document_support;
  generateCompletion.mockResolvedValueOnce({ tool_calls: [search] })
    .mockResolvedValueOnce({ tool_calls: [call(args())] }).mockResolvedValueOnce({ content: "Libero" });
  const result = await orchestrate("Domanda");
  expect(result.answer).toContain("FAQ operative TrialPulse");
  expect(result.answer).not.toMatch(/più report/);
  expect(result.tools_used).toEqual(["search_knowledge", "analyze_operations"]);
});
it("conserva soglie custom senza inventare fonti", async () => {
  delete response.document_support;
  response.parameters_applied = { attention_threshold_percent: 99, escalation_threshold_percent: 97 };
  response.results[0].classification = "attention";
  const text = await answer({ ...args(), parameters: response.parameters_applied });
  expect(text).toContain("99");
  expect(text).toContain("attention");
  expect(text).not.toContain("knowledge_base/");
});
it("presenta separatamente report misti senza sintesi libera", async () => {
  fetch.mockResolvedValueOnce({ ok: true, json: async () => response })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ analysis: "queries", scope: { group_by: [] },
      parameters_applied: {}, results: [{ open_queries: 12 }], data_quality: { warnings: ["Altro avviso"] } }) });
  generateCompletion.mockResolvedValueOnce({ tool_calls: [call(args()), call({ analysis: "queries" }, "queries")] })
    .mockResolvedValueOnce({ content: "Sintesi inventata" });
  const result = await orchestrate("Domanda mista");
  expect(result.answer).toMatch(/report.*separat/i);
  expect(result.answer).toContain("queries");
  expect(result.answer).toContain("open_queries");
  expect(result.answer).toContain("Altro avviso");
  expect(result.answer).not.toContain("Sintesi inventata");
});
it("non sceglie fra due report completeness distinti", async () => {
  const other = report(["site_id"], [{ ...row, site_id: "SITE_01" }]);
  fetch.mockResolvedValueOnce({ ok: true, json: async () => response })
    .mockResolvedValueOnce({ ok: true, json: async () => other });
  generateCompletion.mockResolvedValueOnce({ tool_calls: [call(args()), call(args(["site_id"]), "sites")] })
    .mockResolvedValueOnce({ content: "Sintesi inventata" });
  const result = await orchestrate("Domanda");
  expect(result.answer).toMatch(/report.*separat/i);
  expect(result.answer).toContain("portfolio");
  expect(result.answer).toContain("SITE_01");
});