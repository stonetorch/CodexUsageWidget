import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

function executableCandidates() {
  const candidates = [];
  if (process.env.CODEX_CLI_PATH) candidates.push(process.env.CODEX_CLI_PATH);

  const localRoot = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const binRoot = path.join(localRoot, "OpenAI", "Codex", "bin");
  try {
    const versionDirectories = fs
      .readdirSync(binRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(binRoot, entry.name, "codex.exe"))
      .filter((candidate) => fs.existsSync(candidate))
      .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
    candidates.push(...versionDirectories);
  } catch {
    // Fall through to the command on PATH.
  }
  candidates.push("codex");
  return [...new Set(candidates)];
}

export function resolveCodexExecutable() {
  return executableCandidates().find((candidate) => candidate === "codex" || fs.existsSync(candidate)) || "codex";
}

export class AppServerClient extends EventTarget {
  constructor({ cwd = process.cwd(), logger = console } = {}) {
    super();
    this.cwd = cwd;
    this.logger = logger;
    this.nextId = 1;
    this.pending = new Map();
    this.process = null;
  }

  async start() {
    if (this.process) return;
    const executable = resolveCodexExecutable();
    this.process = spawn(executable, ["app-server", "--stdio"], {
      cwd: this.cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (chunk) => {
      const message = chunk.trim();
      if (message) this.logger.debug?.(`[app-server] ${message}`);
    });
    this.process.on("exit", (code, signal) => {
      const error = new Error(`Codex app-server exited (${code ?? signal ?? "unknown"})`);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.process = null;
      this.dispatchEvent(new CustomEvent("exit", { detail: { code, signal } }));
    });

    const lines = readline.createInterface({ input: this.process.stdout });
    lines.on("line", (line) => this.#handleLine(line));

    await this.request("initialize", {
      clientInfo: {
        name: "codex_usage_overlay",
        title: "Codex Usage Overlay",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: false },
    });
    this.notify("initialized", {});
  }

  request(method, params = {}) {
    if (!this.process?.stdin.writable) return Promise.reject(new Error("Codex app-server is not running"));
    const id = this.nextId++;
    const timeout = setTimeout(() => {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      pending.reject(new Error(`${method} timed out`));
    }, 15_000);
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, timeout }));
    this.process.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    return promise;
  }

  notify(method, params = {}) {
    this.process?.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async readRateLimits() {
    return this.request("account/rateLimits/read", {});
  }

  close() {
    this.process?.kill();
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.logger.warn?.("Ignored non-JSON app-server output");
      return;
    }
    if (message.id != null) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (message.method) this.dispatchEvent(new CustomEvent("notification", { detail: message }));
  }
}
