import { toolbarPlacement, intersects } from "./placement.mjs";

function bootstrap(state, place, overlaps) {
  if (window.__codexUsageOverlayV2) { window.__codexUsageOverlayV2.update(state); return; }
  let current = state || {};
  let preferred = null;
  let watched = null;
  let open = false;
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
    .panel{position:absolute;bottom:calc(100% + 8px);left:var(--panel-left,0px);width:300px;max-width:calc(100vw - 16px);max-height:75vh;overflow:auto;padding:14px;border:1px solid color-mix(in srgb,CanvasText 24%,transparent);border-radius:12px;background:Canvas;color:CanvasText;box-shadow:0 12px 32px #0005;font:12px/1.5 system-ui,'Segoe UI',sans-serif;pointer-events:auto}
    :host([data-panel-below=true]) .panel{top:calc(100% + 8px);bottom:auto}
    .panel[hidden]{display:none}.panel h2{font-size:14px;margin:0 0 8px}.panel p{margin:6px 0}.panel fieldset{border:0;border-top:1px solid color-mix(in srgb,CanvasText 16%,transparent);padding:6px 0;margin:8px 0 0}.panel label{display:flex;align-items:center;gap:6px;margin:6px 0}.panel input[type=number]{width:65px;background:Canvas;color:CanvasText;border:1px solid color-mix(in srgb,CanvasText 35%,transparent);border-radius:4px;padding:2px}.hint{opacity:.7}
  </style><button class="widget" aria-expanded="false"><span id="five">5h --</span><span>·</span><span id="week">周 --</span><span>·</span><span class="last" id="last">上轮 --</span><span class="gear">⚙</span></button>
  <section class="panel" hidden><h2>用量与设置</h2><p id="remaining"></p><p id="session"></p><p id="previous"></p><p class="hint" id="confidence"></p>
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
  const messageMarker = (value) => compact(String(value||"").replace(/!\[[^\]]*\]\([^)]*\)/g," ").replace(/\[([^\]]+)\]\([^)]*\)/g,"$1").replace(/[`*_>#~|]/g," ")).slice(0,72);

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
    $("confidence").textContent=`估算依据：5 小时 ${current.calibration?.primary?.source==="observed"?`已校准 ${current.calibration.primary.samples} 次`:"粗估"}；每周 ${current.calibration?.secondary?.source==="observed"?`已校准 ${current.calibration.secondary.samples} 次`:"粗估"}。额度与 API 账单并非同一计量。`;
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
    const panelWidth=Math.min(300,innerWidth-16);
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
  root.addEventListener("change",(event)=>{
    if (!event.target.matches("input")) return;
    const settings={sidebar:$("sidebar").checked,turnBadges:$("turns").checked,budgets:{primary:Number($("budget-five").value),secondary:Number($("budget-week").value)}};
    current.settings=settings;
    try {window.__codexUsageSaveSettings?.(JSON.stringify(settings));} catch { /* CDP reconnects */ }
    schedule();
  });
  window.__codexUsageOverlayV2={update(next){current=next||{};schedule();},destroy(){clearTimeout(scheduled);clearInterval(fallback);observer.disconnect();sizeObserver.disconnect();removeEventListener("resize",schedule);document.removeEventListener("scroll",onScroll,true);document.removeEventListener("visibilitychange",schedule);document.removeEventListener("pointerdown",onPointer);host.remove();side.remove();for(const item of turnHosts.values())item.remove();delete window.__codexUsageOverlayV2;}};
  ensure();
}

const helpers=`(${toolbarPlacement.toString()}),(${intersects.toString()})`;
const serialize=(state)=>JSON.stringify(state).replaceAll("<","\\u003c");
export function injectionSource(state) {return `(${bootstrap.toString()})(${serialize(state)},${helpers})`;}
export function updateSource(state) {const data=serialize(state);return `window.__codexUsageOverlay?.destroy();window.__codexUsageOverlayV2?window.__codexUsageOverlayV2.update(${data}):(${bootstrap.toString()})(${data},${helpers})`;}
