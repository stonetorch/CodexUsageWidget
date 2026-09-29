# 设计与实现说明

面向改代码的人。用户视角的用法见 [README](../README.md)。

## 概览

一个 `main.mjs` 进程是全部状态的中枢，它把三条数据链路汇进同一个 `StateStore`，再把快照推给注入到 Codex 渲染进程里的浮窗：

```
Stop Hook ─┐
转录补录  ─┼─→ StateStore (state.json) ─→ 浮窗快照 ─→ CDP evaluate ─→ Codex 渲染进程
App Server ┘                                    ←─ 设置回传（Runtime binding）─┘
```

- 三条链路互为冗余：Hook 最快，转录补录兜底，额度快照来自 App Server。
- 只有 `StateStore` 持有状态；浮窗是无状态渲染器，每次收到完整快照。
- 浮窗到宿主的唯一反向通道是设置（`__codexUsageSaveSettings` binding）。

## 模块职责

| 模块 | 职责 |
| --- | --- |
| `main.mjs` | 编排：实例互斥、目标发现与注入、状态推送、定时刷新、关停 |
| `config.mjs` | 路径（`%LOCALAPPDATA%\CodexUsageOverlay`）、默认端口、参数解析 |
| `cdp-client.mjs` | CDP 目标枚举、WebSocket 连接、`evaluate`/`request` |
| `app-server-client.mjs` | 启动 Codex App Server 子进程，`account/rateLimits/read` 与通知订阅 |
| `desktop-launcher.mjs` | MSIX 应用模型激活、AUMID 发现与缓存、Codex 是否在运行 |
| `widget-overlay.mjs` | 浮窗 DOM、样式、事件、注入源码、浮窗版本常量 |
| `placement.mjs` | 纯函数几何：在输入栏底部按钮行里找空隙、碰撞判定 |
| `transcript.mjs` | 解析会话转录，产出逐轮 token 与额度观测 |
| `transcript-recovery.mjs` | 定时扫描转录目录，补录缺失轮次与未完成轮次 |
| `quota-estimator.mjs` | 模型权重、参考成本、额度校准、对外 `usageView` |
| `state-store.mjs` | 状态持久化、设置合并、活动轮次、写入失败回滚 |
| `hook-installer.mjs` / `hook-client.mjs` / `hook-server.mjs` | Stop Hook 的安装、上报与接收 |

## 启动时序

1. 探测 `hookPort` 的 `/health`：已有实例就只唤出 Codex 窗口并退出，避免重复注入。
2. 枚举 CDP 目标。失败时按 `--attach` 报错、或按 Codex 是否在运行决定“只唤出窗口”还是冷启动并轮询等待（最多 120 × 250 ms）。
3. 安装 Stop Hook、写 `connection.json`（供外部脚本读取端口）。
4. 起 `StateStore`、转录补录、Hook server、App Server，随后读一次额度并每 60 秒刷新。
5. 每 2 秒重新发现目标并注入；`StateStore` 每次 `changed` 就向所有 client 推送快照。
6. `SIGINT`/`SIGTERM` 时依次关停补录、定时器、CDP 连接、Hook server、App Server。

## 注入与页面协同

- 每个目标连接后开 `Runtime.enable`、注册 `Runtime.addBinding("__codexUsageSaveSettings")`、尽力开 `Page.enable`。
- 设置回传走 binding：`Runtime.bindingCalled` 解析 JSON 命令，`updateSettings` 合并设置，`clearCalibrationEvidence` 写校准截止时间。
- 主框架 `Page.frameNavigated` 后延迟 250 ms 重新注入，处理页面重载。
- 非 Codex 目标会被主动执行 `destroy()` 清理（`cleanedTargets` 去重，避免每轮重复尝试）。
- 浮窗把 `window.__CODEX_USAGE_WIDGET_SESSION__.detectedSessionId` 暴露给宿主，`main.mjs` 每轮读取并用 UUID 校验，命中的会话在转录补录里获得优先扫描权——这就是“当前打开的页面即使转录超过 48 小时也不会漏”的实现方式。

