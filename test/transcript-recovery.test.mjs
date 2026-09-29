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

test("open page session is recovered even when its transcript is older than 48 hours", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cuo-old-page-test-"));
  try {
    const root = path.join(directory, "sessions");
    fs.mkdirSync(root);
    const id = "01a0e8a5-14a0-7813-87fc-f0457e51d052";
    const file = path.join(root, `rollout-${id}.jsonl`);
    fs.writeFileSync(file, [
      { type: "session_meta", payload: { id } },
      { type: "turn_context", payload: { turn_id: "old-turn", model: "gpt-6-sol" } },
      { type: "token_usage_record", payload: { turn_id: "old-turn", turn_token_usage: { total_tokens: 42 } } },
      { type: "event_msg", payload: { type: "task_complete" } },
      { type: "turn_context", payload: { turn_id: "newer-active", model: "gpt-6-sol" } },
      { type: "token_usage_record", payload: { turn_id: "newer-active", turn_token_usage: { total_tokens: 3 } } },
    ].map(JSON.stringify).join("\n"));
    const child = path.join(root, `rollout-${id}_01a0e89f-96cc-7fa2-879e-b374e84c3dc2.jsonl`);
    fs.writeFileSync(child, [
      { type: "session_meta", payload: { id } },
      { type: "turn_context", payload: { turn_id: "child-turn", model: "gpt-6-sol" } },
      { type: "token_usage_record", payload: { turn_id: "child-turn", turn_token_usage: { total_tokens: 12 } } },
      { type: "event_msg", payload: { type: "task_complete" } },
      { type: "turn_context", payload: { turn_id: "older-active", model: "gpt-6-sol" } },
      { type: "token_usage_record", payload: { turn_id: "older-active", turn_token_usage: { total_tokens: 2 } } },
    ].map(JSON.stringify).join("\n"));
    const old = new Date(Date.now() - 72 * 60 * 60 * 1000);
    const older = new Date(Date.now() - 73 * 60 * 60 * 1000);
    fs.utimesSync(file, old, old);
    fs.utimesSync(child, older, older);
    const store = new StateStore(path.join(directory, "state.json"));
    assert.equal(recoverRecentTranscripts({ root, store }), 0);
    assert.equal(recoverRecentTranscripts({ root, store, prioritySessionIds: new Set([id]) }), 2);
    assert.deepEqual(store.snapshot().sessions[id].turns.map((turn) => turn.turnId).sort(), ["child-turn", "old-turn"]);
    assert.equal(store.snapshot().activeTurns[id].turnId, "newer-active");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("failed state write leaves a completed turn eligible for recovery retry", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cuo-recovery-retry-test-"));
  try {
    const root = path.join(directory, "sessions");
    fs.mkdirSync(root);
    const id = "retry-session";
    fs.writeFileSync(path.join(root, `rollout-${id}.jsonl`), [
      { type: "session_meta", payload: { id } },
      { type: "turn_context", payload: { turn_id: "turn-1", model: "gpt-6-sol" } },
      { type: "token_usage_record", payload: { turn_id: "turn-1", turn_token_usage: { total_tokens: 42 } } },
      { type: "event_msg", payload: { type: "task_complete" } },
    ].map(JSON.stringify).join("\n"));
    const store = new StateStore(directory);
    const seenFiles = new Map();
    const warnings = [];
    const logger = { warn: (message) => warnings.push(message) };
    assert.equal(recoverRecentTranscripts({ root, store, seenFiles, logger }), 0);
    assert.equal(store.snapshot().sessions[id], undefined);
    assert.equal(store.persistenceStatus().error, "EISDIR");
    assert.equal(warnings.length, 1);
    store.filePath = path.join(directory, "state.json");
    assert.equal(recoverRecentTranscripts({ root, store, seenFiles, logger }), 1);
    assert.equal(new StateStore(store.filePath).snapshot().sessions[id].turns.length, 1);
    assert.equal(store.persistenceStatus().error, null);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
