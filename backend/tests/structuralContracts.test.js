import { afterEach, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { dataReport } from "./fixtures/report.js";

const provider = vi.hoisted(() => vi.fn());
vi.mock("../src/llm.js", () => ({ generateCompletion: provider }));
import { orchestrate } from "../src/orchestrator.js";
import { executeTool } from "../src/toolExecutor.js";

let previousOrchestrate, previousTool;
if (process.env.TRIALPULSE_COMPARISON_ROOT) {
  const directory = resolve(process.env.TRIALPULSE_COMPARISON_ROOT, "backend/src");
  vi.doMock(resolve(directory, "llm.js"), () => ({ generateCompletion: provider }));
  previousOrchestrate = (await import(pathToFileURL(resolve(directory, "orchestrator.js")).href)).orchestrate;
  previousTool = (await import(pathToFileURL(resolve(directory, "toolExecutor.js")).href)).executeTool;
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const call = (name, args, id) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const rag = id => ({ role: "assistant", content: null, tool_calls: [call("search_knowledge", { query: "Ruoli" }, id)] });
const data = (args, id) => ({ role: "assistant", content: null, tool_calls: [call("analyze_operations", args, id)] });
const final = { role: "assistant", content: "Risposta generale verificata." };
const knowledge = { results: [{ source: "knowledge_base/faq.md", section: "Quando una query deve essere escalata?",
  text: "Regola documentale generale.", distance: 0.1 }] };
const report = dataReport("portfolio_summary", { results: [{ screened_participants: 194, enrolled_participants: 154 }],
  extra_internal: "non destinato al modello", data_quality: { duplicates_removed: 8, inconsistent_actual_dates: 15,
    inconsistent_query_rows: 3, excluded_records: 0, warnings: [], exclusions_by_reason: {}, physical_rows: 1508 } });

const scenarios = [
  { name: "finale senza tool", replies: [final], responses: [], completions: 1, requests: 0 },
  { name: "RAG riuscito", replies: [rag("rag_a"), final], responses: [knowledge], completions: 2, requests: 1 },
  { name: "RAG vuoto", replies: [rag("rag_empty"), final], responses: [{ results: [] }], completions: 2, requests: 1 },
  { name: "report Data e proiezione per il modello", replies: [data({ analysis: "portfolio_summary" }, "data_a"), final],
    responses: [report], completions: 2, requests: 1 },
  { name: "sequenza RAG e Data", replies: [rag("rag_a"), data({ analysis: "portfolio_summary" }, "data_a"), final],
    responses: [knowledge, report], completions: 3, requests: 2 },
  { name: "cache con ordine diverso degli argomenti", replies: [data({ analysis: "portfolio_summary", filters: { site_id: "SITE_03" } }, "data_a"),
    data({ filters: { site_id: "SITE_03" }, analysis: "portfolio_summary" }, "data_b"), final],
    responses: [report], completions: 3, requests: 1 },
  { name: "due tool nello stesso round", replies: [{ role: "assistant", content: null,
    tool_calls: [call("search_knowledge", { query: "Ruoli" }, "rag_a"), call("analyze_operations", { analysis: "portfolio_summary" }, "data_a")] }, final],
    responses: [knowledge, report], completions: 2, requests: 2 },
  { name: "quattro round e finale", replies: [...Array.from({ length: 4 }, (_, i) => rag(`rag_${i}`)), final],
    responses: Array(4).fill(knowledge), completions: 5, requests: 4 },
  { name: "quattro round vuoti senza quinta completion", replies: Array.from({ length: 4 }, (_, i) => rag(`rag_${i}`)),
    responses: Array(4).fill({ results: [] }), completions: 4, requests: 4 },
  { name: "tool respinto nella finale forzata", replies: [...Array.from({ length: 4 }, (_, i) => rag(`rag_${i}`)), rag("vietato")],
    responses: Array(4).fill(knowledge), completions: 5, requests: 4, error: "risposta finale" },
];

async function replay(run, scenario) {
  const completions = [], requests = [];
  provider.mockReset().mockImplementation(async (messages, options) => {
    completions.push(structuredClone({ messages, options }));
    return structuredClone(scenario.replies[completions.length - 1]);
  });
  vi.stubGlobal("fetch", vi.fn(async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => structuredClone(scenario.responses[requests.length - 1]) };
  }));
  let outcome;
  try { outcome = await run("Domanda generale", [{ role: "user", content: "Contesto precedente" },
    { role: "assistant", content: "Risposta precedente" }]); }
  catch (error) { outcome = { error: error.message, diagnostic: error.providerDiagnostics }; }
  return { outcome, completions, requests };
}

it.each(scenarios)("preserva risposta, round, payload, history e tool: $name", async scenario => {
  const current = await replay(orchestrate, scenario);
  expect(current.completions).toHaveLength(scenario.completions);
  expect(current.requests).toHaveLength(scenario.requests);
  expect(current.completions[0].messages.slice(1, 3)).toEqual([
    { role: "user", content: "Contesto precedente" }, { role: "assistant", content: "Risposta precedente" }]);
  if (scenario.error) expect(current.outcome.error).toContain(scenario.error);
  else expect(current.outcome.answer).toBeTruthy();
  if (previousOrchestrate) expect(current).toEqual(await replay(previousOrchestrate, scenario));
});

const failures = [null, "testo", [], {}, { results: [null] }, { ...report, scope: null }, { ...report, error: "riservato" }];
it.each(failures)("preserva il rifiuto controllato degli envelope: %j", async response => {
  const operation = call("analyze_operations", { analysis: "portfolio_summary" }, "validation");
  const run = async execute => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => response }));
    return execute(operation);
  };
  const current = await run(executeTool);
  expect(current).toEqual({ error: "Risposta non valida del servizio Data Agent. Nessun risultato ottenuto." });
  if (previousTool) expect(current).toEqual(await run(previousTool));
});

it.each([
  [400, { detail: "Filtro site_id non valido" }, false],
  [400, { detail: "  efficacy richiede un singolo study_id.  " }, false],
  [400, { detail: "CANARY_RISERVATO" }, false],
  [422, { detail: [{ loc: ["body", "filters", "site_id"], type: "string_type", input: "CANARY_RISERVATO" }] }, false],
  [422, { detail: [null, { loc: ["ignoto"], type: "missing" }, { loc: ["body"], type: "ignoto" },
    { loc: ["parameters"], type: "missing" }] }, false],
  [422, null, false],
  [422, { detail: [{ loc: ["body"], type: "missing" }] }, true],
  [503, { detail: "CANARY_RISERVATO" }, false],
])("preserva status, dettagli sanitizzati e logger HTTP%s: %j", async (status, payload, loggerFails) => {
  const run = async execute => {
    const logs = [];
    vi.spyOn(console, "warn").mockImplementation(value => {
      logs.push(value);
      if (loggerFails) throw Error("CANARY_LOGGER");
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status, json: async () => payload }));
    const result = await execute(call("analyze_operations", { analysis: "portfolio_summary" }, "http_error"));
    vi.restoreAllMocks();
    return { result, logs };
  };
  const current = await run(executeTool);
  expect(current.result.error).toContain(`HTTP ${status}`);
  expect(JSON.stringify(current)).not.toMatch(/CANARY_RISERVATO|CANARY_LOGGER/);
  if (previousTool) expect(current).toEqual(await run(previousTool));
});
