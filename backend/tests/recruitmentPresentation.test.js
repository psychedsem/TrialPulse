import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../src/llm.js", () => ({ generateCompletion: vi.fn() }));
import { generateCompletion } from "../src/llm.js";
import { orchestrate } from "../src/orchestrator.js";
import { readFileSync } from "node:fs";

const report = () => ({
  analysis: "recruitment_target",
  scope: { study_id: null, site_id: "SITE_03", participant_id: null, visit_name: null, group_by: [] },
  parameters_applied: { threshold_percent: 75, consecutive_months: 2 },
  results: [
    { study_id: "NNR-PSI-01", site_id: "SITE_03", monthly: [
      { month: "2026-02", actual_enrolled: 2, target_enrolled: 2, achievement_percent: 100, below_threshold: false },
      { month: "2026-03", actual_enrolled: 1, target_enrolled: 2, achievement_percent: 50, below_threshold: true },
      { month: "2026-04", actual_enrolled: 1, target_enrolled: 2, achievement_percent: 50, below_threshold: true },
      { month: "2026-05", actual_enrolled: 0, target_enrolled: 2, achievement_percent: 0, below_threshold: true },
      { month: "2026-06", actual_enrolled: 1, target_enrolled: 2, achievement_percent: 50, below_threshold: true },
    ], trigger_met: true, first_trigger_months: ["2026-03", "2026-04"] },
    { study_id: "NNR-SER-04", site_id: "SITE_03", monthly: [
      { month: "2026-02", actual_enrolled: 3, target_enrolled: 3, achievement_percent: 100, below_threshold: false },
      { month: "2026-03", actual_enrolled: 1, target_enrolled: 3, achievement_percent: 33.33, below_threshold: true },
      { month: "2026-04", actual_enrolled: 1, target_enrolled: 3, achievement_percent: 33.33, below_threshold: true },
      { month: "2026-05", actual_enrolled: 1, target_enrolled: 3, achievement_percent: 33.33, below_threshold: true },
    ], trigger_met: true, first_trigger_months: ["2026-03", "2026-04"] },
  ],
  data_quality: { duplicates_removed: 8, inconsistent_actual_dates: 15, inconsistent_query_rows: 3,
    excluded_records: 0, exclusions_by_reason: {}, warnings: [] },
});
const call = (args, id = "monthly") => ({ role: "assistant", content: null, tool_calls: [{
  id, type: "function", function: { name: "analyze_operations", arguments: JSON.stringify(args) },
}] });
const args = { analysis: "recruitment_target", filters: { site_id: "SITE_03" },
  parameters: { threshold_percent: 75, consecutive_months: 2 } };
const rulesDocument = readFileSync(new URL("../../knowledge_base/operations/deviation_escalation_rules.md", import.meta.url), "utf8");
const rules = { source: "knowledge_base/operations/deviation_escalation_rules.md", section: "Altre escalation operative",
  text: rulesDocument.slice(rulesDocument.indexOf("## Altre escalation operative")).trim(), distance: 0.1 };
let transport;
beforeEach(() => {
  vi.resetAllMocks();
  transport = vi.fn();
  vi.stubGlobal("fetch", transport);
});
afterEach(() => vi.unstubAllGlobals());

async function run(value = report(), message = "Recruitment SITE_03 PSI e SER da febbraio a giugno 2026") {
  transport.mockResolvedValue({ ok: true, json: async () => value });
  generateCompletion.mockResolvedValueOnce(call({ ...args, parameters: value.parameters_applied })).mockResolvedValueOnce({ role: "assistant",
    content: "Non sono stati trovati dati mancanti. Qualsiasi valore non presente è stato trattato come zero." });
  return orchestrate(message);
}

it("preserva le nove righe e distingue lo zero PSI maggio dal mese SER non restituito", async () => {
  const result = await run();
  expect(result.answer).toContain("| 2026-05 | 0 | 2 | 0 | sì |");
  expect(result.answer).toContain("NNR-SER-04");
  expect(result.answer).toContain("Mesi presenti negli altri risultati, non in questo gruppo: 2026-06");
  expect(result.answer).not.toContain("trattato come zero");
  expect(result.answer).not.toContain("Non sono stati trovati dati mancanti");
  const rows = result.answer.split("\n").filter(line => /^\| 2026-/.test(line));
  expect(rows).toEqual([
    "| 2026-02 | 2 | 2 | 100 | no |", "| 2026-03 | 1 | 2 | 50 | sì |",
    "| 2026-04 | 1 | 2 | 50 | sì |", "| 2026-05 | 0 | 2 | 0 | sì |", "| 2026-06 | 1 | 2 | 50 | sì |",
    "| 2026-02 | 3 | 3 | 100 | no |", "| 2026-03 | 1 | 3 | 33.33 | sì |",
    "| 2026-04 | 1 | 3 | 33.33 | sì |", "| 2026-05 | 1 | 3 | 33.33 | sì |",
  ]);
  expect(result.tools_used).toEqual(["analyze_operations"]);
});

