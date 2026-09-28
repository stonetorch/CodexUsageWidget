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
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "当前对话正在运行" }] } },
      { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 150, output_tokens: 20, total_tokens: 170 } } } },
    ];
    fs.writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    const store = new StateStore(path.join(directory, "state.json"));
    const seenFiles = new Map();
    assert.equal(recoverRecentTranscripts({ root: path.join(directory, "sessions"), store, seenFiles }), 1);
    assert.deepEqual(store.snapshot().sessions["session-1"].turns.map((turn) => turn.turnId), ["turn-1"]);
    assert.equal(store.snapshot().activeTurns["session-1"].turnId, "turn-2");
    assert.equal(store.snapshot().activeTurns["session-1"].usage.total_tokens, 60);
    assert.equal(store.snapshot().activeTurns["session-1"].lastUserMessage, "当前对话正在运行");
    assert.equal(recoverRecentTranscripts({ root: path.join(directory, "sessions"), store, seenFiles }), 0);
    assert.equal(store.snapshot().activeTurns["session-1"].turnId, "turn-2");
    fs.appendFileSync(file, `${JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } })}\n`);
    assert.equal(recoverRecentTranscripts({ root: path.join(directory, "sessions"), store, seenFiles }), 1);
    assert.deepEqual(store.snapshot().sessions["session-1"].turns.map((turn) => turn.turnId), ["turn-1", "turn-2"]);
    assert.equal(store.snapshot().activeTurns["session-1"], undefined);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test("recovery upgrades legacy records, backfills every completed turn, and is idempotent", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cuo-upgrade-test-"));
  try {
    const root = path.join(directory, 'sessions'); fs.mkdirSync(root);
    const store = new StateStore(path.join(directory, 'state.json'));
    store.recordTurn({ session_id: 's', turn_id: 'a' }, {
      model: 'gpt-6-sol', turnUsage: { input_tokens: 24000000, total_tokens: 24000000 },
      conversationUsage: { total_tokens: 24000000 }, completedAt: '2026-09-28T12:00:00Z',
      rateLimitDelta: { primary: 6 },
    });
    const entries = [{ type: 'session_meta', payload: { id: 's' } }];
    for (const [i, id] of ['a', 'b', 'unfinished'].entries()) {
      entries.push({ timestamp: `2026-09-28T10:0${i}:00Z`, type: 'turn_context', payload: { turn_id: id, model: 'gpt-6-sol' } });
      entries.push({ timestamp: `2026-09-28T10:0${i}:01Z`, type: 'token_usage_record', payload: {
        turn_id: id, turn_token_usage: { input_tokens: 100, total_tokens: 100 },
        thread_token_usage: { input_tokens: 100 * (i + 1), total_tokens: 100 * (i + 1) } } });
      if (id !== 'unfinished') entries.push({ timestamp: `2026-09-28T10:0${i}:02Z`, type: 'event_msg', payload: { type: 'task_complete' } });
    }
    fs.writeFileSync(path.join(root, 'rollout.jsonl'), entries.map(JSON.stringify).join('\n'));
    assert.equal(recoverRecentTranscripts({ root, store }), 2);
    const s = store.snapshot().sessions.s;
    assert.deepEqual(s.turns.map(t => t.turnId), ['a', 'b']);
    assert.equal(s.turns[0].usage.total_tokens, 100);
    assert.equal(s.turns[0].accountingVersion, 2);
    assert.equal(s.turns[0].completedAt, '2026-09-28T10:00:02.000Z');
    assert.equal(s.conversationUsage.total_tokens, 200);
    assert.equal(recoverRecentTranscripts({ root, store }), 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("known session rollout is checked even when outside the newest 200 generic files", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cuo-known-session-test-"));
  try {
    const root = path.join(directory, "sessions"); fs.mkdirSync(root);
    const store = new StateStore(path.join(directory, "state.json"));
    store.recordTurn({ session_id: "known", turn_id: "previous" }, {
      model: "gpt-6-sol", turnUsage: { total_tokens: 10 },
      conversationUsage: { total_tokens: 10 }, completedAt: "2026-09-28T10:00:00Z",
    });
    const target = path.join(root, "rollout-known.jsonl");
    fs.writeFileSync(target, [
      { type: "session_meta", payload: { id: "known" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "running" } },
      { type: "turn_context", payload: { turn_id: "running", model: "gpt-6-sol" } },
      { type: "token_usage_record", payload: { turn_id: "running", turn_token_usage: { total_tokens: 42 } } },
    ].map(JSON.stringify).join("\n"));
    const earlier = new Date(Date.now() - 60_000);
    fs.utimesSync(target, earlier, earlier);
    for (let index = 0; index < 205; index += 1) {
      fs.writeFileSync(path.join(root, `other-${index}.jsonl`), "{}\n");
    }
    recoverRecentTranscripts({ root, store });
    assert.equal(store.snapshot().activeTurns.known.turnId, "running");
    assert.equal(store.snapshot().activeTurns.known.usage.total_tokens, 42);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
