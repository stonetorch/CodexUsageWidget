export class CdpClient extends EventTarget {
  constructor(webSocketUrl) {
    super();
    this.webSocketUrl = webSocketUrl;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.webSocketUrl);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => this.#onMessage(event.data));
    this.socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) pending.reject(new Error("CDP connection closed"));
      this.pending.clear();
      this.dispatchEvent(new Event("close"));
    });
  }

  request(method, params = {}) {
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error("CDP is not connected"));
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return promise;
  }

  async evaluate(expression) {
    const response = await this.request("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (response?.exceptionDetails) throw new Error(response.exceptionDetails.text || "Injected script failed");
    return response;
  }

  close() {
    this.socket?.close();
  }

  #onMessage(raw) {
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    if (message.id == null) {
      if (message.method) this.dispatchEvent(new CustomEvent("notification", { detail: message }));
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
    else pending.resolve(message.result);
  }
}

export async function listCdpTargets(port) {
  const errors = [];
  // Recent desktop builds may bind only IPv6 loopback even when launched with
  // --remote-debugging-address=127.0.0.1. Keep discovery on explicit loopback IPs.
  for (const host of ["127.0.0.1", "[::1]"]) {
    try {
      const response = await fetch(`http://${host}:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const targets = await response.json();
      if (!Array.isArray(targets)) throw new Error("Invalid CDP target list");
      return targets.filter((target) => target?.webSocketDebuggerUrl && ["page", "webview"].includes(target.type));
    } catch (error) {
      errors.push(`${host}:${port}: ${error.message}`);
    }
  }
  throw new Error(`No loopback CDP endpoint available (${errors.join("; ")})`);
}

export function isCodexAppTarget(target) {
  return target.type === "page" && String(target.url || "").startsWith("app://-/");
}
