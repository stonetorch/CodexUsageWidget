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
  return {
    usedPercent: Number(window.used_percent ?? window.usedPercent ?? 0),
    windowDurationMins: Number(window.window_minutes ?? window.windowDurationMins ?? 0),
    resetsAt: Number(window.resets_at ?? window.resetsAt ?? 0),
  };
}

function subtractLimits(after, before) {
  const result = {};
  for (const key of ["primary", "secondary"]) {
    if (!after?.[key] || !before?.[key]) {
      result[key] = null;
      continue;
    }
    result[key] = after[key].resetsAt && before[key].resetsAt && after[key].resetsAt !== before[key].resetsAt
      ? null : Math.max(0, after[key].usedPercent - before[key].usedPercent);
  }
  return result;
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

function entryTimestamp(entry) {
  const value = entry?.timestamp ?? entry?.payload?.timestamp;
  return Number.isFinite(Date.parse(value || "")) ? new Date(value).toISOString() : null;
}

export function parseTranscriptText(text, requestedTurnId = null) {
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A concurrently written final line can be incomplete. Ignore it and retry on the next hook.
    }
  }

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

  let baselineUsage = {};
  let baselineLimits = null;
  for (let index = targetIndex - 1; index >= 0; index -= 1) {
    const payload = entries[index]?.payload;
    if (entries[index]?.type === "event_msg" && payload?.type === "token_count" && payload.info) {
      baselineUsage = payload.info.total_token_usage || {};
      baselineLimits = normalizeLimits(payload.rate_limits);
      break;
    }
  }

  let finalUsage = null;
  let finalLimits = null;
  let lastAssistantMessage = null;
  let completedAt = startedAt;
  for (let index = targetIndex + 1; index < entries.length; index += 1) {
    if (entries[index]?.type === "turn_context") break;
    completedAt = entryTimestamp(entries[index]) || completedAt;
    const payload = entries[index]?.payload;
    if (entries[index]?.type === "event_msg" && payload?.type === "token_count" && payload.info) {
      finalUsage = payload.info.total_token_usage || finalUsage;
      finalLimits = normalizeLimits(payload.rate_limits) || finalLimits;
    }
    lastAssistantMessage = extractAssistantText(entries[index]) || lastAssistantMessage;
  }
  if (!finalUsage) return null;

  return {
    turnId,
    model,
    startedAt,
    completedAt,
    turnUsage: subtractUsage(finalUsage, baselineUsage),
    conversationUsage: Object.fromEntries(TOKEN_FIELDS.map((field) => [field, Number(finalUsage[field] || 0)])),
    rateLimitDelta: subtractLimits(finalLimits, baselineLimits),
    rateLimits: finalLimits,
    lastAssistantMessage,
  };
}

export function parseTranscriptFile(filePath, turnId = null) {
  return parseTranscriptText(fs.readFileSync(filePath, "utf8"), turnId);
}

export function parseLatestCompletedTranscriptFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  let sessionId = null;
  let cwd = null;
  let activeTurnId = null;
  let completedTurnId = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === "session_meta") {
      sessionId = entry.payload?.id || sessionId;
      cwd = entry.payload?.cwd || cwd;
    } else if (entry.type === "turn_context") {
      activeTurnId = entry.payload?.turn_id ?? entry.payload?.turnId ?? null;
    } else if (entry.type === "event_msg" && entry.payload?.type === "task_complete") {
      completedTurnId = activeTurnId;
    }
  }
  if (!sessionId || !completedTurnId) return null;
  const metrics = parseTranscriptText(text, completedTurnId);
  if (!metrics || Number(metrics.turnUsage?.total_tokens || 0) <= 0) return null;
  return { sessionId, turnId: completedTurnId, cwd, metrics };
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
