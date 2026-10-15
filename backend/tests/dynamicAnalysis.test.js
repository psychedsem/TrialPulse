import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("../src/llm.js", () => ({ generateCompletion: vi.fn(), paceGeneration: vi.fn(), observeGenerationQuota: vi.fn() }));
vi.mock("../src/pythonBridge.js", () => ({ isConnectionRefused: () => true, localPythonFallback: vi.fn() }));
import { generateCompletion } from "../src/llm.js";
import { localPythonFallback } from "../src/pythonBridge.js";
import { executeTool } from "../src/toolExecutor.js";
import { orchestrate } from "../src/orchestrator.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJawAAAAASUVORK5CYII=";
const args = { analysis: "dynamic", question: "Confronta gli arruolamenti per studio in un grafico", chart: "bar" };
const tool = values => ({ id: "chart_1", type: "function", function: { name: "analyze_operations", arguments: JSON.stringify(values) } });
const report = () => ({ analysis: "dynamic", scope: { filters: {}, row_count: 1500 }, parameters_applied: { chart: "bar" }, data_quality: { warnings: ["Dati sintetici"], duplicates_removed: 8 }, results: [{ label: "NNR-ESK-02", value: 32 }], artifacts: [{ type: "image", mime_type: "image/png", data: png, alt: "Grafico sui dati sintetici" }] });
beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.unstubAllGlobals());

it("porta il PNG alla risposta ma non nel contesto delle completion", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => report() })));
  generateCompletion.mockResolvedValueOnce({ role: "assistant", tool_calls: [tool(args)] }).mockResolvedValueOnce({ content: "Arruolamenti per studio: dati sintetici." });
  const result = await orchestrate("Mostra un grafico per studio");
  expect(result.artifacts).toEqual(report().artifacts);
  expect(result.tools_used).toEqual(["analyze_operations"]);
  const context = JSON.stringify(generateCompletion.mock.calls[1][0]);
  expect(context).not.toContain(png);
  expect(context).toContain("32");
});

it("rifiuta il PNG non valido invece di esporre un artefatto arbitrario", async () => {
  const invalid = report(); invalid.artifacts[0].data = "not_a_png";
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => invalid })));
  const result = await executeTool(tool(args));
  expect(result.error).toBeTruthy();
  expect(result.artifacts).toBeUndefined();
});

it("conserva serie e periodi del report lineare separando il PNG dal contesto LLM", async () => {
  const line = report();
  line.parameters_applied.chart = "line";
  line.results = [{ label: "2026-01 ESK", value: 2, period: "2026-01", series: "NNR-ESK-02" },
    { label: "2026-03 ESK", value: 4, period: "2026-03", series: "NNR-ESK-02" }];
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => line })));
  generateCompletion.mockResolvedValueOnce({ role: "assistant", tool_calls: [tool({ ...args, chart: "line" })] })
    .mockResolvedValueOnce({ content: "Dati sintetici: gennaio 2, marzo 4; febbraio non restituito." });
  const result = await orchestrate("Mostra gli arruolamenti mensili per studio con un grafico lineare");
  expect(result.artifacts).toEqual(line.artifacts);
  const messages = generateCompletion.mock.calls[1][0];
  const context = JSON.parse(messages.find(message => message.role === "tool").content);
  expect(context.results).toEqual(line.results);
  expect(context.parameters_applied.chart).toBe("line");
  expect(context.artifacts).toBeUndefined();
  expect(JSON.stringify(messages)).not.toContain(png);
});

it("non usa il vecchio bridge non isolato se il servizio dinamico è assente", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
  expect((await executeTool(tool(args))).error).toBeTruthy();
  expect(localPythonFallback).not.toHaveBeenCalled();
});

it.each([{ ...args, parameters: {} }, { ...args, chart: "svg" }, { ...args, question: "" }, { ...args, filters: { participant_id: "P1" } }])("rifiuta payload dinamici fuori contratto: %j", async invalid => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  await expect(executeTool(tool(invalid))).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
