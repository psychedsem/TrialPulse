import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as chat from "./api/chat.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJawAAAAASUVORK5CYII=";
const image = { type: "image", mime_type: "image/png", data: png, alt: "Grafico dati sintetici" };
const history = [{ role: "user", content: "Grafico" }, { role: "assistant", content: "Risultato sintetico" }];
async function api() {
  try { return await import("./artifacts.js"); }
  catch { assert.fail("Artefatti grafici non ancora implementati."); }
}
const storage = () => { const map = new Map(); return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) }; };

test("il primo artefatto invalido non viene sostituito e i campi estranei non vengono conservati", async () => {
  const { safeArtifacts } = await api();
  assert.deepEqual(safeArtifacts([null, image]), []);
  assert.deepEqual(safeArtifacts({ 0: image }), []);
  const extended = { ...image, code: "non destinato alla history", url: "https://example.invalid" };
  assert.deepEqual(safeArtifacts([extended, image]), [image]);
  assert.equal(extended.code, "non destinato alla history");
});

test("il limite delle ultime quattro posizioni precede la verifica della correlazione", async () => {
  const { loadArtifacts } = await api();
  const entries = { 1: { answer: history[1].content, images: [image] }, 3: null, 5: null, 7: null, 9: null };
  assert.deepEqual(loadArtifacts({ getItem: () => JSON.stringify(entries) }, history), {});
});

test("un salvataggio oltre quota conserva il valore precedente e una mappa vuota lo elimina", async () => {
  const { saveArtifacts } = await api();
  const session = storage();
  session.setItem("trialpulse.artifacts", "precedente");
  const longHistory = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "Risposta" }));
  const large = { ...image, data: image.data.slice(0, 44) + "A".repeat(1100000) };
  saveArtifacts({ 1: [large], 3: [large], 5: [large], 7: [large] }, session, longHistory);
  assert.equal(session.getItem("trialpulse.artifacts"), "precedente");
  saveArtifacts({}, session);
  assert.equal(session.getItem("trialpulse.artifacts"), null);
  assert.equal(saveArtifacts({}, { removeItem: () => true }), undefined);
});

test("API estesa conserva PNG e compatibilità della risposta testuale", async () => {
  assert.equal(typeof chat.requestChatResult, "function");
  const fetcher = async () => ({ ok: true, json: async () => ({ answer: "Dati sintetici.", artifacts: [image] }) });
  assert.deepEqual(await chat.requestChatResult("Grafico", fetcher), { answer: "Dati sintetici.", artifacts: [image] });
  assert.equal(await chat.requestChat("Grafico", fetcher), "Dati sintetici.");
});
test("React mostra soltanto un PNG inline valido senza URL o HTML arbitrari", async () => {
  const { ChatArtifacts } = await api();
  const markup = renderToStaticMarkup(createElement(ChatArtifacts, { artifacts: [image] }));
  assert.match(markup, /data:image\/png;base64,/);
  assert.match(markup, /Grafico dati sintetici/);
  assert.equal(renderToStaticMarkup(createElement(ChatArtifacts, { artifacts: [{ ...image, mime_type: "image/svg+xml", data: "<svg/>" }] })), "");
});
test("immagini persistono separatamente e reset elimina soltanto la mappa", async () => {
  const { loadArtifacts, saveArtifacts } = await api();
  const session = storage();
  saveArtifacts({ 1: [image] }, session, history);
  assert.deepEqual(loadArtifacts(session, history), { 1: [image] });
  saveArtifacts({}, session);
  assert.deepEqual(loadArtifacts(session), {});
});
test("quota storage esaurita non compromette la risposta e dati corrotti sono rifiutati", async () => {
  const { loadArtifacts, saveArtifacts, safeArtifacts } = await api();
  assert.doesNotThrow(() => saveArtifacts({ 1: [image] }, { setItem() { throw Error("Quota"); }, removeItem() {} }, history));
  assert.deepEqual(loadArtifacts({ getItem: () => "{broken" }), {});
  assert.deepEqual(safeArtifacts([{ ...image, data: "notPNG" }]), []);
});

test("un grafico di una conversazione precedente non viene attribuito a una nuova risposta", async () => {
  const { loadArtifacts, saveArtifacts } = await api();
  const session = storage();
  saveArtifacts({ 1: [image] }, session, history);
  assert.deepEqual(loadArtifacts(session, [{ role: "user", content: "Altro" }, { role: "assistant", content: "Nuova risposta" }]), {});
  assert.deepEqual(loadArtifacts(session, []), {});
});
