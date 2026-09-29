import assert from "node:assert/strict";
import test from "node:test";
import { weightedCost, quotaCalibration, estimateTurnQuota, estimateActiveTurnQuota, usageSummary, usageView } from "../src/quota-estimator.mjs";

test("active turn uses observed quota growth when calibration is unavailable", () => {
  const observation = (before, after) => ({ before: { limitId: "codex", primary: { usedPercent: before, resetsAt: 100 } },
    after: { limitId: "codex", primary: { usedPercent: after, resetsAt: 100 } } });
  const active = { accountingVersion: 2, model: "gpt-6-sol", usage: { input_tokens: 100 },
    quotaObservations: [observation(27, 30), observation(30, 33)] };
  const result = estimateActiveTurnQuota(active, { models: {} });
  assert.equal(result.primary.percent, 6);
  assert.equal(result.primary.source, "observed-lower-bound");
  assert.equal(result.secondary.percent, null);
});

const NOW = Date.parse("2026-09-28T12:00:00.000Z");
const at = (offset) => new Date(NOW + offset).toISOString();
function limits(used, reset = Math.floor(NOW / 1000) + 3600) {
  return { limitId: "codex", primary: { usedPercent: used, resetsAt: reset, windowDurationMins: 300 },
    secondary: { usedPercent: used, resetsAt: reset + 604800, windowDurationMins: 10080 } };
}
function turn({ id = "t", model = "gpt-6-sol", input = 1000, delta = 2, before = 10,
  start = -60000, end = -1000, reset } = {}) {
  const usage = { input_tokens: input, total_tokens: input };
  return { turnId: id, model, accountingVersion: 2, usage, startedAt: at(start), completedAt: at(end),
    quotaObservations: [{ startedAt: at(start), completedAt: at(end), usage,
      before: limits(before, reset), after: limits(before + delta, reset) }] };
}
function session(turns, model = "gpt-6-sol") {
  return { model, conversationUsage: { total_tokens: turns.reduce((sum, t) => sum + (t.usage?.total_tokens || 0), 0) }, turns };
}
function calibration(sessions, options = {}) {
  return quotaCalibration(sessions, undefined, { now: NOW, ...options });
}

test("prices cached, uncached, cache-write, and output tokens separately", () => {
  assert.equal(weightedCost({ input_tokens: 1_000_000, cached_input_tokens: 500_000, output_tokens: 100_000 }, "gpt-6-sol"), 1.05);
  assert.equal(weightedCost({ input_tokens: 100_000, cached_input_tokens: 40_000, cache_write_input_tokens: 20_000, output_tokens: 10_000 }, "gpt-6-sol"), 0.119);
  const summary = usageSummary({ input_tokens: 100, cached_input_tokens: 70, cache_write_input_tokens: 10, output_tokens: 20 }, "gpt-6-sol");
  assert.equal(summary.uncachedInputTokens, 20);
  assert.equal(summary.cacheHitRate, 0.7);
  assert.equal(summary.totalTokens, 120);
});

test("Terra has its own reference weights and can calibrate from observations", () => {
  const usage = { input_tokens: 1_000_000, cached_input_tokens: 500_000,
    cache_write_input_tokens: 100_000, output_tokens: 100_000 };
  assert.equal(weightedCost(usage, "gpt-5.6-terra"), 2.35);
  const t = turn({ model: "gpt-5.6-terra", input: 100_000, delta: 2 });
  const c = calibration({ s: session([t], t.model) });
  assert.equal(c.models[t.model].primary.source, "calibrated");
  assert.equal(estimateTurnQuota(t, c).primary.percent, 2);
});

test("both Luna models use their own reference weights and calibration", () => {
  const usage = { input_tokens: 1_000_000, cached_input_tokens: 500_000,
    cache_write_input_tokens: 100_000, output_tokens: 100_000 };
  for (const [model, expectedCost] of [["gpt-6-luna", 0.1075], ["gpt-5.6-luna", 0.235]]) {
    assert.ok(Math.abs(weightedCost(usage, model) - expectedCost) < 1e-12);
    const t = turn({ model, input: 100_000, delta: 2 });
    const c = calibration({ s: session([t], model) });
    assert.equal(c.models[model].primary.source, "calibrated");
    assert.equal(estimateTurnQuota(t, c).primary.percent, 2);
  }
});

