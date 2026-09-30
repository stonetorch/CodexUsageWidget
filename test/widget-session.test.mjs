import assert from "node:assert/strict";
import test from "node:test";
import { messageMarker, detectPageSessionId, updateSource, formatQuota, resetAlert, WIDGET_DISPLAY_VERSION, WIDGET_IMPLEMENTATION_VERSION } from "../src/widget-overlay.mjs";
import { isCodexAppTarget } from "../src/cdp-client.mjs";

test("session marker matches rendered Markdown text", () => {
  const transcript = "我建议把估算改成“**价格加权的 token 成本 + 按模型、按额度窗口分别学习的换算系数**”。这符合你的四个假设。";
  const rendered = "我建议把估算改成“价格加权的 token 成本 + 按模型、按额度窗口分别学习的换算系数”。这符合你的四个假设。";
  assert.ok(rendered.includes(messageMarker(transcript)));
});

test("replaces an older injected widget implementation on update", () => {
  assert.match(updateSource({}), new RegExp(`__codexUsageOverlayV2\\?\\.version!==${WIDGET_IMPLEMENTATION_VERSION}`));
});

test("expanded settings show the current overlay version", () => {
  const source = updateSource({});
  assert.equal(WIDGET_DISPLAY_VERSION, `v${WIDGET_IMPLEMENTATION_VERSION}`);
  assert.match(source, /浮窗版本/);
  assert.match(source, new RegExp(WIDGET_DISPLAY_VERSION));
});

test("settings show CDP delivery and the backend's last successful state write", () => {
  const source = updateSource({ persistence: { lastPersistedAt: "2026-09-29T02:32:00.000Z", error: null } });
  assert.match(source, /上次收到 CDP 更新/);
  assert.match(source, /state\.json 最近成功写入（后端报告）/);
  assert.match(source, /lastCdpUpdateAt=Date\.now\(\)/);
  assert.match(source, /current\.persistence\?\.lastPersistedAt/);
});

test("estimation evidence and display options open in a separate settings page", () => {
  const source = updateSource({});
  assert.match(source, /id="settings-open"/);
  assert.match(source, /id="settings-view" hidden/);
  assert.match(source, /id="settings-back"/);
  assert.match(source, /估算与设置/);
  assert.match(source, /settingsPage=true/);
  assert.match(source, /settingsPage=false/);
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

test("page ID fallback ignores hidden conversations and preserves original URL priority", () => {
  const a = "01a0e8a5-14a0-7813-87fc-f0457e51d052";
  const b = "01a0f184-7253-74d3-bfa0-e5c2212c67b1";
  const element = (id, visible, visibility = "visible") => ({
    getAttribute: () => id,
    getBoundingClientRect: () => ({ width: visible ? 700 : 0, height: visible ? 32 : 0 }),
    visibility,
  });
  let elements = [element(a, false), element(b, true), element(b, true)];
  const doc = {
    querySelectorAll: (selector) => selector === "[data-above-composer-conversation-id]" ? elements : [],
    defaultView: { getComputedStyle: (item) => ({ visibility: item.visibility }) },
  };
  assert.equal(detectPageSessionId(doc, "app://-/index.html"), b);
  assert.equal(detectPageSessionId(doc, `app://-/thread/${a}`), a);
  elements = [element(a, true), element(b, true)];
  assert.equal(detectPageSessionId(doc, "app://-/index.html"), null);
  elements = [element(a, false), element(b, true, "hidden")];
  assert.equal(detectPageSessionId(doc, "app://-/index.html"), null);
  elements = [element(a, false)];
  assert.equal(detectPageSessionId(doc, "app://-/index.html"), a);
});

test("overlay targets Codex app pages rather than embedded webviews", () => {
  assert.equal(isCodexAppTarget({ type: "page", url: "app://-/index.html" }), true);
  assert.equal(isCodexAppTarget({ type: "page", url: "app://-/detached-window.html" }), true);
  assert.equal(isCodexAppTarget({ type: "webview", url: "https://chatgpt.com/" }), false);
  assert.equal(isCodexAppTarget({ type: "webview", url: "codex-sandbox://example" }), false);
});

test("runtime diagnostics distinguish page ID from state session selection", () => {
  const source = updateSource({});
  const usageMarkup = source.slice(source.indexOf('<div id="usage-view"'), source.indexOf('<div id="settings-view"'));
  assert.doesNotMatch(usageMarkup, /id="runtime-status"/);
  assert.match(source, /<fieldset><strong>调试信息<\/strong><p class="hint" id="runtime-status"><\/p>/);
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

test("reset probability opens its own page from the usage view", () => {
  const source = updateSource({});
  const usageMarkup = source.slice(source.indexOf('<div id="usage-view"'), source.indexOf('<div id="settings-view"'));
  assert.match(usageMarkup, /<button class="settings-link" id="reset-open" type="button">/);
  assert.match(usageMarkup, /重置概率预测/);
  assert.match(source, /<div id="reset-view" hidden>/);
  assert.match(source, /<button class="small" id="reset-back" type="button">← 返回<\/button>/);
  assert.match(source, /id="reset-p12h"/);
  assert.match(source, /id="reset-p24h"/);
  assert.match(source, /id="reset-p48h"/);
  assert.match(source, /id="reset-p72h"/);
  assert.match(source, /resetPage=true;settingsPage=false/);
  assert.match(source, /usage-view"\)\.hidden=settingsPage\|\|resetPage/);
  assert.match(source, /current\.resetProbability/);
  assert.match(source, /Tibo 随机重置 Codex 额度的概率预测/);
});

test("the composer pill flags a likely reset from the 48h probability", () => {
  assert.equal(resetAlert(0.7), true);
  assert.equal(resetAlert(0.6999999), false);
  assert.equal(resetAlert(0.81), true);
  assert.equal(resetAlert(0), false);
  assert.equal(resetAlert(null), false);
  assert.equal(resetAlert(undefined), false);
  const source = updateSource({ resetProbability: { p24h: 0.81, p48h: 0.65 } });
  assert.match(source, /<span class="tail"><span class="reset-flag" id="reset-flag" hidden>⚡<\/span><span class="gear">⚙<\/span><\/span>/);
  assert.match(source, /const flagged=alertAt\(reset\?\.p48h\)/);
  assert.match(source, /\$\("reset-flag"\)\.hidden=!flagged/);
  assert.match(source, /48 小时内重置 Codex 额度概率/);
});

test("session hints are compact hover markers instead of inline sentences", () => {
  const source = updateSource({});
  const usageMarkup = source.slice(source.indexOf('<div id="usage-view"'), source.indexOf('<div id="settings-view"'));
  assert.match(usageMarkup, /<span class="mark" id="session-window-mark"[^>]*title="完整窗口等值：[^"]+">ⓘ<\/span>/);
  assert.match(usageMarkup, /<span class="mark" id="session-partial-mark"[^>]*title="仅含已记录轮次：[^"]+" hidden>ⓘ<\/span>/);
  assert.doesNotMatch(usageMarkup, /（完整窗口等值）/);
  assert.match(source, /id="session-values"/);
  assert.match(source, /\$\("session-partial-mark"\)\.hidden=!partialHistory/);
});
