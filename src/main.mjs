import fs from "node:fs";
import { AppServerClient } from "./app-server-client.mjs";
import { CdpClient, isCodexAppTarget, listCdpTargets } from "./cdp-client.mjs";
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
      if (targets.some(isCodexAppTarget)) break;
    } catch { /* wait for Electron */ }
  }
}
if (!targets?.some(isCodexAppTarget)) throw new Error("Codex started, but no injectable renderer was exposed");
if (appWasRunning) launchChatGpt();

ensureAppDataDirectory();
try {
  if (ensureHookInstalled()) console.log("Installed Stop hook; Codex may request trust confirmation.");
} catch (error) { console.warn(`Could not install Stop hook: ${error.message}`); }
fs.writeFileSync(connectionPath(), JSON.stringify({ hookPort: options.hookPort, debugPort: options.debugPort }));

const store = new StateStore();
const pageSessionIds = new Map();
const stopRecovery = startTranscriptRecovery({ store, prioritySessionIds: () => new Set(pageSessionIds.values()) });
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
const cleanedTargets = new Set();
async function trackPageSession(id, client) {
  try {
    const result = await client.evaluate("window.__CODEX_USAGE_WIDGET_SESSION__?.detectedSessionId || null");
    const sessionId = result.result?.value;
    if (typeof sessionId === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(sessionId)) {
      pageSessionIds.set(id, sessionId);
    } else pageSessionIds.delete(id);
  } catch { pageSessionIds.delete(id); }
}
async function removeOverlay(target) {
  const client = new CdpClient(target.webSocketDebuggerUrl);
  try {
    await client.connect();
    await client.evaluate("window.__codexUsageOverlayV2?.destroy();window.__codexUsageOverlay?.destroy()");
  } finally { client.close(); }
}
async function discoverAndInject() {
  let currentTargets = [];
  try { currentTargets = await listCdpTargets(options.debugPort); } catch { return; }
  const currentIds = new Set(currentTargets.map((target) => target.id));
  for (const id of cleanedTargets) if (!currentIds.has(id)) cleanedTargets.delete(id);
  for (const [id, client] of clients) {
    const target = currentTargets.find((item) => item.id === id);
    if (!target || !isCodexAppTarget(target)) {
      if (target) try { await client.evaluate("window.__codexUsageOverlayV2?.destroy();window.__codexUsageOverlay?.destroy()"); } catch { /* Renderer may have navigated. */ }
      client.close();
      clients.delete(id);
      pageSessionIds.delete(id);
    }
  }
  for (const target of currentTargets) {
    if (!isCodexAppTarget(target)) {
      if (!cleanedTargets.has(target.id)) {
        try { await removeOverlay(target); cleanedTargets.add(target.id); } catch { /* Retry on next discovery. */ }
      }
      continue;
    }
    cleanedTargets.delete(target.id);
    if (clients.has(target.id)) {
      await trackPageSession(target.id, clients.get(target.id));
      continue;
    }
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
      await trackPageSession(target.id, client);
      console.log(`Injected usage UI into: ${target.title || target.url || target.id}`);
    } catch (error) {
      clients.get(target.id)?.close();
      clients.delete(target.id);
      pageSessionIds.delete(target.id);
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
