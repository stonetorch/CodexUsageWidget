import { toolbarPlacement, intersects } from "./placement.mjs";

export function messageMarker(value) {
  return String(value || "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_>#~|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 72);
}

function bootstrap(state, place, overlaps, makeMarker) {
  if (window.__codexUsageOverlayV2) { window.__codexUsageOverlayV2.update(state); return; }
  let current = state || {};
  let preferred = null;
  let watched = null;
  let open = false;
  let detailScope = "last";
  let evidenceOpen = false;
  let scheduled;
  const turnHosts = new Map();
  const host = document.createElement("span");
  host.id = "codex-usage-widget";
  host.style.cssText = "position:fixed;z-index:1000;pointer-events:none";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>
    :host([hidden]){display:none!important}*{box-sizing:border-box}
    button{cursor:pointer}.widget{display:flex;align-items:center;gap:5px;width:100%;height:28px;max-width:100%;padding:3px 8px;border:1px solid color-mix(in srgb,CanvasText 24%,transparent);border-radius:999px;background:color-mix(in srgb,Canvas 86%,CanvasText 14%);color:CanvasText;font:500 11px/1.2 system-ui,'Segoe UI',sans-serif;white-space:nowrap;overflow:hidden;pointer-events:auto;box-shadow:0 2px 8px #0002}
    .widget span{overflow:hidden;text-overflow:ellipsis}.widget .gear{margin-left:auto}.widget:focus-visible{outline:2px solid #10a37f}
    :host([data-narrow=true]) .last{display:none}
    .panel{position:absolute;bottom:calc(100% + 8px);left:var(--panel-left,0px);width:380px;max-width:calc(100vw - 16px);max-height:78vh;overflow:auto;padding:14px;border:1px solid color-mix(in srgb,CanvasText 24%,transparent);border-radius:12px;background:Canvas;color:CanvasText;box-shadow:0 12px 32px #0005;font:12px/1.5 system-ui,'Segoe UI',sans-serif;pointer-events:auto}
    :host([data-panel-below=true]) .panel{top:calc(100% + 8px);bottom:auto}
    .panel[hidden],[hidden]{display:none!important}.panel h2{font-size:14px;margin:0 0 8px}.panel p{margin:6px 0}.panel fieldset{border:0;border-top:1px solid color-mix(in srgb,CanvasText 16%,transparent);padding:8px 0 0;margin:10px 0 0}.panel label{display:flex;align-items:center;gap:6px;margin:6px 0}.panel input[type=number]{width:65px;background:Canvas;color:CanvasText;border:1px solid color-mix(in srgb,CanvasText 35%,transparent);border-radius:4px;padding:2px}.hint{opacity:.7}
    .tabs{display:flex;gap:4px;margin:7px 0}.tabs button,.small{border:1px solid color-mix(in srgb,CanvasText 24%,transparent);border-radius:7px;background:transparent;color:CanvasText;padding:4px 8px;font:inherit}.tabs button[aria-selected=true]{background:color-mix(in srgb,CanvasText 14%,Canvas);font-weight:650}
    .metrics{display:grid;grid-template-columns:1fr 1fr;gap:5px 12px;padding:8px;border-radius:8px;background:color-mix(in srgb,CanvasText 6%,Canvas)}.metric{display:flex;justify-content:space-between;gap:8px}.metric span{opacity:.7}.metric strong{font-variant-numeric:tabular-nums;text-align:right}
    .section-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.evidence{max-height:190px;overflow:auto;margin-top:6px}.evidence table{width:100%;border-collapse:collapse;font-size:10px;font-variant-numeric:tabular-nums}.evidence th,.evidence td{padding:3px 4px;border-bottom:1px solid color-mix(in srgb,CanvasText 10%,transparent);text-align:right}.evidence th:first-child,.evidence td:first-child{text-align:left;max-width:95px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.danger{margin-top:8px;border-color:#d55!important;color:#d55!important}
  </style><button class="widget" aria-expanded="false"><span id="five">5h --</span><span>·</span><span id="week">周 --</span><span>·</span><span class="last" id="last">上轮 --</span><span class="gear">⚙</span></button>
  <section class="panel" hidden><h2>用量与设置</h2><p id="remaining"></p><p id="session"></p><p id="previous"></p>
  <fieldset><div class="tabs" role="tablist"><button id="scope-last" type="button" role="tab">上一轮</button><button id="scope-session" type="button" role="tab">当前会话</button></div><div class="metrics"><div class="metric"><span>总 token</span><strong id="metric-total">--</strong></div><div class="metric"><span>输出 token</span><strong id="metric-output">--</strong></div><div class="metric"><span>未缓存输入</span><strong id="metric-uncached">--</strong></div><div class="metric"><span>缓存输入</span><strong id="metric-cached">--</strong></div><div class="metric"><span>缓存写入</span><strong id="metric-write">--</strong></div><div class="metric"><span>缓存命中率</span><strong id="metric-hit">--</strong></div><div class="metric"><span>参考费用</span><strong id="metric-cost">--</strong></div><div class="metric"><span>模型</span><strong id="metric-model">--</strong></div></div><p class="hint" id="metric-note"></p></fieldset>
  <fieldset><div class="section-head"><strong>估算证据</strong><button class="small" id="evidence-toggle" type="button">查看详情</button></div><p id="confidence"></p><div class="evidence" id="evidence-details" hidden><table><thead><tr><th>模型</th><th>5h 组/权重</th><th>5h 系数</th><th>周 组/权重</th><th>周系数</th></tr></thead><tbody id="evidence-body"></tbody></table></div><button class="small danger" id="evidence-clear" type="button">清空用于估算的证据</button></fieldset>
  <fieldset><label><input id="sidebar" type="checkbox">侧栏显示剩余额度</label><label><input id="turns" type="checkbox">回复按钮旁显示本轮消耗</label></fieldset>
  <fieldset><p class="hint">无观测数据时的粗估预算（加权单位 / 整个窗口）</p><label>5 小时 <input id="budget-five" type="number" min="0.01" max="1000" step="0.01"></label><label>每周 <input id="budget-week" type="number" min="0.01" max="1000" step="0.01"></label></fieldset></section>`;
  const side = document.createElement("span");
  side.id = "codex-usage-sidebar-widget";
  side.style.cssText = "position:fixed;z-index:900;pointer-events:none;display:block";
  side.attachShadow({ mode: "open" }).innerHTML = `<style>:host([hidden]){display:none!important}.badge{box-sizing:border-box;display:block;width:100%;overflow:hidden;text-overflow:ellipsis;padding:5px 8px;border:1px solid color-mix(in srgb,CanvasText 18%,transparent);border-radius:8px;background:Canvas;color:CanvasText;font:500 11px system-ui;white-space:nowrap}</style><span class="badge"></span>`;
  const $ = (id) => root.getElementById(id);
  const compact = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const rect = (element) => { const r = element.getBoundingClientRect(); return { left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height }; };
  const visible = (element) => element?.isConnected && rect(element).width > 0 && rect(element).height > 0 && getComputedStyle(element).visibility !== "hidden";
  const buttons = (element) => [...element.querySelectorAll("button,[role=button]")].filter(visible);
  const remaining = (value) => value ? `${Math.max(0,100-Number(value.usedPercent||0)).toFixed(0)}%` : "--";
  const percent = (value) => { if (value == null) return "--"; const x = Number(value||0); return `${x>=10?x.toFixed(1):x>=1?x.toFixed(2):x.toFixed(3).replace(/0+$/,'').replace(/\.$/,'')}%`; };
  const pair = (estimate) => estimate ? `${percent(estimate.primary?.percent)} / ${percent(estimate.secondary?.percent)}` : "-- / --";
  const integer = (value) => value!=null&&Number.isFinite(Number(value)) ? Math.round(Number(value)).toLocaleString() : "--";
  const money = (value) => {const x=Number(value);return value!=null&&Number.isFinite(x)?`$${x<.01?x.toFixed(4):x.toFixed(3)}`:"--";};
  const rate = (value) => value!=null&&Number.isFinite(Number(value)) ? `${(Number(value)*100).toFixed(1)}%` : "--";
  const coefficient = (value) => Number.isFinite(Number(value)) ? Number(value).toFixed(2) : "--";
  const messageMarker = makeMarker;

  function locateComposer() {
    const explicit = ".composer-surface-chrome,[data-testid='composer'],[data-testid^='composer-'],[class*='ComposerLayoutRoot']";
    const found = [];
    for (const edit of document.querySelectorAll("textarea,[contenteditable=true],[role=textbox]")) {
      if (!visible(edit)) continue;
      let shell = edit.closest(explicit);
      let strategy = "explicit";
      if (!visible(shell)) {
        strategy = "editable-ancestor"; shell = null;
        let ancestor = edit.parentElement;
        for (let depth=0; ancestor && depth<7; depth++,ancestor=ancestor.parentElement) {
          const r=rect(ancestor);
          if (visible(ancestor) && r.width>=180 && r.height>=50 && r.height<=320 && buttons(ancestor).length>=2) { shell=ancestor; break; }
        }
      }
      if (!visible(shell)) continue;
      const r=rect(shell);
      let score=(strategy==="explicit"?100:45)+(shell.contains(document.activeElement)?75:0)+(shell===preferred?35:0)+(r.bottom>innerHeight*.55?25:0)+(r.width>300?10:0)+Math.min(8,buttons(shell).length);
      found.push({element:shell,rect:r,strategy,score});
    }
    found.sort((a,b)=>b.score-a.score||b.rect.bottom-a.rect.bottom);
    preferred=found[0]?.element||null;
    return found[0]||null;
  }

  function activeSession() {
    const sessions=Object.values(current.sessions||{}).sort((a,b)=>String(b.updatedAt||"").localeCompare(String(a.updatedAt||"")));
    const byUrl=sessions.find((s)=>s.sessionId && location.href.includes(s.sessionId));
    if (byUrl) return byUrl;
    const body=compact(document.body?.innerText);
    return sessions.find((s)=>{const latest=[...(s.turns||[])].reverse().find((t)=>t.lastAssistantMessage);const mark=messageMarker(latest?.lastAssistantMessage);return mark.length>=16 && body.includes(mark);}) || (sessions.length===1?sessions[0]:null);
  }

  function data() {
    const limits=current.limits||{};
    const session=activeSession();
    const last=session?.turns?.at(-1);
    $("five").textContent=`5h余 ${remaining(limits.primary)}`;
    $("week").textContent=`周余 ${remaining(limits.secondary)}`;
    $("last").textContent=`上轮≈${pair(last?.quotaEstimate)}`;
    $("remaining").textContent=`剩余：5 小时 ${remaining(limits.primary)} · 每周 ${remaining(limits.secondary)}`;
    $("session").textContent=`当前会话消耗：5 小时约 ${percent(session?.quotaEstimate?.primary?.percent)} · 每周约 ${percent(session?.quotaEstimate?.secondary?.percent)}`;
    $("previous").textContent=`上一轮消耗：5 小时约 ${percent(last?.quotaEstimate?.primary?.percent)} · 每周约 ${percent(last?.quotaEstimate?.secondary?.percent)}`;
    const selected=detailScope==="session"?session:last;
    const summary=selected?.usageSummary;
    $("scope-last").setAttribute("aria-selected",String(detailScope==="last"));
    $("scope-session").setAttribute("aria-selected",String(detailScope==="session"));
    $("metric-total").textContent=integer(summary?.totalTokens);
    $("metric-output").textContent=integer(summary?.outputTokens);
    $("metric-uncached").textContent=integer(summary?.uncachedInputTokens);
    $("metric-cached").textContent=integer(summary?.cachedInputTokens);
    $("metric-write").textContent=integer(summary?.cacheWriteInputTokens);
    $("metric-hit").textContent=rate(summary?.cacheHitRate);
    $("metric-cost").textContent=money(summary?.referenceCost);
    $("metric-model").textContent=summary?.model||"--";
    $("metric-note").textContent=`参考费用按 API token 价格加权${summary?.approximate?"，其中缺失轮次按当前模型估算":""}；它用于相对估算，不是 ChatGPT 账单。`;
    const model=String(last?.model||session?.model||"unknown").toLowerCase();
    const modelCalibration=current.calibration?.models?.[model];
    const evidenceText=(window,key)=>{const own=modelCalibration?.[key];return `${window}：全局 ${current.calibration?.[key]?.samples||0} 组（当前模型 ${own?.samples||0} 组，有效权重 ${Number(own?.effectiveSamples||0).toFixed(2)}）`;};
    $("confidence").textContent=`${evidenceText("5 小时","primary")}；${evidenceText("每周","secondary")}。${current.settings?.calibrationResetAt?`仅使用 ${new Date(current.settings.calibrationResetAt).toLocaleString()} 之后的数据。`:""}`;
    $("evidence-details").hidden=!evidenceOpen;
    $("evidence-toggle").textContent=evidenceOpen?"收起详情":"查看详情";
    const rows=Object.entries(current.calibration?.models||{}).sort((a,b)=>(b[1].primary?.effectiveSamples||0)-(a[1].primary?.effectiveSamples||0));
    $("evidence-body").replaceChildren(...rows.map(([name,value])=>{const row=document.createElement("tr");for(const text of [name,`${value.primary?.samples||0} / ${Number(value.primary?.effectiveSamples||0).toFixed(2)}`,coefficient(value.primary?.percentPerCostUnit),`${value.secondary?.samples||0} / ${Number(value.secondary?.effectiveSamples||0).toFixed(2)}`,coefficient(value.secondary?.percentPerCostUnit)]){const cell=document.createElement("td");cell.textContent=text;row.appendChild(cell);}return row;}));
    $("sidebar").checked=current.settings?.sidebar===true;
    $("turns").checked=current.settings?.turnBadges===true;
    $("budget-five").value=String(current.settings?.budgets?.primary??1);
    $("budget-week").value=String(current.settings?.budgets?.secondary??5);
    root.querySelector(".panel").hidden=!open;
    root.querySelector(".widget").setAttribute("aria-expanded",String(open));
    side.shadowRoot.querySelector(".badge").textContent=`5h余 ${remaining(limits.primary)} · 周余 ${remaining(limits.secondary)}`;
  }

  function placeMain() {
    if (host.parentElement!==document.body) document.body.appendChild(host);
    const composer=locateComposer();
    if (!composer) {host.hidden=true;window.__CODEX_USAGE_WIDGET_DEBUG__={status:"degraded",reason:"composer-not-found"};return;}
    if (watched!==composer.element) {sizeObserver.disconnect();watched=composer.element;sizeObserver.observe(watched);sizeObserver.observe(host);}
    const result=place({composerRect:composer.rect,controlRects:buttons(composer.element).map(rect),normalWidth:360,compactWidth:150,viewportWidth:innerWidth});
    if (!result.ok) {host.hidden=true;window.__CODEX_USAGE_WIDGET_DEBUG__={status:"degraded",reason:result.reason,composerStrategy:composer.strategy};return;}
    host.hidden=false;host.dataset.compact=String(result.compact);host.dataset.narrow=String(result.maxWidth<255);
    host.style.width=`${Math.floor(result.width)}px`;host.style.left=`${Math.round(result.left)}px`;
    const h=rect(host).height||28;
    host.style.top=`${Math.round(Math.max(8,Math.min(innerHeight-h-8,result.topCenter-h/2)))}px`;
    host.dataset.panelBelow=String(rect(host).top<Math.min(300,innerHeight*.75)+16);
    if (result.row.some((r)=>overlaps(rect(host),r))) {host.hidden=true;window.__CODEX_USAGE_WIDGET_DEBUG__={status:"degraded",reason:"control-collision"};return;}
    const panelWidth=Math.min(380,innerWidth-16);
    host.style.setProperty("--panel-left",`${Math.max(8-result.left,Math.min(0,innerWidth-8-result.left-panelWidth))}px`);
    window.__CODEX_USAGE_WIDGET_DEBUG__={status:"ready",composerStrategy:composer.strategy,availableWidth:result.maxWidth,compact:result.compact,lastPlacementAt:Date.now()};
  }

  function placeSidebar() {
    if (side.parentElement!==document.body) document.body.appendChild(side);
    side.hidden=true;
    if (!current.settings?.sidebar) return;
    const target=[...document.querySelectorAll("aside,nav,[role=navigation]")].filter(visible).map((element)=>({element,box:rect(element)}))
      .filter(({box})=>box.left<innerWidth*.2&&box.width>=120&&box.width<=innerWidth*.38&&box.height>=180).sort((a,b)=>b.box.height-a.box.height)[0];
    if (!target) return;
    const width=Math.min(230,target.box.width-16),left=target.box.left+8;
    const occupied=[...target.element.querySelectorAll("button,[role=button],a[href],input,[role=link],li,p")].filter(visible).map(rect);
    const textWalker=document.createTreeWalker(target.element,NodeFilter.SHOW_TEXT);
    let textNode,scanned=0;
    while ((textNode=textWalker.nextNode()) && scanned++<300) {
      if (compact(textNode.nodeValue) && visible(textNode.parentElement)) occupied.push(rect(textNode.parentElement));
    }
    for (let top=Math.min(target.box.bottom-38,innerHeight-36);top>=Math.max(target.box.top+10,8);top-=36) {
      const candidate={left,right:left+width,top,bottom:top+28};
      if (!occupied.some((button)=>overlaps(candidate,button))) {
        side.style.left=`${Math.round(left)}px`;side.style.top=`${Math.round(top)}px`;side.style.width=`${Math.floor(width)}px`;side.hidden=false;return;
      }
    }
  }

  function messageRect(message) {
    const mark=messageMarker(message);
    if (mark.length<16) return null;
    const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
    let node;
    while ((node=walker.nextNode())) {
      if (!compact(node.nodeValue).includes(mark.slice(0,36))) continue;
      let element=node.parentElement;
      for (let depth=0;element&&depth<6;depth++,element=element.parentElement) {
        const box=rect(element);
        if (compact(element.innerText).includes(mark)&&box.width>180&&box.height>15&&box.height<innerHeight*.8) return box;
      }
    }
    return null;
  }
  function turnHost(turn) {
    let item=turnHosts.get(turn.turnId);
    if (item) return item;
    item=document.createElement("span");item.dataset.cuoTurn=turn.turnId;item.style.cssText="position:fixed;z-index:900;pointer-events:none";
    item.attachShadow({mode:"open"}).innerHTML=`<style>:host([hidden]){display:none!important}.badge{display:block;padding:3px 7px;border:1px solid color-mix(in srgb,CanvasText 16%,transparent);border-radius:999px;background:Canvas;color:CanvasText;font:500 10px system-ui;white-space:nowrap}</style><span class="badge"></span>`;
    document.body.appendChild(item);turnHosts.set(turn.turnId,item);return item;
  }
  function placeTurns() {
    for (const item of turnHosts.values()) item.hidden=true;
    if (!current.settings?.turnBadges) return;
    for (const turn of (activeSession()?.turns||[]).slice(-30)) {
      const message=messageRect(turn.lastAssistantMessage);
      if (!message||message.bottom<0||message.top>innerHeight) continue;
      const row=[...document.querySelectorAll("button,[role=button]")].filter(visible).map(rect)
        .filter((r)=>r.top>=message.bottom-8&&r.top<=message.bottom+76&&r.left>=message.left-20&&r.right<=message.right+30).sort((a,b)=>a.left-b.left);
      if (!row.length) continue;
      const item=turnHost(turn);
      item.shadowRoot.querySelector(".badge").textContent=`本轮≈${pair(turn.quotaEstimate)}`;item.hidden=false;
      const box=rect(item),end=row.at(-1),left=end.right+8,top=end.top+(end.height-box.height)/2;
      const candidate={left,right:left+box.width,top,bottom:top+box.height};
      if (candidate.right>Math.min(innerWidth-8,message.right+30)||row.some((button)=>overlaps(candidate,button))) {item.hidden=true;continue;}
      item.style.left=`${Math.round(left)}px`;item.style.top=`${Math.round(top)}px`;
    }
  }

  function ensure() {scheduled=null;if (!document.body) return;data();placeMain();placeSidebar();placeTurns();}
  function schedule() {clearTimeout(scheduled);scheduled=setTimeout(ensure,120);}
  const sizeObserver=new ResizeObserver(schedule);
  const observer=new MutationObserver(schedule);
  observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:["class","aria-label","placeholder","data-placeholder","data-conversation-id","data-thread-id"]});
  const fallback=setInterval(()=>{if(!document.hidden)ensure();},20_000);
  const onScroll=()=>{if(!document.hidden)schedule();};
  const onPointer=(event)=>{if(open&&!event.composedPath().includes(host)){open=false;schedule();}};
  addEventListener("resize",schedule,{passive:true});document.addEventListener("scroll",onScroll,{capture:true,passive:true});document.addEventListener("visibilitychange",schedule);document.addEventListener("pointerdown",onPointer);
  root.querySelector(".widget").addEventListener("click",()=>{open=!open;schedule();});
  $("scope-last").addEventListener("click",()=>{detailScope="last";schedule();});
  $("scope-session").addEventListener("click",()=>{detailScope="session";schedule();});
  $("evidence-toggle").addEventListener("click",()=>{evidenceOpen=!evidenceOpen;schedule();});
  $("evidence-clear").addEventListener("click",()=>{
    if (!confirm("清空当前校准证据？会话和 token 记录仍会保留，之后的新轮次将重新拟合。")) return;
    try {window.__codexUsageSaveSettings?.(JSON.stringify({action:"clearCalibrationEvidence"}));} catch { /* CDP reconnects */ }
  });
  root.addEventListener("change",(event)=>{
    if (!event.target.matches("input")) return;
    const settings={sidebar:$("sidebar").checked,turnBadges:$("turns").checked,budgets:{primary:Number($("budget-five").value),secondary:Number($("budget-week").value)}};
    current.settings={...current.settings,...settings};
    try {window.__codexUsageSaveSettings?.(JSON.stringify({action:"updateSettings",settings}));} catch { /* CDP reconnects */ }
    schedule();
  });
  window.__codexUsageOverlayV2={version:4,update(next){current=next||{};schedule();},destroy(){clearTimeout(scheduled);clearInterval(fallback);observer.disconnect();sizeObserver.disconnect();removeEventListener("resize",schedule);document.removeEventListener("scroll",onScroll,true);document.removeEventListener("visibilitychange",schedule);document.removeEventListener("pointerdown",onPointer);host.remove();side.remove();for(const item of turnHosts.values())item.remove();delete window.__codexUsageOverlayV2;}};
  ensure();
}

const helpers=`(${toolbarPlacement.toString()}),(${intersects.toString()}),(${messageMarker.toString()})`;
const serialize=(state)=>JSON.stringify(state).replaceAll("<","\\u003c");
export function injectionSource(state) {return `(${bootstrap.toString()})(${serialize(state)},${helpers})`;}
export function updateSource(state) {const data=serialize(state);return `window.__codexUsageOverlay?.destroy();if(window.__codexUsageOverlayV2?.version!==4)window.__codexUsageOverlayV2?.destroy();window.__codexUsageOverlayV2?window.__codexUsageOverlayV2.update(${data}):(${bootstrap.toString()})(${data},${helpers})`;}
