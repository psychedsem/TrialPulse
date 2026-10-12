import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { orchestrate } from "../src/orchestrator.js";
import { generateCompletion } from "../src/llm.js";
import { completenessFixture } from "./fixtures/completeness.js";
import { readFileSync } from "node:fs";

vi.mock("../src/llm.js", () => ({ generateCompletion: vi.fn() }));
const source = "knowledge_base/operations/clinical_operations_sop.md";
const chunk = (overrides = {}) => ({ source, section: "Data completeness", text: "Testo recuperato",
  distance: 0.15, similarity: 0.85, id: "diagnostic-id", ...overrides });
const call = (name, args, id = name) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const parameters = { attention_threshold_percent: 95, escalation_threshold_percent: 90 };
beforeEach(() => { generateCompletion.mockReset(); vi.stubGlobal("fetch", vi.fn()); });
afterEach(() => vi.unstubAllGlobals());
async function run(tools, results, content = "Risposta del modello.", message = "Domanda") {
  for (const result of results) fetch.mockResolvedValueOnce({ ok: true, json: async () => result });
  generateCompletion.mockResolvedValueOnce({ tool_calls: tools }).mockResolvedValueOnce({ content });
  return orchestrate(message);
}
const search = () => call("search_knowledge", { query: "Regola" });
const analyze = () => call("analyze_operations", { analysis: "completeness_threshold", group_by: ["site_id"], parameters });

it("RAG-only presenta documenti consultati, non regole applicate o dati analizzati", async () => {
  const result = await run([search()], [{ results: [chunk(), chunk()] }]);
  expect(result.answer).toContain("Documenti Novera consultati");
  expect(result.answer).toContain("SOP sintetica - Clinical Operations");
  expect(result.answer).toContain("Data completeness");
  expect(result.answer).not.toMatch(/Regole documentali attestate|CSV operativo|knowledge_base\/|distance|similarity|diagnostic-id/);
  expect(result.answer.match(/SOP sintetica - Clinical Operations/g)).toHaveLength(1);
  expect(result.answer).toContain("non attesta ogni affermazione");
  const internal = JSON.parse(generateCompletion.mock.calls[1][0].at(-1).content);
  expect(internal.results[0].title).toBe("SOP sintetica - Clinical Operations");
  expect(internal.results[0]).not.toHaveProperty("distance");
  expect(internal.results[0]).not.toHaveProperty("id");
});

it("Data-only identifica il CSV sintetico soltanto dopo un report riuscito", async () => {
  const result = await run([call("analyze_operations", { analysis: "portfolio_summary" })], [{
    analysis: "portfolio_summary", scope: { group_by: [] }, parameters_applied: {}, data_quality: {}, results: [{ screened: 194, enrolled: 154 }],
  }]);
  expect(result.answer).toContain("CSV operativo TrialPulse (dati sintetici)");
  expect(result.answer).not.toMatch(/Documenti Novera|Regole documentali/);
  expect(result.tools_used).toEqual(["analyze_operations"]);
});

it("un chiarimento ESK con sola ricerca documentale non attesta analisi del CSV", async () => {
  const faq = readFileSync(new URL("../../knowledge_base/faq.md", import.meta.url), "utf8")
    .split("## Quando una query")[0].split("## Qual è la finestra della Week 6?")[1];
  const result = await run([search()], [{ results: [chunk({ source: "knowledge_base/faq.md",
    section: "Qual è la finestra della Week 6?", text: `## Qual è la finestra della Week 6?${faq}`.trim() })] }],
    JSON.stringify({ schedule_facts: [{ study_id: "NNR-ESK-02", visit_name: "Week 6", window_days: 2,
      source: "knowledge_base/faq.md", section: "Qual è la finestra della Week 6?" }] }), "Mi riferisco allo studio NNR-ESK-02.");
  expect(result.tools_used).toEqual(["search_knowledge"]);
  expect(result.answer).toContain("±2 giorni");
  expect(result.answer).toContain("Documenti Novera consultati");
  expect(result.answer).not.toMatch(/Dati analizzati|CSV operativo|Regole documentali attestate/);
});

it("il CSV è attestato se il modello esegue realmente un'analisi anche per una domanda documentale", async () => {
  const result = await run([call("analyze_operations", { analysis: "visits", filters: { study_id: "NNR-ESK-02" } })],
    [{ analysis: "visits", scope: { study_id: "NNR-ESK-02" }, parameters_applied: {}, data_quality: {}, results: [{ completed_visits: 377 }] }],
    "Analisi delle visite disponibile.", "Mi riferisco allo studio NNR-ESK-02.");
  expect(result.tools_used).toEqual(["analyze_operations"]);
  expect(result.answer).toContain("Dati analizzati");
  expect(result.answer).toContain("CSV operativo TrialPulse (dati sintetici)");
  expect(result.answer).not.toContain("Regole documentali attestate");
});

it("RAG poi Data conserva la ricerca come consultazione senza attestazione automatica", async () => {
  const report = completenessFixture(parameters);
  const result = await run([search(), analyze()], [{ results: [chunk()] }, report]);
  expect(result.answer).toContain("Documenti Novera consultati");
  expect(result.answer).toContain("CSV operativo TrialPulse");
  expect(result.answer).not.toContain("Regole documentali attestate");
  expect(result.answer).toContain("nessuna fonte documentale attestata nel report");
});

