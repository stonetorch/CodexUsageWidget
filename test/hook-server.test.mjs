import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startHookServer } from "../src/hook-server.mjs";
import { StateStore } from "../src/state-store.mjs";

test("Stop hook acknowledges only after a turn has been saved", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cuo-hook-server-test-"));
  const transcript = path.join(directory, "turn.jsonl");
  const store = new StateStore(path.join(directory, "state.json"));
  const entries = [
    { type: "session_meta", payload: { id: "session-1" } },
    { type: "turn_context", payload: { turn_id: "turn-1", model: "gpt-6-sol" } },
    { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } } },
    { type: "event_msg", payload: { type: "task_complete" } },
  ];
  fs.writeFileSync(transcript, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  const server = startHookServer({ port: 0, store });
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hook_event_name: "Stop", session_id: "session-1", turn_id: "turn-1", transcript_path: transcript }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).saved, true);
    assert.equal(store.snapshot().sessions["session-1"].turns.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
