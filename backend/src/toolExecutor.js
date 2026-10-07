import { DATA_AGENT_URL, RAG_API_URL } from "./config.js";
import { TOOLS } from "./tools.js";

export async function executeTool(call) {
  const name = call.function?.name;
  const definition = TOOLS.find(tool => tool.function.name === name);
  if (!definition) throw new Error("Tool sconosciuto.");
  let args;
  try {
    args = JSON.parse(call.function.arguments);
  } catch {
    throw new Error("Argomenti tool JSON non validi.");
  }
  const schema = definition.function.parameters;
  if (!args || typeof args !== "object" || Array.isArray(args)
      || Object.keys(args).some(key => !Object.hasOwn(schema.properties, key))) {
    throw new Error("Payload tool non valido.");
  }
  if (name === "search_knowledge" && (typeof args.query !== "string" || !args.query.trim())) {
    throw new Error("La query documentale deve essere un testo non vuoto.");
  }
  if (name === "analyze_operations" && !schema.properties.analysis.enum.includes(args.analysis)) {
    throw new Error("Analisi non supportata.");
  }
  const url = name === "search_knowledge" ? `${RAG_API_URL}/retrieve` : `${DATA_AGENT_URL}/analyze`;
  const service = name === "search_knowledge" ? "RAG" : "Data Agent";
  try {
    const response = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args), signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) return { error: `Il servizio ${service} ha rifiutato la richiesta (HTTP ${response.status}). Verifica gli argomenti.` };
    return await response.json();
  } catch {
    return { error: `Servizio ${service} non disponibile o risposta non valida. Nessun risultato ottenuto.` };
  }
}
