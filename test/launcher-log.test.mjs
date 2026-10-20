import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(new URL("../launcher/Program.cs", import.meta.url), "utf8");
assert.ok(source.indexOf("using var log =") < source.indexOf("Process.Start(start)"), "Logging must be prepared before spawning the runtime");

if (process.platform === "win32") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-launcher-log-"));
  try {
    const result = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-File", fileURLToPath(new URL("./launcher-log.test.ps1", import.meta.url)),
      "-SourcePath", fileURLToPath(new URL("../launcher/LauncherLog.cs", import.meta.url)), "-TestDirectory", directory,
    ], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
    console.log(result.stdout.trim());
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
} else {
  console.log("launcher log: Windows file-sharing cases skipped on this platform");
}
