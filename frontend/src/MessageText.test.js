import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageText } from "./MessageText.js";

const render = (text, role = "assistant") => renderToStaticMarkup(createElement(MessageText, { text, role }));

test("formatta grassetto e corsivo nelle risposte dell'assistente", () => {
  const html = render("**Studio:** NNR-ESK-02\n*knowledge_base/protocols/NNR-ESK-02.md*");
  assert.match(html, /<strong>Studio:<\/strong>/);
  assert.match(html, /<em>knowledge_base\/protocols\/NNR-ESK-02.md<\/em>/);
  assert.doesNotMatch(html, /\*\*/);
});

test("conserva testo ordinario, paragrafi e a capo senza abbreviazioni", () => {
  const html = render("Prima riga\nSeconda riga\n\nAltro paragrafo.");
  assert.match(html, /<p>Prima riga\nSeconda riga<\/p>/);
  assert.match(html, /<p>Altro paragrafo\.<\/p>/);
});

test("rende elenchi ordinati e non ordinati", () => {
  const html = render("- Primo\n- Secondo\n\n1. Terzo\n2. Quarto");
  assert.match(html, /<ul>\s*<li>Primo<\/li>\s*<li>Secondo<\/li>\s*<\/ul>/);
  assert.match(html, /<ol>\s*<li>Terzo<\/li>\s*<li>Quarto<\/li>\s*<\/ol>/);
});

test("rende codice inline senza interpretarne i caratteri HTML", () => {
  assert.match(render("Campo `actual_date < target_date`"), /<code>actual_date &lt; target_date<\/code>/);
});

test("non interpreta HTML non attendibile", () => {
  const html = render('<script>alert("x")</script>\n\n<iframe src="https://example.com"></iframe>\n\n<img src="https://example.com/x.png" onerror="alert(1)">\n\nTesto sicuro.');
  assert.doesNotMatch(html, /<(script|iframe|img)\b/i);
  assert.match(html, /Testo sicuro\./);
});

test("non genera immagini o preload da URL remoti, locali o data", () => {
  const html = render("![remota](https://example.com/x.png)\n\n![locale](/x.png)\n\n![data](data:image/png;base64,AAAA)");
  assert.doesNotMatch(html, /<(img|link)\b/i);
  assert.doesNotMatch(html, /src=|href=/);
});

test("non abilita URL javascript nei link Markdown", () => {
  assert.doesNotMatch(render("[link](javascript:alert%281%29)"), /href="javascript:/i);
});

test("i messaggi utente restano testo letterale con HTML escapato", () => {
  const html = render("**Non formattare**\n*testo* <img src='x'>", "user");
  assert.match(html, /\*\*Non formattare\*\*\n\*testo\*/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<(strong|em|p|img)\b/);
});