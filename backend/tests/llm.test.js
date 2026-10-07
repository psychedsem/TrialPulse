import { beforeEach, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("groq-sdk", () => ({ default: vi.fn(function () {
  return { chat: { completions: { create: sdk.create } } };
}) }));
vi.mock("../src/config.js", () => ({ GROQ_API_KEY: "test-placeholder", GROQ_MODEL: "openai/gpt-oss-120b" }));
import { generateCompletion } from "../src/llm.js";

beforeEach(() => vi.clearAllMocks());

it("invia i due tool nativi con scelta automatica senza ragionamento esposto", async () => {
  sdk.create.mockResolvedValue({ choices: [{ message: { role: "assistant", content: "Risposta." } }] });
  const messages = [{ role: "user", content: "Domanda" }];
  expect(await generateCompletion(messages)).toEqual({ role: "assistant", content: "Risposta." });
  const payload = sdk.create.mock.calls[0][0];
  expect(payload.model).toBe("openai/gpt-oss-120b");
  expect(payload.messages).toEqual(messages);
  expect(payload.tool_choice).toBe("auto");
  expect(payload.include_reasoning).toBe(false);
  expect(payload.tools.map(tool => tool.function.name)).toEqual(["search_knowledge", "analyze_operations"]);
});
