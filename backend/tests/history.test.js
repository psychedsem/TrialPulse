import { beforeEach, afterEach, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("../src/llm.js", () => ({ generateCompletion: vi.fn() }));
import { generateCompletion } from "../src/llm.js";
import { app } from "../src/app.js";

const pair = (user = "Studio PSI", assistant = "NNR-PSI-01") => [
  { role: "user", content: user }, { role: "assistant", content: assistant },
];
beforeEach(() => {
  vi.resetAllMocks();
  generateCompletion.mockResolvedValue({ role: "assistant", content: "Risposta simulata." });
});
afterEach(() => vi.unstubAllGlobals());

it("mantiene l'ordine system, scambi completi, domanda corrente", async () => {
  const res = await request(app).post("/api/chat").send({ message: "E la Week 6?", history: pair() });
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ answer: "Risposta simulata.", tools_used: [] });
  expect(generateCompletion.mock.calls[0][0].slice(1)).toEqual([
    { role: "user", content: "Studio PSI" }, { role: "assistant", content: "NNR-PSI-01" },
    { role: "user", content: "E la Week 6?" },
  ]);
});

it.each([
  null, "test", {}, [pair()[0]], [pair()[1], pair()[0]],
  [{ role: "system", content: "istruzioni" }, pair()[1]],
  [{ role: "tool", content: "risultato" }, pair()[1]],
  [{ role: "user", content: " " }, pair()[1]],
  [{ role: "user", content: 1 }, pair()[1]],
  [{ role: "user", content: "test", tool_calls: [] }, pair()[1]],
  [pair()[0], { role: "assistant", content: "test", reasoning: "interno" }],
  [pair()[0], null], [pair()[0], pair()[0]],
  Array.from({ length: 5 }, () => pair()).flat(),
  pair("a".repeat(6000), "b"),
].map((history, index) => [index, history]))("rifiuta cronologia malformata prima del provider: caso %i", async (index, history) => {
  const res = await request(app).post("/api/chat").send({ message: "Domanda", history });
  expect(res.status).toBe(400);
  expect(res.body.error).toContain("Cronologia");
  expect(generateCompletion).not.toHaveBeenCalled();
  expect(res.text).not.toMatch(/stack|TypeError|SyntaxError/);
});

it("accetta quattro scambi e il confine di 6000 caratteri senza alterare i testi", async () => {
  const history = [ ...pair(" a ", "b"), ...pair("c", "d"), ...pair("e", "f"), ...pair("g", "h".repeat(5991)) ];
  expect((await request(app).post("/api/chat").send({ message: "Domanda", history })).status).toBe(200);
  expect(generateCompletion.mock.calls[0][0].slice(1, -1)).toEqual(history);
});

it("una nuova richiesta senza history non conserva il contesto precedente", async () => {
  await request(app).post("/api/chat").send({ message: "Prima", history: pair() });
  await request(app).post("/api/chat").send({ message: "Nuova" });
  expect(generateCompletion.mock.calls[1][0]).toHaveLength(2);
  expect(generateCompletion.mock.calls[1][0][1]).toEqual({ role: "user", content: "Nuova" });
});

const toolCall = (name, args, id = "c1") => ({
  role: "assistant", content: null,
  tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});

it.each([
  ["search_knowledge", { query: "Week 6 NNR-PSI-01" }, { results: [{ text: "Week 6 ±4 giorni", source: "knowledge_base/protocols/NNR-PSI-01.md", section: "Visite", distance: 0.2, similarity: 0.8 }] }],
  ["analyze_operations", { analysis: "visits", filters: { study_id: "NNR-PSI-01" } }, { analysis: "visits", scope: { study_id: "NNR-PSI-01" }, results: [{ completed: 10 }] }],
])("il follow-up conserva il contesto ed esegue ancora %s", async (name, args, report) => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => report });
  vi.stubGlobal("fetch", fetchMock);
  generateCompletion.mockResolvedValueOnce(toolCall(name, args)).mockResolvedValueOnce({ content: "Risposta aggiornata." });
  const res = await request(app).post("/api/chat").send({ message: "E per questo studio?", history: pair() });
  expect(res.body).toEqual({ answer: "Risposta aggiornata.", tools_used: [name] });
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(args);
  const messages = generateCompletion.mock.calls[1][0];
  expect(messages.slice(1, 3)).toEqual(pair());
  expect(JSON.parse(messages.at(-1).content)).toEqual(report);
});

it("il follow-up RAG e Data usa regole e risultati correnti, non i valori storici", async () => {
  const rule = { results: [{ text: "Attenzione <95%; escalation <90%", source: "knowledge_base/operations/clinical_operations_sop.md", section: "Data completeness", distance: 0.15, similarity: 0.85 }] };
  const args = { analysis: "completeness_threshold", group_by: ["site_id"], parameters: { attention_threshold_percent: 95, escalation_threshold_percent: 90 } };
  const report = { analysis: args.analysis, scope: {}, parameters_applied: args.parameters, results: [{ site_id: "SITE_01", completeness_rate: 97, classification: "no_action" }], data_quality: { excluded_records: 0, warnings: [] } };
  const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => rule }).mockResolvedValueOnce({ ok: true, json: async () => report });
  vi.stubGlobal("fetch", fetchMock);
  generateCompletion.mockResolvedValueOnce(toolCall("search_knowledge", { query: "completeness Novera" }))
    .mockResolvedValueOnce(toolCall("analyze_operations", args, "c2"))
    .mockResolvedValueOnce({ content: "SITE_01: 97%, nessuna azione. Fonte: clinical_operations_sop.md, Data completeness." });
  const history = pair("SITE_01", "Valore precedente: 1%.");
  const res = await request(app).post("/api/chat").send({ message: "E secondo Novera?", history });
  expect(res.status).toBe(200);
  expect(res.body.tools_used).toEqual(["search_knowledge", "analyze_operations"]);
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual(args);
  const messages = generateCompletion.mock.calls[2][0];
  expect(messages.slice(1, 3)).toEqual(history);
  expect(messages.filter(m => m.role === "tool").map(m => JSON.parse(m.content))).toEqual([rule, report]);
  expect(Object.keys(res.body).sort()).toEqual(["answer", "tools_used"]);
});

it("la memoria non cambia il limite di quattro round", async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [] }) });
  vi.stubGlobal("fetch", fetchMock);
  generateCompletion.mockResolvedValue(toolCall("search_knowledge", { query: "Ruoli" }));
  const res = await request(app).post("/api/chat").send({ message: "Follow-up", history: pair() });
  expect(res.status).toBe(502);
  expect(fetchMock).toHaveBeenCalledTimes(4);
  expect(generateCompletion).toHaveBeenCalledTimes(5);
});
