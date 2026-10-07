import Groq from "groq-sdk";
import { GROQ_API_KEY, GROQ_MODEL } from "./config.js";
import { TOOLS } from "./tools.js";

const groq = new Groq({
  apiKey: GROQ_API_KEY,
  timeout: 60000,
  maxRetries: 0,
});

export async function generateCompletion(messages) {
  if (!GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY non configurata");
  }

  const completion = await groq.chat.completions.create({
    model: GROQ_MODEL,
    messages,
    tools: TOOLS,
    tool_choice: "auto",
    temperature: 0.2,
    include_reasoning: false,
  });

  return completion.choices[0]?.message;
}
