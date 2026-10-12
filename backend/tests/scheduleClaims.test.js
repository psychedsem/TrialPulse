import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
vi.mock("../src/llm.js", () => ({ generateCompletion: vi.fn() }));
import { generateCompletion } from "../src/llm.js";
import { orchestrate } from "../src/orchestrator.js";
import request from "supertest";
import { app } from "../src/app.js";
import { selectHistory } from "../../frontend/src/conversation.js";
import { presentScheduleClaims } from "../src/scheduleClaims.js";

const source = "knowledge_base/reference/visit_schedule_windows.md";
const ids = ["NNR-PSI-01", "NNR-ESK-02", "NNR-DXB-03", "NNR-SER-04"];
function section(path, title) {
  const text = readFileSync(new URL(`../../${path}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const headings = [...text.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)];
  const index = headings.findIndex(item => item[1] === title);
  if (index < 0) throw new Error("Sezione fixture inesistente");
  return { source: path, section: title, text: text.slice(headings[index].index, headings[index + 1]?.index ?? text.length).trim(), distance: 0.15 };
}
const tables = ids.map(id => section(source, id));
const faq = section("knowledge_base/faq.md", "Qual è la finestra della Week 6?");
const rule = section("knowledge_base/operations/deviation_escalation_rules.md", "Altre escalation operative");
const wrong = "La visita Week 6 è programmata per il giorno +42 e la finestra operativa consentita è ±4 giorni (tra il giorno +38 e il giorno +46).";
beforeEach(() => { vi.resetAllMocks(); vi.stubGlobal("fetch", vi.fn()); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function run(message, answer, chunks = tables, history = [], search = true) {
  if (search) {
    fetch.mockResolvedValue({ ok: true, json: async () => ({ results: chunks }) });
    generateCompletion.mockResolvedValueOnce({ tool_calls: [{ id: "s1", type: "function", function: {
      name: "search_knowledge", arguments: JSON.stringify({ query: message }),
    } }] });
  }
  generateCompletion.mockResolvedValueOnce({ content: typeof answer === "string" ? answer : JSON.stringify(answer) });
  return orchestrate(message, history);
}
const claim = (index, overrides = {}) => ({ study_id: ids[index], visit_name: "Week 6", target_day: 42,
  window_days: [4, 2, 4, 5][index], source, section: ids[index], ...overrides });
const packet = (...facts) => ({ schedule_facts: facts });

it.each([
  ["facts_missing", "Week 6: giorno target 42, finestra ±2 giorni.", [tables[1]]],
  ["facts_invalid", { schedule_facts: [] }, [tables[1]]],
  ["fact_invalid", packet(claim(1, { target_day: "42" })), [tables[1]]],
  ["study_scope_mismatch", packet(claim(0)), [tables[0]]],
  ["evidence_missing", packet(claim(1)), []],
  ["evidence_conflict", packet(claim(1)), [tables[1], { ...tables[1], text: "contenuto sintetico alterato" }]],
  ["evidence_unverified", packet(claim(1)), [{ ...tables[1], text: "contenuto sintetico alterato" }]],
  ["visit_value_unavailable", packet(claim(1, { visit_name: "Week6" })), [tables[1]]],
  ["value_not_attested", packet(claim(1, { window_days: 3 })), [tables[1]]],
  ["duplicate_fact", packet(claim(1), claim(1)), [tables[1]]],
])("diagnostica il motivo realmente verificato senza pubblicarlo: %s", async (code, content, knowledge) => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const answer = await presentScheduleClaims(typeof content === "string" ? content : JSON.stringify(content),
    knowledge, "Week 6 NNR-ESK-02");
  expect(answer).toContain("Informazioni di calendario non verificate");
  expect(warn.mock.calls.flat().join(" ")).toContain(`code=${code};`);
  expect(answer).not.toContain(code);
});

it.each([0, 1])("registra soltanto una verifica riuscita per studio documentato: %s", async index => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const answer = await presentScheduleClaims(JSON.stringify(packet(claim(index))), [tables[index]], `Week 6 ${ids[index]}`);
  expect(answer).toContain(`giorno target: 42; finestra: ±${[4, 2][index]} giorni`);
  expect(warn.mock.calls.flat().join(" ")).toContain("code=fact_verified;");
});

it("distingue il perimetro utente assente senza cambiare il chiarimento", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(await presentScheduleClaims(JSON.stringify(packet(claim(1))), [tables[1]], "Qual è la finestra Week 6?"))
    .toContain("Per quale studio");
  expect(warn.mock.calls.flat().join(" ")).toContain("code=scope_missing;");
});

it("distingue una fonte non ammessa anche se il chunk è stato recuperato", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const fact = claim(1, { source: "unknown.md" });
  const chunk = { ...tables[1], source: fact.source };
  expect(await presentScheduleClaims(JSON.stringify(packet(fact)), [chunk], "Week 6 ESK"))
    .toContain("Informazioni di calendario non verificate");
  expect(warn.mock.calls.flat().join(" ")).toContain("code=source_section_not_allowed;");
});

it("la diagnostica non registra contenuti privati e non interferisce se fallisce", async () => {
  const privateText = "canary_privata_prompt_documento";
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const content = JSON.stringify(packet(claim(1, { source: privateText })));
  const answer = await presentScheduleClaims(content, [], "Week 6 ESK", [
    { role: "user", content: privateText }, { role: "assistant", content: privateText },
  ]);
  const logs = warn.mock.calls.flat().join(" ");
  expect(logs).toContain("code=evidence_missing;");
  expect(logs).not.toMatch(/canary_privata|schedule_facts|target_day|window_days|knowledge_base/);
  warn.mockImplementation(() => { throw Error(privateText); });
  expect(await presentScheduleClaims(content, [], "Week 6 ESK")).toBe(answer);
  expect(await presentScheduleClaims(JSON.stringify(packet(claim(1))), [tables[1]], "Week 6 ESK"))
    .toContain("finestra: ±2 giorni");
});

it.each([
  ["Week 6 senza FAQ con sola tabella DXB", "Qual è la finestra consentita per la visita Week 6?", wrong, [tables[2]]],
  ["Week 6 senza FAQ con quattro tabelle", "Qual è la finestra consentita per la visita Week 6?", wrong, tables],
  ["Week 4 anonima", "Qual è la finestra Week 4?", "La finestra Week 4 è ±3 giorni.", [tables[2], tables[3]]],
  ["Baseline anonima", "Quando è prevista la Baseline?", "La Baseline è prevista al giorno 0.", tables],
])("chiede chiarimento nel replay %s", async (name, message, answer, chunks) => {
  const result = await run(message, answer, chunks);
  expect(result.answer).toMatch(/quale studio/i);
  expect(result.answer).not.toMatch(/±|giorno \+?\d/);
});
it("blocca la risposta numerica anonima senza retrieval", async () => {
  const result = await run("Qual è la finestra consentita per la visita Week 6?", wrong, [], [], false);
  expect(result.answer).toMatch(/quale studio|non verificat/i);
  expect(result.answer).not.toContain("±4");
});
it("una FAQ incidentale non blocca la regola generale di query aging", async () => {
  const answer = "Una query aperta oltre 10 giorni richiede escalation Data Management.";
  expect((await run("Quando una query deve essere escalata?", answer, [rule, faq])).answer).toContain(answer);
});

it.each(ids)("verifica la finestra effettiva di %s", async id => {
  const index = ids.indexOf(id);
  const result = await run(`Qual è la finestra Week 6 per ${id}?`, packet(claim(index)), [tables[index]]);
  expect(result.answer).toContain(id);
  expect(result.answer).toContain(`±${[4, 2, 4, 5][index]} giorni`);
  expect(result.answer).toContain("42");
  expect(result.answer).toContain("Documenti Novera consultati");
  expect(result.answer).not.toContain("schedule_facts");
});
it("non pubblica un fatto strutturato vero per uno studio non autorizzato", async () => {
  const result = await run("Qual è la finestra Week 6?", packet(claim(2)));
  expect(result.answer).toMatch(/quale studio/i);
  expect(result.answer).not.toContain("±4");
});
it("il chiarimento ESK e il follow-up PSI usano history utente effettiva", async () => {
  const question = "Qual è la finestra consentita per la visita Week 6?";
  const initial = await run(question, wrong, [tables[2]]);
  expect(initial.answer).toMatch(/quale studio/i);
  const history = [{ role: "user", content: question }, { role: "assistant", content: initial.answer }];
  const esk = await run("Mi riferisco allo studio NNR-ESK-02.", packet(claim(1)), tables, history);
  expect(esk.answer).toContain("±2 giorni");
  const psi = await run("E per lo studio PSI?", packet(claim(0)), tables, [
    ...history, { role: "user", content: "Mi riferisco allo studio NNR-ESK-02." }, { role: "assistant", content: esk.answer },
  ]);
  expect(psi.answer).toContain("±4 giorni");
  expect(psi.answer).not.toContain("±2 giorni");
  expect(psi.answer).not.toMatch(/confronto|incompleto/i);
});
it("una query PSI autosufficiente viene trasmessa senza ereditare ESK", async () => {
  const history = [{ role: "user", content: "Week 6 ESK?" }, { role: "assistant", content: "Day 42 ±2 giorni." }];
  generateCompletion.mockResolvedValueOnce({ tool_calls: [{ id: "psi-search", type: "function", function: {
    name: "search_knowledge", arguments: JSON.stringify({ query: "Finestra visita Week 6 NNR-PSI-01" }),
  } }] }).mockResolvedValueOnce({ content: JSON.stringify(packet(claim(0))) });
  fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ results: [tables[0]] }) });
  const result = await orchestrate("E per lo studio PSI?", history);
  expect(JSON.parse(fetch.mock.calls[0][1].body).query).toBe("Finestra visita Week 6 NNR-PSI-01");
  expect(generateCompletion.mock.calls[0][0].slice(1)).toEqual([...history, { role: "user", content: "E per lo studio PSI?" }]);
  expect(result.answer).toContain("±4 giorni");
  expect(result.answer).not.toMatch(/NNR-ESK-02|confronto|incompleto/);
});
it("una fonte solo ESK non attesta la finestra PSI nel follow-up", async () => {
  const history = [{ role: "user", content: "Week 6 ESK?" }, { role: "assistant", content: "Day 42 ±2 giorni." }];
  const result = await run("E per lo studio PSI?", packet(claim(0)), [tables[1]], history);
  expect(result.answer).toMatch(/non verificate/i);
  expect(result.answer).not.toMatch(/±4|confronto/);
});
it("non ricava la selezione da un precedente turno assistant", async () => {
  const history = [{ role: "user", content: "Quale studio?" }, { role: "assistant", content: "NNR-ESK-02" }];
  expect((await run("E la finestra?", packet(claim(1)), tables, history)).answer).toMatch(/quale studio/i);
});
it("un confronto completo presenta tutti e quattro gli studi", async () => {
  const result = await run("Confronta le finestre Week 6 di tutti gli studi", packet(...ids.map((id, i) => claim(i))));
  for (const id of ids) expect(result.answer).toContain(id);
  expect(result.answer).not.toMatch(/incompleto|quale studio/i);
});
it("un confronto parziale identifica le informazioni non disponibili", async () => {
  const result = await run("Confronta le finestre Week 6 di tutti gli studi", packet(claim(2)), [tables[2]]);
  expect(result.answer).toMatch(/incomplet/i);
  expect(result.answer).toContain("NNR-DXB-03");
  expect(result.answer).toContain("±4 giorni");
  expect(result.answer).toContain("NNR-ESK-02");
  expect(result.answer).toMatch(/non disponibile/i);
});
it.each([
  ["valore sbagliato", packet(claim(1, { window_days: 4 }))],
  ["target sbagliato", packet(claim(1, { target_day: 41 }))],
  ["studio non coerente con la sezione", packet(claim(1, { section: ids[2] }))],
  ["fonte non recuperata", packet(claim(1, { source: "knowledge_base/protocols/NNR-ESK-02.md", section: "Schedule" }))],
  ["fatti mancanti", { schedule_facts: [] }],
  ["dichiarazione generale ingannevole", { mode: "general", answer: "La finestra Week 6 è ±4 giorni." }],
  ["prosa contraddittoria aggiunta", { ...packet(claim(1)), answer: "La finestra universale è ±4 giorni." }],
  ["duplicati", packet(claim(1), claim(1))],
])("blocca %s senza ritorno alla prosa libera", async (name, answer) => {
  const result = await run("Qual è la finestra Week 6 ESK?", answer, [tables[1]]);
  expect(result.answer).toMatch(/non verificat|incomplet|non disponibile/i);
  expect(result.answer).not.toMatch(/±\d/);
});
it("non accetta un chunk modificato anche quando contiene il valore dichiarato", async () => {
  const changed = { ...tables[1], text: tables[1].text.replace("**±2 giorni**", "**±9 giorni**") };
  expect((await run("Week 6 ESK?", packet(claim(1, { window_days: 9 })), [changed])).answer).not.toContain("±9");
});
it("supporta target e finestre di altre visite senza costanti Week 6", async () => {
  const result = await run("Baseline per PSI?", packet(claim(0, { visit_name: "Preparazione 2 / Baseline", target_day: -3, window_days: 1 })), [tables[0]]);
  expect(result.answer).toContain("-3");
  expect(result.answer).toContain("±1 giorno");
});
it("preserva una spiegazione generale delle finestre senza valori specifici", async () => {
  const answer = "Le finestre sono tolleranze espresse in giorni rispetto al target.";
  expect((await run("Cosa sono le finestre operative?", answer, [faq, rule])).answer).toContain(answer);
});
it("blocca la dichiarazione generale ingannevole anche con escape JSON", async () => {
  const answer = '{"mode":"general","answer":"La finestra è \\u00b14 giorni."}';
  expect((await run("Qual è la finestra?", answer)).answer).toMatch(/quale studio/i);
});
it("blocca un contratto troncato senza pubblicarlo come prosa", async () => {
  const result = await run("Calendario ESK?", '{"schedule_facts":[{"study_id":"NNR-ESK-02"');
  expect(result.answer).toMatch(/non verificate/i);
  expect(result.answer).not.toContain("schedule_facts");
});
it("blocca valori in lettere nella prosa di calendario", async () => {
  const result = await run("Qual è la finestra?", "La finestra consentita è quattro giorni.");
  expect(result.answer).toMatch(/quale studio/i);
});
it("blocca sezioni conflittuali senza scegliere il primo chunk", async () => {
  const altered = { ...tables[1], text: tables[1].text.replace("**±2 giorni**", "**±9 giorni**") };
  const result = await run("Week 6 ESK?", packet(claim(1)), [tables[1], altered]);
  expect(result.answer).toMatch(/non verificate/i);
  expect(result.answer).not.toContain("±2");
});
it("verifica una finestra zero presente nella tabella", async () => {
  const result = await run("Baseline ESK?", packet(claim(1, { visit_name: "Baseline", target_day: 0, window_days: 0 })), [tables[1]]);
  expect(result.answer).toContain("giorno target: 0");
  expect(result.answer).toContain("±0 giorni");
});
it("un protocollo può attestare un target ma non una finestra assente", async () => {
  const protocol = section("knowledge_base/protocols/NNR-ESK-02.md", "Schedule");
  const fact = { study_id: ids[1], visit_name: "Week 6", target_day: 42, source: protocol.source, section: protocol.section };
  expect((await run("Target Week 6 ESK?", packet(fact), [protocol])).answer).toContain("giorno target: 42");
  expect((await run("Finestra Week 6 ESK?", packet({ ...fact, window_days: 2 }), [protocol])).answer).toMatch(/non verificate/i);
});
it("una nuova conversazione non eredita una selezione precedente", async () => {
  await run("Week 6 ESK?", packet(claim(1)), [tables[1]]);
  const result = await run("Qual è la finestra?", packet(claim(1)), [tables[1]]);
  expect(result.answer).toMatch(/quale studio/i);
});
it("non accetta uno studio negato o un gruppo extra nella risposta", async () => {
  expect((await run("Non scegliere DXB", packet(claim(2)), tables)).answer).toMatch(/quale studio/i);
  expect((await run("Week 6 ESK?", packet(claim(1), claim(2)), tables)).answer).toMatch(/non verificate/i);
});
it.each([null, "2", -1, 1.5])("rifiuta window_days non valido: %s", async window_days => {
  expect((await run("Week 6 ESK?", packet(claim(1, { window_days })), [tables[1]])).answer).toMatch(/non verificate/i);
});
it("conserva gli identificatori degli evidence e non aggiunge tool o round", async () => {
  const result = await run("Week 6 ESK?", packet(claim(1)), [tables[1]]);
  const messages = generateCompletion.mock.calls[1][0];
  const evidence = JSON.parse(messages.at(-1).content).results[0].schedule_evidence;
  expect(evidence).toEqual({ source, section: ids[1] });
  expect(messages.at(-1).tool_call_id).toBe("s1");
  expect(result.tools_used).toEqual(["search_knowledge"]);
  expect(generateCompletion).toHaveBeenCalledTimes(2);
});
it.each([
  "La finestra è ±4.", "±4", "La finestra è di quattro giorni.",
  "**Finestra:**\n\n±4", "**Day** +42", "La visita Baseline è nello stesso giorno.",
  '{"mode":"general","facts":[{"target_day":42,"window_days":4}]}',
])("non pubblica una regola anonima fuori dal contratto: %s", async answer => {
  expect((await run("Qual è la finestra?", answer, [])).answer).toMatch(/quale studio/i);
});
it("non confonde una dispersione numerica Data-only con una finestra visita", async () => {
  generateCompletion.mockResolvedValueOnce({ tool_calls: [{ id: "d1", type: "function", function: {
    name: "analyze_operations", arguments: JSON.stringify({ analysis: "efficacy", filters: { study_id: ids[1] } }),
  } }] }).mockResolvedValueOnce({ content: "MADRS medio: 18 ±2, dati sintetici descrittivi." });
  fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ analysis: "efficacy", scope: { study_id: ids[1] },
    parameters_applied: {}, data_quality: {}, results: [{ visit_name: "Week 6", mean_score: 18, observations: 10 }] }) });
  const result = await orchestrate("Descrivi i punteggi MADRS ESK.");
  expect(result.answer).toContain("MADRS medio: 18 ±2");
  expect(result.answer).not.toMatch(/quale studio|non verificate/i);
});

async function replayPsi(query, chunks, answer, withData = false) {
  const question = "Qual è la finestra prevista per la Week 6?";
  const initial = await run(question, "Per quale studio desideri conoscere la finestra?", [faq]);
  const previous = [{ role: "user", content: question }, { role: "assistant", content: initial.answer }];
  const clarification = "Mi riferisco allo studio NNR-ESK-02.";
  const esk = await run(clarification, packet(claim(1)), [tables[1]], selectHistory(previous));
  expect(esk.answer).toContain("±2 giorni");
  const history = selectHistory([...previous,
    { role: "user", content: clarification }, { role: "assistant", content: esk.answer }]);
  generateCompletion.mockReset();
  fetch.mockReset();
  const calls = [{ id: "psi-search", type: "function", function: {
    name: "search_knowledge", arguments: JSON.stringify({ query }),
  } }];
  if (withData) calls.push({ id: "unrelated-data", type: "function", function: {
    name: "analyze_operations", arguments: JSON.stringify({ analysis: "portfolio_summary" }),
  } });
  generateCompletion.mockResolvedValueOnce({ tool_calls: calls })
    .mockResolvedValueOnce({ content: typeof answer === "string" ? answer : JSON.stringify(answer) });
  fetch.mockImplementation(async url => ({ ok: true, json: async () => url.endsWith("/retrieve") ?
    { results: chunks } : { analysis: "portfolio_summary", scope: { group_by: [] },
      parameters_applied: {}, data_quality: {}, results: [{ enrolled: 154 }] } }));
  const response = await request(app).post("/api/chat").send({ message: "E per lo studio PSI?", history });
  expect(response.status).toBe(200);
  expect(generateCompletion.mock.calls[0][0].slice(1)).toEqual([
    ...history, { role: "user", content: "E per lo studio PSI?" },
  ]);
  expect(JSON.parse(fetch.mock.calls[0][1].body).query).toBe(query);
  expect(generateCompletion.mock.calls[1][0].filter(turn => turn.role === "tool").map(turn => turn.tool_call_id))
    .toEqual(calls.map(call => call.id));
  return response.body;
}

const genericPsi = [section(source, "Schedule e visit windows"),
  section("knowledge_base/faq.md", "Come si valuta un sito con molte visite fuori finestra?"),
  section("knowledge_base/operations/site_monitoring_guidelines.md", "Site Monitoring Guidelines"),
  section("knowledge_base/protocols/NNR-PSI-01.md", "Profilo dello studio")];

it("il replay HTTP completo conserva Week 6 nella history e seleziona PSI con evidenze corrette", async () => {
  const result = await replayPsi("Finestra visita Week 6 NNR-PSI-01", [tables[0]], packet(claim(0)));
  expect(result.answer).toContain("NNR-PSI-01; Week 6: giorno target: 42; finestra: ±4 giorni");
  expect(result.answer).not.toMatch(/NNR-ESK-02|Dati analizzati|non verificate/);
  expect(result.tools_used).toEqual(["search_knowledge"]);
});
it("una query priva di Week 6 non viene riscritta e fonti PSI generiche non attestano la finestra", async () => {
  const result = await replayPsi("E per lo studio PSI?", genericPsi, packet(claim(0)));
  expect(result.answer).toContain("Informazioni di calendario non verificate");
  expect(result.answer).not.toMatch(/±4|Dati analizzati/);
  expect(result.tools_used).toEqual(["search_knowledge"]);
});
it("una query generica resta verificabile se il retrieval restituisce la tabella pertinente", async () => {
  const result = await replayPsi("E per lo studio PSI?", [tables[0]], packet(claim(0)));
  expect(result.answer).toContain("±4 giorni");
});
it.each([
  ["fatti assenti", "La visita Week 6 ha target Day 42 e finestra ±4 giorni."],
  ["fatti incoerenti", packet(claim(0, { window_days: 2 }))],
])("la fonte PSI corretta non sostituisce %s", async (name, answer) => {
  const result = await replayPsi("Week 6 NNR-PSI-01", [tables[0]], answer);
  expect(result.answer).toContain("Informazioni di calendario non verificate");
  expect(result.answer).not.toMatch(/±4|Dati analizzati/);
});
it("il replay con analisi non pertinente riproduce rifiuto documentale e provenienza CSV", async () => {
  const result = await replayPsi("E per lo studio PSI?", genericPsi, packet(claim(0)), true);
  expect(result.answer).toContain("Informazioni di calendario non verificate");
  expect(result.answer).toContain("Dati analizzati:** CSV operativo TrialPulse (dati sintetici)");
  expect(result.answer).not.toContain("±4");
  expect(result.tools_used).toEqual(["search_knowledge", "analyze_operations"]);
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ analysis: "portfolio_summary" });
});

it("il fatto PSI osservato sulla FAQ non sana il target non attestato", async () => {
  const observed = { study_id: "PSI", visit_name: "Week 6", target_day: 42, window_days: 4,
    source: faq.source, section: faq.section };
  const result = await replayPsi("Schedule visit windows PSI study week 6", [faq], packet(observed));
  expect(result.answer).toContain("Informazioni di calendario non verificate");
  expect(result.answer).not.toMatch(/±4|giorno target: 42/);
});
it.each(ids.map((id, i) => [id.split("-")[1], id, [4, 2, 4, 5][i]]))(
  "normalizza l'alias autorizzato %s senza inventare il target della FAQ", async (alias, id, window) => {
    const result = await run(`Finestra Week 6 ${alias}?`, packet({ study_id: alias, visit_name: "Week 6",
      window_days: window, source: faq.source, section: faq.section }), [faq]);
    expect(result.answer).toContain(`${id}; Week 6: finestra: ±${window} giorni.`);
    expect(result.answer).not.toContain("giorno target");
  });
it("il follow-up HTTP ESK poi PSI normalizza soltanto l'ID con tabella verificata", async () => {
  const result = await replayPsi("Week 6 NNR-PSI-01 target day visit window", [tables[0]], packet(claim(0, { study_id: "PSI" })));
  expect(result.answer).toContain("NNR-PSI-01; Week 6: giorno target: 42; finestra: ±4 giorni.");
  expect(result.tools_used).toEqual(["search_knowledge"]);
  expect(result.answer).not.toMatch(/NNR-ESK-02|Dati analizzati/);
});
it.each(["UNKNOWN", "PSI-extra", "NNR-PSI-02", "ESK", null, 3])(
  "non autorizza un ID sconosciuto o estraneo al perimetro PSI: %s", async study_id => {
    const result = await run("Week 6 PSI?", packet(claim(0, { study_id })), [tables[0]]);
    expect(result.answer).toContain("Informazioni di calendario non verificate");
    expect(result.answer).not.toContain("±4");
  });
it("l'alias PSI non è autorizzato dal solo studio ESK corrente", async () => {
  expect((await run("Week 6 ESK?", packet(claim(0, { study_id: "PSI" })), [tables[0]])).answer)
    .toContain("Informazioni di calendario non verificate");
});
it.each([
  { section: "PSI" }, { section: ids[1] }, { source: "knowledge_base/protocols/NNR-ESK-02.md", section: "Schedule" },
  { window_days: 9 },
])("l'alias non sana una fonte, sezione o valore incoerente: %j", async overrides => {
  const result = await run("Week 6 PSI?", packet(claim(0, { study_id: "PSI", ...overrides })), [tables[0]]);
  expect(result.answer).toContain("Informazioni di calendario non verificate");
});
it("alias e ID canonico non consentono due fatti per lo stesso studio e visita", async () => {
  const result = await run("Week 6 PSI?", packet(claim(0), claim(0, { study_id: "PSI" })), [tables[0]]);
  expect(result.answer).toContain("Informazioni di calendario non verificate");
});
it("gli alias mantengono il chiarimento quando nessuno studio è autorizzato", async () => {
  const result = await run("Qual è la finestra della Week 6?", packet(claim(0, { study_id: "PSI" })), [tables[0]]);
  expect(result.answer).toMatch(/quale studio/i);
  expect(result.answer).not.toContain("±4");
});
it("l'ID canonico non rende verificabile un target assente dalla FAQ", async () => {
  const result = await run("Target e finestra Week 6 PSI?", packet(claim(0, { source: faq.source, section: faq.section })), [faq]);
  expect(result.answer).toContain("Informazioni di calendario non verificate");
});
it("maiuscole e spazi esterni non cambiano l'identità dell'alias ufficiale", async () => {
  const result = await run("Week 6 PSI?", packet(claim(0, { study_id: " psi " })), [tables[0]]);
  expect(result.answer).toContain("NNR-PSI-01; Week 6: giorno target: 42; finestra: ±4 giorni.");
});
it("un confronto esplicito presenta ID canonici anche con fatti dichiarati tramite alias", async () => {
  const result = await run("Confronta Week 6 per tutti gli studi", packet(...ids.map((id, i) =>
    claim(i, { study_id: id.split("-")[1] }))));
  for (const [id, window] of [["NNR-PSI-01", 4], ["NNR-ESK-02", 2], ["NNR-DXB-03", 4], ["NNR-SER-04", 5]]) {
    expect(result.answer).toContain(`${id}; Week 6: giorno target: 42; finestra: ±${window} giorni.`);
  }
  expect(result.answer).not.toMatch(/incompleto|quale studio/i);
});
it("l'alias non consente di pubblicare valori senza una fonte recuperata", async () => {
  const result = await run("Week 6 PSI?", packet(claim(0, { study_id: "PSI" })), []);
  expect(result.answer).toContain("Informazioni di calendario non verificate");
  expect(result.answer).not.toContain("±4");
});
