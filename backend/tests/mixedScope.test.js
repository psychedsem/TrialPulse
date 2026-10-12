import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("../src/llm.js", () => ({ generateCompletion: vi.fn() }));
import { generateCompletion } from "../src/llm.js";
import { orchestrate } from "../src/orchestrator.js";

const question = "Considerando i dati sintetici del portfolio Novera, confronta i quattro studi per numero di partecipanti arruolati e tasso di completamento delle visite. Sulla base di questi risultati, possiamo stabilire quale trattamento sia più efficace contro la depressione e quale sarebbe preferibile raccomandare a un paziente?";
const enrollment = { analysis: "recruitment", scope: { group_by: ["study_id"] }, parameters_applied: {}, data_quality: {}, results: [
  { study_id: "NNR-DXB-03", enrolled_participants: 44 }, { study_id: "NNR-ESK-02", enrolled_participants: 32 },
  { study_id: "NNR-PSI-01", enrolled_participants: 36 }, { study_id: "NNR-SER-04", enrolled_participants: 42 },
] };
const visits = { analysis: "visits", scope: { group_by: ["study_id"] }, parameters_applied: {}, data_quality: {}, results: [
  { study_id: "NNR-DXB-03", expected_visits: 295, completed_visits: 287, missed_visits: 8, completion_rate: 97.29, missed_rate: 2.71 },
  { study_id: "NNR-ESK-02", expected_visits: 394, completed_visits: 377, missed_visits: 17, completion_rate: 95.69, missed_rate: 4.31 },
  { study_id: "NNR-PSI-01", expected_visits: 280, completed_visits: 267, missed_visits: 13, completion_rate: 95.36, missed_rate: 4.64 },
  { study_id: "NNR-SER-04", expected_visits: 275, completed_visits: 259, missed_visits: 16, completion_rate: 94.18, missed_rate: 5.82 },
] };
const toolCalls = ["recruitment", "visits"].map(analysis => ({ id: analysis, type: "function",
  function: { name: "analyze_operations", arguments: JSON.stringify({ analysis, group_by: ["study_id"] }) } }));
beforeEach(() => { vi.resetAllMocks(); vi.stubGlobal("fetch", vi.fn()); });
afterEach(() => vi.unstubAllGlobals());

it("trasporta entrambi i KPI della richiesta mista senza impedirne il confronto operativo", async () => {
  fetch.mockResolvedValueOnce({ ok: true, json: async () => enrollment }).mockResolvedValueOnce({ ok: true, json: async () => visits });
  const answer = "Dati sintetici: DXB 44 arruolati, 97,29% visite completate; ESK 32, 95,69%; PSI 36, 95,36%; SER 42, 94,18%. Questi KPI operativi non dimostrano superiorità clinica e non consentono di raccomandare una terapia a un paziente.";
  generateCompletion.mockResolvedValueOnce({ tool_calls: toolCalls }).mockResolvedValueOnce({ content: answer });
  const result = await orchestrate(question);
  expect(result.answer).toContain(answer);
  expect(result.tools_used).toEqual(["analyze_operations"]);
  expect(fetch.mock.calls.map(([, options]) => JSON.parse(options.body))).toEqual([
    { analysis: "recruitment", group_by: ["study_id"] }, { analysis: "visits", group_by: ["study_id"] },
  ]);
  const results = generateCompletion.mock.calls[1][0].filter(turn => turn.role === "tool").map(turn => JSON.parse(turn.content));
  expect(results).toEqual([enrollment, visits]);
});
it("con servizi indisponibili il percorso simulato non attribuisce KPI o fonti al CSV", async () => {
  fetch.mockRejectedValue(new Error("servizio non raggiungibile"));
  generateCompletion.mockResolvedValueOnce({ tool_calls: toolCalls }).mockResolvedValueOnce({ content: "Non ho ottenuto i KPI. Non posso raccomandare una terapia." });
  const result = await orchestrate(question);
  expect(result.answer).not.toMatch(/44|97,29|Dati analizzati/);
  expect(generateCompletion.mock.calls[1][0].filter(turn => turn.role === "tool").every(turn => JSON.parse(turn.content).error)).toBe(true);
});
it("una richiesta esclusivamente terapeutica può essere rifiutata senza tool", async () => {
  generateCompletion.mockResolvedValueOnce({ content: "Non posso raccomandare una terapia o stabilire idoneità clinica." });
  const result = await orchestrate("Quale terapia prescrivere a un paziente depresso?");
  expect(result.tools_used).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
});
