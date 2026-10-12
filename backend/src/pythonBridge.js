import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../scripts/python_bridge.py", import.meta.url));
const TIMEOUT_MS = 60000;
const IDLE_MS = 300000;
const MAX_INPUT_BYTES = 131072;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_WAITING = 3;
const ALLOWED_CODES = new Set(["service_error", "invalid_request", "invalid_frame"]);
let nextId = 0;
let dataActive = 0;
const MAX_DATA_ACTIVE = 2;

function interpreter() {
  if (process.env.PYTHON_BRIDGE_ENABLED !== "true") return null;
  const candidate = process.env.PYTHON_EXECUTABLE;
  return typeof candidate === "string" && isAbsolute(candidate) && existsSync(candidate) ? candidate : null;
}

function childEnv() {
  const allowed = ["SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE",
    "LOCALAPPDATA", "APPDATA", "XDG_CACHE_HOME", "HF_HOME", "HF_HUB_CACHE", "TRANSFORMERS_CACHE"];
  const env = {};
  for (const key of allowed) if (typeof process.env[key] === "string") env[key] = process.env[key];
  env.PYTHONDONTWRITEBYTECODE = "1";
  env.PYTHONIOENCODING = "utf-8";
  env.PYTHONUNBUFFERED = "1";
  env.HF_HUB_OFFLINE = "1";
  env.TRANSFORMERS_OFFLINE = "1";
  // Never inherit GROQ_API_KEY, PATH or arbitrary application secrets.
  return env;
}

function decodeFrame(data, id) {
  let packet;
  try { packet = JSON.parse(data); } catch { return null; }
  if (!packet || typeof packet !== "object" || Array.isArray(packet) ||
    packet.v !== 1 || packet.id !== id || typeof packet.ok !== "boolean") return null;
  if (packet.ok) return Object.hasOwn(packet, "result") ? { ok: true, result: packet.result } : null;
  const error = packet.error;
  if (!error || !ALLOWED_CODES.has(error.code) || ![400, 422, 503].includes(error.status)) return null;
  return { ok: false, error: { status: error.status, code: error.code } };
}

function createChild(python, mode, worker) {
  return spawn(python, ["-B", "-u", SCRIPT, "--mode", mode, ...(worker ? ["--worker"] : [])], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    env: childEnv(),
    windowsHide: true,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function closeChild(child) {
  try { if (!child.killed) child.kill(); } catch { /* Processo gia terminato. */ }
}

function finishTask(task, value) {
  clearTimeout(task.queueTimer);
  clearTimeout(task.timer);
  task.resolve(value);
}

function oneShot(python, frame) {
  return new Promise(resolve => {
    const child = createChild(python, "analyze", false);
    let output = "";
    let settled = false;
    let invalid = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => { closeChild(child); finish(null); }, TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      output += chunk;
      if (Buffer.byteLength(output, "utf8") > MAX_FRAME_BYTES) {
        invalid = true;
        closeChild(child);
      }
    });
    child.stderr.on("data", () => {});
    child.on("error", () => finish(null));
    child.on("close", code => {
      if (invalid || code !== 0) return finish(null);
      const lines = output.trim().split(/\r?\n/);
      finish(lines.length === 1 ? decodeFrame(lines[0], frame.id) : null);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(frame) + "\n");
  });
}

// A single lazy RAG worker serializes requests; it is never shared with Data.
class RagWorker {
  constructor() {
    this.process = null;
    this.pending = [];
    this.active = null;
    this.buffer = "";
    this.idleTimer = null;
    this.exitHandler = () => this.stop();
  }

  reset() {
    const child = this.process;
    this.process = null;
    if (child) process.removeListener("exit", this.exitHandler);
    this.buffer = "";
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.active) {
      finishTask(this.active, null);
      this.active = null;
    }
    if (child) closeChild(child);
    this.dispatch();
  }

  dispatch() {
    if (this.active) return;
    if (!this.pending.length) {
      if (this.process && !this.idleTimer) {
        const child = this.process;
        this.idleTimer = setTimeout(() => {
          this.idleTimer = null;
          if (this.process === child && !this.active && !this.pending.length) {
            this.reset();
          }
        }, IDLE_MS);
        this.idleTimer.unref?.();
      }
      return;
    }
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const task = this.pending.shift();
    clearTimeout(task.queueTimer);
    if (!this.start(task.python)) {
      finishTask(task, null);
      this.dispatch();
      return;
    }
    task.timer = setTimeout(() => this.reset(), TIMEOUT_MS);
    this.active = task;
    this.process.stdin.write(JSON.stringify(task.frame) + "\n");
  }

  start(python) {
    if (this.process) return true;
    try {
      this.process = createChild(python, "retrieve", true);
      process.once("exit", this.exitHandler);
    } catch { return false; }
    const child = this.process;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      if (this.process !== child) return;
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer, "utf8") > MAX_FRAME_BYTES) return this.reset();
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (this.buffer.length) return this.reset();
      const current = this.active;
      if (!current) return this.reset();
      const decoded = decodeFrame(line, current.frame.id);
      if (!decoded) return this.reset();
      this.active = null;
      finishTask(current, decoded);
      this.dispatch();
    });
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => this.reset());
    child.on("error", () => { if (this.process === child) this.reset(); });
    child.on("close", () => { if (this.process === child) this.reset(); });
    return true;
  }

  run(python, frame) {
    if (this.pending.length >= MAX_WAITING) return Promise.resolve(null);
    return new Promise(resolve => {
      const task = { python, frame, resolve };
      task.queueTimer = setTimeout(() => {
        const index = this.pending.indexOf(task);
        if (index >= 0) { this.pending.splice(index, 1); finishTask(task, null); }
      }, TIMEOUT_MS);
      this.pending.push(task);
      this.dispatch();
    });
  }

  stop() {
    const waiting = this.pending.splice(0);
    for (const task of waiting) finishTask(task, null);
    this.reset();
  }
}

const ragWorker = new RagWorker();

export function isConnectionRefused(error) {
  const cause = error?.cause;
  if (cause?.code === "ECONNREFUSED") return true;
  const errors = cause?.errors;
  return Array.isArray(errors) && errors.length > 0 &&
    errors.every(item => item?.code === "ECONNREFUSED");
}

export function isLoopbackUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  } catch { return false; }
}

export async function localPythonFallback(url, args, service) {
  if (!isLoopbackUrl(url)) return null;
  const python = interpreter();
  if (!python) return null;
  const frame = { v: 1, id: ++nextId, op: service === "RAG" ? "retrieve" : "analyze", body: args };
  if (Buffer.byteLength(JSON.stringify(frame), "utf8") + 1 > MAX_INPUT_BYTES) return null;
  let output;
  try {
    if (service === "RAG") output = await ragWorker.run(python, frame);
    else {
      if (dataActive >= MAX_DATA_ACTIVE) return { error: `Servizio ${service} non disponibile. Nessun risultato ottenuto.` };
      dataActive++;
      try { output = await oneShot(python, frame); }
      finally { dataActive--; }
    }
  } catch {
    output = null;
  }
  if (!output) return { error: `Servizio ${service} non disponibile. Nessun risultato ottenuto.` };
  if (!output.ok) return { error: `Il servizio ${service} ha rifiutato la richiesta (HTTP ${output.error.status}). Verifica gli argomenti.` };
  return output.result;
}

export function stopPythonWorker() { ragWorker.stop(); }
