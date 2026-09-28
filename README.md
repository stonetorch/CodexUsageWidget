# Codex Usage Overlay

在 Windows Codex/ChatGPT 桌面应用的页面 DOM 中显示：

- 输入栏附近的 5 小时额度和每周额度；
- 当前对话累计 Token；
- 每次完整模型回复的 Token 消耗；
- 如果额度百分比在该轮发生可观察变化，同时显示该轮的近似百分比消耗。

它不会修改 Microsoft Store 的 MSIX 或 `app.asar`。启动器通过仅监听 `127.0.0.1` 的 Chromium DevTools Protocol 注入 UI，额度数据通过 Codex App Server 读取。

## 精度

每轮 Token 来自 Codex 当前会话记录中的累计 Token 计数差值，包括该轮的多次模型调用，因此比按照文字长度估算更准确。徽标的悬停提示会分别列出输入、缓存输入和输出 Token。

额度百分比来自服务端窗口数据，通常只有有限精度，并可能延迟更新；所以它始终标记为“约”。如果百分比在一轮内没有变化，就只显示精确 Token，不显示 `0%`。

Codex 官方说明 transcript 格式不是稳定 Hook API。解析器无法识别未来格式时会停止显示该轮数据，不会编造数值；剩余额度仍可独立工作。

## 安装

要求：Windows、Node.js 22 或更高版本、已登录的 Codex 桌面应用。

1. 在 PowerShell 中运行：

   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass
   .\install-hooks.ps1
   ```

2. Codex 弹出 Hook 审核时，确认命令路径属于本项目后选择信任。
3. 从系统托盘彻底退出 ChatGPT/Codex。仅关闭窗口通常仍有后台进程。
4. 运行：

   ```powershell
   .\start.ps1
   ```

启动器将重新打开官方应用并注入额度条。保持该 PowerShell 窗口运行。停止注入器不会退出 Codex，但下次刷新页面后注入内容会消失。

## 卸载

运行：

```powershell
.\uninstall-hooks.ps1
```

随后退出注入器并正常重启 Codex。运行数据位于 `%LOCALAPPDATA%\CodexUsageOverlay`，可在注入器退出后自行删除。

## 故障处理

- `already running without DOM debugging`：从托盘退出应用，确认任务管理器中没有 `ChatGPT.exe`，再运行 `start.ps1`。
- 顶部显示“额度读取中”：确认 Codex 使用 ChatGPT 账户登录；API Key-only 登录不一定提供 ChatGPT 额度窗口。
- 额度条显示但回复徽标没有出现：确认 Stop Hook 已获信任，并完成一轮新的对话。历史回复不会自动批量回填。
- 官方更新后位置错误：输入框定位采用可见 textbox 启发式；先重启注入器。如果 DOM 结构发生较大变化，需要更新 `src/dom-overlay.mjs` 中的定位规则。

## 数据与安全

- 调试端口和 Hook 接收端口仅绑定本机回环地址。
- 不读取或保存登录令牌。
- 本地状态仅保存会话 ID、模型、Token 数、额度变化和最后一条回复文本，用于把徽标匹配到可见回复。
- 不应把调试端口绑定到局域网地址。
