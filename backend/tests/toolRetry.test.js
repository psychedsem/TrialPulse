import { afterEach, beforeEach, expect, it, vi } from "vitest";
import request from "supertest";
import { readFileSync } from "node:fs";

vi.mock("../src/config.js", () => ({
  GROQ_API_KEY: "offline-placeholder", GROQ_MODEL: "openai/gpt-oss-120b",
  GROQ_FALLBACK_MODEL: "openai/gpt-oss-20b",
  DATA_AGENT_URL: "http://127.0.0.1:8000", RAG_API_URL: "http://127.0.0.1:8001",
}));
const source = "knowledge_base/reference/visit_schedule_windows.md";
const text = readFileSync(new URL(`../../${source}`, import.meta.url), "utf8")
  .split(/(?=^#{1,6} )/m).find(section => section.startsWith("## NNR-ESK-02")).trim();
const chunk = { source, section: "NNR-ESK-02", text, distance: 0.1 };
const tool = (id = "rag-id", name = "search_knowledge") => ({ status: 200, body: { choices: [{ message: {
  role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name,
    arguments: JSON.stringify(name === "search_knowledge" ? { query: "NNR-ESK-02 Week 6" } : { analysis: "visits" }),
  } }],
} }] } });
const final = { status: 200, body: { choices: [{ message: { role: "assistant", content: JSON.stringify({
  schedule_facts: [{ study_id: "NNR-ESK-02", visit_name: "Week 6", target_day: 42,
    window_days: 2, source, section: "NNR-ESK-02" }],
}) } }] } };
const failure = (status = 400, fields = {}) => ({ status, body: { error: {
  code: "tool_use_failed", type: "invalid_request_error", message: "contenuto riservato",
  ...fields,
} } });
const history = [{ role: "user", content: "Qual è la finestra prevista per la Week 6?" },
  { role: "assistant", content: "Per quale studio?" }];
