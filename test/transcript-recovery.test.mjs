import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StateStore } from "../src/state-store.mjs";
import { recoverRecentTranscripts } from "../src/transcript-recovery.mjs";

test("backfills only completed turns from recently changed transcripts", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cuo-recovery-test-"));
  try {
    const sessions = path.join(directory, "sessions", "2026", "09", "09");
    fs.mkdirSync(sessions, { recursive: true });
    const file = path.join(sessions, "rollout.jsonl");
    const entries = [
      { type: "session_meta", payload: { id: "session-1", cwd: directory } },
      { type: "turn_context", payload: { turn_id: "turn-1", model: "gpt-6-sol" } },
      { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } } },
      { type: "event_msg", payload: { type: "task_complete" } },
      { type: "turn_context", payload: { turn_id: "turn-2", model: "gpt-6-sol" } },
      { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 150, output_tokens: 20, total_tokens: 170 } } } },
    ];
    fs.writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    const store = new StateStore(path.join(directory, "state.json"));
    const seenFiles = new Map();
    assert.equal(recoverRecentTranscripts({ root: path.join(directory, "sessions"), store, seenFiles }), 1);
    assert.deepEqual(store.snapshot().sessions["session-1"].turns.map((turn) => turn.turnId), ["turn-1"]);
    assert.equal(recoverRecentTranscripts({ root: path.join(directory, "sessions"), store, seenFiles }), 0);
    fs.appendFileSync(file, `${JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } })}\n`);
    assert.equal(recoverRecentTranscripts({ root: path.join(directory, "sessions"), store, seenFiles }), 1);
    assert.deepEqual(store.snapshot().sessions["session-1"].turns.map((turn) => turn.turnId), ["turn-1", "turn-2"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
