import { afterEach, expect, it } from "vitest";
import { isConnectionRefused, isLoopbackUrl, localPythonFallback, stopPythonWorker } from "../src/pythonBridge.js";

const original = { enabled: process.env.PYTHON_BRIDGE_ENABLED, python: process.env.PYTHON_EXECUTABLE };
afterEach(() => {
  if (original.enabled === undefined) delete process.env.PYTHON_BRIDGE_ENABLED;
  else process.env.PYTHON_BRIDGE_ENABLED = original.enabled;
  if (original.python === undefined) delete process.env.PYTHON_EXECUTABLE;
  else process.env.PYTHON_EXECUTABLE = original.python;
  stopPythonWorker();
});

it("ammette solo URL HTTP di loopback", () => {
  for (const url of ["http://127.0.0.1:8000/analyze", "http://localhost:8001/retrieve", "http://[::1]:8000/analyze"])
    expect(isLoopbackUrl(url)).toBe(true);
  for (const url of ["https://127.0.0.1:8000/analyze", "http://192.168.1.12:8000", "http://example.com", "not-a-url"])
    expect(isLoopbackUrl(url)).toBe(false);
});

it("non confonde ECONNREFUSED con timeout, reset e altri errori", () => {
  expect(isConnectionRefused({ cause: { code: "ECONNREFUSED" } })).toBe(true);
  expect(isConnectionRefused({ cause: { errors: [{ code: "ECONNREFUSED" }, { code: "ECONNREFUSED" }] } })).toBe(true);
  expect(isConnectionRefused({ cause: { errors: [{ code: "ECONNREFUSED" }, { code: "ETIMEDOUT" }] } })).toBe(false);
  for (const code of ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH", "UND_ERR_SOCKET"])
    expect(isConnectionRefused({ cause: { code } })).toBe(false);
  expect(isConnectionRefused(new Error("fetch failed"))).toBe(false);
});

it("è disabilitato di default, anche con richiesta valida", async () => {
  delete process.env.PYTHON_BRIDGE_ENABLED;
  process.env.PYTHON_EXECUTABLE = "/non/esiste/python";
  expect(await localPythonFallback("http://127.0.0.1:8000/analyze", { analysis: "portfolio_summary" }, "Data Agent")).toBeNull();
});

it("non avvia interpreti relativi o inesistenti", async () => {
  process.env.PYTHON_BRIDGE_ENABLED = "true";
  for (const python of ["python", "../../python", "/non/esiste/python"]) {
    process.env.PYTHON_EXECUTABLE = python;
    expect(await localPythonFallback("http://127.0.0.1:8000/analyze", { analysis: "portfolio_summary" }, "Data Agent")).toBeNull();
  }
});

it("non permette fallback verso URL remoti", async () => {
  process.env.PYTHON_BRIDGE_ENABLED = "true";
  process.env.PYTHON_EXECUTABLE = process.execPath;
  expect(await localPythonFallback("http://example.com/analyze", { analysis: "portfolio_summary" }, "Data Agent")).toBeNull();
});

it("non registra listener exit senza un worker attivo", async () => {
  const baseline = process.listenerCount("exit");
  await import("../src/pythonBridge.js?exit-listener-regression");
  expect(process.listenerCount("exit")).toBe(baseline);
});
