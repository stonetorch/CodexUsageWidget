export function chooseOverlayLeft({
  anchorRect,
  overlayWidth,
  overlayHeight = 0,
  overlayTop = 0,
  viewportWidth,
  exclusionRects = [],
  edgePadding = 8,
  controlGap = 6,
}) {
  const boundLeft = Math.max(edgePadding, anchorRect.left + edgePadding);
  const boundRight = Math.min(viewportWidth - edgePadding, anchorRect.right - edgePadding);
  const blocked = exclusionRects
    .filter((rect) => overlayTop < rect.bottom && overlayTop + overlayHeight > rect.top)
    .map((rect) => ({
      left: Math.max(boundLeft, rect.left - controlGap),
      right: Math.min(boundRight, rect.right + controlGap),
    }))
    .filter((rect) => rect.left < rect.right)
    .sort((left, right) => left.left - right.left);

  const merged = [];
  for (const rect of blocked) {
    const previous = merged.at(-1);
    if (previous && rect.left <= previous.right) previous.right = Math.max(previous.right, rect.right);
    else merged.push({ ...rect });
  }

  const free = [];
  let cursor = boundLeft;
  for (const rect of merged) {
    if (rect.left > cursor) free.push({ left: cursor, right: rect.left });
    cursor = Math.max(cursor, rect.right);
  }
  if (cursor < boundRight) free.push({ left: cursor, right: boundRight });

  const slot = [...free].reverse().find((interval) => interval.right - interval.left >= overlayWidth);
  return slot ? slot.right - overlayWidth : null;
}

