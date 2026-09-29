# Codex Usage Widget（Windows）

双击 `dist/CodexUsageWidget.exe` 启动。EXE 内含 Node 运行时和项目脚本，首次运行会在 `%LOCALAPPDATA%\CodexUsageOverlay\runtime` 展开。无需单独安装 Node 或 .NET 运行时。

如果 Codex 已运行，启动器会再次调用官方应用以唤出窗口；若该进程本来就开放了本机 CDP 端口，Widget 会连接并显示。若已运行的 Codex 没有 CDP 端口，本次只唤出窗口。想显示 Widget，请从系统托盘完整退出 Codex，再双击 EXE，让启动器带 CDP 参数启动它。启动器保持在后台运行，日志在 `%LOCALAPPDATA%\CodexUsageOverlay\launcher.log`。

Widget 位于输入栏底部按钮之间。点击它会显示设置面板，包含：

- 5 小时与每周剩余额度；
- 当前会话历史累计和上一轮对两个额度窗口的消耗估算；说明性文字收进 ⓘ 小标记，悬停或长按可查看；
- 可单独开关的侧栏剩余额度、回复操作按钮旁的逐轮消耗；
- 估算证据详情；缺少当前轮次的 token 证据时显示“--”，有 token 但缺少模型估算数据时显示“无法估算”。
- 面板底部显示当前浮窗版本，便于确认已运行更新后的版本。

可选注入默认关闭；界面结构不匹配或空间不足时，相应标记会隐藏，避免遮挡原生按钮。可以在 DevTools 中查看 `window.__CODEX_USAGE_WIDGET_DEBUG__` 了解输入栏 Widget 的定位状态。

## 额度估算

