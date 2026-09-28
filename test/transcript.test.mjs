import assert from "node:assert/strict";
import test from "node:test";
import { parseTranscriptText } from "../src/transcript.mjs";

function line(value) {
  return JSON.stringify(value);
}

test("computes per-turn and conversation token totals from cumulative token events", () => {
  const transcript = [
    line({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 10, reasoning_output_tokens: 4, total_tokens: 110 } }, rate_limits: { primary: { used_percent: 8, window_minutes: 300, resets_at: 10 }, secondary: { used_percent: 2, window_minutes: 10080, resets_at: 20 } } } }),
    line({ timestamp: "2026-09-28T10:00:00.000Z", type: "turn_context", payload: { turn_id: "turn-2", model: "gpt-test" } }),
    line({ timestamp: "2026-09-28T10:01:00.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 140, cached_input_tokens: 75, output_tokens: 18, reasoning_output_tokens: 7, total_tokens: 158 } }, rate_limits: { primary: { used_percent: 9, window_minutes: 300, resets_at: 10 }, secondary: { used_percent: 2, window_minutes: 10080, resets_at: 20 } } } }),
    line({ timestamp: "2026-09-28T10:01:02.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Finished the task." }] } }),
  ].join("\n");

  const result = parseTranscriptText(transcript, "turn-2");
  assert.equal(result.turnUsage.total_tokens, 48);
  assert.equal(result.turnUsage.cached_input_tokens, 15);
  assert.equal(result.turnUsage.output_tokens, 8);
  assert.equal(result.conversationUsage.total_tokens, 158);
  assert.equal(result.rateLimitDelta.primary, null);
  assert.equal(result.rateLimitDelta.secondary, null);
  assert.equal(result.startedAt, "2026-09-28T10:00:00.000Z");
  assert.equal(result.completedAt, "2026-09-28T10:01:02.000Z");
  assert.equal(result.lastAssistantMessage, "Finished the task.");
});

test("ignores a partially written trailing JSONL line", () => {
  const transcript = [
    line({ type: "turn_context", payload: { turn_id: "turn-1", model: "gpt-test" } }),
    line({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 25 } }, rate_limits: null } }),
    "{not-complete",
  ].join("\n");
  assert.equal(parseTranscriptText(transcript).conversationUsage.total_tokens, 25);
});


const context = (id = "t", timestamp = "2026-09-28T10:00:00Z") => ({ timestamp, type: "turn_context", payload: { turn_id: id, model: "gpt-6-sol" } });
const usage = (n) => ({ input_tokens: n, cached_input_tokens: 0, output_tokens: 0, total_tokens: n });
const token = (timestamp, n, percent = 10, bucket = "codex") => ({ timestamp, type: "event_msg", payload: {
  type: "token_count", info: { total_token_usage: usage(n) }, rate_limits: { limit_id: bucket,
    primary: { used_percent: percent, resets_at: 1790604000, window_minutes: 300 } } } });
const parse = (entries, id = 't') => parseTranscriptText(entries.map(line).join('\n'), id);

test("uses explicit turn ledger when the first cumulative count includes inherited history", () => {
  const result = parse([context(), token('2026-09-28T10:00:01Z', 20000000),
    { timestamp: '2026-09-28T10:00:02Z', type: 'token_usage_record', payload: {
      turn_id: 't', turn_token_usage: usage(100), thread_token_usage: usage(30000000) } },
    token('2026-09-28T10:00:03Z', 20000100)]);
  assert.equal(result.turnUsage.total_tokens, 100);
  assert.equal(result.conversationUsage.total_tokens, 30000000);
  assert.equal(result.usageSource, 'turn-ledger');
  assert.equal(result.accountingVersion, 2);
});

test("missing baseline and backwards cumulative counters are unknown, never zero-based", () => {
  assert.equal(parse([context(), token('2026-09-28T10:00:01Z', 20000000)]).turnUsage, null);
  assert.equal(parse([token('2026-09-28T09:00:00Z', 20000), context(),
    token('2026-09-28T10:00:01Z', 100)]).turnUsage, null);
});

test("idle spending is excluded and zero increments within a turn retain their token cost", () => {
  const result = parse([token('2026-09-28T08:00:00Z', 10000, 10), context(),
    token('2026-09-28T10:00:01Z', 10100, 16), token('2026-09-28T10:00:02Z', 10200, 16),
    token('2026-09-28T10:00:03Z', 10300, 17)]);
  assert.equal(result.turnUsage.total_tokens, 300);
  assert.equal(result.rateLimitDelta.primary, null);
  assert.equal(result.quotaObservations.length, 2);
  assert.equal(result.quotaObservations[0].usage.total_tokens, 100);
  assert.equal(result.quotaObservations[0].before.primary.usedPercent, 16);
  assert.equal(result.quotaObservations[0].after.primary.usedPercent, 16);
});

test("premium bucket cannot overwrite codex snapshots and completed turns stop at task_complete", () => {
  const result = parse([context(), token('2026-09-28T10:00:01Z', 100, 10),
    token('2026-09-28T10:00:02Z', 100, 90, 'premium'),
    token('2026-09-28T10:00:03Z', 200, 12),
    { timestamp: '2026-09-28T10:00:04Z', type: 'event_msg', payload: { type: 'task_complete' } },
    token('2026-09-28T10:30:00Z', 90000000, 99)]);
  assert.equal(result.rateLimits.primary.usedPercent, 12);
  assert.equal(result.quotaObservations.length, 1);
  assert.equal(result.quotaObservations[0].usage.total_tokens, 100);
  assert.equal(result.conversationUsage.total_tokens, 200);
  assert.equal(result.completedAt, '2026-09-28T10:00:04.000Z');
});


test("a counter reset within the turn invalidates cumulative subtraction even after it catches up", () => {
  const result = parse([token('2026-09-28T09:00:00Z', 10000), context(),
    token('2026-09-28T10:00:01Z', 500), token('2026-09-28T10:00:02Z', 11000)]);
  assert.equal(result.turnUsage, null);
});

test("a missing cumulative count does not silently establish a zero baseline", () => {
  const result = parse([{ type: 'event_msg', payload: { type: 'token_count', info: {} } },
    context(), token('2026-09-28T10:00:01Z', 20000000)]);
  assert.equal(result.turnUsage, null);
});