test("no evidence or reset produces unavailable percentages regardless of legacy budgets", () => {
  const t = turn(); t.quotaObservations = [];
  const sessions = { s: session([t]) };
  const c = quotaCalibration(sessions, { primary: 0.01, secondary: 1000 }, { now: NOW });
  assert.equal(estimateTurnQuota(t, c).primary.percent, null);
  assert.equal(c.models[t.model].primary.percentPerCostUnit, null);
  assert.equal(estimateTurnQuota(turn(), calibration({ s: session([turn()]) }, { resetAt: at(0) })).primary.percent, null);
});

test("zero increments contribute cost and are never replaced by positive-only samples", () => {
  const turns = Array.from({ length: 200 }, (_, i) => turn({ id: String(i), delta: i % 100 === 99 ? 1 : 0,
    before: 10 + Math.floor(i / 100), start: -400000 + i * 2000, end: -399000 + i * 2000 }));
  const c = calibration({ s: session(turns) });
  assert.equal(c.models['gpt-6-sol'].primary.intervals, 200);
  assert.ok(Math.abs(c.models['gpt-6-sol'].primary.percentPerCostUnit - 10) < 1e-9);
  const view = usageView({ sessions: { s: session(turns) } }, { now: NOW });
  assert.ok(Math.abs(view.sessions.s.quotaEstimate.primary.percent - 2) < 1e-9);
  const insufficient = calibration({ s: session(turns.slice(0, 100)) });
  assert.equal(estimateTurnQuota(turns[0], insufficient).primary.percent, null);
});

test("models learn only their own observed cost ratio, with no API budget or cross-model prior", () => {
  const a = turn({ model: 'gpt-6-sol', input: 100000, delta: 4, start: -120000, end: -90000 });
  const b = turn({ model: 'gpt-6-luna', input: 100000, delta: 2 });
  const c = calibration({ a: session([a]), b: session([b], b.model) });
  assert.ok(Math.abs(c.models[a.model].primary.percentPerCostUnit - 40) < 1e-9);
  assert.ok(Math.abs(c.models[b.model].primary.percentPerCostUnit - 200) < 1e-9);
  assert.equal(estimateTurnQuota(turn({ model: 'new-model' }), c).primary.percent, null);
  assert.equal(estimateTurnQuota(turn({ model: 'gpt-5.6-sol' }), c).primary.percent, null);
});

test("rejects concurrency, unknown buckets, resets, backwards counters and legacy deltas", () => {
  const a = turn();
  const b = turn({ id: 'b', start: -50000, end: -2000 });
  assert.equal(calibration({ a: session([a]), b: session([b]) }).primary.samples, 0);
  for (const mutate of [
    t => { t.quotaObservations[0].after.limitId = 'premium'; },
    t => { t.quotaObservations[0].after.primary.resetsAt += 1; },
    t => { t.quotaObservations[0].after.primary.usedPercent = 9; },
    t => { t.quotaObservations[0].after.primary.windowDurationMins = 60; },
    t => { t.quotaObservations[0].startedAt = at(-120000); },
    t => { t.accountingVersion = 1; t.rateLimitDelta = { primary: 6 }; },
  ]) {
    const t = turn(); mutate(t);
    assert.equal(calibration({ s: session([t]) }).models[t.model].primary.percentPerCostUnit, null);
  }
});

test("old records ending before the observation do not permanently block new evidence", () => {
  const old = turn({ end: -120000 }); old.startedAt = null; old.accountingVersion = 1;
  const c = calibration({ old: session([old]), current: session([turn()]) });
  assert.equal(c.models['gpt-6-sol'].primary.source, 'calibrated');
});

test("reset excludes intervals crossing the cutoff, not only completed turns", () => {
  const c = calibration({ s: session([turn()]) }, { resetAt: at(-30000) });
  assert.equal(c.primary.samples, 0);
});

