// Relative weights use the OpenAI API standard short-context prices per 1M tokens.
// ChatGPT/Codex quota accounting is separate; observed quota deltas calibrate the mapping.
export const MODEL_WEIGHTS = Object.freeze({
  "gpt-6-astra": { input: 5, cached: 0.5, cacheWrite: 6.25, output: 25 },
  "gpt-6-sol": { input: 1, cached: 0.1, cacheWrite: 1.25, output: 5 },
  "gpt-6-luna": { input: 0.05, cached: 0.005, cacheWrite: 0.0625, output: 0.25 },
  "gpt-5.6-sol": { input: 4, cached: 0.4, cacheWrite: 5, output: 20 },
  "gpt-5.3-codex": { input: 1.75, cached: 0.175, cacheWrite: 1.75, output: 14 },
});

const DEFAULT_BUDGETS = Object.freeze({ primary: 1, secondary: 5 });
const WINDOWS = Object.freeze(["primary", "secondary"]);
const DAY_MS = 24 * 60 * 60 * 1000;
const HALF_LIFE_MS = 21 * DAY_MS;
const GLOBAL_PRIOR_WEIGHT = 2;
const MODEL_PRIOR_WEIGHT = 3;
const MAX_OBSERVED_DELTA = 25;
const NEARBY_TURN_MS = 2 * 60 * 1000;
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;
const HUBER_LOG_DISTANCE = Math.log(2.5);

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

function flattenTurns(sessions) {
  return Object.entries(sessions || {}).flatMap(([sessionId, session]) => (session.turns || []).map((turn) => {
    const startedAt = timestamp(turn.startedAt);
    const completedAt = timestamp(turn.completedAt);
    return {
      turn,
      sessionId,
      model: normalizeModel(turn.model || session.model),
      cost: Number(turn.weightedCost ?? weightedCost(turn.usage, turn.model || session.model)),
      startedAt,
      completedAt,
      hasInterval: startedAt !== null && completedAt !== null && completedAt >= startedAt
        && completedAt - startedAt <= MAX_INTERVAL_MS,
    };
  }));
}

function intervalsOverlap(left, right) {
  return left.startedAt <= right.completedAt && right.startedAt <= left.completedAt;
}

function observationQuality(item, turns) {
  const others = turns.filter((candidate) => candidate.sessionId !== item.sessionId);
  if (item.hasInterval) {
    const overlaps = others.filter((candidate) => candidate.hasInterval && intervalsOverlap(item, candidate)).length;
    if (overlaps) return 1 / (1 + 4 * overlaps);
    return 1;
  }

  // Old recovered records lack source timestamps. They remain useful as weak evidence, while
  // near-simultaneous completions from another session are treated as likely concurrency.
  const nearby = item.completedAt !== null && others.some((candidate) => candidate.completedAt !== null
    && Math.abs(candidate.completedAt - item.completedAt) <= NEARBY_TURN_MS);
  return nearby ? 0.1 : 0.35;
}

function samplesFor(turns, window, now, resetAt) {
  return turns.flatMap((item) => {
    if (resetAt !== null && (item.completedAt === null || item.completedAt < resetAt)) return [];
    const delta = Number(item.turn.rateLimitDelta?.[window]);
    if (!Number.isFinite(delta) || delta <= 0 || delta > MAX_OBSERVED_DELTA || !(item.cost > 0)) return [];
    const completedAt = item.completedAt ?? now;
    const age = Math.max(0, now - completedAt);
    const recency = Math.exp(-Math.log(2) * age / HALF_LIFE_MS);
    const weight = observationQuality(item, turns) * recency;
    if (!(weight > 0.001)) return [];
    return [{ model: item.model, logRate: Math.log(delta / item.cost), weight, completedAt }];
  });
}

function robustLogMean(samples, priorLog, priorWeight) {
  let estimate = priorLog;
  for (let pass = 0; pass < 4; pass += 1) {
    let weightedTotal = priorLog * priorWeight;
    let totalWeight = priorWeight;
    for (const sample of samples) {
      const distance = Math.abs(sample.logRate - estimate);
      const robustWeight = distance > HUBER_LOG_DISTANCE ? HUBER_LOG_DISTANCE / distance : 1;
      const weight = sample.weight * robustWeight;
      weightedTotal += sample.logRate * weight;
      totalWeight += weight;
    }
    estimate = weightedTotal / totalWeight;
  }
  return estimate;
}

function confidence(source, effectiveSamples) {
  if (source === "rough") return "low";
  if (source === "borrowed" || effectiveSamples < 2) return "medium";
  return "high";
}

function coefficient(logRate, source, samples, effectiveSamples) {
  return {
    percentPerCostUnit: Math.exp(logRate),
    source,
    confidence: confidence(source, effectiveSamples),
    samples,
    effectiveSamples: Number(effectiveSamples.toFixed(2)),
  };
}

/**
 * Build a time-decayed, robust hierarchical calibration.
 *
 * Each quota window gets an independent global estimate. A model estimate starts at that
 * global value and only moves away as model-specific evidence accumulates. This supplies a
 * weak cross-model prior for cold starts without forcing all models to share one conversion.
 */
