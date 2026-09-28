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
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "turn_context") continue;
    const candidate = entry.payload?.turn_id ?? entry.payload?.turnId;
    if (!requestedTurnId || candidate === requestedTurnId) {
      targetIndex = index;
      turnId = candidate || turnId;
      model = entry.payload?.model ?? null;
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
  for (let index = targetIndex + 1; index < entries.length; index += 1) {
    if (entries[index]?.type === "turn_context") break;
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
