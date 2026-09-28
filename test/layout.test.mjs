import assert from "node:assert/strict";
import { chooseOverlayLeft } from "../src/dom-overlay.mjs";

const overlayWidth = 226;
const overlayHeight = 27;
const top = 116;
const exclusionRects = [
  { left: 808, right: 832, top: 111, bottom: 137 },
  { left: 934, right: 1059, top: 102, bottom: 142 },
];

const left = chooseOverlayLeft({
  anchorRect: { left: 22, right: 1070 },
  overlayWidth,
  overlayHeight,
  overlayTop: top,
  viewportWidth: 1081,
  exclusionRects,
});

assert.equal(typeof left, "number", "a safe horizontal slot should be found");

const overlaps = exclusionRects.some((rect) =>
  left < rect.right && left + overlayWidth > rect.left && top < rect.bottom && top + overlayHeight > rect.top,
);

assert.equal(overlaps, false, "usage overlay must not cover composer buttons");
console.log("layout overlap regression: ok");
