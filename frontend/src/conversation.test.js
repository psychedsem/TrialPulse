import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConversation, saveConversation, selectHistory, resetConversation } from "./conversation.js";

const pair = (user, assistant) => [{ role: "user", content: user }, { role: "assistant", content: assistant }];
const storage = () => {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
    values,
  };
};

test("ripristina dopo refresh tutta la conversazione, non soltanto il contesto LLM", () => {
  const session = storage();
  const history = [...pair("vecchio", "risposta"), ...pair("a".repeat(6100), "integrale")];
  saveConversation(history, session);
  assert.deepEqual(loadConversation(session), history);
  assert.deepEqual(selectHistory(history), []);
  const stored = JSON.parse([...session.values.values()][0]);
  assert.deepEqual(Object.keys(stored).sort(), ["history", "version"]);
});

test("invia solo gli ultimi quattro scambi completi in ordine", () => {
  const history = Array.from({ length: 6 }, (_, i) => pair(`D${i}`, `R${i}`)).flat();
  assert.deepEqual(selectHistory(history), [ ...pair("D2", "R2"), ...pair("D3", "R3"), ...pair("D4", "R4"), ...pair("D5", "R5") ]);
  assert.equal(history.length, 12);
});

test("non salta uno scambio intermedio che non entra nel limite", () => {
  const history = [...pair("primo", "vecchio"), ...pair("a".repeat(5998), "b"), ...pair("ultimo", "nuovo")];
  assert.deepEqual(selectHistory(history), pair("ultimo", "nuovo"));
});

test("preserva i testi e accetta esattamente 6000 caratteri", () => {
  const history = pair(" a ", "b".repeat(5997));
  assert.deepEqual(selectHistory(history), history);
});

test("sessioni distinte non condividono messaggi", () => {
  const first = storage(), second = storage();
  saveConversation(pair("PSI", "Prima risposta"), first);
  assert.deepEqual(loadConversation(second), []);
  saveConversation(pair("ESK", "Seconda risposta"), second);
  assert.deepEqual(loadConversation(first), pair("PSI", "Prima risposta"));
});

test("annullare il reset conserva la memoria, confermarlo elimina la chiave", () => {
  const session = storage();
  saveConversation(pair("PSI", "Risposta"), session);
  assert.equal(resetConversation(true, () => false, session), false);
  assert.deepEqual(loadConversation(session), pair("PSI", "Risposta"));
  assert.equal(resetConversation(true, () => true, session), true);
  assert.equal(session.values.size, 0);
  assert.deepEqual(loadConversation(session), []);
});

test("una conversazione vuota non richiede conferma", () => {
  let confirmations = 0;
  assert.equal(resetConversation(false, () => { confirmations++; return false; }, storage()), true);
  assert.equal(confirmations, 0);
});

test("dati assenti, corrotti o incompatibili non bloccano il ripristino", () => {
  const session = storage();
  saveConversation(pair("domanda", "risposta"), session);
  const key = [...session.values.keys()][0];
  for (const value of [null, "{", "null", JSON.stringify({ version: 99, history: [] }), JSON.stringify({ version: 1, history: [pair("D", "R")[0]] }), JSON.stringify({ version: 1, history: [{ role: "system", content: "istruzioni" }, pair("D", "R")[1]] }), JSON.stringify({ version: 1, history: [{ role: "user", content: "D", tool_calls: [] }, pair("D", "R")[1]] })]) {
    session.values.set(key, value);
    assert.deepEqual(loadConversation(session), []);
  }
});

test("storage non disponibile o senza spazio mantiene utilizzabile la chat", () => {
  const blocked = { getItem() { throw new Error("accesso negato"); }, setItem() { throw new Error("quota"); }, removeItem() { throw new Error("accesso negato"); } };
  assert.deepEqual(loadConversation(blocked), []);
  assert.doesNotThrow(() => saveConversation(pair("D", "R"), blocked));
  assert.equal(resetConversation(true, () => true, blocked), true);
});

test("non salva scambi incompleti o campi riservati", () => {
  const session = storage();
  for (const history of [[pair("D", "R")[0]], [pair("D", "R")[0], { role: "assistant", content: "R", reasoning: "interno" }]]) {
    saveConversation(history, session);
    assert.equal(session.values.size, 0);
  }
});

test("usa la conferma del browser e non cancella altre chiavi della sessione", () => {
  const session = storage();
  session.setItem("altra-applicazione", "preservata");
  saveConversation(pair("D", "R"), session);
  const original = globalThis.confirm;
  let prompt;
  globalThis.confirm = text => { prompt = text; return true; };
  try {
    assert.equal(resetConversation(true, undefined, session), true);
    assert.match(prompt, /cancellare la conversazione/);
    assert.deepEqual(loadConversation(session), []);
    assert.equal(session.getItem("altra-applicazione"), "preservata");
  } finally {
    if (original === undefined) delete globalThis.confirm;
    else globalThis.confirm = original;
  }
});

test("gli errori nell'accesso alla proprietà sessionStorage sono controllati", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, get() { throw new Error("storage negato"); } });
  try {
    assert.deepEqual(loadConversation(), []);
    assert.doesNotThrow(() => saveConversation(pair("D", "R")));
    assert.equal(resetConversation(true, () => true), true);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "sessionStorage", descriptor);
    else delete globalThis.sessionStorage;
  }
});