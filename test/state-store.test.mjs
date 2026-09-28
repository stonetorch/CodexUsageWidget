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
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
console.log("settings persistence: ok");
