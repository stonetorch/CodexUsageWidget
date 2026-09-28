import assert from "node:assert/strict";
import { toolbarPlacement, intersects } from "../src/placement.mjs";

const composerRect = { left: 20, right: 1060, top: 15, bottom: 150 };
const controlRects = [
  { left: 45, right: 70, top: 109, bottom: 135, width: 25, height: 26 },
  { left: 90, right: 193, top: 109, bottom: 135, width: 103, height: 26 },
  { left: 810, right: 834, top: 109, bottom: 135, width: 24, height: 26 },
  { left: 940, right: 1050, top: 106, bottom: 139, width: 110, height: 33 },
];
const placement = toolbarPlacement({ composerRect, controlRects, normalWidth: 400, viewportWidth: 1080 });
assert.equal(placement.ok, true);
assert.equal(placement.compact, false);
assert.ok(placement.left > 193);
assert.ok(placement.left + placement.width < 810);
const widgetRect = { left: placement.left, right: placement.left + placement.width,
  top: placement.topCenter - 14, bottom: placement.topCenter + 14 };
assert.ok(controlRects.every((rect) => !intersects(widgetRect, rect)));

const small = toolbarPlacement({ composerRect: { left: 0, right: 320 }, controlRects: [
  { left: 10, right: 110, top: 100, bottom: 130, width: 100, height: 30 },
  { left: 220, right: 310, top: 100, bottom: 130, width: 90, height: 30 },
], normalWidth: 400, compactWidth: 150, viewportWidth: 320 });
assert.equal(small.ok, false);
console.log("toolbar placement: ok");
