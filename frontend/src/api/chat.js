const FALLBACK_ERROR = "Il servizio non è disponibile in questo momento. Riprova tra poco.";

/** Invia un messaggio al backend senza esporre indirizzi o credenziali nel browser. */
export async function requestChat(message, fetchImpl = globalThis.fetch) {
  let response;

  try {
    response = await fetchImpl("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
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

  return payload.answer.trim();
}
