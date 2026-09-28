import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseLatestCompletedTranscriptFile } from "./transcript.mjs";

const MAX_AGE_MS = 48 * 60 * 60 * 1000;
const MAX_FILES = 200;

function recentFiles(root, now) {
  const directories = [root];
  const files = [];
  while (directories.length) {
    const directory = directories.pop();
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(filePath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const stat = fs.statSync(filePath);
          if (stat.mtimeMs >= now - MAX_AGE_MS && stat.size > 0 && stat.size <= 64 * 1024 * 1024) {
            files.push({ filePath, modified: stat.mtimeMs, size: stat.size });
          }
        } catch { /* A transcript may be removed while scanning. */ }
      }
    }
  }
  return files.sort((a, b) => b.modified - a.modified).slice(0, MAX_FILES);
}

export function recoverRecentTranscripts({
  root = path.join(os.homedir(), ".codex", "sessions"),
  store,
  now = Date.now(),
  logger = console,
  seenFiles = null,
}) {
  const known = new Set(Object.values(store.snapshot().sessions || {})
    .flatMap((session) => (session.turns || []).map((turn) => `${session.sessionId}:${turn.turnId}`)));
  let added = 0;
  for (const { filePath, modified, size } of recentFiles(root, now)) {
    const signature = `${modified}:${size}`;
    if (seenFiles?.get(filePath) === signature) continue;
    try {
      const record = parseLatestCompletedTranscriptFile(filePath);
      seenFiles?.set(filePath, signature);
      if (!record) continue;
      const key = `${record.sessionId}:${record.turnId}`;
      if (known.has(key)) continue;
      store.recordTurn({ session_id: record.sessionId, turn_id: record.turnId, cwd: record.cwd }, record.metrics);
      known.add(key);
      added += 1;
    } catch (error) {
      logger.warn?.(`Could not recover a completed transcript: ${error.code || error.name || "unknown error"}`);
    }
  }
  return added;
}

export function startTranscriptRecovery({ store, intervalMs = 15_000, logger = console }) {
  const seenFiles = new Map();
  const run = () => {
    const count = recoverRecentTranscripts({ store, logger, seenFiles });
    if (count) logger.log?.(`Recovered ${count} completed turn${count === 1 ? "" : "s"} from local transcripts.`);
  };
  run();
  const timer = setInterval(run, intervalMs);
  return () => clearInterval(timer);
}
