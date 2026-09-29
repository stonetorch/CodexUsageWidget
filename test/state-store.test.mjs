import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StateStore } from "../src/state-store.mjs";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cuo-state-test-"));
const file = path.join(directory, "state.json");
try {
  const store = new StateStore(file);
  assert.equal(store.snapshot().settings.sidebar, false);
  assert.equal(store.snapshot().settings.turnBadges, false);
  store.updateSettings({ sidebar: true, turnBadges: true, budgets: { primary: 2, secondary: 10 } });
  const reopened = new StateStore(file);
  assert.deepEqual(reopened.snapshot().settings, {
    sidebar: true, turnBadges: true, budgets: { primary: 2, secondary: 10 }, calibrationResetAt: null,
  });
  reopened.updateSettings({ sidebar: false, turnBadges: false, budgets: { primary: -1, secondary: 0 } });
  assert.equal(new StateStore(file).snapshot().settings.budgets.primary, 2);
  reopened.clearCalibrationEvidence("2026-09-28T12:00:00.000Z");
  const reset = new StateStore(file).snapshot();
  assert.equal(reset.settings.calibrationResetAt, "2026-09-28T12:00:00.000Z");
  assert.deepEqual(reset.sessions, {});
  const metrics = (completedAt, total) => ({ accountingVersion: 2, usageSource: 'turn-ledger',
    model: 'gpt-6-sol', completedAt, turnUsage: { input_tokens: 100, total_tokens: 100 },
    conversationUsage: { input_tokens: total, total_tokens: total }, quotaObservations: [] });
  reopened.recordTurn({ session_id: 's', turn_id: 'new' }, metrics('2026-09-28T12:00:00Z', 200));
  reopened.recordTurn({ session_id: 's', turn_id: 'old' }, metrics('2026-09-28T11:00:00Z', 100));
  const session = reopened.snapshot().sessions.s;
  assert.equal(session.conversationUsage.total_tokens, 200);
  assert.deepEqual(session.turns.map(t => t.turnId), ['old', 'new']);
  assert.equal(new StateStore(file).snapshot().sessions.s.turns[0].accountingVersion, 2);
  assert.equal(reopened.persistenceStatus().error, null);
  assert.equal(reopened.persistenceStatus().lastPersistedAt, reopened.snapshot().updatedAt);

  const failed = new StateStore(directory);
  assert.throws(() => failed.setLimits({ primary: null }), { code: "EISDIR" });
  assert.equal(failed.persistenceStatus().error, "EISDIR");
  assert.equal(failed.persistenceStatus().lastPersistedAt, null);
  assert.equal(failed.snapshot().limits, null);
  failed.setActiveTurn("s", { turnId: "unwritten" });
  assert.throws(() => failed.recordTurn({ session_id: "s", turn_id: "unwritten" }, metrics("2026-09-28T13:00:00Z", 300)), { code: "EISDIR" });
  assert.equal(failed.snapshot().sessions.s, undefined);
  assert.equal(failed.snapshot().activeTurns.s.turnId, "unwritten");

} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
console.log("settings persistence: ok");
