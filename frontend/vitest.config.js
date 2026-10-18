import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  envDir: false,
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["tests/react/**/*.test.jsx"],
    setupFiles: ["./tests/react/setup.js"],
    restoreMocks: true,
  },
});
