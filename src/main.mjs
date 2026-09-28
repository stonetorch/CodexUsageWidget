import fs from "node:fs";
import { AppServerClient } from "./app-server-client.mjs";
import { CdpClient, listCdpTargets } from "./cdp-client.mjs";
import { connectionPath, ensureAppDataDirectory, parseArgs } from "./config.mjs";
import { launchChatGpt, isChatGptRunning } from "./desktop-launcher.mjs";
import { updateSource } from "./dom-overlay.mjs";
import { startHookServer } from "./hook-server.mjs";
import { StateStore } from "./state-store.mjs";
import { normalizeRateLimitsResult } from "./transcript.mjs";

async function run() {
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const options = parseArgs(process.argv.slice(2));

let targets;
try {
  targets = await listCdpTargets(options.debugPort);
} catch {
  if (options.attach) {
    throw new Error(`No Codex debugging endpoint found on 127.0.0.1:${options.debugPort}`);
  }
  if (isChatGptRunning()) {
    throw new Error("ChatGPT/Codex is already running without DOM debugging. Fully quit it from the tray, then run start.ps1.");
  }
  launchChatGpt(options.debugPort);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await delay(250);
    try {
      targets = await listCdpTargets(options.debugPort);
      if (targets.length) break;
    } catch { /* wait for Electron */ }
  }
}
if (!targets?.length) throw new Error("Codex started, but no injectable renderer was exposed");

ensureAppDataDirectory();
fs.writeFileSync(connectionPath(), JSON.stringify({ hookPort: options.hookPort, debugPort: options.debugPort }));

const store = new StateStore();
const hookServer = startHookServer({ port: options.hookPort, store });
const appServer = new AppServerClient({ cwd: process.cwd() });
await appServer.start();

async function refreshLimits() {
  try {
    store.setLimits(normalizeRateLimitsResult(await appServer.readRateLimits()));
  } catch (error) {
    console.warn(`Unable to refresh limits: ${error.message}`);
  }
}

appServer.addEventListener("notification", (event) => {
  if (event.detail.method === "account/rateLimits/updated") {
    const normalized = normalizeRateLimitsResult(event.detail.params);
    if (normalized) store.setLimits(normalized);
  }
});
await refreshLimits();
const limitTimer = setInterval(refreshLimits, 60_000);

const clients = new Map();
async function discoverAndInject() {
  let currentTargets = [];
  try { currentTargets = await listCdpTargets(options.debugPort); } catch { return; }
  const currentIds = new Set(currentTargets.map((target) => target.id));
  for (const [id, client] of clients) {
    if (!currentIds.has(id)) {
      client.close();
      clients.delete(id);
    }
  }
  for (const target of currentTargets) {
    if (clients.has(target.id)) continue;
    try {
      const client = new CdpClient(target.webSocketDebuggerUrl);
      await client.connect();
      client.addEventListener("close", () => clients.delete(target.id));
      clients.set(target.id, client);
      await client.evaluate(updateSource(store.snapshot()));
      console.log(`Injected usage UI into: ${target.title || target.url || target.id}`);
    } catch (error) {
      console.warn(`Could not inject target ${target.id}: ${error.message}`);
    }
  }
}

async function pushState() {
  const expression = updateSource(store.snapshot());
  await Promise.allSettled([...clients.values()].map((client) => client.evaluate(expression)));
}

store.addEventListener("changed", () => void pushState());
await discoverAndInject();
const discoveryTimer = setInterval(discoverAndInject, 2000);

console.log("Codex Usage Overlay is running. Keep this process open; press Ctrl+C to stop.");
function shutdown() {
  clearInterval(limitTimer);
  clearInterval(discoveryTimer);
  for (const client of clients.values()) client.close();
  hookServer.close();
  appServer.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
}

try {
  await run();
} catch (error) {
  console.error(`Codex Usage Overlay could not start: ${error.message}`);
  process.exit(1);
}
