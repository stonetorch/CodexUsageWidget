import fs from "node:fs";

const TOKEN_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
];

function subtractUsage(after = {}, before = {}) {
  return Object.fromEntries(
    TOKEN_FIELDS.map((field) => [field, Math.max(0, Number(after[field] || 0) - Number(before[field] || 0))]),
  );
}

function normalizeLimits(limits) {
  if (!limits) return null;
  return {
    limitId: limits.limit_id ?? limits.limitId ?? null,
    primary: normalizeWindow(limits.primary),
    secondary: normalizeWindow(limits.secondary),
  };
}

function normalizeWindow(window) {
  if (!window) return null;
  const usedPercent = window.used_percent ?? window.usedPercent;
  if (usedPercent == null || !Number.isFinite(Number(usedPercent))) return null;
  return {
    usedPercent: Number(usedPercent),
    windowDurationMins: Number(window.window_minutes ?? window.windowDurationMins ?? 0),
    resetsAt: Number(window.resets_at ?? window.resetsAt ?? 0),
  };
}

function extractAssistantText(item) {
  if (item?.type !== "response_item") return null;
  const payload = item.payload;
  if (payload?.type === "message" && payload.role === "assistant") {
    return (payload.content || [])
      .filter((part) => part?.type === "output_text" || part?.type === "text")
      .map((part) => part.text || "")
      .join("\n")
      .trim() || null;
  }
  return null;
}

function extractUserText(item) {
  if (item?.type !== "response_item" || item.payload?.type !== "message" || item.payload.role !== "user") return null;
  return (item.payload.content || []).filter((part) => part?.type === "input_text" || part?.type === "text")
    .map((part) => part.text || "").join("\n").trim() || null;
}

function entryTimestamp(entry) {
  const value = entry?.timestamp ?? entry?.payload?.timestamp;
  return Number.isFinite(Date.parse(value || "")) ? new Date(value).toISOString() : null;
}

function transcriptEntries(text) {
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A concurrently written final line can be incomplete. Ignore it and retry on the next hook.
    }
  }

  return entries;
}

export function parseTranscriptText(text, requestedTurnId = null) {
  return parseTranscriptEntries(transcriptEntries(text), requestedTurnId);
}

function parseTranscriptEntries(entries, requestedTurnId = null) {
  let targetIndex = -1;
  let turnId = requestedTurnId;
  let model = null;
  let startedAt = null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "turn_context") continue;
    const candidate = entry.payload?.turn_id ?? entry.payload?.turnId;
    if (!requestedTurnId || candidate === requestedTurnId) {
      targetIndex = index;
      turnId = candidate || turnId;
      model = entry.payload?.model ?? null;
      startedAt = entryTimestamp(entry);
      break;
    }
  }
  if (targetIndex < 0) return null;

  let baselineUsage = null;
  for (let index = targetIndex - 1; index >= 0; index -= 1) {
    const payload = entries[index]?.payload;
    if (entries[index]?.type === "event_msg" && payload?.type === "token_count" && payload.info) {
      if (payload.info.total_token_usage) {
        baselineUsage = payload.info.total_token_usage;
        break;
      }
    }
  }

  let finalUsage = null;
  let previousUsage = baselineUsage;
  let counterReset = false;
  let explicitTurnUsage = null;
  let threadUsage = null;
  let finalLimits = null;
  let previousSnapshot = null;
  const quotaObservations = [];
  let lastAssistantMessage = null;
  let lastUserMessage = null;
  let completedAt = startedAt;
  for (let index = targetIndex + 1; index < entries.length; index += 1) {
    if (entries[index]?.type === "turn_context") break;
    completedAt = entryTimestamp(entries[index]) || completedAt;
    const payload = entries[index]?.payload;
    if (entries[index]?.type === "token_usage_record" && payload?.turn_id === turnId) {
      explicitTurnUsage = payload.turn_token_usage || explicitTurnUsage;
      threadUsage = payload.thread_token_usage || threadUsage;
    }
    if (entries[index]?.type === "event_msg" && payload?.type === "token_count" && payload.info) {
      const nextUsage = payload.info.total_token_usage;
      if (!nextUsage) continue;
      if (previousUsage && TOKEN_FIELDS.some((field) => Number(nextUsage[field] || 0) < Number(previousUsage[field] || 0))) {
        counterReset = true;
        previousSnapshot = null;
      }
      finalUsage = nextUsage;
      previousUsage = nextUsage;
      const limits = normalizeLimits(payload.rate_limits);
      // Only compare snapshots inside this turn. A previous turn's account snapshot
      // includes unrelated spending during the idle gap. Keep quota buckets separate.
      if (limits?.limitId === "codex" && finalUsage) {
        finalLimits = limits;
        const snapshot = { at: entryTimestamp(entries[index]), usage: finalUsage, limits };
        if (previousSnapshot && snapshot.at && previousSnapshot.at
          && Date.parse(snapshot.at) > Date.parse(previousSnapshot.at)
          && TOKEN_FIELDS.every((field) => Number(finalUsage[field] || 0) >= Number(previousSnapshot.usage[field] || 0))) {
          quotaObservations.push({
            startedAt: previousSnapshot.at,
            completedAt: snapshot.at,
            usage: subtractUsage(finalUsage, previousSnapshot.usage),
            before: previousSnapshot.limits,
            after: limits,
          });
        }
        previousSnapshot = snapshot;
      }
    }
    lastAssistantMessage = extractAssistantText(entries[index]) || lastAssistantMessage;
    lastUserMessage = extractUserText(entries[index]) || lastUserMessage;
    if (entries[index]?.type === "event_msg" && payload?.type === "task_complete") break;
  }
  if (!finalUsage && !explicitTurnUsage) return null;
  // Missing baseline is not zero: compacted/forked transcripts can start with a
  // large inherited cumulative counter. Prefer the explicit per-turn ledger.
  const monotonic = !counterReset && baselineUsage && finalUsage && TOKEN_FIELDS.every((field) =>
    Number(finalUsage[field] || 0) >= Number(baselineUsage[field] || 0));
  const turnUsage = explicitTurnUsage || (monotonic ? subtractUsage(finalUsage, baselineUsage) : null);
  const conversationUsage = threadUsage || finalUsage || {};

  return {
    turnId,
    model,
    startedAt,
    completedAt,
    accountingVersion: 2,
    usageSource: explicitTurnUsage ? "turn-ledger" : turnUsage ? "cumulative-difference" : "unknown",
    turnUsage,
    conversationUsage: Object.fromEntries(TOKEN_FIELDS.map((field) => [field, Number(conversationUsage[field] || 0)])),
    // Retained for consumers of the old field; calibration uses interval evidence.
    rateLimitDelta: { primary: null, secondary: null },
    quotaObservations,
    rateLimits: finalLimits,
    lastAssistantMessage,
    lastUserMessage,
  };
}