function bootstrapCodexUsageOverlay(initialState, chooseLeft) {
  const GLOBAL_KEY = "__codexUsageOverlay";
  const ROOT_ID = "codex-usage-overlay-root";
  if (window[GLOBAL_KEY]) {
    window[GLOBAL_KEY].update(initialState);
    return;
  }

  let state = initialState || {};
  let scheduled = false;
  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.setAttribute("aria-label", "Codex usage");
  root.style.cssText = [
    "position:fixed",
    "z-index:2147483646",
    "display:flex",
    "align-items:center",
    "gap:6px",
    "font:500 11px/1.2 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif",
    "pointer-events:none",
    "user-select:none",
    "transition:left .12s ease,top .12s ease",
  ].join(";");
  document.documentElement.appendChild(root);

  const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const matchable = (value) => normalize(String(value || "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_>#~|]/g, " "));
  const escapeText = (value) => String(value ?? "");
  const formatTokens = (value) => {
    const number = Number(value || 0);
    if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 1 : 2)}M`;
    if (number >= 1_000) return `${(number / 1_000).toFixed(number >= 100_000 ? 0 : 1)}K`;
    return String(number);
  };
  const durationLabel = (minutes) => {
    if (minutes === 300) return "5h";
    if (minutes === 10080) return "周";
    if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440}d`;
    return `${minutes || "?"}m`;
  };
  const remaining = (window) => window ? Math.max(0, 100 - Number(window.usedPercent || 0)) : null;

  function chip(text, tone = "normal", title = "") {
    const colors = tone === "accent"
      ? "background:color-mix(in srgb,#10a37f 18%,Canvas);border-color:color-mix(in srgb,#10a37f 40%,transparent)"
      : "background:color-mix(in srgb,Canvas 88%,CanvasText 12%);border-color:color-mix(in srgb,CanvasText 16%,transparent)";
    return `<span title="${escapeText(title).replaceAll('"', '&quot;')}" style="${colors};color:CanvasText;border:1px solid;border-radius:999px;padding:3px 7px;box-shadow:0 1px 3px rgba(0,0,0,.08);white-space:nowrap">${escapeText(text)}</span>`;
  }

  function visibleText() {
    return normalize(document.body?.innerText || "");
  }

  function activeSession() {
    const bodyText = visibleText();
    const sessions = Object.values(state.sessions || {}).sort((left, right) =>
      String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")),
    );
    const urlMatch = sessions.find((session) => session.sessionId && location.href.includes(session.sessionId));
    if (urlMatch) return urlMatch;
    return sessions.find((session) => {
      const last = [...(session.turns || [])].reverse().find((turn) => turn.lastAssistantMessage);
      const marker = matchable(last?.lastAssistantMessage).slice(0, 72);
      return marker.length >= 16 && bodyText.includes(marker);
    }) || null;
  }

  function findComposer() {
    const candidates = [...document.querySelectorAll("textarea,[contenteditable='true'],[role='textbox']")]
      .filter((element) => !element.closest(`#${ROOT_ID}`))
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 180 && rect.height > 20 && rect.bottom > innerHeight * 0.45 && rect.top < innerHeight);
    candidates.sort((left, right) => right.rect.bottom - left.rect.bottom || right.rect.width - left.rect.width);
    return candidates[0] || null;
  }

  function findComposerShell(composer) {
    let candidate = composer.element.parentElement;
    for (let depth = 0; candidate && depth < 6; depth += 1, candidate = candidate.parentElement) {
      const rect = candidate.getBoundingClientRect();
      if (rect.width >= composer.rect.width && rect.width <= composer.rect.width + 120
        && rect.height >= composer.rect.height + 20 && rect.height < innerHeight * 0.5) {
        return rect;
      }
    }
    return composer.rect;
  }

  function interactiveRects(composer, top, height) {
    return [...document.querySelectorAll("button,[role='button'],a[href],[tabindex]:not([tabindex='-1'])")]
      .filter((element) => !element.closest(`#${ROOT_ID}`) && element !== composer.element)
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0
        && rect.left < composer.rect.right && rect.right > composer.rect.left
        && top < rect.bottom && top + height > rect.top);
  }

  function renderRoot() {
    const limits = state.limits;
    const windows = [limits?.primary, limits?.secondary].filter(Boolean);
    const limitHtml = windows.map((window) => chip(
      `${durationLabel(window.windowDurationMins)} 剩余 ${remaining(window).toFixed(0)}%`,
      remaining(window) <= 15 ? "accent" : "normal",
      window.resetsAt ? `重置：${new Date(window.resetsAt * 1000).toLocaleString()}` : "",
    ));
    const session = activeSession();
    if (session?.conversationUsage) {
      limitHtml.push(chip(`本对话 ${formatTokens(session.conversationUsage.total_tokens)} tokens`, "accent"));
    }
    root.innerHTML = limitHtml.length ? limitHtml.join("") : chip("额度读取中…");

    const composer = findComposer();
    if (!composer) {
      root.style.left = "auto";
      root.style.right = "16px";
      root.style.top = "auto";
      root.style.bottom = "16px";
      return;
    }
    root.style.right = "auto";
    root.style.bottom = "auto";
    const own = root.getBoundingClientRect();
    const desiredTop = composer.rect.bottom + 5;
    let top = desiredTop + own.height < innerHeight - 4 ? desiredTop : composer.rect.top - own.height - 5;
    let left = chooseLeft({
      anchorRect: composer.rect,
      overlayWidth: own.width,
      overlayHeight: own.height,
      overlayTop: top,
      viewportWidth: innerWidth,
      exclusionRects: interactiveRects(composer, top, own.height),
    });
    if (left == null) {
      const shell = findComposerShell(composer);
      top = shell.bottom + own.height < innerHeight - 4 ? shell.bottom + 5 : shell.top - own.height - 5;
      left = chooseLeft({ anchorRect: shell, overlayWidth: own.width, viewportWidth: innerWidth });
    }
    root.style.left = `${left ?? 8}px`;
    root.style.top = `${Math.max(4, top)}px`;
  }

  function findMessageContainer(message) {
    const marker = matchable(message).slice(0, 72);
    if (marker.length < 16) return null;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    const firstWords = marker.slice(0, 36);
    while ((node = walker.nextNode())) {
      if (node.parentElement?.closest(`#${ROOT_ID},[data-cuo-turn]`)) continue;
      if (!normalize(node.nodeValue).includes(firstWords)) continue;
      let candidate = node.parentElement;
      for (let depth = 0; candidate && depth < 8; depth += 1, candidate = candidate.parentElement) {
        const text = normalize(candidate.innerText || candidate.textContent);
        const rect = candidate.getBoundingClientRect();
        if (text.includes(marker) && rect.width > 180 && rect.height > 20 && rect.height < innerHeight * 0.8) return candidate;
      }
    }
    return null;
  }

  function renderTurnBadges() {
    for (const session of Object.values(state.sessions || {})) {
      for (const turn of session.turns || []) {
        if (!turn.lastAssistantMessage || document.querySelector(`[data-cuo-turn="${CSS.escape(turn.turnId)}"]`)) continue;
        const container = findMessageContainer(turn.lastAssistantMessage);
        if (!container) continue;
        const usage = turn.usage || {};
        const delta = turn.rateLimitDelta?.primary;
        const badge = document.createElement("div");
        badge.dataset.cuoTurn = turn.turnId;
        badge.style.cssText = "display:flex;justify-content:flex-end;margin-top:6px;pointer-events:none;font:500 10px/1.2 ui-sans-serif,system-ui;color:color-mix(in srgb,CanvasText 62%,transparent)";
        const details = `输入 ${formatTokens(usage.input_tokens)} · 缓存 ${formatTokens(usage.cached_input_tokens)} · 输出 ${formatTokens(usage.output_tokens)}`;
        badge.innerHTML = `<span title="${details}" style="border:1px solid color-mix(in srgb,CanvasText 12%,transparent);border-radius:999px;padding:2px 6px;background:color-mix(in srgb,Canvas 94%,CanvasText 6%)">本次 ${formatTokens(usage.total_tokens)} tokens${delta > 0 ? ` · 5h约 ${delta.toFixed(1)}%` : ""}</span>`;
        container.appendChild(badge);
      }
    }
  }

  function render() {
    scheduled = false;
    renderRoot();
    renderTurnBadges();
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(render);
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  addEventListener("resize", schedule);
  addEventListener("scroll", schedule, true);
  window[GLOBAL_KEY] = {
    update(nextState) {
      state = nextState || {};
      schedule();
    },
    destroy() {
      observer.disconnect();
      root.remove();
      delete window[GLOBAL_KEY];
    },
  };
  render();
}

export function injectionSource(state) {
  return `(${bootstrapCodexUsageOverlay.toString()})(${JSON.stringify(state).replaceAll("<", "\\u003c")},(${chooseOverlayLeft.toString()}))`;
}

export function updateSource(state) {
  const serialized = JSON.stringify(state).replaceAll("<", "\\u003c");
  return `window.__codexUsageOverlay ? window.__codexUsageOverlay.update(${serialized}) : (${bootstrapCodexUsageOverlay.toString()})(${serialized},(${chooseOverlayLeft.toString()}))`;
}
