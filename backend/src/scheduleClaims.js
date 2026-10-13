import { verifySection } from "./documentAdapter.js";
import { canonicalStudyId, selectedUserStudies } from "./documentScope.js";

const SCHEDULE_SOURCE = "knowledge_base/reference/visit_schedule_windows.md";
const CLARIFY = "La regola dipende dallo studio. Per quale studio desideri la risposta? Indica lo study ID o la sigla dello studio.";
const UNVERIFIED = "Informazioni di calendario non verificate: fatti o evidenze incompleti o incoerenti. Nessun valore specifico disponibile con questo supporto.";

function diagnose(code, index = null) {
  try {
    console.warn(`[TrialPulse] schedule_fact; code=${code}; fact_index=${index ?? "non_disponibile"};`);
  } catch { /* La diagnostica non deve modificare l'esito della verifica. */ }
}

// Controllo del formato delle affermazioni, non classificazione o routing della domanda.
function calendarAssertion(text) {
  text = text.replace(/[*`#|]/g, "").replace(/[\r\n]+/g, " ");
  const amount = "(?:[+-]?\\d+|zero|un[oa]?|due|tre|quattro|cinque|sei|sette|otto|nove|dieci|undici|dodici|tredici|quattordici|quindici|sedici|diciassette|diciotto|diciannove|vent\\w*|trent\\w*|quarant\\w*|cinquant\\w*|sessant\\w*|settant\\w*|ottant\\w*|novant\\w*|cent\\w*)";
  return /\b(?:day|giorno|target(?:\s+day)?)\s*[+:]?\s*[+-]?\d/i.test(text) ||
    /^\s*±\s*\d+\s*[.!]?\s*$/.test(text) ||
    /(?:finestr\w*|visita|baseline|schedule)[^.!?]{0,160}\bstesso giorno\b/i.test(text) ||
    /(?:finestr\w*|visita|baseline|schedule)[^.!?\n]{0,160}±\s*\d/i.test(text) ||
    new RegExp(`(?:finestr\\w*|visita|baseline|schedule)[^.!?\\n]{0,160}\\b${amount}\\s+giorn[oi]\\b`, "i").test(text) ||
    new RegExp(`\\b(?:giorno|day)\\s+(?:meno\\s+)?${amount}\\b`, "i").test(text) ||
    /±\s*\d+(?:\s+giorn[oi]|(?=[^.!?\n]{0,80}(?:finestr|visita)))/i.test(text);
}

function documentedValue(fact, chunk) {
  if (fact.source === SCHEDULE_SOURCE && fact.section === fact.study_id) {
    const rows = chunk.text.split("\n").filter(line => line.startsWith("|"))
      .map(line => line.split("|").slice(1, -1).map(cell => cell.trim().replaceAll("**", "")));
    const matching = rows.filter(cells => cells.length === 3 && cells[0] === fact.visit_name);
    if (matching.length !== 1 || !/^[+-]?\d+$/.test(matching[0][1])) return null;
    const window = matching[0][2].match(/^±(\d+) giorn[oi]$/);
    if (!window && matching[0][2] !== "stesso giorno") return null;
    return { target_day: Number(matching[0][1]), window_days: window ? Number(window[1]) : 0 };
  }
  if (fact.source === `knowledge_base/protocols/${fact.study_id}.md` && fact.section === "Schedule") {
    const rows = [...chunk.text.matchAll(/^- (.+?) - Day\s*([+-]?\d+)\s*$/gm)];
    const matching = rows.filter(row => row[1] === fact.visit_name);
    return matching.length === 1 ? { target_day: Number(matching[0][2]) } : null;
  }
  if (fact.source === "knowledge_base/faq.md" && fact.section === `Qual è la finestra della ${fact.visit_name}?`) {
    const rows = [...chunk.text.matchAll(/^- ([A-Z]+): ±(\d+) giorni\s*$/gm)];
    const matching = rows.filter(row => row[1] === fact.study_id.split("-")[1]);
    return matching.length === 1 ? { window_days: Number(matching[0][2]) } : null;
  }
  return null;
}

export async function presentScheduleClaims(content, knowledge, message, history = []) {
  let packet;
  try { packet = JSON.parse(content); } catch { /* La prosa generale rimane compatibile. */ }
  const declared = packet && Object.hasOwn(packet, "schedule_facts");
  const attempted = /"(?:schedule_facts|target_day|window_days)\\*"\s*:/.test(content);
  if (!declared && !attempted && !calendarAssertion(packet ? JSON.stringify(packet) : content)) return null;
  const selected = selectedUserStudies(message, history);
  if (!selected.length) { diagnose("scope_missing"); return CLARIFY; }
  if (!declared) { diagnose("facts_missing"); return UNVERIFIED; }
  if (Object.keys(packet).length !== 1 || !Array.isArray(packet.schedule_facts) ||
    !packet.schedule_facts.length || packet.schedule_facts.length > 100) {
    diagnose("facts_invalid"); return UNVERIFIED;
  }

  const facts = packet.schedule_facts.map(fact => fact && typeof fact === "object" && !Array.isArray(fact) ?
    { ...fact, study_id: canonicalStudyId(fact.study_id) } : fact);
  const seen = new Set();
  for (const [index, fact] of facts.entries()) {
    const reject = code => { diagnose(code, index); return UNVERIFIED; };
    if (!fact || typeof fact !== "object" || Array.isArray(fact) ||
      Object.keys(fact).some(key => !["study_id", "visit_name", "target_day", "window_days", "source", "section"].includes(key)) ||
      typeof fact.visit_name !== "string" || !fact.visit_name.trim() ||
      typeof fact.source !== "string" || typeof fact.section !== "string" ||
      !(Object.hasOwn(fact, "target_day") || Object.hasOwn(fact, "window_days")) ||
      (Object.hasOwn(fact, "target_day") && !Number.isSafeInteger(fact.target_day)) ||
      (Object.hasOwn(fact, "window_days") && (!Number.isSafeInteger(fact.window_days) || fact.window_days < 0))) return reject("fact_invalid");
    if (!selected.includes(fact.study_id)) return reject("study_scope_mismatch");
    const key = JSON.stringify([fact.study_id, fact.visit_name]);
    if (seen.has(key)) return reject("duplicate_fact");
    seen.add(key);
    const chunks = knowledge.filter(chunk => chunk.source === fact.source && chunk.section === fact.section);
    if (!chunks.length) return reject("evidence_missing");
    if (new Set(chunks.map(chunk => chunk.text)).size !== 1) return reject("evidence_conflict");
    // Nessuna lettura di un percorso scelto dal modello senza un'identità operativa ammessa.
    if (!(fact.source === SCHEDULE_SOURCE && fact.section === fact.study_id) &&
      !(fact.source === `knowledge_base/protocols/${fact.study_id}.md` && fact.section === "Schedule") &&
      !(fact.source === "knowledge_base/faq.md" && fact.section === `Qual è la finestra della ${fact.visit_name}?`)) return reject("source_section_not_allowed");
    try { await verifySection(chunks[0]); } catch { return reject("evidence_unverified"); }
    const value = documentedValue(fact, chunks[0]);
    if (!value) return reject("visit_value_unavailable");
    if (["target_day", "window_days"].some(field => Object.hasOwn(fact, field) && fact[field] !== value[field])) return reject("value_not_attested");
    diagnose("fact_verified", index);
  }

  const lines = ["**Calendario documentato Novera (studi sintetici)**"];
  const requirements = new Map();
  for (const fact of facts) {
    const fields = requirements.get(fact.visit_name) ?? new Set();
    for (const field of ["target_day", "window_days"]) if (Object.hasOwn(fact, field)) fields.add(field);
    requirements.set(fact.visit_name, fields);
    const values = [];
    if (Object.hasOwn(fact, "target_day")) values.push(`giorno target: ${fact.target_day}`);
    if (Object.hasOwn(fact, "window_days")) values.push(`finestra: ±${fact.window_days} ${fact.window_days === 1 ? "giorno" : "giorni"}`);
    lines.push(`- ${fact.study_id}; ${fact.visit_name}: ${values.join("; ")}.`);
  }
  const missing = [];
  for (const study of selected) for (const [visit, fields] of requirements) {
    const fact = facts.find(item => item.study_id === study && item.visit_name === visit);
    if (!fact || [...fields].some(field => !Object.hasOwn(fact, field))) missing.push(`${study}; ${visit}: informazione non disponibile nel report verificato.`);
  }
  if (missing.length) lines.push("**Supporto documentale incompleto per il confronto:**", ...missing.map(value => `- ${value}`));
  return lines.join("\n\n");
}