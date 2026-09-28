import fs from "node:fs";
import { AppServerClient } from "./app-server-client.mjs";
import { CdpClient, listCdpTargets } from "./cdp-client.mjs";
import { connectionPath, ensureAppDataDirectory, parseArgs } from "./config.mjs";
import { launchChatGpt, isChatGptRunning } from "./desktop-launcher.mjs";
import { updateSource } from "./widget-overlay.mjs";
import { ensureHookInstalled } from "./hook-installer.mjs";
import { startHookServer } from "./hook-server.mjs";
import { StateStore } from "./state-store.mjs";
import { normalizeRateLimitsResult } from "./transcript.mjs";
import { startTranscriptRecovery } from "./transcript-recovery.mjs";
import { usageView } from "./quota-estimator.mjs";

async function run() {
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const options = parseArgs(process.argv.slice(2));
const appWasRunning = isChatGptRunning();

async function anotherOverlayIsRunning() {
  try {
    const response = await fetch(`http://127.0.0.1:${options.hookPort}/health`, { signal: AbortSignal.timeout(500) });
    return response.ok;
  } catch { return false; }
}
if (await anotherOverlayIsRunning()) {
  launchChatGpt(appWasRunning ? null : options.debugPort);
  console.log("Codex window activated; usage widget is already running.");
  return;
}

let targets;
try {
  targets = await listCdpTargets(options.debugPort);
} catch {
  if (options.attach) {
    throw new Error(`No Codex debugging endpoint found on 127.0.0.1:${options.debugPort}`);
  }
  if (appWasRunning) {
    launchChatGpt();
    console.log("Codex window activated. It was started without CDP; restart it through this launcher to enable the widget.");
    return;
  }
  launchChatGpt(options.debugPort);
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await delay(250);
    try {
      targets = await listCdpTargets(options.debugPort);
      if (targets.length) break;
    } catch { /* wait for Electron */ }
  }
}
if (!targets?.length) throw new Error("Codex started, but no injectable renderer was exposed");
if (appWasRunning) launchChatGpt();

ensureAppDataDirectory();
try {
  if (ensureHookInstalled()) console.log("Installed Stop hook; Codex may request trust confirmation.");
} catch (error) { console.warn(`Could not install Stop hook: ${error.message}`); }
fs.writeFileSync(connectionPath(), JSON.stringify({ hookPort: options.hookPort, debugPort: options.debugPort }));

const store = new StateStore();
const stopRecovery = startTranscriptRecovery({ store });
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
      await client.request("Runtime.enable");
      try { await client.request("Runtime.addBinding", { name: "__codexUsageSaveSettings" }); }
      catch (error) { console.warn(`Settings bridge unavailable for ${target.id}: ${error.message}`); }
      try { await client.request("Page.enable"); } catch { /* Some webviews omit Page domain. */ }
      client.addEventListener("notification", (event) => {
        if (event.detail.method === "Page.frameNavigated" && !event.detail.params?.frame?.parentId) {
          setTimeout(() => void client.evaluate(updateSource(usageView(store.snapshot()))).catch(() => {}), 250);
          return;
        }
        if (event.detail.method !== "Runtime.bindingCalled" || event.detail.params?.name !== "__codexUsageSaveSettings") return;
        try {
          const command = JSON.parse(event.detail.params.payload);
          if (command?.action === "clearCalibrationEvidence") store.clearCalibrationEvidence();
          else store.updateSettings(command?.settings || command);
        }
        catch (error) { console.warn(`Ignored invalid widget settings: ${error.message}`); }
      });
      client.addEventListener("close", () => clients.delete(target.id));
      clients.set(target.id, client);
      await client.evaluate(updateSource(usageView(store.snapshot())));
      console.log(`Injected usage UI into: ${target.title || target.url || target.id}`);
    } catch (error) {
      clients.get(target.id)?.close();
      clients.delete(target.id);
      console.warn(`Could not inject target ${target.id}: ${error.message}`);
    }
  }
}

async function pushState() {
  const expression = updateSource(usageView(store.snapshot()));
  await Promise.allSettled([...clients.values()].map((client) => client.evaluate(expression)));
}

store.addEventListener("changed", () => void pushState());
await discoverAndInject();
const discoveryTimer = setInterval(discoverAndInject, 2000);

console.log("Codex Usage Overlay is running. Keep this process open; press Ctrl+C to stop.");
function shutdown() {
  stopRecovery();
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