export function parseTranscriptFile(filePath, turnId = null) {
  return parseTranscriptText(fs.readFileSync(filePath, "utf8"), turnId);
}

export function parseLatestCompletedTranscriptFile(filePath) {
  return parseCompletedTranscriptFile(filePath).at(-1) || null;
}

export function parseActiveTranscriptFile(filePath) {
  const entries = transcriptEntries(fs.readFileSync(filePath, "utf8"));
  let sessionId = null, cwd = null, turnId = null, completed = false, context = null;
  for (const entry of entries) {
    if (entry.type === "session_meta") {
      sessionId = entry.payload?.id || sessionId;
      cwd = entry.payload?.cwd || cwd;
    } else if (entry.type === "event_msg" && entry.payload?.type === "task_started") {
      turnId = entry.payload?.turn_id || turnId;
      completed = false;
    } else if (entry.type === "turn_context") {
      turnId = entry.payload?.turn_id ?? entry.payload?.turnId ?? null;
      context = entry;
      completed = false;
    } else if (entry.type === "event_msg" && entry.payload?.type === "task_complete") {
      if (!entry.payload?.turn_id || entry.payload.turn_id === turnId) completed = true;
    }
  }
  if (!sessionId || !turnId || completed) return null;
  const metrics = parseTranscriptEntries(entries, turnId) || {
    turnId, model: context?.payload?.model || null, startedAt: entryTimestamp(context),
    accountingVersion: 2, turnUsage: null,
    lastUserMessage: entries.slice(Math.max(0, entries.indexOf(context) + 1)).map(extractUserText).find(Boolean) || null,
  };
  return { sessionId, turnId, cwd, metrics };
}

export function parseCompletedTranscriptFile(filePath, limit = Infinity) {
  const entries = transcriptEntries(fs.readFileSync(filePath, "utf8"));
  let sessionId = null;
  let cwd = null;
  let activeTurnId = null;
  const completedTurnIds = new Set();
  for (const entry of entries) {
    if (entry.type === "session_meta") {
      sessionId = entry.payload?.id || sessionId;
      cwd = entry.payload?.cwd || cwd;
    } else if (entry.type === "turn_context") {
      activeTurnId = entry.payload?.turn_id ?? entry.payload?.turnId ?? null;
    } else if (entry.type === "event_msg" && entry.payload?.type === "task_complete") {
      if (activeTurnId) completedTurnIds.add(activeTurnId);
    }
  }
  if (!sessionId) return [];
  return [...completedTurnIds].slice(-limit).map((turnId) => ({
    sessionId, turnId, cwd, metrics: parseTranscriptEntries(entries, turnId),
  })).filter((record) => record.metrics);
}

export function normalizeRateLimitsResult(result) {
  const limits = result?.rateLimitsByLimitId?.codex || result?.rateLimits || result;
  if (!limits) return null;
  return {
    limitId: limits.limitId ?? null,
    primary: normalizeWindow(limits.primary),
    secondary: normalizeWindow(limits.secondary),
    credits: limits.credits ?? null,
    planType: limits.planType ?? null,
  };
}
