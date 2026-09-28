import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function ensureHookInstalled({
  hooksFile = path.join(os.homedir(), ".codex", "hooks.json"),
  launcherPath = process.env.CUO_LAUNCHER_EXE,
  nodePath = process.execPath,
  clientPath = new URL("./hook-client.mjs", import.meta.url).pathname,
} = {}) {
  const quoted = (value) => `"${String(value).replaceAll('"', '\\"')}"`;
  const command = launcherPath
    ? `${quoted(launcherPath)} --hook-client`
    : `${quoted(nodePath)} ${quoted(decodeURIComponent(clientPath.replace(/^\/(\w:)/, "$1")))}`;
  fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
  let config = { hooks: {} };
  if (fs.existsSync(hooksFile)) {
    config = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
  }
  config.hooks ||= {};
  const existing = Array.isArray(config.hooks.Stop) ? config.hooks.Stop : [];
  const own = (handler) => handler?.command === command || /codex-usage-overlay|CodexUsageOverlay/i.test(handler?.command || "");
  const kept = existing.map((entry) => ({
    ...entry,
    hooks: (entry.hooks || []).filter((handler) => !own(handler)),
  })).filter((entry) => entry.hooks.length);
  const ownCommands = existing.flatMap((entry) => (entry.hooks || []).filter(own).map((handler) => handler.command));
  if (ownCommands.length === 1 && ownCommands[0] === command) return false;
  config.hooks.Stop = [...kept, { hooks: [{ type: "command", command, async: true, timeout: 15 }] }];
  if (fs.existsSync(hooksFile)) fs.copyFileSync(hooksFile, `${hooksFile}.${new Date().toISOString().replaceAll(/[:.]/g, "-")}.bak`);
  fs.writeFileSync(hooksFile, `${JSON.stringify(config, null, 2)}\n`);
  return true;
}
