const FALLBACK_ERROR = "Il servizio non è disponibile in questo momento. Riprova tra poco.";
import { safeArtifacts } from "../artifacts.js";

/** Invia un messaggio al backend senza esporre indirizzi o credenziali nel browser. */
export async function requestChatResult(message, fetchImpl = globalThis.fetch, history) {
  let response;

  try {
    response = await fetchImpl(`${import.meta.env?.VITE_API_BASE_URL ?? ""}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(history === undefined ? { message } : { message, history }),
    });
  } catch {
    throw new Error(FALLBACK_ERROR);
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const safeMessage = typeof payload?.error === "string" && payload.error.trim()
      ? payload.error.trim()
      : FALLBACK_ERROR;
    throw new Error(safeMessage);
  }

  if (typeof payload?.answer !== "string" || !payload.answer.trim()) {
    throw new Error("Il servizio ha restituito una risposta non valida. Riprova.");
  }

  return { answer: payload.answer.trim(), artifacts: safeArtifacts(payload.artifacts) };
}

export async function requestChat(message, fetchImpl = globalThis.fetch, history) {
  return (await requestChatResult(message, fetchImpl, history)).answer;
}