## 浮窗版本与注入

`WIDGET_IMPLEMENTATION_VERSION` 与派生的 `WIDGET_DISPLAY_VERSION` 都在 `widget-overlay.mjs`。浮窗的标记、样式、辅助函数和事件处理器会被 `toString()` 序列化进注入表达式，所以：

- 页面里已有同版本浮窗时，`updateSource` 只调用 `update(data)` 刷新数据，保留旧 DOM；
- 版本不同时先 `destroy()` 再重新 `bootstrap`，旧 DOM 才会被替换。

任何界面改动都必须递增该常量，否则改动永远到不了已经注入过浮窗的页面。显示字符串不要手改，`test/widget-session.test.mjs` 断言它由常量派生。

## 输入栏定位

`placement.mjs` 是纯函数，输入 composer 矩形、控件矩形、视口宽度：

1. 只保留与 composer 水平相交、且中心落在 composer 高度 45% 以下的控件；
2. 取中心 Y 最大的一行（容差 `rowTolerance = 14px`），按左边界排序；
3. 在行内按钮之间切出空隙，左右各留 8px，并夹在视口 8px 边距内；
4. 丢弃窄于 `compactWidth = 150px` 的空隙，在剩余空隙里选最宽的一个；
5. 宽度取 `min(normalWidth, 空隙宽度)`；空隙更窄时置 `compact`，浮窗隐藏“上轮”字段。

返回 `no-controls` 或 `insufficient-width` 时浮窗隐藏，避免遮挡原生按钮。放置后还会用 `intersects` 做一次碰撞检查，命中则隐藏并报 `control-collision`。composer 本身用多候选选择器检测（`[data-testid^=composer-]`、`ComposerLayoutRoot` 等），失败时同样隐藏。

调试：`window.__CODEX_USAGE_WIDGET_DEBUG__` 给出 `status`（`ready`/`degraded`）、命中的 composer 策略、可用宽度、是否 compact 和最近一次定位时间。

## 数据链路细节

### Stop Hook

`hook-installer.mjs` 往 `~/.codex/hooks.json` 的 `Stop` 事件里追加一条 `runtime\node.exe runtime\src\hook-client.mjs`。`hook-server` 只接受 `POST /hook`，校验 `hook_event_name === "Stop"` 且带 `transcript_path`、`session_id`、`turn_id`；转录可能还在落盘，因此解析最多重试 6 次（`250ms × attempt` 退避）。**只有成功写入 state 才返回 200**，否则 422/500，让 Codex 侧能看出投递失败。

### 转录补录

`recoverRecentTranscripts` 每次扫描 `~/.codex/sessions`：

- 目录递归；文件需非空，且满足“48 小时内修改”或“命中已知/优先会话 ID”或“体积 ≤ 64 MB”；
- 优先会话与已知会话的文件全部处理，其余按修改时间取最近 200 个；
- 文件名含会话 ID 时把该 ID 关联到文件（子代理文件形如 `<sessionId>_<uuid>.jsonl`）；
- 每文件解析最近 200 个已完成轮次，并用 `(modified, size)` 签名跳过未变文件；
- 解析出的轮次与已有记录比较，`accountingVersion 2` 且用量、观测、完成时间都没变就跳过，否则重写——这样能升级旧版估算，也能刷新后来才落盘的记录。

活动轮次由 `parseActiveTranscriptFile` 识别，写进 `store.setActiveTurn`；本轮不再活跃时清除，浮窗据此在“上一轮消耗”和“本轮进行中”之间切换。

### 额度

`account/rateLimits/read` 的结果经 `normalizeRateLimitsResult` 归一化为 `primary`(5 小时) / `secondary`(每周) 两个窗口；`account/rateLimits/updated` 通知到达时立即覆盖。

## 额度估算

