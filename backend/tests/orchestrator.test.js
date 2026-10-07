import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("../src/llm.js", () => ({ generateCompletion: vi.fn() }));
import { generateCompletion } from "../src/llm.js";
import { app } from "../src/app.js";
import { orchestrate } from "../src/orchestrator.js";
import { executeTool } from "../src/toolExecutor.js";
import { DATA_AGENT_URL, RAG_API_URL } from "../src/config.js";

const final = (content = "Risposta italiana.") => ({ role: "assistant", content, reasoning: "interno" });
const call = (name, args, id = "call_1") => ({
  id, type: "function", function: { name, arguments: JSON.stringify(args) },
});
const calls = (...tool_calls) => ({ role: "assistant", content: null, tool_calls });
let fetchMock;

beforeEach(() => {
  vi.resetAllMocks();
  fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [] }) });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("Contratto backend", () => {
  it("mantiene health", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", service: "trialpulse-backend" });
  });
  it.each([{}, { message: "" }, { message: "  " }, { message: 4 }, { message: null }])(
    "rifiuta message non valido: %j", async (body) => {
      const res = await request(app).post("/api/chat").send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("message");
      expect(generateCompletion).not.toHaveBeenCalled();
    },
  );
  it("risponde senza tool e senza ragionamento interno", async () => {
    generateCompletion.mockResolvedValue(final());
    const res = await request(app).post("/api/chat").send({ message: "  Presentati  " });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ answer: "Risposta italiana.", tools_used: [] });
    const messages = generateCompletion.mock.calls[0][0];
    expect(messages[0].role).toBe("system");
    expect(messages[1]).toEqual({ role: "user", content: "Presentati" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("nasconde errori provider e mantiene il processo disponibile", async () => {
    generateCompletion.mockRejectedValue(new Error("segreto provider"));
    const res = await request(app).post("/api/chat").send({ message: "Presentati" });
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain("segreto");
    expect((await request(app).get("/health")).status).toBe(200);
  });
  it("gestisce JSON HTTP malformato senza stack trace", async () => {
    const res = await request(app).post("/api/chat").set("Content-Type", "application/json").send("{");
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
    expect(res.text).not.toContain("SyntaxError");
  });
});

describe("Tool calling e servizi", () => {
  it.each([
    ["search_knowledge", { query: "Week 6 PSI" }, RAG_API_URL + "/retrieve"],
    ["analyze_operations", { analysis: "portfolio_summary" }, DATA_AGENT_URL + "/analyze"],
  ])("esegue %s via HTTP e reinserisce il risultato", async (name, args, url) => {
    const data = { results: [{ source: "knowledge_base/faq.md", distance: 0.12, enrolled: 154 }] };
    fetchMock.mockResolvedValue({ ok: true, json: async () => data });
    generateCompletion.mockResolvedValueOnce(calls(call(name, args))).mockResolvedValueOnce(final("Verificato."));
    const res = await request(app).post("/api/chat").send({ message: "Domanda" });
    expect(res.body).toEqual({ answer: "Verificato.", tools_used: [name] });
    expect(fetchMock.mock.calls[0][0]).toBe(url);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(args);
    const history = generateCompletion.mock.calls[1][0];
    expect(history[2]).toEqual(calls(call(name, args)));
    expect(history[3]).toEqual({ role: "tool", tool_call_id: "call_1", content: JSON.stringify(data) });
  });
  it("gestisce più round e deduplica i tool effettivamente eseguiti", async () => {
    generateCompletion.mockResolvedValueOnce(calls(call("search_knowledge", { query: "Protocollo" }, "a")))
      .mockResolvedValueOnce(calls(call("search_knowledge", { query: "Ruoli" }, "b")))
      .mockResolvedValueOnce(final());
    expect((await orchestrate("Domanda")).tools_used).toEqual(["search_knowledge"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("preserva tutti gli id quando arrivano tool call nello stesso round", async () => {
    generateCompletion.mockResolvedValueOnce(calls(
      call("search_knowledge", { query: "Protocollo" }, "a"),
      call("search_knowledge", { query: "Ruoli" }, "b"),
    )).mockResolvedValueOnce(final());
    await orchestrate("Domanda");
    expect(generateCompletion.mock.calls[1][0].filter(m => m.role === "tool").map(m => m.tool_call_id)).toEqual(["a", "b"]);
  });
  it("ammette quattro round e poi una risposta finale", async () => {
    for (let i = 0; i < 4; i++) generateCompletion.mockResolvedValueOnce(calls(call("search_knowledge", { query: "Ruoli" }, `c${i}`)));
    generateCompletion.mockResolvedValueOnce(final());
    expect((await orchestrate("Domanda")).answer).toBe("Risposta italiana.");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(generateCompletion).toHaveBeenCalledTimes(5);
  });
  it("non esegue un quinto round", async () => {
    generateCompletion.mockResolvedValue(calls(call("search_knowledge", { query: "Ruoli" })));
    await expect(orchestrate("Domanda")).rejects.toThrow("limite");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(generateCompletion).toHaveBeenCalledTimes(5);
  });
  it.each([
    call("unknown", {}), { ...call("search_knowledge", {}), function: { name: "search_knowledge", arguments: "{" } },
    call("search_knowledge", { query: "" }), call("analyze_operations", { analysis: "invented" }),
    call("analyze_operations", { analysis: "visits", unknown: true }),
    call("analyze_operations", { analysis: "visits", toString: "non ammesso" }),
  ])("non esegue tool o argomenti invalidi: %j", async (tool) => {
    generateCompletion.mockResolvedValueOnce(calls(tool)).mockResolvedValueOnce(final("Chiedo chiarimento."));
    const result = await orchestrate("Domanda");
    expect(result.tools_used).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(generateCompletion.mock.calls[1][0][3].content).error).toBeTruthy();
  });
  it.each(["search_knowledge", "analyze_operations"])("se %s è indisponibile informa il modello senza crash", async name => {
    fetchMock.mockRejectedValue(new Error("stack e segreto"));
    const args = name === "search_knowledge" ? { query: "Ruoli" } : { analysis: "visits" };
    generateCompletion.mockResolvedValueOnce(calls(call(name, args))).mockResolvedValueOnce(final("Servizio non disponibile."));
    const res = await request(app).post("/api/chat").send({ message: "Domanda" });
    expect(res.status).toBe(200);
    expect(res.body.tools_used).toEqual([name]);
    const error = JSON.parse(generateCompletion.mock.calls[1][0][3].content).error;
    expect(error).toBeTruthy();
    expect(error).not.toContain("segreto");
  });
  it("mantiene la validazione finale del Data Agent senza esporre errori grezzi", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400 });
    const result = await executeTool(call("analyze_operations", { analysis: "efficacy" }));
    expect(result.error).toContain("400");
  });
  it("gestisce output LLM vuoto", async () => {
    generateCompletion.mockResolvedValue(final(""));
    await expect(orchestrate("Domanda")).rejects.toThrow();
  });
});
