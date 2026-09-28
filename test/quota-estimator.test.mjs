import assert from "node:assert/strict";
import { weightedCost, quotaCalibration, estimateTurnQuota, usageView } from "../src/quota-estimator.mjs";

assert.equal(weightedCost({ input_tokens: 1_000_000, cached_input_tokens: 500_000, output_tokens: 100_000 }, "gpt-6-sol"), 1.05);
assert.equal(weightedCost({ input_tokens: 100_000, cached_input_tokens: 40_000, cache_write_input_tokens: 20_000, output_tokens: 10_000 }, "gpt-6-sol"), 0.119);

const turn = {
  model: "gpt-6-sol",
  usage: { input_tokens: 100_000, cached_input_tokens: 80_000, output_tokens: 2_000, total_tokens: 102_000 },
  rateLimitDelta: { primary: 2, secondary: 0 },
};
const sessions = { one: { model: "gpt-6-sol", conversationUsage: { total_tokens: 102_000 }, turns: [turn] } };
const calibration = quotaCalibration(sessions);
assert.equal(calibration.primary.source, "observed");
assert.equal(calibration.secondary.source, "rough");
assert.equal(estimateTurnQuota(turn, calibration).primary.percent, 2);
assert.ok(estimateTurnQuota(turn, calibration).secondary.percent > 0);
const view = usageView({ sessions });
assert.ok(view.sessions.one.quotaEstimate.primary.percent > 0);
assert.ok(view.sessions.one.turns[0].quotaEstimate.secondary.percent > 0);
console.log("quota estimator: ok");
