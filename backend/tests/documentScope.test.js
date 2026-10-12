import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
vi.mock("../src/llm.js", () => ({ generateCompletion: vi.fn() }));
import { generateCompletion } from "../src/llm.js";
import { orchestrate } from "../src/orchestrator.js";

const faq = readFileSync(new URL("../../knowledge_base/faq.md", import.meta.url), "utf8")
  .split("## Quando una query")[0].split("## Qual è la finestra della Week 6?")[1];
const chunk = { text: `## Qual è la finestra della Week 6?${faq}`.trim(), source: "knowledge_base/faq.md", section: "Qual è la finestra della Week 6?", distance: 0.14 };
const windows = { "NNR-PSI-01": 4, "NNR-ESK-02": 2, "NNR-DXB-03": 4, "NNR-SER-04": 5 };
const schedule = (...studies) => JSON.stringify({ schedule_facts: studies.map(study_id => ({ study_id,
  visit_name: "Week 6", window_days: windows[study_id], source: chunk.source, section: chunk.section })) });
let fetchMock;
beforeEach(() => { vi.resetAllMocks(); fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [chunk] }) }); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => vi.unstubAllGlobals());
async function run(message, answer, history = [], query = message) {
  generateCompletion.mockResolvedValueOnce({ tool_calls: [{ id: "s1", type: "function",
    function: { name: "search_knowledge", arguments: JSON.stringify({ query }) } }] })
    .mockResolvedValueOnce({ content: answer });
  return orchestrate(message, history);
}
it("blocca la selezione DXB senza contesto anche quando la FAQ è corretta", async () => {
  const result = await run("Qual è la finestra consentita per la visita Week 6?", "NNR-DXB-03: target +42, finestra ±4 giorni.");
  expect(result.answer).toMatch(/quale studio/i);
  expect(result.answer).not.toContain("±4");
});
it("la FAQ che richiede lo studio blocca anche una finestra priva di identificativo", async () => {
  expect((await run("Qual è la finestra consentita?", "La finestra è ±4 giorni.")).answer).toMatch(/quale studio/i);
});
it("una query tool DXB non costituisce una selezione dell'utente", async () => {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ results: [{ text: "Week 6 ±4 giorni", source: "knowledge_base/protocols/NNR-DXB-03.md", section: "Schedule", distance: 0.14 }] }) });
  expect((await run("Qual è la finestra consentita?", "NNR-DXB-03 ±4 giorni.", [], "Week 6 DXB")).answer).toMatch(/quale studio/i);
});
it("una risposta storica dell'assistente non autorizza a selezionare ESK", async () => {
  const history = [{ role: "user", content: "Quale studio?" }, { role: "assistant", content: "NNR-ESK-02 ±2 giorni." }];
  expect((await run("E la finestra della visita?", "NNR-ESK-02 ±2 giorni.", history)).answer).toMatch(/quale studio/i);
});
it("un'entità negata non autorizza la selezione", async () => {
  expect((await run("Non scegliere DXB: quale finestra?", "NNR-DXB-03 ±4 giorni.")).answer).toMatch(/quale studio/i);
});
it.each(["NNR-ESK-02", "ESK"])("preserva lo studio esplicito %s e i documenti", async study => {
  const result = await run(`Qual è la finestra Week 6 per ${study}?`, schedule("NNR-ESK-02"));
  expect(result.answer).toContain("±2");
  expect(result.answer).toContain("Documenti Novera consultati");
});
it("il follow-up PSI prevale sulla selezione ESK precedente", async () => {
  const history = [{ role: "user", content: "Week 6 ESK?" }, { role: "assistant", content: "NNR-ESK-02 ±2 giorni." }];
  expect((await run("E per lo studio PSI?", schedule("NNR-PSI-01"), history)).answer).toContain("±4");
});
it("una fonte mancante nel follow-up singolo non viene descritta come confronto", async () => {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ results: [{
    text: "Protocollo ESK", source: "knowledge_base/protocols/NNR-ESK-02.md", section: "Scope", distance: 0.14,
  }] }) });
  const history = [{ role: "user", content: "Mi riferisco allo studio NNR-ESK-02." },
    { role: "assistant", content: "Day 42, ±2 giorni." }];
  const result = await run("E per lo studio PSI?", "Informazioni per NNR-PSI-01 non disponibili.", history);
  expect(result.answer).toMatch(/supporto documentale.*incompleto.*perimetro/i);
  expect(result.answer).not.toMatch(/confronto|±4/);
});
it("blocca una risposta ESK quando il follow-up seleziona PSI", async () => {
  const history = [{ role: "user", content: "Week 6 ESK?" }, { role: "assistant", content: "±2 giorni." }];
  const result = await run("E per lo studio PSI?", schedule("NNR-ESK-02"), history);
  expect(result.answer).toMatch(/non verificate/i);
  expect(result.answer).not.toContain("±2");
});
it("preserva il contesto del solo utente dopo un chiarimento", async () => {
  const history = [{ role: "user", content: "Studio ESK" }, { role: "assistant", content: "Quale visita?" }];
  expect((await run("Week 6", schedule("NNR-ESK-02"), history)).answer).toContain("±2");
});
it("un confronto esplicito non richiede un singolo studio", async () => {
  const result = await run("Confronta le finestre Week 6 di tutti gli studi", schedule(...Object.keys(windows)));
  for (const [study, window] of Object.entries(windows)) {
    expect(result.answer).toContain(study);
    expect(result.answer).toContain(`±${window} giorni`);
  }
  expect(result.answer).not.toMatch(/quale studio|incompleto/i);
});
it("due studi espliciti consentono il confronto documentale", async () => {
  const result = await run("Confronta PSI ed ESK", schedule("NNR-PSI-01", "NNR-ESK-02"));
  expect(result.answer).toContain("±4 giorni");
  expect(result.answer).toContain("±2 giorni");
});
it("il confronto non può essere dichiarato completo con una fonte per un solo studio", async () => {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ results: [{ text: "NNR-DXB-03 ±4 giorni", source: "knowledge_base/protocols/NNR-DXB-03.md", section: "Schedule", distance: 0.1 }] }) });
  const result = await run("Confronta tutti gli studi", "PSI ±4; ESK ±2; DXB ±4; SER ±5.");
  expect(result.answer).toMatch(/non verificate|supporto documentale.*incompleto/i);
  expect(result.answer).not.toContain("±2");
});
it("una regola generale senza studio resta disponibile", async () => {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ results: [{ text: "Query aperte >10 giorni", source: "knowledge_base/operations/deviation_escalation_rules.md", section: "Query", distance: 0.1 }] }) });
  expect((await run("Quando escalare una query?", "Oltre 10 giorni a Data Management.")).answer).toContain("Oltre 10");
});
it("una panoramica documentale generale non viene scambiata per una regola study-specific", async () => {
  const answer = "Gli studi sono NNR-PSI-01, NNR-ESK-02, NNR-DXB-03 e NNR-SER-04.";
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ results: [{ text: answer,
    source: "knowledge_base/00_scope.md", section: "Portfolio studi", distance: 0.1 }] }) });
  expect((await run("Quali studi comprende Novera?", answer)).answer).toContain(answer);
});
it("un alias duplicato nel manifest non seleziona arbitrariamente un protocollo", async () => {
  vi.resetModules();
  vi.doMock("node:fs", async importOriginal => {
    const fs = await importOriginal();
    return { ...fs, readFileSync: (path, ...args) => String(path).endsWith("knowledge_base/manifest.yaml") ?
      "ingest:\n  - knowledge_base/protocols/NNR-PSI-01.md\n  - knowledge_base/protocols/NNR-PSI-02.md\n" :
      fs.readFileSync(path, ...args) };
  });
  try {
    const { canonicalStudyId, selectedUserStudies } = await import("../src/documentScope.js");
    expect(canonicalStudyId("PSI")).toBeNull();
    expect(canonicalStudyId("NNR-PSI-01")).toBe("NNR-PSI-01");
    expect(canonicalStudyId("NNR-PSI-02")).toBe("NNR-PSI-02");
    expect(selectedUserStudies("Studio PSI")).toEqual([]);
    expect(selectedUserStudies("E per PSI?", [{ role: "user", content: "Studio NNR-PSI-01" },
      { role: "assistant", content: "Risposta." }])).toEqual([]);
    expect(selectedUserStudies("Studio NNR-PSI-02")).toEqual(["NNR-PSI-02"]);
  } finally {
    vi.doUnmock("node:fs");
    vi.resetModules();
  }
});