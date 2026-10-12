import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { executeTool } from "../src/toolExecutor.js";
import { orchestrate } from "../src/orchestrator.js";
import { generateCompletion } from "../src/llm.js";
import { completenessFixture } from "./fixtures/completeness.js";

vi.mock("../src/llm.js", () => ({ generateCompletion: vi.fn() }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
import { readFile } from "node:fs/promises";

const source = "knowledge_base/operations/clinical_operations_sop.md";
const document = readFileSync(new URL(`../../${source}`, import.meta.url), "utf8");
const text = document.split(/(?=^#{1,6} )/m).find(part => part.startsWith("## Data completeness")).trim();
const parameters = { attention_threshold_percent: 95, escalation_threshold_percent: 90 };
const call = args => ({ id: "data", type: "function", function: {
  name: "analyze_operations", arguments: JSON.stringify({ analysis: "completeness_threshold", group_by: ["site_id"], ...args }),
} });
const chunks = () => [{ source, section: "Data completeness", text, distance: 0.15 }];
let bodies;
beforeEach(async () => {
  readFile.mockImplementation((await vi.importActual("node:fs/promises")).readFile);
  bodies = [];
  vi.stubGlobal("fetch", vi.fn(async (url, options) => {
    const body = JSON.parse(options.body);
    bodies.push({ url, body });
    const result = url.endsWith("/retrieve") ? { results: chunks() } : {
      ...completenessFixture(body.parameters, body.group_by,
        [[807, 26, 781, 96.78], [1048, 24, 1024, 97.71], [423, 12, 411, 97.16], [911, 25, 886, 97.26],
          [800, 17, 783, 97.88], [974, 30, 944, 96.92], [742, 17, 725, 97.71], [963, 16, 947, 98.34]]
          .map(([required, missing, completed, rate], i) => ({ site_id: `SITE_0${i + 1}`,
            required_assessments_total: required, missing_assessments_total: missing,
            completed_assessments_total: completed, completeness_rate: rate, classification: "no_action" }))),
      data_quality: { duplicates_removed: 8, inconsistent_actual_dates: 15, inconsistent_query_rows: 3,
        excluded_records: 0, exclusions_by_reason: {}, warnings: ["8 duplicati rimossi.", "15 date segnalate.", "3 righe query segnalate."] },
    };
    return { ok: true, json: async () => result };
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); readFile.mockReset(); });

it("blocca il replay originale senza provenienza esplicita", async () => {
  await expect(executeTool(call({ parameters: {} }))).rejects.toThrow(/mancanti/i);
  expect(bodies).toEqual([]);
});
it("completa il replay esplicito e conserva il report nel contesto del modello", async () => {
  generateCompletion.mockResolvedValueOnce({ tool_calls: [call({ rule_source: "novera_kb", parameters: {} })] })
    .mockResolvedValueOnce({ content: "Risposta simulata." });
  const result = await orchestrate("Quali siti richiedono attenzione o escalation per data completeness secondo Novera?");
  expect(bodies[0].body.where).toEqual({ $and: [{ source }, { section: "Data completeness" }] });
  expect(bodies[1].body).toEqual({ analysis: "completeness_threshold", group_by: ["site_id"], parameters });
  const report = JSON.parse(generateCompletion.mock.calls[1][0].find(message => message.role === "tool").content);
  expect(report.parameters_applied).toEqual(parameters);
  expect(report.results.map(row => row.classification)).toEqual(Array(8).fill("no_action"));
  expect(report.results.map(row => row.completeness_rate)).toEqual([96.78, 97.71, 97.16, 97.26, 97.88, 96.92, 97.71, 98.34]);
  expect(report.document_support.sources[0]).toEqual({ title: "SOP sintetica - Clinical Operations", section: "Data completeness" });
  expect(report.document_support.comparison).toBe("<");
  expect(report.scope).toMatchObject({ group_by: ["site_id"] });
  expect(report.data_quality).toMatchObject({ duplicates_removed: 8, inconsistent_actual_dates: 15,
    inconsistent_query_rows: 3, excluded_records: 0, exclusions_by_reason: {} });
  expect(report.data_quality.warnings).toHaveLength(3);
  expect(result.tools_used).toEqual(["analyze_operations"]);
  for (const row of report.results) expect(result.answer).toContain(row.site_id);
  expect(result.answer).not.toContain("Risposta simulata.");
});
it.each([{ attention_threshold_percent: 95 }, { escalation_threshold_percent: 90 }])("completa solo la soglia assente: %j", async supplied => {
  await executeTool(call({ rule_source: "novera_kb", parameters: supplied }));
  expect(bodies.at(-1).body.parameters).toEqual(parameters);
});
it("preserva soglie personalizzate complete senza retrieval", async () => {
  await executeTool(call({ parameters: { attention_threshold_percent: 99, escalation_threshold_percent: 97 } }));
  expect(bodies).toHaveLength(1);
  expect(bodies[0].body.parameters).toEqual({ attention_threshold_percent: 99, escalation_threshold_percent: 97 });
});
it.each([
  { attention_threshold_percent: null }, { attention_threshold_percent: "95" },
  { attention_threshold_percent: -1 }, { escalation_threshold_percent: 101 },
  { attention_threshold_percent: 90, escalation_threshold_percent: 95 },
  { attention_threshold_percent: 90, escalation_threshold_percent: 90 }, { other: 1 },
])("non ripara parametri invalidi: %j", async supplied => {
  await expect(executeTool(call({ rule_source: "novera_kb", parameters: supplied }))).rejects.toThrow();
  expect(bodies).toEqual([]);
});
it.each([{ attention_threshold_percent: 94 }, { attention_threshold_percent: 99, escalation_threshold_percent: 97 }])("blocca parametri in conflitto con Novera esplicita: %j", async supplied => {
  await expect(executeTool(call({ rule_source: "novera_kb", parameters: supplied }))).rejects.toThrow(/conflitto/i);
  expect(bodies.some(item => item.url.endsWith("/analyze"))).toBe(false);
});
it.each([
  { analysis: "completeness", rule_source: "novera_kb" },
  { analysis: "out_of_window", rule_source: "novera_kb" },
  { rule_source: "other" }, { rule_source: null },
])("blocca provenienza non ammessa: %j", async args => {
  await expect(executeTool(call(args))).rejects.toThrow(/rule_source/i);
  expect(bodies).toEqual([]);
});
it.each([
  ["assente", []],
  ["non pertinente", [{ ...chunks()[0], source: "knowledge_base/faq.md" }]],
  ["conflittuale", [...chunks(), { ...chunks()[0], text: text.replace("95", "94") }]],
  ["incompleta", [{ ...chunks()[0], text: text.replace(/^- completeness <90%.*$/m, "") }]],
  ["non verificabile", [{ ...chunks()[0], text: text.replaceAll("95", "94") }]],
])("blocca documentazione %s prima del calcolo", async (_label, results) => {
  fetch.mockResolvedValue({ ok: true, json: async () => ({ results }) });
  await expect(executeTool(call({ rule_source: "novera_kb", parameters: {} }))).rejects.toThrow();
  expect(fetch.mock.calls.every(([url]) => url.endsWith("/retrieve"))).toBe(true);
});
it.each([
  ["soglie alternative", text.replaceAll("95", "94").replaceAll("90", "87"), { attention_threshold_percent: 94, escalation_threshold_percent: 87 }],
  ["soglie decimali", text.replaceAll("95", "94,5").replaceAll("90", "87,5"), { attention_threshold_percent: 94.5, escalation_threshold_percent: 87.5 }],
])("applica %s da una fixture documentale verificabile", async (_label, alternative, expected) => {
  readFile.mockResolvedValue(document.replace(text, alternative));
  fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ results: [{ ...chunks()[0], text: alternative }] }) })
    .mockResolvedValueOnce({ ok: true, json: async () => completenessFixture(expected) });
  await executeTool(call({ rule_source: "novera_kb", parameters: {} }));
  expect(JSON.parse(fetch.mock.calls[1][1].body).parameters).toEqual(expected);
});
it.each([
  text.replace("completeness <90%", "completeness <=90%"),
  text.replace("90%-<95%", "90%-<94%"),
  text + "\n- completeness <89%: **escalation**.",
  text + "\n- completeness <=94%: **attenzione operativa**;",
])("rifiuta semantica inclusiva o incoerente anche se il testo è attestato", async alternative => {
  readFile.mockResolvedValue(document.replace(text, alternative));
  fetch.mockResolvedValue({ ok: true, json: async () => ({ results: [{ ...chunks()[0], text: alternative }] }) });
  await expect(executeTool(call({ rule_source: "novera_kb", parameters: {} }))).rejects.toThrow();
  expect(fetch.mock.calls.every(([url]) => url.endsWith("/retrieve"))).toBe(true);
});
it("preserva parametri completi coerenti con la provenienza esplicita", async () => {
  await executeTool(call({ rule_source: "novera_kb", parameters }));
  expect(bodies.at(-1).body.parameters).toEqual({ attention_threshold_percent: 95, escalation_threshold_percent: 90 });
  expect(bodies.at(-1).body).not.toHaveProperty("rule_source");
});