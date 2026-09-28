// Relative weights use the OpenAI API standard short-context prices per 1M tokens.
// ChatGPT/Codex quota accounting is separate; observed quota deltas calibrate the mapping.
export const MODEL_WEIGHTS = Object.freeze({
  "gpt-6-astra": { input: 5, cached: 0.5, cacheWrite: 6.25, output: 25 },
  "gpt-6-sol": { input: 1, cached: 0.1, cacheWrite: 1.25, output: 5 },
  "gpt-6-luna": { input: 0.1, cached: 0.01, cacheWrite: 0.125, output: 0.5 },
  "gpt-5.6-sol": { input: 4, cached: 0.4, cacheWrite: 5, output: 20 },
  "gpt-5.6-terra": { input: 2, cached: 0.2, cacheWrite: 2.5, output: 12 },
  "gpt-5.6-luna": { input: 0.2, cached: 0.02, cacheWrite: 0.25, output: 1.2 },
  "gpt-5.3-codex": { input: 1.75, cached: 0.175, cacheWrite: 1.75, output: 14 },
});

const WINDOWS = Object.freeze(["primary", "secondary"]);
const HALF_LIFE_MS = 21 * 24 * 60 * 60 * 1000;
const MAX_INTERVAL_MS = 30 * 60 * 1000;
const MIN_OBSERVED_DELTA = 2;

export function modelWeights(model) {
  const name = normalizeModel(model);
  const key = Object.keys(MODEL_WEIGHTS).find((candidate) => name === candidate || name.startsWith(`${candidate}-`));
  return { ...(MODEL_WEIGHTS[key] || MODEL_WEIGHTS["gpt-6-sol"]), known: Boolean(key) };
}

export function weightedCost(usage = {}, model) {
  const price = modelWeights(model);
  const input = Math.max(0, Number(usage.input_tokens || 0));
  const cached = Math.min(input, Math.max(0, Number(usage.cached_input_tokens || 0)));
  const cacheWrite = Math.min(input - cached, Math.max(0, Number(usage.cache_write_input_tokens || 0)));
  const uncached = Math.max(0, input - cached - cacheWrite);
  const output = Math.max(0, Number(usage.output_tokens || 0));
  return (uncached * price.input + cached * price.cached + cacheWrite * price.cacheWrite + output * price.output) / 1_000_000;
}

function normalizeModel(model) {
  return String(model || "unknown").trim().toLowerCase() || "unknown";
}

function timestamp(value) {
  const result = Date.parse(value || "");
  return Number.isFinite(result) ? result : null;
}

function unavailable(reason = "insufficient-evidence") {
  return { percentPerCostUnit: null, source: "unavailable", confidence: "low",
    samples: 0, effectiveSamples: 0, reason };
}

function overlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

/**
 * Pool cost AND quota deltas, including zero deltas, within each model/reset bucket.
 * Only use timestamped, same-turn account snapshots and discard known concurrent
 * activity. No API-dollar budget or cross-model coefficient is assumed.
 * Account snapshots are rounded and can lag; even accepted evidence is approximate.
 */
