import { test } from "node:test";
import assert from "node:assert/strict";
import { requestChat } from "./chat.js";

const response = (ok, payload) => ({ ok, json: async () => payload });

test("invia gli scambi precedenti senza duplicare il messaggio corrente", async () => {
  let body;
  const history = [{ role: "user", content: "Parliamo di PSI." }, { role: "assistant", content: "Studio NNR-PSI-01." }];
  await requestChat("E la Week 6?", async (url, options) => {
    body = JSON.parse(options.body);
    return response(true, { answer: "Risposta simulata.", tools_used: [] });
  }, history);
  assert.deepEqual(body, { message: "E la Week 6?", history });
});

test("invia il messaggio al contratto API corretto", async () => {
  const calls = [];
  const answer = await requestChat("Quali siti hanno query aging elevato?", async (...args) => {
    calls.push(args);
    return response(true, { answer: "SITE_05", tools_used: ["analyze_operations"] });
  });
  assert.equal(answer, "SITE_05");
  assert.equal(calls[0][0], "/api/chat");
  assert.equal(calls[0][1].method, "POST");
  assert.deepEqual(JSON.parse(calls[0][1].body), { message: "Quali siti hanno query aging elevato?" });
});

test("espone un errore API leggibile", async () => {
  await assert.rejects(
    () => requestChat("test", async () => response(false, { error: "Richiesta non valida." })),
    /Richiesta non valida/,
  );
});

test("usa un messaggio sicuro quando il servizio non risponde", async () => {
  await assert.rejects(
    () => requestChat("test", async () => { throw new Error("Dettaglio interno non esponibile"); }),
    /Il servizio non è disponibile/,
  );
});

test("rifiuta risposte prive di answer e risposte non JSON", async () => {
  await assert.rejects(() => requestChat("test", async () => response(true, { tools_used: [] })), /risposta non valida/);
  await assert.rejects(() => requestChat("test", async () => ({ ok: true, json: async () => { throw new Error("HTML inatteso"); } })), /risposta non valida/);
});

test("usa un errore generico per risposte HTTP non JSON", async () => {
  await assert.rejects(() => requestChat("test", async () => ({ ok: false, json: async () => { throw new Error("HTML inatteso"); } })), /servizio non è disponibile/);
});