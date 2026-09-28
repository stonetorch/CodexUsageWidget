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

export function modelWeights(model) {
  const name = String(model || "").toLowerCase();
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

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function quotaCalibration(sessions = {}, budgets = DEFAULT_BUDGETS) {
  const turns = Object.values(sessions).flatMap((session) => session.turns || []);
  const result = {};
  for (const key of ["primary", "secondary"]) {
    const samples = turns.flatMap((turn) => {
      const delta = Number(turn.rateLimitDelta?.[key]);
      const cost = Number(turn.weightedCost ?? weightedCost(turn.usage, turn.model));
      return Number.isFinite(delta) && delta > 0 && cost > 0 && delta <= 25
        ? [delta / cost]
        : [];
    });
    result[key] = {
      percentPerCostUnit: median(samples) ?? 100 / Math.max(0.01, Number(budgets?.[key] || DEFAULT_BUDGETS[key])),
      source: samples.length ? "observed" : "rough",
      samples: samples.length,
    };
  }
  return result;
}

export function estimateTurnQuota(turn, calibration) {
  if (!turn) return null;
  const cost = Number(turn.weightedCost ?? weightedCost(turn.usage, turn.model));
  return Object.fromEntries(["primary", "secondary"].map((key) => {
    const direct = Number(turn.rateLimitDelta?.[key]);
    const observed = Number.isFinite(direct) && direct > 0;
    return [key, {
      percent: Math.max(0, observed ? direct : cost * calibration[key].percentPerCostUnit),
      source: observed ? "observed" : calibration[key].source,
    }];
  }));
}

export function estimateSessionQuota(session, calibration) {
  if (!session) return null;
  const recorded = (session.turns || []).reduce((sum, turn) => sum + Number(turn.weightedCost ?? weightedCost(turn.usage, turn.model)), 0);
  const totalTokens = Number(session.conversationUsage?.total_tokens || 0);
  const recordedTokens = (session.turns || []).reduce((sum, turn) => sum + Number(turn.usage?.total_tokens || 0), 0);
  const missingTokens = Math.max(0, totalTokens - recordedTokens);
  const approximateMissing = weightedCost({ input_tokens: missingTokens, cached_input_tokens: missingTokens * 0.8 }, session.model);
  const cost = recorded + approximateMissing;
  return Object.fromEntries(["primary", "secondary"].map((key) => [key, {
    percent: Math.max(0, cost * calibration[key].percentPerCostUnit),
    source: missingTokens > 0 || calibration[key].source === "rough" ? "rough" : "calibrated",
  }]));
}

export function usageView(state) {
  const sessions = state.sessions || {};
  const calibration = quotaCalibration(sessions, state.settings?.budgets);
  return {
    ...state,
    calibration,
    sessions: Object.fromEntries(Object.entries(sessions).map(([id, session]) => {
      const turns = (session.turns || []).map((turn) => ({ ...turn, quotaEstimate: estimateTurnQuota(turn, calibration) }));
      return [id, { ...session, turns, quotaEstimate: estimateSessionQuota(session, calibration) }];
    })),
  };
}
