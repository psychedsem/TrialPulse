import "dotenv/config";

export const PORT = Number(process.env.PORT || 3001);
export const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
export const GROQ_MODEL =
  process.env.GROQ_MODEL || "openai/gpt-oss-120b";
export const DATA_AGENT_URL = (process.env.DATA_AGENT_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
export const RAG_API_URL = (process.env.RAG_API_URL || "http://127.0.0.1:8001").replace(/\/$/, "");
