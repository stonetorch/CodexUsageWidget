import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureHookInstalled } from "../src/hook-installer.mjs";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cuo-hook-test-"));
const hooksFile = path.join(directory, "hooks.json");
fs.writeFileSync(hooksFile, JSON.stringify({ hooks: { Stop: [
  { hooks: [{ type: "command", command: "other-tool" }] },
  { hooks: [{ type: "command", command: "old-codex-usage-overlay/hook-client.mjs" }] },
] } }));
try {
  assert.equal(ensureHookInstalled({ hooksFile, nodePath: "C:\\Node\\node.exe", clientPath: "C:\\Widget\\hook-client.mjs" }), true);
  const config = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
  assert.equal(config.hooks.Stop.length, 2);
  assert.equal(config.hooks.Stop[0].hooks[0].command, "other-tool");
  assert.match(config.hooks.Stop[1].hooks[0].command, /C:\\Widget\\hook-client\.mjs/);
  assert.equal(ensureHookInstalled({ hooksFile, nodePath: "C:\\Node\\node.exe", clientPath: "C:\\Widget\\hook-client.mjs" }), false);
  assert.equal(fs.readdirSync(directory).filter((name) => name.endsWith(".bak")).length, 1);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
console.log("hook installer: ok");