it("completeness usa il supporto attestato senza duplicare la stessa consultazione", async () => {
  const report = completenessFixture(parameters);
  report.document_support = { comparison: "<", sources: [chunk(), chunk()] };
  const result = await run([search(), analyze()], [{ results: [chunk()] }, report], "Citazione inventata");
  expect(result.answer).toContain("Regole documentali attestate e applicate");
  expect(result.answer.match(/SOP sintetica - Clinical Operations/g)).toHaveLength(1);
  expect(result.answer).not.toMatch(/Citazione inventata|knowledge_base\/|distance|similarity|document_support/);
  expect(result.answer).toContain("SITE_01");
  expect(result.answer).toContain("96.78");
  expect(result.answer).toContain("Record esclusi dalla specifica analisi: 0");
});

it("separa fonti attestate e altri documenti realmente consultati", async () => {
  const report = completenessFixture(parameters);
  report.document_support = { comparison: "<", sources: [chunk()] };
  const result = await run([search(), analyze()], [{ results: [chunk({ source: "knowledge_base/faq.md", section: "Quando la completeness è problematica?" })] }, report]);
  expect(result.answer).toContain("FAQ operative TrialPulse");
  expect(result.answer).toContain("Documenti Novera consultati");
  expect(result.answer).toContain("Regole documentali attestate e applicate");
});

it.each([
  [{ source, text: "Testo", distance: 0.2 }, "Sezione non disponibile"],
  [{ source, section: "", text: "Testo", distance: 0.2 }, "Sezione non disponibile"],
])("non inventa una sezione mancante %j", async (entry, expected) => {
  const result = await run([search()], [{ results: [entry] }]);
  expect(result.answer).toContain(expected);
  expect(result.answer).not.toContain("Data completeness");
});

it.each([[], [{ text: "Testo", distance: 0.2 }], [{ source: "../../AGENTS.md", section: "Interno", text: "Testo", distance: 0.2 }]])(
  "non inventa riferimenti con fonti assenti o non identificabili %j", async results => {
    const result = await run([search()], [{ results }]);
    expect(result.answer).not.toMatch(/SOP sintetica|FAQ operative|Interno|AGENTS|CSV operativo/);
  });

it("nessuna fonte è attribuita a tool falliti", async () => {
  const result = await run([search(), call("analyze_operations", { analysis: "queries" })], [{ error: "RAG indisponibile" }, { error: "Data indisponibile" }]);
  expect(result.answer).toContain("Non ho ottenuto nessun risultato analitico verificato");
  expect(result.answer).not.toMatch(/Documenti Novera|Regole documentali|CSV operativo|Risposta del modello/);
});

it("preserva la prosa generativa senza fingere di aver verificato le sue citazioni", async () => {
  const text = "Citazione libera non verificata: documento inesistente.";
  const result = await run([search()], [{ results: [chunk()] }], text);
  expect(result.answer.startsWith(text)).toBe(true);
  expect(result.answer).toContain("non attesta ogni affermazione");
});

it("la vista RAG del modello usa titoli e sezioni senza identificativi o percorsi tecnici", async () => {
  await run([search()], [{ results: [chunk({ metadata: { diagnostic: "privato" } })] }]);
  const view = JSON.parse(generateCompletion.mock.calls[1][0].at(-1).content);
  expect(view.results).toEqual([{ text: "Testo recuperato", title: "SOP sintetica - Clinical Operations", section: "Data completeness" }]);
  expect(JSON.stringify(view)).not.toMatch(/diagnostic-id|knowledge_base|distance|similarity|metadata|privato/);
});

it("le fonti del report viste dal modello non espongono metadati tecnici", async () => {
  const report = { analysis: "queries", scope: { group_by: [] }, results: [{ open_queries: 12 }], parameters_applied: {},
    data_quality: {},
    document_support: { action: "Review documentata", sources: [chunk()] } };
  const result = await run([call("analyze_operations", { analysis: "queries" })], [report]);
  const view = JSON.parse(generateCompletion.mock.calls[1][0].at(-1).content);
  expect(view.results).toEqual([{ open_queries: 12 }]);
  expect(view.document_support.sources).toEqual([{ title: "SOP sintetica - Clinical Operations", section: "Data completeness" }]);
  expect(view.document_support.action).toBe("Review documentata");
  expect(result.answer).toContain("Regole documentali attestate e applicate");
});

it("non presenta una sezione non presente nel documento verificato", async () => {
  const result = await run([search()], [{ results: [chunk({ section: "diagnostic-section-secret" })] }]);
  expect(result.answer).not.toContain("diagnostic-section-secret");
  expect(result.answer).toContain("Sezione non disponibile");
});

it("il recruitment separa prescrizioni attestate e suggerimenti non vincolanti", async () => {
  const report = { analysis: "recruitment_target", scope: { site_id: "SITE_03", group_by: [] },
    parameters_applied: { threshold_percent: 75, consecutive_months: 2 }, data_quality: {}, results: [{ study_id: "NNR-PSI-01", site_id: "SITE_03", trigger_met: true }] };
  const result = await run([call("analyze_operations", { analysis: "recruitment_target", parameters: report.parameters_applied })], [report]);
  expect(result.answer).toMatch(/suggerimenti operativi non vincolanti/i);
  expect(result.answer).not.toContain("Regole documentali attestate e applicate");
});

it("i report misti non espongono il supporto tecnico nella copia presentata", async () => {
  const other = { analysis: "queries", scope: { group_by: [] }, parameters_applied: {}, results: [{ open_queries: 12 }],
    document_support: { action: "Azione interna", sources: [chunk()] }, data_quality: { warnings: ["Avviso originale"] } };
  const result = await run([analyze(), call("analyze_operations", { analysis: "queries" }, "other")], [completenessFixture(parameters), other]);
  expect(result.answer).not.toMatch(/document_support|distance|similarity|Azione interna/);
  expect(result.answer).toContain("12");
  expect(result.answer).toContain("Avviso originale");
  expect(JSON.parse(generateCompletion.mock.calls[1][0].at(-1).content).document_support.action).toBe("Azione interna");
});