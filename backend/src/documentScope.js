import { readFileSync } from "node:fs";

const manifest = readFileSync(new URL("../../knowledge_base/manifest.yaml", import.meta.url), "utf8");
const studies = [...new Set(manifest.match(/NNR-[A-Z]{3}-\d{2}/g))];
const clarification = "La regola dipende dallo studio. Per quale studio desideri la risposta? Indica lo study ID o la sigla dello studio.";

export function canonicalStudyId(value) {
  if (typeof value !== "string") return null;
  const reference = value.trim().toUpperCase();
  const matching = studies.filter(id => id === reference || id.split("-")[1] === reference);
  return matching.length === 1 ? matching[0] : null;
}

function studyReferences(text) {
  return studies.filter(id => new RegExp(`(?:^|[^\\w])(?:${id}|${id.split("-")[1]})(?=$|[^\\w])`, "i").test(text));
}

function userSelection(text) {
  const references = studyReferences(text);
  // Un riferimento negato o escluso non dimostra una selezione positiva.
  if (/\b(?:non|esclud\w*|tranne|eccetto)\b/i.test(text) && references.length) return [];
  if (references.length) return references.filter(id =>
    canonicalStudyId(id.split("-")[1]) === id || new RegExp(`\\b${id}\\b`, "i").test(text));
  if (/\b(?:tutti|quattro|4)\s+(?:gli\s+)?studi\b|\bportfolio\b/i.test(text)) return studies;
  return [];
}

export function selectedUserStudies(message, history = []) {
  const current = userSelection(message);
  if (current.length || studyReferences(message).length) return current;
  for (const turn of [...history].reverse()) {
    if (turn.role !== "user") continue;
    const selected = userSelection(turn.content);
    if (selected.length || studyReferences(turn.content).length) return selected;
  }
  return [];
}

export function controlDocumentScope(answer, knowledge, message, history = []) {
  if (!knowledge.length) return answer;
  const attributed = studyReferences(answer);
  if (!attributed.length) return answer;

  const supported = new Set(knowledge.flatMap(chunk => studyReferences(
    `${chunk.source || ""} ${chunk.section || ""} ${chunk.text || ""}`)));
  const incomplete = "Il supporto documentale recuperato è incompleto per il perimetro richiesto. Non posso fornire una risposta verificata con queste fonti.";
  let selected = userSelection(message);
  const currentMentions = studyReferences(message).length > 0;
  if (!selected.length && !currentMentions && attributed.length > 1) {
    return attributed.every(id => supported.has(id)) ? answer : incomplete;
  }
  if (!selected.length && !currentMentions) {
    selected = selectedUserStudies(message, history);
  }
  if (!selected.length || attributed.some(id => !selected.includes(id)) ||
    (selected.length > 1 && attributed.length === 1)) {
    return clarification;
  }

  if (attributed.some(id => !supported.has(id))) {
    return incomplete;
  }
  return answer;
}