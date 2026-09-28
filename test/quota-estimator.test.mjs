import assert from "node:assert/strict";
import test from "node:test";
import { weightedCost, quotaCalibration, estimateTurnQuota, usageSummary, usageView } from "../src/quota-estimator.mjs";

const NOW = Date.parse("2026-09-28T12:00:00.000Z");

function turn({ id, model = "gpt-6-sol", cost = 0.1, primary = null, secondary = null,
  start = NOW - 60_000, end = NOW }) {
  return {
    turnId: id,
    model,
    weightedCost: cost,
    usage: { total_tokens: 100 },
    rateLimitDelta: { primary, secondary },
    startedAt: start === null ? null : new Date(start).toISOString(),
    completedAt: end === null ? null : new Date(end).toISOString(),
  };
}

function session(id, model, turns) {
  return { sessionId: id, model, conversationUsage: { total_tokens: turns.length * 100 }, turns };
}

test("prices cached, uncached, cache-write, and output tokens separately", () => {
  assert.equal(weightedCost({ input_tokens: 1_000_000, cached_input_tokens: 500_000, output_tokens: 100_000 }, "gpt-6-sol"), 1.05);
  assert.equal(weightedCost({ input_tokens: 100_000, cached_input_tokens: 40_000, cache_write_input_tokens: 20_000, output_tokens: 10_000 }, "gpt-6-sol"), 0.119);
  const summary = usageSummary({ input_tokens: 100, cached_input_tokens: 70, cache_write_input_tokens: 10, output_tokens: 20 }, "gpt-6-sol");
  assert.equal(summary.uncachedInputTokens, 20);
  assert.equal(summary.cacheHitRate, 0.7);
  assert.equal(summary.totalTokens, 120);
});

test("learns separate model coefficients while shrinking both toward cross-model history", () => {
  const solTurns = Array.from({ length: 4 }, (_, index) => turn({
    id: `sol-${index}`, model: "gpt-6-sol", primary: 12,
    start: NOW - (index + 1) * 600_000, end: NOW - (index + 1) * 600_000 + 60_000,
  }));
  const lunaTurns = Array.from({ length: 4 }, (_, index) => turn({
    id: `luna-${index}`, model: "gpt-6-luna", primary: 4,
    start: NOW - (index + 6) * 600_000, end: NOW - (index + 6) * 600_000 + 60_000,
  }));
  const sessions = {
    sol: session("sol", "gpt-6-sol", solTurns),
    luna: session("luna", "gpt-6-luna", lunaTurns),
  };
  const calibration = quotaCalibration(sessions, undefined, { now: NOW });
  const solRate = calibration.models["gpt-6-sol"].primary.percentPerCostUnit;
  const lunaRate = calibration.models["gpt-6-luna"].primary.percentPerCostUnit;
  assert.ok(solRate > lunaRate);
  assert.ok(solRate < 120);
  assert.ok(lunaRate > 40);
  assert.equal(calibration.models["gpt-6-sol"].primary.source, "calibrated");

  const cold = estimateTurnQuota(turn({ id: "cold", model: "new-model", primary: null }), calibration);
  assert.equal(cold.primary.source, "borrowed");
  assert.equal(cold.primary.percent, 0.1 * calibration.primary.percentPerCostUnit);
});

test("recent evidence outweighs old history", () => {
  const old = turn({
    id: "old", primary: 2,
    start: NOW - 84 * 86_400_000, end: NOW - 84 * 86_400_000 + 60_000,
  });
  const recent = turn({ id: "recent", primary: 20 });
  const withRecent = quotaCalibration({ one: session("one", "gpt-6-sol", [old, recent]) }, undefined, { now: NOW });
  const oldOnly = quotaCalibration({ one: session("one", "gpt-6-sol", [old]) }, undefined, { now: NOW });
  assert.ok(withRecent.primary.percentPerCostUnit > oldOnly.primary.percentPerCostUnit);
});

test("a calibration reset excludes earlier evidence without deleting usage history", () => {
  const before = turn({ id: "before", primary: 20, start: NOW - 120_000, end: NOW - 60_000 });
  const sessions = { one: session("one", "gpt-6-sol", [before]) };
  const retained = quotaCalibration(sessions, undefined, { now: NOW });
  const reset = quotaCalibration(sessions, undefined, { now: NOW, resetAt: new Date(NOW).toISOString() });
  assert.equal(retained.primary.samples, 1);
  assert.equal(reset.primary.samples, 0);
  assert.equal(sessions.one.turns.length, 1);
});

test("downweights overlapping sessions and never treats account delta as an exact turn charge", () => {
  const isolated = turn({ id: "isolated", primary: 5, start: NOW - 600_000, end: NOW - 540_000 });
  const overlappingA = turn({ id: "a", primary: 20, start: NOW - 60_000, end: NOW });
  const overlappingB = turn({ id: "b", primary: 20, start: NOW - 50_000, end: NOW });
  const sessions = {
    isolated: session("isolated", "gpt-6-sol", [isolated]),
    a: session("a", "gpt-6-sol", [overlappingA]),
    b: session("b", "gpt-6-sol", [overlappingB]),
  };
  const calibration = quotaCalibration(sessions, undefined, { now: NOW });
  assert.equal(calibration.primary.samples, 3);
  assert.ok(calibration.primary.effectiveSamples < 1.5);
  assert.notEqual(estimateTurnQuota(overlappingA, calibration).primary.percent, 20);
});

test("builds per-turn and mixed-model session estimates through one interface", () => {
  const turns = [
    turn({ id: "sol", model: "gpt-6-sol", primary: 5 }),
    turn({ id: "luna", model: "gpt-6-luna", primary: 2, start: NOW - 180_000, end: NOW - 120_000 }),
  ];
  const view = usageView({ sessions: { mixed: session("mixed", "gpt-6-luna", turns) } }, { now: NOW });
  assert.ok(view.sessions.mixed.quotaEstimate.primary.percent > 0);
  assert.ok(view.sessions.mixed.turns.every((item) => item.quotaEstimate.secondary.percent > 0));
});
