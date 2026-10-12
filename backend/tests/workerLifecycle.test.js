import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));
import * as current from "../src/pythonBridge.js";
const previous = process.env.TRIALPULSE_COMPARISON_ROOT ? await import(pathToFileURL(
  resolve(process.env.TRIALPULSE_COMPARISON_ROOT, "backend/src/pythonBridge.js")).href) : null;
const originalEnvironment = { enabled: process.env.PYTHON_BRIDGE_ENABLED, python: process.env.PYTHON_EXECUTABLE };
afterEach(() => {
  current.stopPythonWorker(); previous?.stopPythonWorker(); vi.useRealTimers();
  for (const [key, value] of [["PYTHON_BRIDGE_ENABLED", originalEnvironment.enabled], ["PYTHON_EXECUTABLE", originalEnvironment.python]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

async function replay(bridge, scenario) {
  vi.useFakeTimers();
  process.env.PYTHON_BRIDGE_ENABLED = "true";
  process.env.PYTHON_EXECUTABLE = process.execPath;
  const children = [], events = [];
  const baselineListeners = process.listenerCount("exit");
  spawn.mockReset().mockImplementation((python, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.frames = [];
    child.stdin.write = child.stdin.end = text => { child.frames.push(JSON.parse(text)); };
    child.kill = () => { child.killed = true; events.push("kill"); child.emit("close", 0); };
    children.push(child);
    events.push({ args: args.slice(0, 2).concat(args.slice(-3)), shell: options.shell,
      windowsHide: options.windowsHide, credentials: Object.keys(options.env).filter(key => /KEY|TOKEN|SECRET|PASSWORD/.test(key)) });
    return child;
  });
  const request = query => bridge.localPythonFallback("http://127.0.0.1:9/retrieve", { query }, "RAG");
  const respond = (child, result, extra = {}) => child.stdout.emit("data", JSON.stringify({ v: 1,
    id: child.frames.at(-1).id, ok: true, result, ...extra }) + "\n");
  let results;
  if (scenario === "fifo") {
    const first = request("prima"), second = request("seconda");
    expect(children[0].frames.map(frame => frame.body.query)).toEqual(["prima"]);
    respond(children[0], { results: [{ text: "prima" }] });
    expect(children[0].frames.map(frame => frame.body.query)).toEqual(["prima", "seconda"]);
    respond(children[0], { results: [{ text: "seconda" }] });
    results = await Promise.all([first, second]);
  } else if (scenario === "capacity") {
    const pending = Array.from({ length: 5 }, (_, i) => request(`query ${i}`));
    expect(await pending[4]).toHaveProperty("error");
    bridge.stopPythonWorker(); results = await Promise.all(pending);
  } else if (scenario === "idle_restart") {
    const first = request("prima"); respond(children[0], { results: [] }); await first;
    expect(process.listenerCount("exit")).toBe(baselineListeners + 1);
    await vi.advanceTimersByTimeAsync(300000);
    expect(process.listenerCount("exit")).toBe(baselineListeners);
    const second = request("seconda"); respond(children[1], { results: [] });
    results = [await second];
  } else if (scenario === "active_timeout") {
    const pending = request("senza risposta");
    await vi.advanceTimersByTimeAsync(60000); results = [await pending];
  } else if (scenario === "queue_timeout") {
    const first = request("prima"), second = request("seconda"), third = request("terza");
    await vi.advanceTimersByTimeAsync(50000); respond(children[0], { results: [] }); await first;
    await vi.advanceTimersByTimeAsync(10000); const expired = await third;
    respond(children[0], { results: [] }); results = [await second, expired];
    expect(children[0].frames.map(frame => frame.body.query)).toEqual(["prima", "seconda"]);
  } else {
    const pending = request("framing");
    if (scenario === "wrong_id") respond(children[0], {}, { id: -1 });
    if (scenario === "bad_json") children[0].stdout.emit("data", "{\n");
    if (scenario === "two_frames") children[0].stdout.emit("data", "{}\n{}\n");
    if (scenario === "spawn_error") children[0].emit("error", Error("CANARY_PRIVATO"));
    results = [await pending];
  }
  bridge.stopPythonWorker();
  expect(process.listenerCount("exit")).toBe(baselineListeners);
  expect(vi.getTimerCount()).toBe(0);
  expect(children.every(child => child.killed)).toBe(true);
  const outcome = { results, events, frames: children.map(child => child.frames.map(frame => ({ op: frame.op, body: frame.body }))) };
  expect(JSON.stringify(outcome)).not.toContain("CANARY_PRIVATO");
  vi.useRealTimers();
  return outcome;
}

it.each(["fifo", "capacity", "idle_restart", "active_timeout", "queue_timeout", "wrong_id", "bad_json", "two_frames", "spawn_error"])(
  "preserva coda, protocollo, timer e cleanup del worker: %s", async scenario => {
    const result = await replay(current, scenario);
    if (previous) expect(result).toEqual(await replay(previous, scenario));
  });