export function quotaCalibration(sessions = {}, budgets = DEFAULT_BUDGETS, { now = Date.now(), resetAt = null } = {}) {
  const turns = flattenTurns(sessions);
  const result = { models: {} };
  const models = new Set(turns.map((item) => item.model));
  const resetTimestamp = timestamp(resetAt);

  for (const window of WINDOWS) {
    const fallback = 100 / Math.max(0.01, Number(budgets?.[window] || DEFAULT_BUDGETS[window]));
    const priorLog = Math.log(fallback);
    const samples = samplesFor(turns, window, now, resetTimestamp);
    const effectiveSamples = samples.reduce((sum, sample) => sum + sample.weight, 0);
    const globalLog = robustLogMean(samples, priorLog, GLOBAL_PRIOR_WEIGHT);
    result[window] = coefficient(
      globalLog,
      effectiveSamples >= 0.5 ? "calibrated" : "rough",
      samples.length,
      effectiveSamples,
    );

    for (const model of models) {
      const ownSamples = samples.filter((sample) => sample.model === model);
      const ownEffectiveSamples = ownSamples.reduce((sum, sample) => sum + sample.weight, 0);
      const modelLog = robustLogMean(ownSamples, globalLog, MODEL_PRIOR_WEIGHT);
      result.models[model] ||= {};
      result.models[model][window] = coefficient(
        modelLog,
        ownEffectiveSamples >= 1.5 ? "calibrated" : effectiveSamples >= 0.5 ? "borrowed" : "rough",
        ownSamples.length,
        ownEffectiveSamples,
      );
    }
  }
  return result;
}

function modelCoefficient(calibration, window, model) {
  return calibration.models?.[normalizeModel(model)]?.[window] || {
    ...calibration[window],
    source: calibration[window]?.source === "calibrated" ? "borrowed" : "rough",
    confidence: calibration[window]?.source === "calibrated" ? "medium" : "low",
  };
}

export function estimateTurnQuota(turn, calibration, fallbackModel = null) {
  if (!turn) return null;
  const model = turn.model || fallbackModel;
  const cost = Number(turn.weightedCost ?? weightedCost(turn.usage, model));
  return Object.fromEntries(WINDOWS.map((window) => {
    const learned = modelCoefficient(calibration, window, model);
    return [window, {
      percent: Math.max(0, cost * learned.percentPerCostUnit),
      source: learned.source,
      confidence: learned.confidence,
      samples: learned.samples,
    }];
  }));
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
    referenceCost: referenceCost ?? weightedCost(normalized, model),
    approximate,
    model: normalizeModel(model),
  };
}

function sessionUsageSummary(session) {
  const empty = normalizedUsage();
  const recordedUsage = (session.turns || []).reduce(
    (sum, turn) => addUsage(sum, normalizedUsage(turn.usage)),
    empty,
  );
  const conversationUsage = normalizedUsage(session.conversationUsage);
  const usage = conversationUsage.total_tokens >= recordedUsage.total_tokens ? conversationUsage : recordedUsage;
  const recordedCost = (session.turns || []).reduce(
    (sum, turn) => sum + Number(turn.weightedCost ?? weightedCost(turn.usage, turn.model || session.model)),
    0,
  );
  const missingUsage = Object.fromEntries(Object.keys(usage).map((key) => [key, Math.max(0, usage[key] - recordedUsage[key])]));
  const hasMissing = missingUsage.total_tokens > 0;
  return usageSummary(
    usage,
    session.model,
    recordedCost + weightedCost(missingUsage, session.model),
    hasMissing,
  );
}

export function estimateSessionQuota(session, calibration) {
  if (!session) return null;
  const turns = session.turns || [];
  const totalTokens = Number(session.conversationUsage?.total_tokens || 0);
  const recordedTokens = turns.reduce((sum, turn) => sum + Number(turn.usage?.total_tokens || 0), 0);
  const missingTokens = Math.max(0, totalTokens - recordedTokens);
  const missingCost = weightedCost({ input_tokens: missingTokens, cached_input_tokens: missingTokens * 0.8 }, session.model);

  return Object.fromEntries(WINDOWS.map((window) => {
    const estimates = turns.map((turn) => estimateTurnQuota(turn, calibration, session.model)?.[window]).filter(Boolean);
    const missingCoefficient = modelCoefficient(calibration, window, session.model);
    const percent = estimates.reduce((sum, estimate) => sum + estimate.percent, 0)
      + missingCost * missingCoefficient.percentPerCostUnit;
    const sources = [...estimates.map((estimate) => estimate.source), missingCoefficient.source];
    const source = missingTokens > 0 || sources.includes("rough")
      ? "rough"
      : sources.includes("borrowed") ? "borrowed" : "calibrated";
    return [window, { percent: Math.max(0, percent), source }];
  }));
}

export function usageView(state, options) {
  const sessions = state.sessions || {};
  const calibration = quotaCalibration(sessions, state.settings?.budgets, {
    resetAt: state.settings?.calibrationResetAt,
    ...options,
  });
  return {
    ...state,
    calibration,
    sessions: Object.fromEntries(Object.entries(sessions).map(([id, session]) => {
      const turns = (session.turns || []).map((turn) => ({
        ...turn,
        quotaEstimate: estimateTurnQuota(turn, calibration, session.model),
        usageSummary: usageSummary(turn.usage, turn.model || session.model),
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
