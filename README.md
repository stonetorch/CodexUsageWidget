# Codex Usage Widget（Windows）

双击 `dist/CodexUsageWidget.exe` 启动。EXE 内含 Node 运行时和项目脚本，首次运行会在 `%LOCALAPPDATA%\CodexUsageOverlay\runtime` 展开。无需单独安装 Node 或 .NET 运行时。

如果 Codex 已运行，启动器会再次调用官方应用以唤出窗口；若该进程本来就开放了本机 CDP 端口，Widget 会连接并显示。若已运行的 Codex 没有 CDP 端口，本次只唤出窗口。想显示 Widget，请从系统托盘完整退出 Codex，再双击 EXE，让启动器带 CDP 参数启动它。启动器保持在后台运行，日志在 `%LOCALAPPDATA%\CodexUsageOverlay\launcher.log`。

Widget 位于输入栏底部按钮之间。点击它会显示设置面板，包含：

- 5 小时与每周剩余额度；
- 当前会话和上一轮对两个额度窗口的消耗估算；
- 可单独开关的侧栏剩余额度、回复操作按钮旁的逐轮消耗；
- 无观测样本时的粗估预算。

可选注入默认关闭；界面结构不匹配或空间不足时，相应标记会隐藏，避免遮挡原生按钮。可以在 DevTools 中查看 `window.__CODEX_USAGE_WIDGET_DEBUG__` 了解输入栏 Widget 的定位状态。

## 额度估算

剩余额度来自 Codex App Server 的 `account/rateLimits/read`。逐轮 Token 数由 Stop Hook 对本地会话记录中的累计计数求差。估算将普通输入、缓存输入、缓存写入及输出按模型分别加权；模型权重取自 [OpenAI API 标准价格](https://developers.openai.com/api/docs/pricing)，仅用于相对成本比较。ChatGPT 的 5 小时和每周额度并不是 API 美元账单。

如果某轮的额度窗口实际变化可观测，程序会用这类样本分别校准两个窗口的“加权单位 → 百分比”比例；没有样本时使用设置面板中的粗估预算。百分比受服务端取整、异步更新、其它任务并发使用、模型改价和长上下文计价影响，始终显示“约”或“≈”。当前会话若有安装 Widget 之前的轮次，其成本只能用剩余 Token 和当前模型粗估。

首次运行会自动向 `~/.codex/hooks.json` 添加本项目的 Stop Hook，并在修改前备份。Codex 可能要求在应用内信任 Hook；在信任之前，“上一轮消耗”没有新数据。卸载可以运行 `uninstall-hooks.ps1`，或从 `hooks.json` 删除指向 `CodexUsageOverlay\runtime` 的 Stop Hook。

## 从源码构建

Windows、Node.js 22+、.NET 8 SDK：

```powershell
npm test
.\build-exe.ps1
```

构建产物为单个 `dist/CodexUsageWidget.exe`。源码模式可运行 `start.ps1`。源码和打包模式都只监听本机回环地址；不要把 CDP 端口绑定到局域网。

## 实现与限制

输入栏定位采用多候选 Composer 检测、底部按钮按屏幕坐标分组、可用空隙计算、`body` 顶层 Shadow DOM 和固定定位。DOM、尺寸、窗口及滚动变化会触发重新定位。它依赖 Codex Desktop 当前 DOM，官方更新后仍可能需要更新定位器。

逐轮按钮旁标记必须找到对应回复文字和操作按钮行才会出现。当前版本没有在正在运行且未开启 CDP 的 Codex 进程中强行开启调试端口；这种情况下需要完整退出并由启动器重新启动。仓库内 mock 页面覆盖了基本、侧栏、逐轮、窄窗口场景。

Codex Desktop 以 MSIX 包分发，直接运行包内 `ChatGPT.exe` 得到的是没有程序包标识符的进程，应用会拒绝启动。启动器因此通过 `IApplicationActivationManager` 激活 `OpenAI.Codex_2p2nqsd0c76g0!App`，调试端口参数由激活接口转交；不要改回直接 `spawn` 可执行文件。
