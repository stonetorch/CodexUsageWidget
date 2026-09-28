import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseActiveTranscriptFile, parseCompletedTranscriptFile } from "./transcript.mjs";

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
  const known = new Map(Object.values(store.snapshot().sessions || {})
    .flatMap((session) => (session.turns || []).map((turn) => [`${session.sessionId}:${turn.turnId}`, turn])));
  let added = 0;
  const activeSessions = new Set();
  for (const { filePath, modified, size } of recentFiles(root, now)) {
    const signature = `${modified}:${size}`;
    const seen = seenFiles?.get(filePath);
    if (seen?.signature === signature) {
      if (seen.activeSessionId) activeSessions.add(seen.activeSessionId);
      continue;
    }
    try {
      for (const record of parseCompletedTranscriptFile(filePath, 200)) {
        const key = `${record.sessionId}:${record.turnId}`;
        const previous = known.get(key);
        const metrics = record.metrics;
        // Upgrade legacy estimates, and refresh a completed turn whose ledger flushed later.
        if (previous?.accountingVersion === 2
          && JSON.stringify(previous.usage) === JSON.stringify(metrics.turnUsage)
          && JSON.stringify(previous.quotaObservations) === JSON.stringify(metrics.quotaObservations)
          && previous.completedAt === metrics.completedAt) continue;
        store.recordTurn({ session_id: record.sessionId, turn_id: record.turnId, cwd: record.cwd }, metrics);
        known.set(key, { accountingVersion: 2, usage: metrics.turnUsage,
          quotaObservations: metrics.quotaObservations, completedAt: metrics.completedAt });
        added += 1;
      }
      const active = parseActiveTranscriptFile(filePath);
      if (active) {
        activeSessions.add(active.sessionId);
        store.setActiveTurn(active.sessionId, {
          turnId: active.turnId, model: active.metrics.model, startedAt: active.metrics.startedAt,
          usage: active.metrics.turnUsage, accountingVersion: 2,
          lastUserMessage: active.metrics.lastUserMessage,
          quotaObservations: active.metrics.quotaObservations || [],
          updatedAt: new Date(modified).toISOString(), cwd: active.cwd,
        });
      }
      seenFiles?.set(filePath, { signature, activeSessionId: active?.sessionId || null });
    } catch (error) {
      logger.warn?.(`Could not recover a completed transcript: ${error.code || error.name || "unknown error"}`);
    }
  }
  for (const sessionId of Object.keys(store.snapshot().activeTurns || {})) {
    if (!activeSessions.has(sessionId)) store.setActiveTurn(sessionId, null);
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
