import assert from "node:assert/strict";
import test from "node:test";
import { messageMarker, detectPageSessionId, updateSource, formatQuota } from "../src/widget-overlay.mjs";
import { isCodexAppTarget } from "../src/cdp-client.mjs";

test("session marker matches rendered Markdown text", () => {
  const transcript = "我建议把估算改成“**价格加权的 token 成本 + 按模型、按额度窗口分别学习的换算系数**”。这符合你的四个假设。";
  const rendered = "我建议把估算改成“价格加权的 token 成本 + 按模型、按额度窗口分别学习的换算系数”。这符合你的四个假设。";
  assert.ok(rendered.includes(messageMarker(transcript)));
});

test("replaces an older injected widget implementation on update", () => {
  assert.match(updateSource({}), /__codexUsageOverlayV2\?\.version!==12/);
});

test("session marker preserves identifier underscores and decodes HTML spaces", () => {
  const transcript = "> 选中 session_id：（无法从当前页面提取） &#x20;\n\n在一些情境下出现了无法提取session_id的情况";
  const rendered = "选中 session_id：（无法从当前页面提取） 在一些情境下出现了无法提取session_id的情况";
  assert.ok(rendered.includes(messageMarker(transcript)));
  assert.equal(messageMarker("_强调_ 与 session_id"), "强调 与 session_id");
});

test("page session ID is read without state and ignores unrelated URL UUIDs", () => {
  const id = "01a0e8a5-14a0-7813-87fc-f0457e51d052";
  const doc = { querySelectorAll(selector) {
    return selector === "[data-above-composer-conversation-id]"
      ? [{ getAttribute: () => id }] : [];
  } };
  assert.equal(detectPageSessionId(doc, "app://-/index.html"), id);
  assert.equal(detectPageSessionId({ querySelectorAll: () => [] }, "codex-sandbox://host/#initId=db3ac564-dd00-4339-ab0d-dac0f791aba6"), null);
});

test("overlay targets Codex app pages rather than embedded webviews", () => {
  assert.equal(isCodexAppTarget({ type: "page", url: "app://-/index.html" }), true);
  assert.equal(isCodexAppTarget({ type: "page", url: "app://-/detached-window.html" }), true);
  assert.equal(isCodexAppTarget({ type: "webview", url: "https://chatgpt.com/" }), false);
  assert.equal(isCodexAppTarget({ type: "webview", url: "codex-sandbox://example" }), false);
});

test("runtime diagnostics distinguish page ID from state session selection", () => {
  const source = updateSource({});
  assert.match(source, /页面 session_id/);
  assert.match(source, /state 会话/);
  assert.match(source, /page-id-untracked/);
  assert.match(source, /detectedSessionId/);
  assert.doesNotMatch(source, /已识别 session_id/);
});


test("quota display distinguishes missing tokens from missing model calibration", () => {
  assert.equal(formatQuota(null), "--");
  assert.equal(formatQuota({ percent: null, reason: "missing-token-usage" }), "--");
  assert.equal(formatQuota({ percent: null, reason: "incomplete-history" }), "--");
  assert.equal(formatQuota({ percent: null, reason: "insufficient-evidence" }), "无法估算");
  assert.equal(formatQuota({ percent: null, reason: "unknown-model" }), "无法估算");
  assert.equal(formatQuota({ percent: NaN }), "无法估算");
  assert.equal(formatQuota({ percent: 0 }), "约 0%");
  assert.equal(formatQuota({ percent: 6 }), "约 6.00%");
});
