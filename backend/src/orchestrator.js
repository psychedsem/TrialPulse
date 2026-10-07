import { generateCompletion } from "./llm.js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";
import { executeTool } from "./toolExecutor.js";

export async function orchestrate(message) {
  const messages = [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: message }];
  const toolsUsed = new Set();
  let rounds = 0;
  while (true) {
    const reply = await generateCompletion([...messages]);
    const toolCalls = reply?.tool_calls || [];
    if (!toolCalls.length) {
      const answer = reply?.content?.trim();
      if (!answer) throw new Error("Il modello non ha restituito una risposta finale.");
      return { answer, tools_used: [...toolsUsed] };
    }
    if (rounds >= 4) throw new Error("Raggiunto il limite di round dei tool. Richiesta interrotta in sicurezza.");
    rounds++;
    messages.push({ role: "assistant", content: reply.content || null, tool_calls: toolCalls });
    for (const call of toolCalls) {
      let result;
      try {
        result = await executeTool(call);
        toolsUsed.add(call.function.name);
      } catch (error) {
        result = { error: error.message };
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
}
