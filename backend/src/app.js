import cors from "cors";
import express from "express";
import { orchestrate } from "./orchestrator.js";
import { validateHistory } from "./history.js";

export const app = express();

app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "trialpulse-backend",
  });
});

app.post("/api/chat", async (req, res) => {
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
  } catch {
    return res.status(502).json({
      error: "Non è stato possibile completare la richiesta al modello entro i limiti operativi. Riprova o semplifica la domanda.",
    });
  }
});

app.use((error, req, res, next) => {
  res.status(error.status === 413 ? 413 : 400).json({ error: "Richiesta HTTP non valida." });
});