import assert from "node:assert/strict";
import test from "node:test";
import { messageMarker, updateSource } from "../src/widget-overlay.mjs";

test("session marker matches rendered Markdown text", () => {
  const transcript = "我建议把估算改成“**价格加权的 token 成本 + 按模型、按额度窗口分别学习的换算系数**”。这符合你的四个假设。";
  const rendered = "我建议把估算改成“价格加权的 token 成本 + 按模型、按额度窗口分别学习的换算系数”。这符合你的四个假设。";
  assert.ok(rendered.includes(messageMarker(transcript)));
});

test("replaces an older injected widget implementation on update", () => {
  assert.match(updateSource({}), /__codexUsageOverlayV2\?\.version!==3/);
});