it("un intervallo richiesto più ampio non estende la copertura né aggiunge mesi", async () => {
  const result = await run(report(), "Mostra il recruitment da gennaio a dicembre 2026");
  expect(result.answer).toContain("Copertura verificata: soltanto i mesi restituiti");
  expect(result.answer).not.toMatch(/\| 2026-(?:01|07|08|09|10|11|12) \|/);
});

it("l'assenza di un mese non attesta un dato mancante o un periodo fuori calendario", async () => {
  const value = report();
  value.results = [value.results[1]];
  const result = await run(value);
  expect(result.answer).toContain("non attesta da solo un dato mancante o un periodo fuori calendario");
  expect(result.answer).toContain("2026-02, 2026-03, 2026-04, 2026-05");
  expect(result.answer).not.toContain("2026-06");
});

it("mantiene mesi discontinui senza interpolare o inventare zeri", async () => {
  const value = report();
  value.results = [value.results[0]];
  value.results[0].monthly = [value.results[0].monthly[0], value.results[0].monthly[4]];
  value.results[0].trigger_met = false;
  value.results[0].first_trigger_months = null;
  const result = await run(value);
  expect(result.answer).toContain("2026-02, 2026-06");
  expect(result.answer).not.toMatch(/\| 2026-0[345] \|/);
});

it("conserva parametri applicati, filtri, trigger e warning attestati senza assegnarli a mesi", async () => {
  const value = report();
  value.parameters_applied = { threshold_percent: 80, consecutive_months: 3 };
  value.results.forEach(group => { group.first_trigger_months = ["2026-03", "2026-04", "2026-05"]; });
  value.data_quality.excluded_records = 1;
  value.data_quality.exclusions_by_reason = { "enrollment_date mancante o non valida": 1 };
  value.data_quality.warnings = ["1 righe escluse dal calcolo pertinente: enrollment_date mancante o non valida."];
  const result = await run(value);
  expect(result.answer).toContain("80%");
  expect(result.answer).toContain("3 mesi consecutivi");
  expect(result.answer).toContain("SITE_03");
  expect(result.answer).toContain("2026-03, 2026-04, 2026-05");
  expect(result.answer).toContain("enrollment_date mancante o non valida");
  expect(result.answer).toContain("Date incoerenti segnalate: 15");
  expect(result.answer).toContain("Record esclusi dalla specifica analisi: 1");
});

it("report incompleti non consentono una conclusione libera o righe stimate", async () => {
  const value = report();
  delete value.results[0].monthly[0].actual_enrolled;
  const result = await run(value);
  expect(result.answer).toMatch(/report recruitment incompleto o incoerente/i);
  expect(result.answer).not.toContain("trattato come zero");
});

it("più chiamate analitiche conservano le coperture separate e il contesto precedente", async () => {
  const value = report();
  transport.mockResolvedValueOnce({ ok: true, json: async () => ({ ...value, results: [value.results[0]] }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ ...value, results: [value.results[1]] }) });
  generateCompletion.mockResolvedValueOnce(call({ ...args, filters: { ...args.filters, study_id: "NNR-PSI-01" } }, "psi"))
    .mockResolvedValueOnce(call({ ...args, filters: { ...args.filters, study_id: "NNR-SER-04" } }, "ser"))
    .mockResolvedValueOnce({ role: "assistant", content: "Tutti i mesi richiesti sono disponibili." });
  const result = await orchestrate("E i mesi successivi?", [{ role: "user", content: "Recruitment SITE_03" },
    { role: "assistant", content: "Contesto precedente" }]);
  expect(result.answer).toContain("NNR-PSI-01");
  expect(result.answer).toContain("Mesi presenti negli altri risultati, non in questo gruppo: 2026-06");
  expect(result.answer).not.toContain("Tutti i mesi richiesti sono disponibili");
  expect(generateCompletion.mock.calls[2][0].slice(1, 3)).toEqual([
    { role: "user", content: "Recruitment SITE_03" }, { role: "assistant", content: "Contesto precedente" },
  ]);
});

it.each(["mese_invalido", "mese_duplicato", "conteggio_assente", "gruppo_nullo", "riga_nulla", "identificativo_assente"])(
  "blocca la presentazione del report non verificabile: %s", async problem => {
    const value = report();
    if (problem === "mese_invalido") value.results[0].monthly[0].month = "2026-13";
    if (problem === "mese_duplicato") value.results[0].monthly[1].month = "2026-02";
    if (problem === "conteggio_assente") value.results[0].monthly[0].actual_enrolled = null;
    if (problem === "gruppo_nullo") value.results[0] = null;
    if (problem === "riga_nulla") value.results[0].monthly[0] = null;
    if (problem === "identificativo_assente") delete value.results[0].site_id;
    const result = await run(value);
    expect(result.answer).toMatch(problem === "gruppo_nullo" ?
      /Non ho ottenuto nessun risultato analitico verificato/ : /report recruitment incompleto o incoerente/i);
    expect(result.answer).not.toMatch(/\| 2026-/);
  });