剩余额度来自 Codex App Server 的 `account/rateLimits/read`。逐轮 Token 优先读取本地日志 `token_usage_record.turn_token_usage`；旧格式只在存在有效累计基线且计数未回退时求差。缺少基线时标为未知，避免把继承的历史累计量归到当前轮次。普通输入、缓存输入、缓存写入及输出按已有模型权重计算参考成本，权重参考 [OpenAI API 标准价格](https://developers.openai.com/api/docs/pricing)；这不是 ChatGPT 的额度账单。

额度校准只比较同一轮内部的 `codex` 账户快照，以相同区间的 Token 成本作为分母。零增量区间也计入成本；不同额度窗口、模型和重置周期分别分组，排除已知并发、额度重置、计数回退和时间范围异常的观测。系数按各组总增量 / 总成本计算，并按 21 天半衰期衰减旧证据。同模型至少积累 2 个百分点的观测增量且证据仍足够新鲜，才提供估算；账户快照仍可能取整、延迟或包含本机未记录的其它活动，因此显示“约”。

逐轮 Token 无法确认时，额度显示“--”；有可靠 Token 数据但模型未知或缺少同模型校准证据时，额度显示“无法估算”。Token 用量仍独立显示，已知价格的模型也继续显示参考费用。不再使用默认 API 费用预算换算额度，也不借用其它模型的系数。旧设置中的预算字段仅为兼容保留，不参与计算。会话累计表示**整个会话历史相当于完整额度窗口的比例**，不代表当前 5 小时/每周窗口已用额度。若会话总 Token 大于已记录逐轮 Token 之和，但已记录轮次均可验证，则显示这些轮次的累计估算，并在数值后显示 ⓘ 小标记，悬停可见“仅含已记录轮次，历史 token 未全部归属，实际累计可能更高”。未归属的历史 Token 不按固定缓存比例补算，完整会话的参考费用仍不提供。

首次运行会自动向 `~/.codex/hooks.json` 添加本项目的 Stop Hook，并在修改前备份。Codex 可能要求在应用内信任 Hook；未信任时仍可通过下述转录补录取得数据，但更新会稍慢。卸载可以运行 `uninstall-hooks.ps1`，或从 `hooks.json` 删除指向 `CodexUsageOverlay\runtime` 的 Stop Hook。

Widget 也会每 15 秒检查最近更新的本地会话记录，补录每个文件最近最多 200 个已完成轮次，并重新解析替换旧版用量记录；当前打开页面的会话 ID 会优先扫描，即使转录文件超过 48 小时也不会遗漏。未重新解析的旧版记录不用于额度估算。当前对话有未完成轮次时，浮窗改为显示本轮截至最近一次日志写入的消耗比例；轮次完成后恢复“上轮消耗”。同模型校准证据不足时，若本轮有连续额度快照，则显示快照间已观测到的最低消耗比例（“至少”）；连快照也不足时显示“无法估算”。这样即使 Hook 被跳过或投递失败，“上一轮消耗”仍可在记录落盘后更新。后台 `GET /health` 会给出已保存轮次数、最近一次 Hook 错误类型，以及 state 最近成功写入时间和写入错误；Hook 请求只有在成功写入后才返回成功。

## 从源码构建

Windows、Node.js 22+、.NET 8 SDK：

```powershell
npm test
.\build-exe.ps1
```

构建产物为单个 `dist/CodexUsageWidget.exe`。源码模式可运行 `start.ps1`。源码和打包模式都只监听本机回环地址；不要把 CDP 端口绑定到局域网。EXE 的图标是 `launcher/icon.ico`，取自已安装包里的 `app\resources\icon-chatgpt.ico`（同一目录下的 `chatgpt-app-*` 和 `chatgpt-tray-*` 是透明底的单色变体，只适合主题感知的场景，不适合给 EXE 用），由 csproj 的 `ApplicationIcon` 写入；官方换图标后重新复制即可。

## 实现与限制

输入栏定位采用多候选 Composer 检测、底部按钮按屏幕坐标分组、可用空隙计算、`body` 顶层 Shadow DOM 和固定定位。DOM、尺寸、窗口及滚动变化会触发重新定位。它依赖 Codex Desktop 当前 DOM，官方更新后仍可能需要更新定位器。

逐轮按钮旁标记必须找到对应回复文字和操作按钮行才会出现。当前版本没有在正在运行且未开启 CDP 的 Codex 进程中强行开启调试端口；这种情况下需要完整退出并由启动器重新启动。仓库内 mock 页面覆盖了基本、侧栏、逐轮、窄窗口场景。

Codex Desktop 以 MSIX 包分发，直接运行包内 `ChatGPT.exe` 得到的是没有程序包标识符的进程，应用会拒绝启动，启动器因此走应用模型激活；不要改回直接 `spawn` 可执行文件。

两条激活路径，因为冷启动要传调试端口、唤出窗口不用：已在运行时用 `cmd /c start shell:AppsFolder\<AUMID>` 唤出，约 0.1 秒；需要带 `--remote-debugging-port` 冷启动时才编译 `IApplicationActivationManager` 互操作并调用，约 0.8 秒，但这段开销被应用自身的启动时间掩盖。查询包清单拿 AUMID 要接近 1 秒，所以结果缓存在 `%LOCALAPPDATA%\CodexUsageOverlay\aumid.txt`；包重装导致标识符变化时，激活失败会自动丢弃缓存重新查询。已运行时双击 EXE 到窗口前置约 1 秒，其中约 0.4 秒是 EXE 自身的 .NET 单文件启动。

运行时目录固定为 `%LOCALAPPDATA%\CodexUsageOverlay\runtime`，不随构建改变。Codex 按 hook 命令的路径审核信任，如果每次重新构建都换目录，用户就要反复确认，Stop Hook 的命令因此始终是 `runtime\node.exe` 加 `runtime\src\hook-client.mjs`。启动器改为就地刷新文件：脚本按内容哈希比对，内置的 Node 运行时只按大小比对，因为每次启动都完整读取并哈希 80 MB 得不偿失；正在运行的实例占用 `node.exe` 时保留旧副本，下次启动再替换。更早的版本按可执行文件哈希命名目录，这些残留会在下次启动时清理。
