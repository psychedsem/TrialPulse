import { app } from "./app.js";
import { PORT } from "./config.js";

app.listen(PORT, () => {
  console.log(`TrialPulse backend attivo su http://localhost:${PORT}`);
});