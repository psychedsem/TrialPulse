import cors from "cors";
import { publicChatGuard } from "./publicGuard.js";
import express from "express";
import { orchestrate } from "./orchestrator.js";
import { validateHistory } from "./history.js";

export const app = express();

app.set("trust proxy", "loopback");
app.use(cors({
  origin: [
    "https://trialpulse-25650.web.app",
    "https://trialpulse-25650.firebaseapp.com",
    "http://localhost:5173"
  ]
}));
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "trialpulse-backend",
  });
});

app.post("/api/chat", publicChatGuard, async (req, res) => {
  const { message } = req.body ?? {};

  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({
      error: "Il campo message è obbligatorio.",
    });
  }

  let history;
  try {
    history = validateHistory(req.body.history);
  } catch {
    return res.status(400).json({ error: "Cronologia della conversazione non valida." });
  }

  try {
    return res.json(await orchestrate(message.trim(), history));
  } catch (error) {
    const reason = typeof error?.status === "number" ? "provider_http_error" :
      typeof error?.message === "string" && error.message.includes("risposta finale") ?
        "final_answer_error" : "orchestration_error";
    const status = reason === "provider_http_error" && Number.isInteger(error.status)
      ? `; status=${error.status}` : "";
    const diagnostic = error?.providerDiagnostics;
    const fields = diagnostic ? `; round=${diagnostic.round}; code=${diagnostic.code}; type=${diagnostic.type}; model=${diagnostic.model}; category=${diagnostic.category}; phase=${diagnostic.phase}` : "";
    try {
      console.warn(`[TrialPulse] /api/chat non completata: ${reason}${status}${fields}`);
    } catch { /* La diagnostica non deve impedire la risposta controllata. */ }
    return res.status(502).json({
      error: "Non è stato possibile completare la richiesta al modello entro i limiti operativi. Riprova o semplifica la domanda.",
    });
  }
});

app.use((error, req, res, next) => {
  res.status(error.status === 413 ? 413 : 400).json({ error: "Richiesta HTTP non valida." });
});