- 权重表 `MODEL_WEIGHTS` 用 OpenAI API 短上下文标准价格（每 1M token）作为相对权重，按模型名前缀匹配，未知模型回落到 `gpt-6-sol` 并标记 `known: false`。
- `weightedCost` 先把 cached 与 cacheWrite 各自夹在 input 之内，避免异常数据重复计数，再按 `(uncached·input + cached·cached + cacheWrite·cacheWrite + output·output) / 1e6` 求和。
- `quotaCalibration` 只用**同一轮内**的 `codex` 账户快照；按窗口 × 模型 × 重置周期分桶，用 30 分钟上限过滤异常区间、按 21 天半衰期衰减旧证据、丢弃并发/重置/回退观测；零增量区间同样计入成本；系数 = Σ增量 / Σ成本，需要同模型至少 2 个百分点的观测增量才产出 `calibrated`。
- 校准证据不足但本轮有连续快照时，退回 `observed-lower-bound`：取快照间已观测到的最低消耗比例，展示为“至少 x%”。
- 旧的 `budgets` 设置字段只为兼容保留，不参与任何计算。

## 启动器与 MSIX

Codex Desktop 以 MSIX 分发（包名 `OpenAI.Codex`），直接 `spawn` 包内 `ChatGPT.exe` 得到的进程没有程序包标识符，应用会拒绝启动，因此必须走应用模型激活：

- **已在运行时**：`cmd /c start shell:AppsFolder\<AUMID>`，约 0.1 秒，但传不了命令行；
- **需要冷启动并带调试端口时**：编译 `IApplicationActivationManager` 互操作（`Add-Type` + COM 调用），约 0.8 秒，开销被应用自身启动时间掩盖。

AUMID 靠 PowerShell 读包清单（约 1 秒）得到，缓存在 `aumid.txt`；激活失败说明缓存过期（包重装），删缓存重新查询。冷启动参数为 `--remote-debugging-port=<port> --remote-debugging-address=127.0.0.1`。

## 运行时目录与 Hook 信任

运行时目录固定为 `%LOCALAPPDATA%\CodexUsageOverlay\runtime`，不随构建改变：Codex 按 hook 命令的路径审核信任，每次重建都换目录会让用户反复确认，所以 Stop Hook 命令永远是 `runtime\node.exe` + `runtime\src\hook-client.mjs`。

启动器就地刷新文件：脚本按内容哈希比对，内置 Node 运行时只按大小比对（每次启动读取并哈希 80 MB 得不偿失）；运行中的实例占用 `node.exe` 时保留旧副本，下次启动再替换。更早版本按可执行文件哈希命名目录，残留会在下次启动时清理。

## 状态持久化

`state.json`（`version: 5`）保存 `limits`、`sessions` 和 `settings`：

- `sessions` 只保留最近更新的 100 个会话，每个会话最多 200 轮；
- 轮次记录带 `accountingVersion`：更高版本的账本即使时间戳更早也会替换旧累计（旧版的完成时间可能只是补录时间）；
- 写入失败时把内存状态回滚到上次成功持久化的快照，并记录 `persistenceError`，通过 `/health` 暴露——`recordTurn` 另外把被清掉的活动轮次放回去，避免丢状态。

## 测试与调试

`npm test` 按固定顺序跑全部 `test/*.test.mjs`（`node:assert/strict`，无测试框架），覆盖转录解析、补录、浮窗会话识别与版本派生、定位几何、额度校准、Hook 安装与服务、状态存储、启动器、构建脚本。

`test/demo-server.mjs` 起一个 mock 页面（`http://127.0.0.1:41737`），覆盖基本、侧栏、逐轮、窄窗口场景，可以在不启动 Codex 的情况下看浮窗。改完界面记得同时递增浮窗版本常量。

## 目录结构

```
src/          ESM 运行时（见上文模块职责表）
launcher/     .NET 8 单文件启动器：把内嵌的 Node 运行时与 src/*.mjs 解包到 runtime，再启动 Node 子进程并把输出写进 launcher.log（激活 Codex 在 Node 侧完成）
test/         断言测试与 mock 页面
doc/          本文件
*.ps1         Hook 安装/卸载、源码启动、打包
```