export function quotaCalibration(sessions = {}, _budgets, { now = Date.now(), resetAt = null } = {}) {
  const turns = Object.entries(sessions).flatMap(([sessionId, session]) => (session.turns || []).map((turn) => ({
    turn, sessionId, model: normalizeModel(turn.model || session.model),
    start: timestamp(turn.startedAt), end: timestamp(turn.completedAt),
  })));
  const reset = timestamp(resetAt);
  const result = { models: {}, primary: unavailable(), secondary: unavailable() };
  for (const model of new Set(turns.map((item) => item.model))) {
    result.models[model] = { primary: unavailable(), secondary: unavailable() };
  }
  for (const window of WINDOWS) {
    const groups = new Map();
    const accepted = [];
    for (const item of turns) {
      if (item.turn.accountingVersion !== 2 || !modelWeights(item.model).known) continue;
      for (const observation of item.turn.quotaObservations || []) {
        const start = timestamp(observation.startedAt);
        const end = timestamp(observation.completedAt);
        if (start === null || end === null || end <= start || end - start > MAX_INTERVAL_MS
          || item.start === null || item.end === null || start < item.start || end > item.end
          || end > now || (reset !== null && start < reset)) continue;
        const before = observation.before?.[window];
        const after = observation.after?.[window];
        const expectedMinutes = window === "primary" ? 300 : 10080;
        if (observation.before?.limitId !== "codex" || observation.after?.limitId !== "codex"
          || !before || !after || !Number.isFinite(before.resetsAt) || before.resetsAt <= 0
          || before.resetsAt !== after.resetsAt || end > after.resetsAt * 1000
          || before.windowDurationMins !== expectedMinutes || after.windowDurationMins !== expectedMinutes
          || !Number.isFinite(before.usedPercent) || !Number.isFinite(after.usedPercent)
          || before.usedPercent < 0 || after.usedPercent > 100 || after.usedPercent < before.usedPercent) continue;
        const span = { start, end };
        // Incomplete timestamps from other sessions cannot establish isolation.
        const concurrent = turns.some((other) => {
          if (other.sessionId === item.sessionId) return false;
          if (other.end !== null && other.end <= start) return false;
          if (other.start !== null && other.start >= end) return false;
          return other.start === null || other.end === null || other.end < other.start || overlap(span, other);
        });
        if (concurrent) continue;
        const cost = weightedCost(observation.usage, item.model);
        if (!observation.usage || !Number.isFinite(cost) || cost < 0) continue;
        accepted.push({ ...span, model: item.model, cost,
          delta: after.usedPercent - before.usedPercent, reset: after.resetsAt });
      }
    }
    // Do not count duplicated/forked observation intervals more than once.
    accepted.sort((a, b) => a.start - b.start || a.end - b.end);
    let previousEnd = -Infinity;
    for (const sample of accepted) {
      if (sample.start < previousEnd) continue;
      previousEnd = sample.end;
      const key = `${sample.model}:${sample.reset}`;
      const group = groups.get(key) || { model: sample.model, cost: 0, delta: 0, end: 0, intervals: 0 };
      group.cost += sample.cost;
      group.delta += sample.delta;
      group.end = Math.max(group.end, sample.end);
      group.intervals += 1;
      groups.set(key, group);
    }
    for (const model of Object.keys(result.models)) {
      const evidence = [...groups.values()].filter((group) => group.model === model);
      let cost = 0, delta = 0, effectiveSamples = 0;
      for (const group of evidence) {
        const weight = Math.exp(-Math.log(2) * (now - group.end) / HALF_LIFE_MS);
        cost += group.cost * weight;
        delta += group.delta * weight;
        effectiveSamples += weight;
      }
      const learned = { ...unavailable(), samples: evidence.length,
        effectiveSamples: Number(effectiveSamples.toFixed(2)),
        intervals: evidence.reduce((sum, group) => sum + group.intervals, 0) };
      if (evidence.reduce((sum, group) => sum + group.delta, 0) >= MIN_OBSERVED_DELTA
        && effectiveSamples >= 0.5 && delta >= 1 && cost > 0) {
        learned.percentPerCostUnit = delta / cost;
        learned.source = "calibrated";
        learned.confidence = "medium";
        learned.reason = null;
      }
      result.models[model][window] = learned;
    }
    // Global counts are informational; coefficients are never borrowed by another model.
    result[window].samples = [...groups.values()].length;
    result[window].effectiveSamples = Number(Object.values(result.models)
      .reduce((sum, model) => sum + model[window].effectiveSamples, 0).toFixed(2));
  }
  return result;
}

function modelCoefficient(calibration, window, model) {
  return calibration.models?.[normalizeModel(model)]?.[window] || unavailable();
}

export function estimateTurnQuota(turn, calibration, fallbackModel = null) {
  if (!turn) return null;
  const model = turn.model || fallbackModel;
  const hasUsage = turn.accountingVersion === 2 && turn.usage != null;
  const knownModel = modelWeights(model).known;
  const validUsage = hasUsage && knownModel;
  const cost = validUsage ? weightedCost(turn.usage, model) : null;
  return Object.fromEntries(WINDOWS.map((window) => {
    const learned = modelCoefficient(calibration, window, model);
    const valid = cost !== null && Number.isFinite(cost) && learned.percentPerCostUnit !== null;
    return [window, {
      percent: valid ? cost * learned.percentPerCostUnit : null,
      source: valid ? learned.source : "unavailable",
      confidence: valid ? learned.confidence : "low",
      reason: valid ? null : !hasUsage ? "missing-token-usage" : !knownModel ? "unknown-model" : learned.reason,
      samples: learned.samples,
    }];
  }));
}

export function estimateActiveTurnQuota(turn, calibration, fallbackModel = null) {
  const estimated = estimateTurnQuota(turn, calibration, fallbackModel);
  if (!estimated) return null;
  for (const window of WINDOWS) {
    if (estimated[window].percent !== null) continue;
    const observations = (turn.quotaObservations || []).filter((item) => {
      const before = item.before?.[window], after = item.after?.[window];
      return item.before?.limitId === "codex" && item.after?.limitId === "codex"
        && before?.resetsAt > 0 && before.resetsAt === after?.resetsAt
        && Number.isFinite(before.usedPercent) && Number.isFinite(after.usedPercent)
        && after.usedPercent >= before.usedPercent;
    });
    if (!observations.length) continue;
    const first = observations[0].before[window];
    const last = observations.at(-1).after[window];
    if (first.resetsAt !== last.resetsAt || last.usedPercent < first.usedPercent) continue;
    estimated[window] = { percent: last.usedPercent - first.usedPercent,
      source: "observed-lower-bound", confidence: "high", reason: null };
  }
  return estimated;
}

