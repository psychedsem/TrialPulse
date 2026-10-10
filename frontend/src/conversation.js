const STORAGE_KEY = "trialpulse.conversation";
const STORAGE_VERSION = 1;
const MAX_CONTEXT_MESSAGES = 8;
const MAX_CONTEXT_CHARACTERS = 6000;

function isCompleteHistory(history) {
  return Array.isArray(history) && history.length % 2 === 0 && history.every((message, index) =>
    message && typeof message === "object" && !Array.isArray(message)
    && Object.keys(message).length === 2
    && Object.hasOwn(message, "role") && Object.hasOwn(message, "content")
    && message.role === (index % 2 ? "assistant" : "user")
    && typeof message.content === "string" && Boolean(message.content.trim()));
}

export function loadConversation(storage) {
  try {
    const stored = JSON.parse((storage ?? globalThis.sessionStorage).getItem(STORAGE_KEY));
    if (stored && Object.keys(stored).length === 2 && stored.version === STORAGE_VERSION
      && isCompleteHistory(stored.history)) return stored.history;
  } catch {
    // La conversazione resta utilizzabile anche senza storage.
  }
  return [];
}

export function saveConversation(history, storage) {
  if (!isCompleteHistory(history)) return;
  try {
    const session = storage ?? globalThis.sessionStorage;
    if (!history.length) session.removeItem(STORAGE_KEY);
    else session.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, history }));
  } catch {
    // Accesso negato o quota esaurita non interrompono la richiesta.
  }
}

export function selectHistory(history) {
  if (!isCompleteHistory(history)) return [];
  let start = history.length;
  let length = 0;
  while (start >= 2 && history.length - start < MAX_CONTEXT_MESSAGES) {
    const pairLength = history[start - 2].content.length + history[start - 1].content.length;
    if (length + pairLength > MAX_CONTEXT_CHARACTERS) break;
    length += pairLength;
    start -= 2;
  }
  return history.slice(start);
}

export function resetConversation(hasConversation, confirmReset = () => globalThis.confirm("Vuoi cancellare la conversazione e iniziarne una nuova?"), storage) {
  if (hasConversation && !confirmReset()) return false;
  saveConversation([], storage);
  return true;
}