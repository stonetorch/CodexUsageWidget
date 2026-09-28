import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";

export function findChatGptExecutable() {
  const script = "(Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1 -ExpandProperty InstallLocation)";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  });
  const installLocation = result.stdout?.trim();
  const executable = installLocation ? `${installLocation}\\app\\ChatGPT.exe` : null;
  if (!executable || !fs.existsSync(executable)) throw new Error("Could not locate the OpenAI.Codex Store package");
  return executable;
}

export function isChatGptRunning() {
  const result = spawnSync("tasklist.exe", ["/FI", "IMAGENAME eq ChatGPT.exe", "/NH"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return /ChatGPT\.exe/i.test(result.stdout || "");
}

export function launchChatGpt(debugPort) {
  const executable = findChatGptExecutable();
  const child = spawn(executable, [
    `--remote-debugging-port=${debugPort}`,
    "--remote-debugging-address=127.0.0.1",
  ], { detached: true, stdio: "ignore", windowsHide: false });
  child.unref();
}