test("recent reset groups outweigh old groups without discarding their zero increments", () => {
  const old = turn({ input: 100000, delta: 2, start: -84 * 86400000, end: -84 * 86400000 + 1000,
    reset: Math.floor(NOW / 1000) - 83 * 86400 });
  const recent = turn({ input: 100000, delta: 8 });
  const c = calibration({ s: session([old, recent]) });
  assert.ok(c.models[recent.model].primary.percentPerCostUnit > 70);
  assert.equal(calibration({ s: session([old]) }).models[old.model].primary.percentPerCostUnit, null);
});

test("unattributed history shows the recorded turns' estimate as partial", () => {
  const s = session([turn()]); s.conversationUsage.total_tokens += 10000000;
  const v = usageView({ sessions: { s } }, { now: NOW }).sessions.s;
  assert.ok(Math.abs(v.quotaEstimate.primary.percent - 2) < 1e-9);
  assert.equal(v.quotaEstimate.primary.reason, null);
  assert.equal(v.quotaEstimate.primary.partialHistory, true);
  assert.equal(v.usageSummary.referenceCost, null);
  assert.equal(v.quotaEstimate.primary.scope, 'recorded-turns');
});

test("legacy and unknown turn usage is never treated as zero or trusted cost", () => {
  const t = turn(); t.usage = null;
  const old = turn({ id: 'old' }); delete old.accountingVersion; old.weightedCost = 100;
  const v = usageView({ sessions: { s: session([t, old]) } }, { now: NOW }).sessions.s;
  assert.equal(v.quotaEstimate.primary.percent, null);
  assert.equal(v.turns[0].usageSummary, null);
  assert.equal(v.turns[1].quotaEstimate.primary.percent, null);
  assert.equal(v.turns[0].quotaEstimate.primary.reason, 'missing-token-usage');
});

test("token counts and reference cost remain available without quota calibration", () => {
  const t = turn({ input: 100000 });
  t.quotaObservations = [];
  const v = usageView({ sessions: { s: session([t]) } }, { now: NOW }).sessions.s;
  assert.equal(v.turns[0].quotaEstimate.primary.reason, 'insufficient-evidence');
  assert.equal(v.turns[0].usageSummary.totalTokens, 100000);
  assert.equal(v.turns[0].usageSummary.referenceCost, 0.1);
  assert.equal(v.usageSummary.referenceCost, 0.1);
  assert.equal(v.quotaEstimate.primary.reason, 'insufficient-evidence');
});

test("unknown model keeps token counts but has no invented reference price", () => {
  const t = turn({ model: 'new-model' });
  const v = usageView({ sessions: { s: session([t], t.model) } }, { now: NOW }).sessions.s;
  assert.equal(v.turns[0].quotaEstimate.primary.reason, 'unknown-model');
  assert.equal(v.turns[0].usageSummary.totalTokens, 1000);
  assert.equal(v.turns[0].usageSummary.referenceCost, null);
});

test("valid mixed-model history sums individual estimates and may span multiple quota windows", () => {
  const a = turn({ input: 100000, delta: 4, start: -120000, end: -90000 });
  const b = turn({ model: 'gpt-6-luna', input: 100000, delta: 2 });
  const v = usageView({ sessions: { s: session([a, b], b.model) } }, { now: NOW }).sessions.s;
  assert.ok(Math.abs(v.quotaEstimate.primary.percent - 6) < 1e-9);
  assert.ok(Math.abs(v.usageSummary.referenceCost - 0.11) < 1e-9);
});


test("delayed quota increments with zero new tokens are retained in the same reset group", () => {
  const a = turn({ id: 'cost', input: 100000, delta: 0, start: -120000, end: -90000 });
  const b = turn({ id: 'delay', input: 0, delta: 2 });
  const c = calibration({ s: session([a, b]) });
  assert.ok(Math.abs(c.models[a.model].primary.percentPerCostUnit - 20) < 1e-9);
});

test("duplicate intervals in the same session do not multiply the evidence", () => {
  const a = turn(); const b = structuredClone(a); b.turnId = 'duplicate';
  const c = calibration({ s: session([a, b]) });
  assert.equal(c.models[a.model].primary.intervals, 1);
  assert.ok(Math.abs(c.models[a.model].primary.percentPerCostUnit - 2000) < 1e-9);
});
