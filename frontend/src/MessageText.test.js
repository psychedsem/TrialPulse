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

test("conserva paragrafi multilinea e sottoelenchi negli elenchi con righe vuote", () => {
  const html = render("- Prima riga\nSeconda riga\n\n- Altro elemento\n\n  - Sottoelemento\n\n  - Ultimo\n\n1. Punto ordinato\n\n2. Altro punto");
  assert.match(html, /<li>\s*<p>Prima riga\nSeconda riga<\/p>/);
  assert.match(html, /<p>Altro elemento<\/p>\s*<ul>\s*<li>\s*<p>Sottoelemento<\/p>/);
  assert.match(html, /<ol>\s*<li>\s*<p>Punto ordinato<\/p>/);
});

test("rende i riferimenti documentali separati come elementi di un unico elenco", () => {
  const html = render("**Documenti Novera consultati:**\n\n- Schedule e visit windows; sezione: NNR-DXB-03.\n\n- FAQ operative TrialPulse; sezione: Qual è la finestra della Week 6?.");
  assert.equal((html.match(/<ul>/g) || []).length, 1);
  assert.equal((html.match(/<li>/g) || []).length, 2);
  assert.match(html, /<p>Schedule e visit windows; sezione: NNR-DXB-03\.<\/p>/);
  assert.match(html, /<p>FAQ operative TrialPulse; sezione: Qual è la finestra della Week 6\?\.<\/p>/);
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

const table = "| Sito | Visite valutabili | Fuori finestra | Tasso |\n| :--- | ---: | ---: | ---: |\n| SITE_01 | 149 | 27 | 18,12% |\n| SITE_08 | 163 | 39 | 23,93% |";

test("rende una tabella GFM con intestazioni e dati out-of-window verificati", () => {
  const html = render(table);
  assert.match(html, /<table>/);
  assert.match(html, /<th[^>]*>Sito<\/th>/);
  assert.match(html, /<td[^>]*>18,12%<\/td>/);
  assert.match(html, /<td[^>]*>23,93%<\/td>/);
  assert.match(html, /text-align:right/);
  assert.match(html, /class="message__table-scroll"/);
});

test("non ripara pipe escaped o tabelle prive del separatore GFM", () => {
  for (const text of [table.replaceAll("|", "\\|"), "| Sito | Tasso |\n| SITE_01 | 18,12% |"])
    assert.doesNotMatch(render(text), /<table>/);
  assert.match(render("Valore letterale `a\\|b`"), /<code>a\\\|b<\/code>/);
});

test("preserva pipe legittime nelle celle e tabelle dentro codice", () => {
  assert.match(render("| Campo |\n| --- |\n| a\\|b |"), /<td>a\|b<\/td>/);
  assert.doesNotMatch(render("```text\n" + table + "\n```"), /<table>/);
});

test("i messaggi utente non diventano tabelle", () => {
  assert.doesNotMatch(render(table, "user"), /<table>/);
});

test("non crea link locali fittizi o protocolli pericolosi", () => {
  const html = render("[fonte](knowledge_base/faq.md) [locale](/knowledge_base/faq.md) [file](file:///C:/secret) [script](javascript:alert%281%29) [data](data:text/html,x)");
  assert.doesNotMatch(html, /href=/);
  assert.match(html, /fonte/);
  assert.match(render("[documentazione](https://example.com/docs)"), /href="https:\/\/example.com\/docs"/);
});

test("HTML e immagini restano bloccati anche nelle tabelle GFM", () => {
  const html = render("| Fonte |\n| --- |\n| <img src=x onerror=alert(1)> ![x](https://example.com/a.png) [x](javascript:alert%281%29) |\n\n<script>alert(1)</script>");
  assert.match(html, /<table>/);
  assert.doesNotMatch(html, /<(img|script|iframe)\b|onerror=|href="javascript:/i);
});