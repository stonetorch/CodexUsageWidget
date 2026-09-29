import assert from "node:assert/strict";
import test from "node:test";
import { fetchResetProbabilities, normalizeResetProbabilities, RESET_PROBABILITY_ENDPOINT } from "../src/reset-probability.mjs";

const payload = {
  schemaVersion: "public-v1",
  checkedAt: "2026-09-29T14:50:08.889Z",
  viewModel: {
    status: "当前未执行重置。",
    probability12h: 0.4478280861765758,
    probability24h: 0.6472237601346813,
    probability48h: 0.7780475188923139,
    probability72h: 0.8037947531596014,
    lastUpdated: "2026-09-29T14:50:08.889Z",
  },
};

test("normalizes the public forecast into the four horizons", () => {
  assert.deepEqual(normalizeResetProbabilities(payload), {
    checkedAt: "2026-09-29T14:50:08.889Z",
    p12h: 0.4478280861765758,
    p24h: 0.6472237601346813,
    p48h: 0.7780475188923139,
    p72h: 0.8037947531596014,
  });
});

test("rejects payloads without a usable view model", () => {
  assert.equal(normalizeResetProbabilities(null), null);
  assert.equal(normalizeResetProbabilities({}), null);
  assert.equal(normalizeResetProbabilities({ viewModel: null }), null);
  assert.equal(normalizeResetProbabilities({ viewModel: { status: "当前未执行重置。" } }), null);
  assert.equal(normalizeResetProbabilities({ viewModel: { probability12h: "高" } }), null);
});

test("keeps partial horizons and treats out-of-range values as unknown", () => {
  assert.deepEqual(normalizeResetProbabilities({ viewModel: { probability24h: 0.71 } }), {
    checkedAt: null, p12h: null, p24h: 0.71, p48h: null, p72h: null,
  });
  assert.equal(normalizeResetProbabilities({ viewModel: { probability24h: 71 } }), null);
  assert.equal(normalizeResetProbabilities({ viewModel: { probability24h: -0.1 } }), null);
  assert.equal(normalizeResetProbabilities({ viewModel: { probability24h: 0 } }).p24h, 0);
});

test("falls back to the view model timestamp and drops unparsable ones", () => {
  assert.equal(normalizeResetProbabilities({ viewModel: { probability24h: 0.5, lastUpdated: "2026-09-29T14:50:08.889Z" } }).checkedAt, "2026-09-29T14:50:08.889Z");
  assert.equal(normalizeResetProbabilities({ checkedAt: "昨天", viewModel: { probability24h: 0.5, lastUpdated: "nope" } }).checkedAt, null);
});

test("fetches the public endpoint and surfaces HTTP failures", async () => {
  const calls = [];
  const response = await fetchResetProbabilities({
    endpoint: "https://example.test/api/current?locale=zh",
    fetchImpl: async (url) => { calls.push(url); return { ok: true, json: async () => payload }; },
  });
  assert.deepEqual(calls, ["https://example.test/api/current?locale=zh"]);
  assert.equal(response.p24h, 0.6472237601346813);
  assert.match(RESET_PROBABILITY_ENDPOINT, /^https:\/\/codex\.gussuriworks\.com\/api\/current\?locale=zh$/);
  await assert.rejects(fetchResetProbabilities({ fetchImpl: async () => ({ ok: false, status: 503 }) }), /HTTP 503/);
});
