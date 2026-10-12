import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildVisitRules, selectKnowledge } from "../src/documentAdapter.js";
import { executeTool } from "../src/toolExecutor.js";
import { orchestrate } from "../src/orchestrator.js";
import { generateCompletion } from "../src/llm.js";
import { completenessFixture } from "./fixtures/completeness.js";

vi.mock("../src/llm.js", () => ({ generateCompletion: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

const root = resolve(import.meta.dirname, "../..");
const schedule = "knowledge_base/reference/visit_schedule_windows.md";
const sop = "knowledge_base/operations/clinical_operations_sop.md";
const studies = ["NNR-PSI-01", "NNR-ESK-02", "NNR-DXB-03", "NNR-SER-04"];

function section(source, heading) {
  return readFileSync(resolve(root, source), "utf8").split(/(?=^#{1,6} )/m)
    .find(part => part.split("\n")[0].replace(/^#+ /, "").trim() === heading)?.trim();
}
function fixtures() {
  const entries = [
    ["knowledge_base/00_scope.md", "TrialPulse Knowledge Base - Ambito"],
    [schedule, "Regola di calcolo"],
    ...studies.flatMap(study => [[schedule, study], [`knowledge_base/protocols/${study}.md`, "Schedule"]]),
  ];
  return entries.map(([source, heading], id) => ({
    id: String(id), source, section: heading, text: section(source, heading),
    distance: 0.25, metadata: { chunk_index: 0 },
  }));
}
const retriever = chunks => async (_query, where) => chunks.filter(chunk =>
  where.$and.every(filter => Object.entries(filter).every(([key, value]) => chunk[key] === value)));
const call = (name, args) => ({
  id: name, type: "function", function: { name, arguments: JSON.stringify(args) },
});
const analyze = args => call("analyze_operations", args);
const search = query => call("search_knowledge", { query });
const replies = (...steps) => steps.forEach(step => generateCompletion.mockResolvedValueOnce(step));
const reports = round => generateCompletion.mock.calls[round][0]
  .filter(message => message.role === "tool").map(message => JSON.parse(message.content));
const posted = (fetch, index = -1) => JSON.parse(fetch.mock.calls.at(index)[1].body);

function mockHttp({ retrieve = retriever(fixtures()), analyzeResult = body => ({
  analysis: body.analysis, parameters_applied: body.parameters || {}, results: [{ site_id: "SITE_01" }],
  scope: { group_by: body.group_by || [] },
  data_quality: { excluded_records: 15, warnings: ["Date inutilizzabili."] },
}) } = {}) {
  const fetch = vi.fn(async (url, { body: json }) => {
    const body = JSON.parse(json);
    const result = url.endsWith("/retrieve")
      ? { results: await retrieve(body.query, body.where) } : analyzeResult(body);
    return { ok: true, json: async () => result };
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

// Validazione delle fonti e degli schedule recuperati dalla Knowledge Base.
describe("Supporto documentale delle finestre", () => {
  it("recupera il portfolio senza Screening, con soglia e fonti", async () => {
    const { parameters, support } = await buildVisitRules({}, retriever(fixtures()));
    expect(parameters.visit_windows).toHaveLength(35);
    expect(parameters.rate_threshold_percent).toBe(10);
    expect(support.coverage.complete).toBe(true);
    expect(support.sources).toHaveLength(10);
    expect(parameters.visit_windows.some(row => row.visit_name === "Screening")).toBe(false);
  });
  it("rispetta lo studio e la visita scelti", async () => {
    const { parameters } = await buildVisitRules({ study_id: "NNR-ESK-02", visit_name: "Week 6" }, retriever(fixtures()));
    expect(parameters.visit_windows).toEqual([{ study_id: "NNR-ESK-02", visit_name: "Week 6", window_days: 2 }]);
  });
  it.each([
    ["soglia assente", chunks => { chunks[1].text = chunks[1].text.replace("supera il 10%", "è elevato"); }, /soglia/i],
    ["studio mancante", chunks => { chunks.splice(4, 1); }, /copertura/i],
    ["tabella incompleta", chunks => { chunks[2].text = chunks[2].text.replace(/^\| Week 12.*\n?/m, ""); }, /copertura/i],
    ["visita duplicata", chunks => { chunks[2].text += "\n| Week 6 | +42 | ±4 giorni |"; }, /duplicat/i],
    ["target incoerente", chunks => { chunks[2].text = chunks[2].text.replace("+42", "+43"); }, /target/i],
    ["finestra non valida", chunks => { chunks[2].text = chunks[2].text.replace("±4 giorni", "±-4 giorni"); }, /finestra/i],
    ["regola date assente", chunks => { chunks[1].text = "Supera il 10%"; }, /date/i],
    ["scope troncato", chunks => { chunks[0].text = chunks[0].text.replace(/^- NNR-(ESK|DXB|SER).*\r?\n?/gm, ""); }, /copertura/i],
    ["tabella e protocollo troncati", chunks => {
      chunks[2].text = chunks[2].text.replace(/^\| Week 12.*\r?\n?/m, "");
      chunks[3].text = chunks[3].text.replace(/^- Week 12.*\r?\n?/m, "");
    }, /copertura/i],
  ])("blocca %s senza inventare fallback", async (_name, change, error) => {
    const chunks = fixtures();
    change(chunks);
    await expect(buildVisitRules({}, retriever(chunks))).rejects.toThrow(error);
  });
  it("rifiuta studio e visita non documentati", async () => {
    await expect(buildVisitRules({ study_id: "NNR-XXX-00" }, retriever(fixtures()))).rejects.toThrow(/studio/i);
    await expect(buildVisitRules({ visit_name: "Inventata" }, retriever(fixtures()))).rejects.toThrow(/visita/i);
  });
  it("rifiuta chunk fuori filtro e fonti in conflitto", async () => {
    await expect(buildVisitRules({}, async () => fixtures())).rejects.toThrow(/copertura/i);
    const chunks = fixtures();
    chunks.push({ ...chunks[2], id: "conflict", text: chunks[2].text.replace("±4 giorni", "±8 giorni") });
    await expect(buildVisitRules({}, retriever(chunks))).rejects.toThrow(/conflitt/i);
  });
  it("conserva una fonte necessaria anche con distance alta", async () => {
    const chunks = fixtures();
    chunks[2].distance = 0.85;
    const { parameters, support } = await buildVisitRules({}, retriever(chunks));
    expect(parameters.visit_windows).toHaveLength(35);
    expect(support.sources.find(item => item.section === "NNR-PSI-01").similarity).toBeCloseTo(0.15);
  });
});

it("ordina per cosine distance e deduplica senza soglia arbitraria", () => {
  const chunks = fixtures().slice(0, 2);
  chunks[0].distance = 0.9;
  chunks[1].distance = 0.1;
  const result = selectKnowledge([...chunks, chunks[1]]);
  expect(result).toHaveLength(2);
  expect(result[0].similarity).toBeCloseTo(0.9);
  expect(result[1].similarity).toBeCloseTo(0.1);
});

// Validazione dei parametri inoltrati al Data Agent e del contesto per l'LLM.
it("inoltra 35 finestre e filtri senza ripetere le tabelle al modello", async () => {
  const fetch = mockHttp();
  replies({ tool_calls: [analyze({ analysis: "out_of_window", filters: { site_id: "SITE_01" }, group_by: ["site_id"] })] }, { content: "Review richiesta." });
  const final = await orchestrate("Quali siti superano la soglia Novera di visite out-of-window?");
  expect(posted(fetch).parameters.visit_windows).toHaveLength(35);
  expect(final.answer.startsWith("Review richiesta.")).toBe(true);
  expect(final.answer).toContain("Regole documentali attestate e applicate");
  expect(final.answer).toContain("CSV operativo TrialPulse (dati sintetici)");
  expect(final.answer).not.toMatch(/knowledge_base\/|document_support|distance|similarity/);
  expect(posted(fetch).filters).toEqual({ site_id: "SITE_01" });
  expect(reports(1)[0].parameters_applied.visit_windows).toBeUndefined();
  expect(reports(1)[0].document_support.coverage.complete).toBe(true);
  expect(reports(1)[0].data_quality.excluded_records).toBe(15);
});
it.each([
  { rate_threshold_percent: 11 },
  { visit_windows: [{ study_id: "NNR-PSI-01", visit_name: "Week 6", window_days: 4 }] },
])("blocca parametri out-of-window in conflitto: %j", async parameters => {
  const fetch = mockHttp();
  await expect(executeTool(analyze({ analysis: "out_of_window", parameters }))).rejects.toThrow(/conflitto|incomplete/i);
  expect(fetch.mock.calls.some(([url]) => url.endsWith("/analyze"))).toBe(false);
});
it("accetta finestre equivalenti indipendentemente dall'ordine delle chiavi", async () => {
  const fetch = mockHttp();
  const { parameters } = await buildVisitRules({}, retriever(fixtures()));
  const visit_windows = parameters.visit_windows.map(({ study_id, visit_name, window_days }) => ({ window_days, visit_name, study_id })).reverse();
  const result = await executeTool(analyze({ analysis: "out_of_window", parameters: { visit_windows } }));
  expect(result.document_support.coverage.complete).toBe(true);
  expect(fetch.mock.calls.at(-1)[0]).toContain("/analyze");
});
it("normalizza il raggruppamento major senza mutare i parametri", async () => {
  const fetch = mockHttp();
  await executeTool(analyze({ analysis: "major_deviations_window", group_by: ["site_id"], parameters: { window_days: 30, min_count: 3 } }));
  expect(posted(fetch, 0)).toEqual({ analysis: "major_deviations_window", parameters: { window_days: 30, min_count: 3 } });
});
it.each([
  {}, { attention_threshold_percent: 95 },
  { attention_threshold_percent: null, escalation_threshold_percent: 90 },
  { attention_threshold_percent: "95", escalation_threshold_percent: 90 },
  { attention_threshold_percent: 95, escalation_threshold_percent: "90" },
  { attention_threshold_percent: 95, escalation_threshold_percent: 95 },
  { attention_threshold_percent: 90, escalation_threshold_percent: 95 },
])("rifiuta soglie completeness non valide: %j", async parameters => {
  const fetch = mockHttp();
  await expect(executeTool(analyze({ analysis: "completeness_threshold", parameters }))).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
it("riusa la stessa analisi e produce una finale senza tool", async () => {
  const fetch = mockHttp();
  const request = analyze({ analysis: "portfolio_summary" });
  replies({ tool_calls: [request] }, { tool_calls: [request] }, { content: "Verificato." });
  await orchestrate("Domanda");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(generateCompletion.mock.calls[2][1]).toMatchObject({ allowTools: false });
});
it("non espone l'errore grezzo di un retrieval non disponibile", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("segreto di servizio")));
  await expect(executeTool(analyze({ analysis: "out_of_window" }))).rejects.toThrow("Servizio RAG non disponibile");
});
it("rifiuta parametri estranei prima delle chiamate HTTP", async () => {
  const fetch = mockHttp();
  await expect(executeTool(analyze({ analysis: "out_of_window", parameters: { threshold_percent: 10 } }))).rejects.toThrow(/parametri non supportati/i);
  expect(fetch).not.toHaveBeenCalled();
});
it.each([
  ["completeness_threshold", sop, "Data completeness", { attention_threshold_percent: 95, escalation_threshold_percent: 90 }, ["site_id"]],
  ["major_deviations_window", "knowledge_base/operations/deviation_escalation_rules.md", "Soglia temporale", { window_days: 30, min_count: 3 }, undefined],
])("preserva documenti e parametri di %s", async (analysis, source, heading, parameters, group_by) => {
  const fetch = mockHttp({
    retrieve: async () => [{ source, section: heading, text: section(source, heading), distance: 0.15 }],
    analyzeResult: body => analysis === "completeness_threshold" ? completenessFixture(body.parameters) :
      ({ analysis, scope: { group_by: [] }, parameters_applied: body.parameters, data_quality: {}, results: [] }),
  });
  replies({ tool_calls: [search(heading)] }, { tool_calls: [analyze({ analysis, parameters, ...(group_by ? { group_by } : {}) })] }, { content: "Analisi verificata." });
  const result = await orchestrate("Applica la regola documentale ai dati.");
  expect(result.tools_used).toEqual(["search_knowledge", "analyze_operations"]);
  expect(posted(fetch, 1).parameters).toEqual(parameters);
  expect(reports(2)[0].results[0]).toEqual({ text: section(source, heading), section: heading,
    title: analysis === "completeness_threshold" ? "SOP sintetica - Clinical Operations" : "Regole deviazioni ed escalation" });
  expect(reports(2)[1].analysis).toBe(analysis);
  expect(reports(2)[1].parameters_applied).toEqual(parameters);
});
it("mantiene completeness descrittiva senza inventare classificazioni", async () => {
  const fetch = mockHttp({ analyzeResult: body => ({
    analysis: body.analysis, scope: { group_by: body.group_by }, parameters_applied: {}, data_quality: {}, results: [{ site_id: "SITE_01", completeness_rate: 96.78 }],
  }) });
  replies({ tool_calls: [analyze({ analysis: "completeness", group_by: ["site_id"] })] }, { content: "KPI descrittivo." });
  await orchestrate("Mostra le percentuali di completeness per sito, senza classificazione.");
  expect(posted(fetch, 0)).toEqual({ analysis: "completeness", group_by: ["site_id"] });
  expect(reports(1)[0].results).toEqual([{ site_id: "SITE_01", completeness_rate: 96.78 }]);
  expect(reports(1)[0].parameters_applied).toEqual({});
});
it("non sostituisce soglie esterne con valori Novera impliciti", async () => {
  const parameters = { attention_threshold_percent: 98, escalation_threshold_percent: 97 };
  mockHttp({ analyzeResult: body => ({
    ...completenessFixture(body.parameters),
    results: [{ ...completenessFixture(body.parameters).results[0], classification: "escalation" }],
  }) });
  replies({ tool_calls: [analyze({ analysis: "completeness_threshold", group_by: ["site_id"], parameters })] }, { content: "Classificazione ricevuta." });
  await orchestrate("Applica le soglie già disponibili.");
  expect(reports(1)[0].analysis).toBe("completeness_threshold");
  expect(reports(1)[0].parameters_applied).toEqual(parameters);
  expect(reports(1)[0].results[0].classification).toBe("escalation");
});

// Distinzione tra duplicati rimossi, warning e record esclusi dalla specifica analisi.
it.each([[8, 15, 3], [4, 6, 2]])("conserva warning e zero esclusioni completeness (%i/%i/%i)", async (duplicates, dates, queries) => {
  const parameters = { attention_threshold_percent: 95, escalation_threshold_percent: 90 };
  const scope = { study_id: null, site_id: null, participant_id: null, visit_name: null, group_by: ["site_id"] };
  const values = [[807, 26, 96.78], [1048, 24, 97.71], [423, 12, 97.16], [911, 25, 97.26],
    [800, 17, 97.88], [974, 30, 96.92], [742, 17, 97.71], [963, 16, 98.34]];
  const results = values.map(([required, missing, rate], index) => ({
    site_id: `SITE_0${index + 1}`, required_assessments_total: required,
    missing_assessments_total: missing, completed_assessments_total: required - missing,
    completeness_rate: rate, classification: "no_action",
  }));
  const data_quality = {
    duplicates_removed: duplicates, inconsistent_actual_dates: dates, inconsistent_query_rows: queries,
    excluded_records: 0, exclusions_by_reason: {},
    warnings: [`${duplicates} duplicati esatti rimossi dalla vista analitica.`, `${dates} actual_date incoerenti.`, `${queries} righe query incoerenti.`],
  };
  const fetch = mockHttp({
    retrieve: async () => [{ source: sop, section: "Data completeness", text: section(sop, "Data completeness"), distance: 0.15 }],
    analyzeResult: body => ({ analysis: body.analysis, scope, parameters_applied: body.parameters, results, data_quality }),
  });
  replies({ tool_calls: [search("Data completeness")] },
    { tool_calls: [analyze({ analysis: "completeness_threshold", group_by: ["site_id"], parameters })] },
    { content: "Risposta simulata, senza riscrittura." });
  const final = await orchestrate("Quali siti richiedono attenzione o escalation per data completeness secondo Novera?");
  expect(reports(2)[0].results[0]).toEqual({ title: "SOP sintetica - Clinical Operations", section: "Data completeness", text: section(sop, "Data completeness") });
  expect(reports(2)[1]).toEqual({ analysis: "completeness_threshold", scope, parameters_applied: parameters, results, data_quality });
  expect(posted(fetch, 1)).toEqual({ analysis: "completeness_threshold", group_by: ["site_id"], parameters });
  expect(final.tools_used).toEqual(["search_knowledge", "analyze_operations"]);
  expect(final.answer).not.toContain("Risposta simulata, senza riscrittura.");
  expect(final.answer).toContain(`Duplicati rimossi dalla vista analitica: ${duplicates}`);
  expect(final.answer).toContain("Record esclusi dalla specifica analisi: 0");
  for (const row of results) expect(final.answer).toContain(row.site_id);
});
it("preserva le esclusioni out-of-window distinte dai warning generali", async () => {
  const scope = { group_by: ["site_id"] };
  const results = [{ site_id: "SITE_01", out_of_window_rate: 18.12, threshold_exceeded: true }];
  const data_quality = {
    duplicates_removed: 8, inconsistent_actual_dates: 15, inconsistent_query_rows: 3,
    excluded_records: 15, exclusions_by_reason: { "date visita inutilizzabili": 15 },
    warnings: ["8 duplicati esatti rimossi dalla vista analitica.", "15 actual_date incoerenti.", "3 righe query incoerenti.", "15 righe escluse dal calcolo pertinente: date visita inutilizzabili."],
  };
  const fetch = mockHttp({ analyzeResult: body => ({ analysis: body.analysis, scope, parameters_applied: body.parameters, results, data_quality }) });
  replies({ tool_calls: [analyze({ analysis: "out_of_window", group_by: ["site_id"] })] }, { content: "Review richiesta." });
  await orchestrate("Quali siti superano la soglia Novera di visite out-of-window?");
  const report = reports(1)[0];
  expect(report.data_quality).toEqual(data_quality);
  expect(report.scope).toEqual(scope);
  expect(report.results).toEqual(results);
  expect(report.parameters_applied).toEqual({ rate_threshold_percent: 10 });
  expect(report.document_support.coverage.complete).toBe(true);
  expect(report.document_support.sources).toHaveLength(10);
  expect(posted(fetch).parameters.visit_windows).toHaveLength(35);
});