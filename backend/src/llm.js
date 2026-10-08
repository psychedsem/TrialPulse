import Groq from "groq-sdk";
import { GROQ_API_KEY, GROQ_MODEL } from "./config.js";
import { TOOLS } from "./tools.js";

const groq = new Groq({
  apiKey: GROQ_API_KEY,
  timeout: 60_000,
  maxRetries: 0,
});

export async function generateCompletion(messages, { allowTools = true } = {}) {
  if (!GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY non configurata.");
  }

  const payload = {
    model: GROQ_MODEL,
    messages,
    reasoning_effort: "low",
    include_reasoning: false,
    temperature: 0.2,
    max_completion_tokens: 600,
  };

  if (allowTools) {
    payload.tools = TOOLS;
    payload.tool_choice = "auto";
  }

  const completion = await groq.chat.completions.create(payload);

  const reply = completion.choices[0]?.message;

  if (!reply) {
    throw new Error("Il modello non ha restituito una risposta.");
  }

  return reply;
}
