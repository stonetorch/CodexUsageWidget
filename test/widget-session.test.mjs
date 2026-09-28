import assert from "node:assert/strict";
import test from "node:test";
import { messageMarker, updateSource, formatQuota } from "../src/widget-overlay.mjs";

test("session marker matches rendered Markdown text", () => {
  const transcript = "我建议把估算改成“**价格加权的 token 成本 + 按模型、按额度窗口分别学习的换算系数**”。这符合你的四个假设。";
  const rendered = "我建议把估算改成“价格加权的 token 成本 + 按模型、按额度窗口分别学习的换算系数”。这符合你的四个假设。";
  assert.ok(rendered.includes(messageMarker(transcript)));
});

test("replaces an older injected widget implementation on update", () => {
  assert.match(updateSource({}), /__codexUsageOverlayV2\?\.version!==6/);
});


test("quota display distinguishes unavailable evidence from measured zero", () => {
  assert.equal(formatQuota({ percent: null }), "无法估算");
  assert.equal(formatQuota({ percent: NaN }), "无法估算");
  assert.equal(formatQuota({ percent: 0 }), "约 0%");
  assert.equal(formatQuota({ percent: 6 }), "约 6.00%");
});
