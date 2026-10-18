import { defineConfig } from "@playwright/test";

// Un processo dedicato evita di usare la sessione di sviluppo dell'operatore.
const port = 5187;
export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "../.tmp/playwright/results",
  reporter: [
    ["list"],
    [
      "html",
      {
        outputFolder: "../.tmp/playwright/report",
        open: "never",
      },
    ],
  ],
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `npm run dev -- --config vite.e2e.config.js --host 127.0.0.1 --port ${port} --strictPort --mode test`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    env: { VITE_API_BASE_URL: "" },
  },
});
