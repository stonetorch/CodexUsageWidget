import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseActiveTranscriptFile, parseCompletedTranscriptFile } from "./transcript.mjs";

const MAX_AGE_MS = 48 * 60 * 60 * 1000;
const MAX_FILES = 200;
const CHILD_SUFFIX = /^_[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.jsonl$/i;

function filenameHasSessionId(filename, sessionId) {
  const marker = `-${sessionId}`;
  const index = filename.lastIndexOf(marker);
  if (index < 0) return false;
  const suffix = filename.slice(index + marker.length);
  return suffix === ".jsonl" || CHILD_SUFFIX.test(suffix);
}

function recentFiles(root, now, sessionIds = new Set(), prioritySessionIds = new Set()) {
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
          const prioritySessionId = [...prioritySessionIds].find((id) => filenameHasSessionId(entry.name, id));
          const sessionId = prioritySessionId || [...sessionIds].find((id) => filenameHasSessionId(entry.name, id));
          if (stat.size > 0 && (prioritySessionId || (stat.mtimeMs >= now - MAX_AGE_MS
            && (sessionId || stat.size <= 64 * 1024 * 1024)))) {
            files.push({ filePath, modified: stat.mtimeMs, size: stat.size, sessionId });
          }
        } catch { /* A transcript may be removed while scanning. */ }
      }
    }
  }
  const targeted = files.filter((file) => file.sessionId).sort((a, b) => b.modified - a.modified);
  const recent = files.filter((file) => !file.sessionId).sort((a, b) => b.modified - a.modified).slice(0, MAX_FILES);
  return [...targeted, ...recent];
}

export function recoverRecentTranscripts({
  root = path.join(os.homedir(), ".codex", "sessions"),
  store,
  now = Date.now(),
  logger = console,
  seenFiles = null,
  prioritySessionIds = new Set(),
}) {
  const snapshot = store.snapshot();
  const known = new Map(Object.values(snapshot.sessions || {})
    .flatMap((session) => (session.turns || []).map((turn) => [`${session.sessionId}:${turn.turnId}`, turn])));
  const sessionIds = new Set([...Object.keys(snapshot.sessions || {}), ...Object.keys(snapshot.activeTurns || {})]);
  let added = 0;
  const activeSessions = new Map();
  const considerActive = (sessionId, turn, modified) => {
    if (!activeSessions.has(sessionId) || modified > activeSessions.get(sessionId).modified) {
      activeSessions.set(sessionId, { turn, modified });
    }
  };
  for (const { filePath, modified, size } of recentFiles(root, now, sessionIds, prioritySessionIds)) {
    const signature = `${modified}:${size}`;
    const seen = seenFiles?.get(filePath);
    if (seen?.signature === signature) {
      if (seen.active) considerActive(seen.active.sessionId, seen.active.turn, modified);
      continue;
    }
    try {
      const active = parseActiveTranscriptFile(filePath);
      let activeRecord = null;
      if (active) {
        const turn = {
          turnId: active.turnId, model: active.metrics.model, startedAt: active.metrics.startedAt,
          usage: active.metrics.turnUsage, accountingVersion: 2,
          lastUserMessage: active.metrics.lastUserMessage,
          quotaObservations: active.metrics.quotaObservations || [],
          updatedAt: new Date(modified).toISOString(), cwd: active.cwd,
        };
        activeRecord = { sessionId: active.sessionId, turn };
        considerActive(active.sessionId, turn, modified);
      }
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
      seenFiles?.set(filePath, { signature, active: activeRecord });
    } catch (error) {
      logger.warn?.(`Could not recover a completed transcript: ${error.code || error.name || "unknown error"}`);
    }
  }
  for (const [sessionId, active] of activeSessions) store.setActiveTurn(sessionId, active.turn);
  for (const sessionId of Object.keys(store.snapshot().activeTurns || {})) {
    if (!activeSessions.has(sessionId)) store.setActiveTurn(sessionId, null);
  }
  return added;
}

export function startTranscriptRecovery({ store, intervalMs = 15_000, logger = console, prioritySessionIds = () => new Set() }) {
  const seenFiles = new Map();
  const run = () => {
    const count = recoverRecentTranscripts({ store, logger, seenFiles, prioritySessionIds: prioritySessionIds() });
    if (count) logger.log?.(`Recovered ${count} completed turn${count === 1 ? "" : "s"} from local transcripts.`);
  };
  run();
  const timer = setInterval(run, intervalMs);
  return () => clearInterval(timer);
}
