const MAX_CONTEXT_MESSAGES = 8;
const MAX_CONTEXT_CHARACTERS = 6000;

function invalidHistory() {
  throw new Error("Cronologia della conversazione non valida.");
}

export function validateHistory(history) {
  if (history === undefined) return [];

  if (!Array.isArray(history) || history.length % 2 !== 0 || history.length > MAX_CONTEXT_MESSAGES) {
    invalidHistory();
  }

  let totalCharacters = 0;
  const validated = history.map((message, index) => {
    const expectedRole = index % 2 ? "assistant" : "user";
    if (!message || typeof message !== "object" || Array.isArray(message)
      || Object.keys(message).length !== 2
      || !Object.hasOwn(message, "role") || !Object.hasOwn(message, "content")
      || message.role !== expectedRole
      || typeof message.content !== "string" || !message.content.trim()) {
      invalidHistory();
    }
    totalCharacters += message.content.length;
    return { role: message.role, content: message.content };
  });

  if (totalCharacters > MAX_CONTEXT_CHARACTERS) invalidHistory();
  return validated;
}