let app, orchestrate, steps, wire, rag, data, local, warn;
beforeEach(async () => {
  vi.resetModules();
  steps = []; wire = []; rag = []; data = [];
  local = { status: 200, body: { results: [chunk] } };
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("fetch", async (input, options = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.hostname === "api.groq.com") {
      wire.push(JSON.parse(options.body));
      const step = steps.shift();
      if (!step) throw new Error("Richiesta provider simulata inattesa");
      if (step.transportError) throw new Error("Connessione simulata interrotta");
      return Response.json(step.body, { status: step.status, headers: step.headers });
    }
    expect(url.hostname).toBe("127.0.0.1");
    if (url.pathname === "/retrieve") {
      rag.push(JSON.parse(options.body));
      return Response.json(local.body, { status: local.status });
    }
    expect(url.pathname).toBe("/analyze");
    data.push(JSON.parse(options.body));
    return Response.json({ analysis: "visits", results: [{ completed_visits: 7 }] });
  });
  ({ app } = await import("../src/app.js"));
  ({ orchestrate } = await import("../src/orchestrator.js"));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const send = () => request(app).post("/api/chat").send({ message: "Mi riferisco allo studio NNR-ESK-02.", history });
const models = () => wire.map(payload => payload.model);
const log = () => warn.mock.calls.flat().join(" ");

it.each([["PSI", "NNR-PSI-01"], ["ESK", "NNR-ESK-02"], ["DXB", "NNR-DXB-03"], ["SER", "NNR-SER-04"]])(
  "trasmette al vero SDK lo studio canonico per l'alias %s senza imporre tool", async (alias, id) => {
    steps = [{ status: 200, body: { choices: [{ message: { role: "assistant",
      content: "Indicami il codice canonico dello studio." } }] } }];
    const message = `E per lo studio ${alias}?`;
    const result = await request(app).post("/api/chat").send({ message, history });
    expect(result.body.tools_used).toEqual([]);
    expect(result.body.answer).toBe("Indicami il codice canonico dello studio.");
    expect(wire).toHaveLength(1);
    expect(wire[0].messages.slice(1)).toEqual([...history, { role: "user", content: message }]);
    const { SYSTEM_PROMPT } = await import("../src/systemPrompt.js");
    const context = wire[0].messages[0].content.slice(SYSTEM_PROMPT.length);
    expect(context.match(/NNR-[A-Z]{3}-\d{2}/g)).toEqual([id]);
    expect(context).not.toMatch(/target_day|window_days|±|42|95|90/);
    expect(wire[0].tool_choice).toBe("auto");
    expect(wire[0].tools.map(item => item.function.name)).toEqual(["search_knowledge", "analyze_operations"]);
    expect(rag).toHaveLength(0);
    expect(data).toHaveLength(0);
  });

it.each([
  ["Studio sconosciuto XYZ", []],
  ["Non scegliere PSI", []],
  ["Escludi NNR-ESK-02", []],
  ["Confronta PSI ed ESK", ["NNR-PSI-01", "NNR-ESK-02"]],
  ["Confronta tutti gli studi", ["NNR-PSI-01", "NNR-ESK-02", "NNR-DXB-03", "NNR-SER-04"]],
])("il contesto canonico rispetta il perimetro: %s", async (message, expected) => {
  steps = [{ status: 200, body: { choices: [{ message: { role: "assistant", content: "Risposta simulata." } }] } }];
  await request(app).post("/api/chat").send({ message });
  const { SYSTEM_PROMPT } = await import("../src/systemPrompt.js");
  expect(wire[0].messages[0].content.slice(SYSTEM_PROMPT.length).match(/NNR-[A-Z]{3}-\d{2}/g) ?? []).toEqual(expected);
  expect(wire[0].messages).toHaveLength(2);
});

it("nel follow-up PSI conserva Week 6 e history ESK senza duplicare o selezionare ESK", async () => {
  const turns = [...history, { role: "user", content: "Mi riferisco allo studio NNR-ESK-02." },
    { role: "assistant", content: "Week 6 ESK, risposta documentata." }];
  steps = [{ status: 200, body: { choices: [{ message: { role: "assistant", content: "Indicami il codice canonico." } }] } }];
  const result = await request(app).post("/api/chat").send({ message: "E per lo studio PSI?", history: turns });
  const { SYSTEM_PROMPT } = await import("../src/systemPrompt.js");
  expect(wire[0].messages[0].content.slice(SYSTEM_PROMPT.length).match(/NNR-[A-Z]{3}-\d{2}/g)).toEqual(["NNR-PSI-01"]);
  expect(wire[0].messages.slice(1)).toEqual([...turns, { role: "user", content: "E per lo studio PSI?" }]);
  expect(result.body.tools_used).toEqual([]);
  expect(result.body.answer).toBe("Indicami il codice canonico.");
});

it.each([
  ["Qual è la finestra Week 6?", [], []],
  ["Week 6", [{ role: "user", content: "Per ESK" }, { role: "assistant", content: "Quale visita?" }], ["NNR-ESK-02"]],
  ["Non scegliere PSI", [{ role: "user", content: "Per ESK" }, { role: "assistant", content: "Quale visita?" }], []],
  ["Week 6", [{ role: "user", content: "Quale studio?" }, { role: "assistant", content: "NNR-PSI-01" }], []],
])("il contesto usa solo selezioni utente pertinenti: %s", async (message, turns, expected) => {
  steps = [{ status: 200, body: { choices: [{ message: { role: "assistant", content: "Risposta simulata." } }] } }];
  await request(app).post("/api/chat").send({ message, history: turns });
  const { SYSTEM_PROMPT } = await import("../src/systemPrompt.js");
  expect(wire[0].messages[0].content.slice(SYSTEM_PROMPT.length).match(/NNR-[A-Z]{3}-\d{2}/g) ?? []).toEqual(expected);
  expect(wire[0].messages.slice(1)).toEqual([...turns, { role: "user", content: message }]);
});

it.each([false, true])("recupera il 400 dopo RAG con payload identico, fallback=%s", async fallback => {
  steps = [...(fallback ? [failure(429)] : []), tool(), failure(), final];
  const result = await send();
  expect(result.status).toBe(200);
  expect(result.body.answer).toContain("±2 giorni");
  expect(result.body.answer).toContain("giorno target: 42");
  expect(result.body.tools_used).toEqual(["search_knowledge"]);
  expect(wire).toHaveLength(fallback ? 4 : 3);
  expect(models()).toEqual(fallback ? ["openai/gpt-oss-120b", ...Array(3).fill("openai/gpt-oss-20b")] : Array(3).fill("openai/gpt-oss-120b"));
  expect(wire.at(-1)).toEqual(wire.at(-2));
  expect(wire.at(-1).messages.slice(1, 3)).toEqual(history);
  expect(wire.at(-1).messages.filter(message => message.role === "tool")).toHaveLength(1);
  expect(wire.at(-1).messages.at(-1).tool_call_id).toBe("rag-id");
  expect(JSON.parse(wire.at(-1).messages.at(-1).content).results[0].text).toBe(text);
  expect(rag).toHaveLength(1);
  expect(log()).toContain("retry_outcome=riuscito");
});

it("arresta il secondo 400 senza un terzo tentativo né dettagli pubblici", async () => {
  steps = [tool(), failure(), failure()];
  const result = await send();
  expect(result.status).toBe(502);
  expect(wire).toHaveLength(3);
  expect(wire[2]).toEqual(wire[1]);
  expect(rag).toHaveLength(1);
  expect(log()).toContain("retry_outcome=fallito");
  expect(log() + result.text).not.toContain("contenuto riservato");
});

it("consuma un solo retry per richiesta anche dopo un altro round RAG", async () => {
  steps = [tool("first"), failure(), tool("second"), failure(), final];
  expect((await send()).status).toBe(502);
  expect(wire).toHaveLength(4);
  expect(rag).toHaveLength(2);
  expect(wire[3].messages.filter(message => message.role === "tool").map(message => message.tool_call_id)).toEqual(["first", "second"]);
  expect(steps).toHaveLength(1);
});

it("una nuova richiesta dispone del proprio retry e riparte dal primary", async () => {
  steps = [failure(429), tool(), failure(), final, tool(), failure(), final];
  expect((await send()).status).toBe(200);
  expect((await send()).status).toBe(200);
  expect(models()).toEqual(["openai/gpt-oss-120b", "openai/gpt-oss-20b", "openai/gpt-oss-20b", "openai/gpt-oss-20b",
    "openai/gpt-oss-120b", "openai/gpt-oss-120b", "openai/gpt-oss-120b"]);
});

it("non ritenta prima di una ricerca documentale riuscita", async () => {
  steps = [failure(), final];
  expect((await send()).status).toBe(502);
  expect(wire).toHaveLength(1);
});
it.each([{ status: 200, body: { results: [] } }, { status: 200, body: { results: [{ ...chunk, text: " " }] } },
  { status: 500, body: { error: "RAG indisponibile" } },
  { status: 200, body: { error: "RAG fallito", results: [chunk] } }])("non ritenta dopo RAG vuoto o fallito: $status", async response => {
  local = response; steps = [tool(), failure(), final];
  expect((await send()).status).toBe(502);
  expect(wire).toHaveLength(2);
});
it("un risultato Data-only non abilita il retry documentale", async () => {
  steps = [tool("data-id", "analyze_operations"), failure(), final];
  expect((await send()).status).toBe(502);
  expect(wire).toHaveLength(2);
  expect(data).toHaveLength(1);
});
it.each([{ code: "invalid_request" }, { code: null }, { type: "rate_limit_error" }, { type: null }])("non ritenta code/type incompatibili: %j", async fields => {
  steps = [tool(), failure(400, fields), final];
  expect((await send()).status).toBe(502);
  expect(wire).toHaveLength(2);
});
it.each([422, 500])("non ritenta altri status dopo RAG: %i", async status => {
  steps = [tool(), failure(status), final];
  expect((await send()).status).toBe(502);
  expect(wire).toHaveLength(2);
});
it("un errore di connessione SDK dopo RAG non attiva il retry 400", async () => {
  steps = [tool(), { transportError: true }, final];
  expect((await send()).status).toBe(502);
  expect(wire).toHaveLength(2);
});
it("un errore diverso sul retry resta terminale senza ulteriori retry 400", async () => {
  steps = [tool(), failure(), failure(500), final];
  expect((await send()).status).toBe(502);
  expect(wire).toHaveLength(3);
});
it("il 429 sul fallback resta terminale, senza retry 400", async () => {
  steps = [failure(429), tool(), failure(429), final];
  expect((await send()).status).toBe(502);
  expect(models()).toEqual(["openai/gpt-oss-120b", "openai/gpt-oss-20b", "openai/gpt-oss-20b"]);
});
it("un 429 sul retry primary conserva il fallback esistente senza un secondo retry 400", async () => {
  steps = [tool(), failure(), failure(429), failure(), final];
  expect((await send()).status).toBe(502);
  expect(models()).toEqual(["openai/gpt-oss-120b", "openai/gpt-oss-120b", "openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
  expect(wire[2]).toEqual(wire[1]);
  expect(wire[3]).toEqual({ ...wire[2], model: "openai/gpt-oss-20b" });
  expect(rag).toHaveLength(1);
});
it.each(["fatti_assenti", "fatti_validi", "valore_non_attestato", "fallback_429", "fallback_400"])(
  "distingue la finale del fallback dall'errore provider dopo primary 400 e retry 429: %s", async scenario => {
    const psiText = readFileSync(new URL(`../../${source}`, import.meta.url), "utf8")
      .split(/(?=^#{1,6} )/m).find(section => section.startsWith("## NNR-PSI-01")).trim();
    local = { status: 200, body: { results: [{ source, section: "NNR-PSI-01", text: psiText, distance: 0.1 }] } };
    const psiFact = { study_id: "NNR-PSI-01", visit_name: "Week 6", target_day: 42,
      window_days: scenario === "valore_non_attestato" ? 3 : 4, source, section: "NNR-PSI-01" };
    const reply = scenario === "fatti_assenti" ? "NNR-PSI-01; Week 6: giorno target 42; finestra ±4 giorni." :
      JSON.stringify({ schedule_facts: [psiFact] });
    const ragCall = tool("psi-rag");
    ragCall.body.choices[0].message.tool_calls[0].function.arguments =
      JSON.stringify({ query: "Schedule visit windows NNR-PSI-01 Week 6" });
    const quota = { ...failure(429, { code: "rate_limit_exceeded", type: null }), headers: {
      "retry-after": "4", "x-ratelimit-limit-tokens": "8000", "x-ratelimit-remaining-tokens": "3672",
      "x-ratelimit-limit-requests": "1000", "x-ratelimit-remaining-requests": "996",
      "x-ratelimit-reset-tokens": "32.46s", "x-ratelimit-reset-requests": "345.6s",
    } };
    steps = [ragCall, failure(400, { failed_generation: "contenuto riservato" }), quota,
      scenario === "fallback_429" ? quota : scenario === "fallback_400" ? failure() :
        { status: 200, body: { choices: [{ message: { role: "assistant", content: reply } }] } }];
    const turns = [{ role: "user", content: 'Consulta "Schedule e visit windows", NNR-ESK-02, Week 6: giorno target e finestra.' },
      { role: "assistant", content: "NNR-ESK-02; Week 6: giorno target 42; finestra ±2 giorni." }];
    const result = await request(app).post("/api/chat").send({ message: "E per lo studio PSI?", history: turns });
    expect(wire).toHaveLength(4);
    expect(models()).toEqual(["openai/gpt-oss-120b", "openai/gpt-oss-120b", "openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
    expect(wire[2]).toEqual(wire[1]);
    expect(wire[3]).toEqual({ ...wire[2], model: "openai/gpt-oss-20b" });
    expect(wire[3].messages.slice(1, 3)).toEqual(turns);
    expect(wire[3].messages.filter(message => message.role === "tool").map(message => message.tool_call_id)).toEqual(["psi-rag"]);
    expect(rag).toEqual([{ query: "Schedule visit windows NNR-PSI-01 Week 6" }]);
    expect(data).toHaveLength(0);
    expect(log()).toContain("retry400_precedente=true; retry_after_seconds=4");
    expect(log() + result.text).not.toContain("contenuto riservato");
    if (scenario.startsWith("fallback_")) {
      expect(result.status).toBe(502);
      expect(result.body).not.toHaveProperty("answer");
      expect(log()).not.toContain("schedule_fact;");
    } else {
      expect(result.status).toBe(200);
      expect(result.body.tools_used).toEqual(["search_knowledge"]);
      if (scenario === "fatti_validi") {
        expect(result.body.answer).toContain("NNR-PSI-01; Week 6: giorno target: 42; finestra: ±4 giorni.");
        expect(log()).toContain("code=fact_verified");
      } else {
        expect(result.body.answer).toContain("Informazioni di calendario non verificate");
        expect(result.body.answer).not.toMatch(/±[34]/);
        expect(log()).toContain(`code=${scenario === "fatti_assenti" ? "facts_missing" : "value_not_attested"}`);
      }
    }
  });
it("un retry riuscito non autorizza un retry in un'altra richiesta priva di RAG", async () => {
  steps = [tool(), failure(), final, failure(), final];
  expect((await send()).status).toBe(200);
  expect((await send()).status).toBe(502);
  expect(wire).toHaveLength(4);
  expect(rag).toHaveLength(1);
});
it("non ritenta la finale forzata dopo quattro round RAG", async () => {
  steps = [tool("a"), tool("b"), tool("c"), tool("d"), failure(), final];
  expect((await send()).status).toBe(502);
  expect(wire).toHaveLength(5);
  expect(rag).toHaveLength(4);
  expect(wire[4]).not.toHaveProperty("tools");
  expect(wire[4]).not.toHaveProperty("tool_choice");
});
it("il retry non aggiunge round e la quinta completion resta senza strumenti", async () => {
  steps = [tool("a"), failure(), tool("b"), tool("c"), tool("d"), final];
  expect((await send()).status).toBe(200);
  expect(wire).toHaveLength(6);
  expect(rag).toHaveLength(4);
  expect(wire[5]).not.toHaveProperty("tools");
  expect(wire[5].messages.filter(message => message.role === "tool")).toHaveLength(4);
});
it.each([
  { fields: {}, present: false, type: "non_disponibile" },
  { fields: { failed_generation: "generazione privata" }, present: true, type: "string" },
  { fields: { failed_generation: null }, present: true, type: "null" },
  { fields: { failed_generation: ["generazione privata"] }, present: true, type: "array" },
  { fields: { failed_generation: { reason: "testo privato", attempted_arguments: "argomenti privati", category: "categoria privata" } }, present: true, type: "object" },
])("diagnostica soltanto presenza e tipo di failed_generation: $type", async ({ fields, present, type }) => {
  steps = [tool(), failure(400, fields), failure(400, fields)];
  const result = await send();
  expect(result.status).toBe(502);
  expect(log()).toContain(`failed_generation_present=${present}`);
  expect(log()).toContain(`failed_generation_type=${type}`);
  expect(log()).toContain("generation_category=non_disponibile");
  expect(log()).toContain("completion=intermedia");
  expect(log() + result.text).not.toMatch(/generazione privata|testo privato|argomenti privati|categoria privata|offline-placeholder|Authorization/);
});
it("un logger fallito non impedisce il recupero della completion", async () => {
  warn.mockImplementation(() => { throw new Error("Logger indisponibile"); });
  steps = [tool(), failure(), final];
  expect((await send()).status).toBe(200);
});
it("una eccezione non SDK dopo RAG con status 400 non abilita retry", async () => {
  const { Completions } = await import("groq-sdk/resources/chat/completions");
  const create = Completions.prototype.create;
  const error = Object.assign(new Error("Errore locale"), {
    status: 400, error: { code: "tool_use_failed", type: "invalid_request_error" },
  });
  vi.spyOn(Completions.prototype, "create").mockImplementation(function (...args) {
    if (wire.length) throw error;
    return create.apply(this, args);
  });
  steps = [tool()];
  await expect(orchestrate("Mi riferisco allo studio NNR-ESK-02.", history)).rejects.toBe(error);
  expect(wire).toHaveLength(1);
  expect(rag).toHaveLength(1);
});
it("una finale non attestata dopo retry resta bloccata dal presenter", async () => {
  const wrong = JSON.parse(final.body.choices[0].message.content);
  wrong.schedule_facts[0].window_days = 4;
  steps = [tool(), failure(), { status: 200, body: { choices: [{ message: { content: JSON.stringify(wrong) } }] } }];
  const response = await send();
  expect(response.status).toBe(200);
  expect(response.body.answer).not.toContain("±4");
  expect(response.body.answer).toMatch(/non verificat|incompleto/i);
});

it("registra gli header 429 ammessi senza cambiare fallback o numero di richieste", async () => {
  const headers = { "retry-after": "393", "x-ratelimit-limit-tokens": "8000",
    "x-ratelimit-remaining-tokens": "12", "x-ratelimit-reset-tokens": "1ms",
    "x-ratelimit-limit-requests": "1000", "x-ratelimit-remaining-requests": "900",
    "x-ratelimit-reset-requests": "2m59.56s", "x-private": "segreto non ammesso" };
  steps = [{ ...failure(429, { code: "rate_limit_exceeded" }), headers }, tool(), final];
  expect((await send()).status).toBe(200);
  expect(wire).toHaveLength(3);
  expect(models()).toEqual(["openai/gpt-oss-120b", "openai/gpt-oss-20b", "openai/gpt-oss-20b"]);
  expect(log()).toContain("provider_rate_limit; status=429; code=rate_limit_exceeded; model=primary; round=1; completion=intermedia");
  for (const part of ["retry_after_seconds=393", "limit_tokens=8000", "remaining_tokens=12", "reset_tokens_seconds=0.001",
    "limit_requests=1000", "remaining_requests=900", "reset_requests_seconds=179.56", "retry400_precedente=false"]) expect(log()).toContain(part);
  expect(log()).not.toContain("segreto non ammesso");
  expect(rag).toHaveLength(1);
});

it.each([
  { headers: {}, expected: "retry_after_seconds=non_disponibile" },
  { headers: { "retry-after": "testo privato", "x-ratelimit-remaining-tokens": "-2",
    "x-ratelimit-limit-tokens": "1e9", "x-ratelimit-reset-tokens": "Infinity",
    "x-ratelimit-reset-requests": "dati privati" }, expected: "remaining_tokens=non_disponibile" },
  { headers: { "x-ratelimit-remaining-tokens": "0", "x-ratelimit-reset-tokens": "7.66s" }, expected: "reset_tokens_seconds=7.66" },
])("429 con quota mancante, malformata o parziale: $expected", async ({ headers, expected }) => {
  steps = [{ ...failure(429, { code: "codice riservato" }), headers }, failure(429), final];
  const response = await send();
  expect(response.status).toBe(502);
  expect(wire).toHaveLength(2);
  expect(log()).toContain("provider_rate_limit");
  expect(log()).toContain(expected);
  expect(log()).toContain("limit_requests=non_disponibile");
  expect(log() + response.text).not.toMatch(/codice riservato|testo privato|dati privati|contenuto riservato/);
});

it("il 429 dopo retry 400 espone la quota del fallback e non genera altre richieste", async () => {
  steps = [failure(429), tool(), failure(), { ...failure(429, { code: "rate_limit_exceeded" }),
    headers: { "retry-after": "70", "x-ratelimit-remaining-tokens": "0", "x-ratelimit-reset-tokens": "70s" } }, final];
  expect((await send()).status).toBe(502);
  expect(wire).toHaveLength(4);
  expect(rag).toHaveLength(1);
  const line = warn.mock.calls.flat().find(value => value.includes("provider_rate_limit") && value.includes("model=fallback"));
  expect(line).toContain("round=2; completion=intermedia");
  expect(line).toContain("retry400_precedente=true");
  expect(line).toContain("retry_after_seconds=70");
  expect(wire[3]).toEqual(wire[2]);
});

it("un logger che fallisce sul 429 lascia invariata la risposta controllata", async () => {
  warn.mockImplementation(() => { throw new Error("Logger indisponibile"); });
  steps = [failure(429), failure(429)];
  expect((await send()).status).toBe(502);
  expect(wire).toHaveLength(2);
});

it("la quota di un 429 non viene trasferita ad una nuova richiesta", async () => {
  steps = [{ ...failure(429), headers: { "retry-after": "393" } }, failure(429), tool(), final];
  expect((await send()).status).toBe(502);
  expect((await send()).status).toBe(200);
  expect(models()).toEqual(["openai/gpt-oss-120b", "openai/gpt-oss-20b", "openai/gpt-oss-120b", "openai/gpt-oss-120b"]);
  expect(wire).toHaveLength(4);
});
