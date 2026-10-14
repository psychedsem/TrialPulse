import { app } from "./app.js";
import { PORT } from "./config.js";

app.listen(PORT, "127.0.0.1", () => {
  console.log(`TrialPulse backend attivo su http://localhost:${PORT}`);
});