import assert from "node:assert/strict";
import test from "node:test";
import { parseTranscriptText } from "../src/transcript.mjs";

function line(value) {
  return JSON.stringify(value);
}

test("computes per-turn and conversation token totals from cumulative token events", () => {
  const transcript = [
    line({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 10, reasoning_output_tokens: 4, total_tokens: 110 } }, rate_limits: { primary: { used_percent: 8, window_minutes: 300, resets_at: 10 }, secondary: { used_percent: 2, window_minutes: 10080, resets_at: 20 } } } }),
    line({ type: "turn_context", payload: { turn_id: "turn-2", model: "gpt-test" } }),
    line({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 140, cached_input_tokens: 75, output_tokens: 18, reasoning_output_tokens: 7, total_tokens: 158 } }, rate_limits: { primary: { used_percent: 9, window_minutes: 300, resets_at: 10 }, secondary: { used_percent: 2, window_minutes: 10080, resets_at: 20 } } } }),
    line({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Finished the task." }] } }),
  ].join("\n");

  const result = parseTranscriptText(transcript, "turn-2");
  assert.equal(result.turnUsage.total_tokens, 48);
  assert.equal(result.turnUsage.cached_input_tokens, 15);
  assert.equal(result.turnUsage.output_tokens, 8);
  assert.equal(result.conversationUsage.total_tokens, 158);
  assert.equal(result.rateLimitDelta.primary, 1);
  assert.equal(result.rateLimitDelta.secondary, 0);
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