it("un report vuoto non viene presentato come arruolamento zero o copertura completa", async () => {
  const value = report();
  value.results = [];
  const result = await run(value);
  expect(result.answer).toContain("Nessun gruppo restituito");
  expect(result.answer).not.toMatch(/\| 2026-/);
  expect(result.answer).not.toContain("trattato come zero");
});

it("le metriche non calcolabili restano tali e non vengono convertite in zero", async () => {
  const value = report();
  value.results = [value.results[0]];
  value.results[0].monthly = [{ month: "2026-02", actual_enrolled: 0, target_enrolled: 0,
    achievement_percent: null, below_threshold: null }];
  value.results[0].trigger_met = false;
  value.results[0].first_trigger_months = null;
  const result = await run(value);
  expect(result.answer).toContain("| 2026-02 | 0 | 0 | non calcolabile | non calcolabile |");
});

it("preserva report misti e fonti consultate senza attestare regole non applicate", async () => {
  const data = report();
  transport.mockResolvedValueOnce({ ok: true, json: async () => ({ results: [{
    source: "knowledge_base/operations/clinical_operations_sop.md", section: "Recruitment",
    text: "Supporto documentale", id: "diagnostic-secret", distance: 0.1,
  }] }) }).mockResolvedValueOnce({ ok: true, json: async () => data })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ analysis: "queries", scope: { group_by: [] },
      parameters_applied: {}, results: [{ open_queries: 12 }], data_quality: { warnings: [] } }) });
  generateCompletion.mockResolvedValueOnce({ tool_calls: [{ id: "rag", type: "function", function: {
    name: "search_knowledge", arguments: JSON.stringify({ query: "Recruitment Novera" }),
  } }] }).mockResolvedValueOnce({ tool_calls: [call(args).tool_calls[0], call({ analysis: "queries" }, "queries").tool_calls[0]] })
    .mockResolvedValueOnce({ role: "assistant", content: "Valori assenti uguali a zero." });
  const result = await orchestrate("Recruitment e query");
  expect(result.answer).toContain("12");
  expect(result.answer).toContain("Documenti Novera consultati");
  expect(result.answer).toContain("SOP sintetica - Clinical Operations");
  expect(result.answer).toContain("dati sintetici");
  expect(result.answer).not.toMatch(/diagnostic-secret|distance|Regole documentali attestate e applicate|Valori assenti uguali a zero/);
});

it("una richiesta mista conserva il report operativo senza pubblicare una raccomandazione terapeutica", async () => {
  transport.mockResolvedValue({ ok: true, json: async () => report() });
  generateCompletion.mockResolvedValueOnce(call(args)).mockResolvedValueOnce({ role: "assistant",
    content: "Raccomando il trattamento con più arruolati." });
  const result = await orchestrate("Confronta il recruitment e raccomanda un trattamento a un paziente.");
  expect(result.answer).toContain("| 2026-05 | 0 | 2 | 0 | sì |");
  expect(result.answer).not.toContain("Raccomando il trattamento");
  expect(result.answer).toContain("non consentono di valutare la superiorità clinica");
});

async function runWithRules(chunk, parameters = args.parameters) {
  const value = report();
  value.parameters_applied = parameters;
  transport.mockResolvedValueOnce({ ok: true, json: async () => ({ results: [chunk] }) })
    .mockResolvedValueOnce({ ok: true, json: async () => value });
  generateCompletion.mockResolvedValueOnce({ tool_calls: [{ id: "rag", type: "function", function: {
    name: "search_knowledge", arguments: JSON.stringify({ query: "Recruitment Novera" }),
  } }] }).mockResolvedValueOnce(call({ ...args, parameters }))
    .mockResolvedValueOnce({ role: "assistant", content: "Avvia procedure aggiuntive obbligatorie." });
  return orchestrate("Applica la regola Novera recruitment e indica l'azione prevista.");
}

it("presenta la site review soltanto dalla regola recuperata, verificata e coerente con i parametri", async () => {
  const result = await runWithRules(rules);
  expect(result.answer.match(/Azione Novera attestata: site review\./g)).toHaveLength(2);
  expect(result.answer).toContain("Regole documentali attestate e applicate");
  expect(result.answer).not.toContain("procedure aggiuntive obbligatorie");
  expect(result.answer).toContain("2026-03, 2026-04");
});

it.each(["testo_alterato", "parametri_diversi", "fonte_non_verificata"])("non attribuisce un'azione alla KB con %s", async problem => {
  const chunk = { ...rules };
  if (problem === "testo_alterato") chunk.text = chunk.text.replace("site review", "nuova procedura");
  if (problem === "fonte_non_verificata") chunk.source = "unknown.md";
  const result = await runWithRules(chunk, problem === "parametri_diversi" ? { threshold_percent: 80, consecutive_months: 2 } : args.parameters);
  expect(result.answer).not.toContain("Azione Novera attestata:");
  expect(result.answer).not.toContain("Regole documentali attestate e applicate");
});