function normalizedUsage(usage = {}) {
  const inputTokens = Math.max(0, Number(usage.input_tokens || 0));
  const cachedInputTokens = Math.min(inputTokens, Math.max(0, Number(usage.cached_input_tokens || 0)));
  const cacheWriteInputTokens = Math.min(
    inputTokens - cachedInputTokens,
    Math.max(0, Number(usage.cache_write_input_tokens || 0)),
  );
  return {
    input_tokens: inputTokens,
    cached_input_tokens: cachedInputTokens,
    cache_write_input_tokens: cacheWriteInputTokens,
    output_tokens: Math.max(0, Number(usage.output_tokens || 0)),
    reasoning_output_tokens: Math.max(0, Number(usage.reasoning_output_tokens || 0)),
    total_tokens: Math.max(0, Number(usage.total_tokens || 0)),
  };
}

function addUsage(left, right) {
  return Object.fromEntries(Object.keys(left).map((key) => [key, left[key] + right[key]]));
}

export function usageSummary(usage = {}, model, referenceCost = null, approximate = false) {
  const normalized = normalizedUsage(usage);
  const uncachedInputTokens = Math.max(
    0,
    normalized.input_tokens - normalized.cached_input_tokens - normalized.cache_write_input_tokens,
  );
  return {
    inputTokens: normalized.input_tokens,
    uncachedInputTokens,
    cachedInputTokens: normalized.cached_input_tokens,
    cacheWriteInputTokens: normalized.cache_write_input_tokens,
    outputTokens: normalized.output_tokens,
    reasoningOutputTokens: normalized.reasoning_output_tokens,
    totalTokens: normalized.total_tokens || normalized.input_tokens + normalized.output_tokens,
    cacheHitRate: normalized.input_tokens > 0 ? normalized.cached_input_tokens / normalized.input_tokens : null,
    referenceCost: referenceCost ?? (modelWeights(model).known ? weightedCost(normalized, model) : null),
    approximate,
    model: normalizeModel(model),
  };
}

function sessionUsageSummary(session) {
  const turns = session.turns || [];
  const verified = turns.filter((turn) => turn.accountingVersion === 2 && turn.usage != null);
  if (!verified.length && !session.conversationUsage) return null;
  const recordedUsage = verified.reduce((sum, turn) => addUsage(sum, normalizedUsage(turn.usage)), normalizedUsage());
  const conversationUsage = normalizedUsage(session.conversationUsage);
  const usage = conversationUsage.total_tokens >= recordedUsage.total_tokens ? conversationUsage : recordedUsage;
  const incomplete = verified.length !== turns.length || usage.total_tokens > recordedUsage.total_tokens;
  const summary = usageSummary(usage, session.model, null, incomplete);
  summary.referenceCost = incomplete || verified.some((turn) => !modelWeights(turn.model || session.model).known)
    ? null : verified.reduce((sum, turn) => sum + weightedCost(turn.usage, turn.model || session.model), 0);
  return summary;
}

export function estimateSessionQuota(session, calibration) {
  if (!session) return null;
  const turns = session.turns || [];
  const totalTokens = Number(session.conversationUsage?.total_tokens || 0);
  const recordedTokens = turns.reduce((sum, turn) => sum + Number(turn.usage?.total_tokens || 0), 0);
  const incomplete = turns.length === 0 || totalTokens > recordedTokens
    || turns.some((turn) => turn.accountingVersion !== 2 || turn.usage == null);
  return Object.fromEntries(WINDOWS.map((window) => {
    const estimates = turns.map((turn) => estimateTurnQuota(turn, calibration, session.model)[window]);
    const missing = incomplete || estimates.some((estimate) => estimate.percent === null);
    return [window, {
      percent: missing ? null : estimates.reduce((sum, estimate) => sum + estimate.percent, 0),
      source: missing ? "unavailable" : "calibrated",
      reason: missing ? incomplete ? "incomplete-history"
        : estimates.find((estimate) => estimate.percent === null)?.reason || "insufficient-evidence" : null,
      scope: "conversation-lifetime",
    }];
  }));
}

export function usageView(state, options) {
  const sessions = state.sessions || {};
  const calibration = quotaCalibration(sessions, state.settings?.budgets, {
    resetAt: state.settings?.calibrationResetAt,
    ...options,
  });
  const activeTurns = Object.fromEntries(Object.entries(state.activeTurns || {}).map(([id, turn]) => [id, {
    ...turn,
    quotaEstimate: estimateActiveTurnQuota(turn, calibration, sessions[id]?.model),
    usageSummary: turn.usage == null ? null : usageSummary(turn.usage, turn.model || sessions[id]?.model),
  }]));
  return {
    ...state,
    calibration,
    activeTurns,
    sessions: Object.fromEntries(Object.entries(sessions).map(([id, session]) => {
      const turns = (session.turns || []).map((turn) => ({
        ...turn,
        quotaEstimate: estimateTurnQuota(turn, calibration, session.model),
        usageSummary: turn.accountingVersion === 2 && turn.usage != null
          ? { ...usageSummary(turn.usage, turn.model || session.model),
            referenceCost: modelWeights(turn.model || session.model).known ? weightedCost(turn.usage, turn.model || session.model) : null }
          : null,
      }));
      return [id, {
        ...session,
        turns,
        quotaEstimate: estimateSessionQuota(session, calibration),
        usageSummary: sessionUsageSummary(session),
      }];
    })),
  };
}
