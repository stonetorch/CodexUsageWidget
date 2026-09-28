import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const APP_NAME = "CodexUsageOverlay";
export const DEFAULT_DEBUG_PORT = 9237;
export const DEFAULT_HOOK_PORT = 47839;

export function appDataDirectory() {
  const root = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(root, APP_NAME);
}

export function ensureAppDataDirectory() {
  const directory = appDataDirectory();
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

export function statePath() {
  return path.join(appDataDirectory(), "state.json");
}

export function connectionPath() {
  return path.join(appDataDirectory(), "connection.json");
}

export function parseArgs(argv) {
  const options = {
    attach: false,
    debugPort: DEFAULT_DEBUG_PORT,
    hookPort: DEFAULT_HOOK_PORT,
    mock: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--attach") options.attach = true;
    else if (argument === "--mock") options.mock = true;
    else if (argument === "--debug-port") options.debugPort = Number(argv[++index]);
    else if (argument === "--hook-port") options.hookPort = Number(argv[++index]);
  }

  if (!Number.isInteger(options.debugPort) || options.debugPort < 1024 || options.debugPort > 65535) {
    throw new Error("--debug-port must be an integer between 1024 and 65535");
  }
  if (!Number.isInteger(options.hookPort) || options.hookPort < 1024 || options.hookPort > 65535) {
    throw new Error("--hook-port must be an integer between 1024 and 65535");
  }
  return options;
}
