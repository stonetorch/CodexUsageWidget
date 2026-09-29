# Codex Usage Widget

A Windows overlay that shows your **5-hour / weekly remaining quota** and **per-turn token usage** right inside the Codex Desktop composer.

[简体中文](README.md) | **English**

Everything stays on your machine: the widget injects itself into the Codex renderer through a local CDP port and never sends data anywhere.

## Features

- A pill-shaped widget between the composer's bottom buttons, showing 5-hour and weekly remaining quota in real time;
- Click it to open a panel with remaining quota, session-to-date totals, last-turn usage, and a token breakdown (total tokens, output, uncached input, cached input, cache writes, cache hit rate, reference cost, model);
- Optional markers: remaining quota in the sidebar and a per-turn badge next to the reply action buttons. Both are off by default and never cover native controls;
- The estimates & settings page inside the panel exposes the calibration evidence, lets you clear it, and shows runtime status plus the overlay version;
- Explanatory text is tucked behind a small ⓘ marker; hover or long-press to read it.

## Getting started

Double-click `dist/CodexUsageWidget.exe` (see [Building from source](#building-from-source) to build it yourself). The EXE bundles the Node runtime and the project scripts, unpacking them to `%LOCALAPPDATA%\CodexUsageOverlay\runtime` on first run, so **no separate Node or .NET runtime install is required**.

The launcher picks a path based on the current state of Codex:

| Codex before launch | What happens |
| --- | --- |
| Not running | The launcher cold-starts Codex with a loopback CDP port and injects the widget |
| Running with a loopback CDP port open | It connects to that process and shows the widget |
| Running without a CDP port | This run only brings the window to the front. To get the widget, fully exit Codex from the system tray and double-click the EXE again |

The launcher keeps running in the background; its log is at `%LOCALAPPDATA%\CodexUsageOverlay\launcher.log`. On first run it adds this project's Stop hook to `~/.codex/hooks.json`, backing the file up first. Codex may ask you to trust the hook in-app; if you don't, data still arrives through transcript recovery, just a little later.

Both the CDP and hook ports bind to loopback only. For runtime status, `GET http://127.0.0.1:47839/health` reports saved turn count, the last hook error type, and when state was last written successfully, plus any write error.

## Where the data comes from

| Data | Source |
| --- | --- |
| 5-hour / weekly remaining quota | `account/rateLimits/read` from the Codex App Server, refreshed every 60 seconds and immediately on `account/rateLimits/updated` notifications |
| Per-turn tokens | The local log's `token_usage_record.turn_token_usage`; the legacy format is only diffed when a valid cumulative baseline exists and the counter has not gone backwards |
| Missing turns | Every 15 seconds the newest local session files are scanned, recovering up to the last 200 completed turns per file and re-parsing older usage records |

A turn without a baseline is marked unknown, so inherited history is never attributed to the current turn. The session ID of the page you are looking at is scanned first, so its transcript is recovered even when the file is older than 48 hours. Legacy records that were never re-parsed are excluded from quota estimation.

While the current conversation has an unfinished turn, the widget shows that turn's usage as of the latest log write; once the turn completes it goes back to "last turn". That way last-turn usage updates after the record lands even if the hook is skipped or its delivery fails — a hook request only reports success once the write succeeded.

## Quota estimation

The remaining quota comes straight from Codex and is exact; the estimate answers "how much quota did this turn roughly consume". It **back-solves a per-model conversion coefficient from quota snapshots taken inside the same turn** rather than applying a guessed fixed budget, falls back to "at least x%" and then "cannot estimate" when evidence is thin, and never borrows another model's coefficient.

The full rules, what each display state means (`--`, cannot estimate, at least x%, approximately), and the implementation are in **[doc/quota-estimation.md](doc/quota-estimation.md)** (Chinese).

## Troubleshooting

- The widget doesn't show up: make sure Codex wasn't already running without a CDP port when you launched (see the table above), and check `%LOCALAPPDATA%\CodexUsageOverlay\launcher.log`; `GET /health` shows whether the data pipeline is writing.
- To check whether the widget hid itself: in DevTools, `window.__CODEX_USAGE_WIDGET_DEBUG__` reports `status: "degraded"` along with the reason (composer not found, no usable gap, collision with a native control).

## Uninstalling

1. Run `uninstall-hooks.ps1`, or delete the Stop hook pointing at `CodexUsageOverlay\runtime` from `~/.codex/hooks.json` (the script backs the file up to `.bak` before editing);
2. For a clean sweep, delete `%LOCALAPPDATA%\CodexUsageOverlay`, which holds the runtime, `state.json`, logs, and the cached AUMID.

## Building from source

Requires Windows, Node.js 22+, and the .NET 8 SDK:

```powershell
npm test
.\build-exe.ps1
```

The build produces a single `dist/CodexUsageWidget.exe`. For development you can run the source directly:

```powershell
npm start          # source mode; launches Codex when needed and injects the widget
npm run attach     # attach to an already running Codex that has an open CDP port
.\start.ps1        # PowerShell convenience wrapper for the above
node test/demo-server.mjs   # preview the widget at http://127.0.0.1:41737 without Codex
```

Source mode and the packaged build both listen on loopback only; never bind the CDP port to the LAN. The EXE icon comes from `icon-chatgpt.ico` in the installed Codex package; copy it over `launcher/icon.ico` and rebuild after the official icon changes.

## Known limits

The widget depends on the current Codex Desktop DOM, so an official UI update may break it until the locators are updated. Codex already running without a CDP port needs a full exit and restart before the widget can be injected. When the structure doesn't match or there is too little space, the widget and its markers hide instead of covering native buttons.

The full list and the reasons behind each are in **[doc/limits.md](doc/limits.md)** (Chinese).

## More documentation

The design documents are Chinese-only.

| Document | Contents |
| --- | --- |
| [doc/quota-estimation.md](doc/quota-estimation.md) | Quota estimation: back-solving approach, display rules, session-total semantics, implementation |
| [doc/limits.md](doc/limits.md) | Known limits: UI dependence, launch requirements, data completeness |
| [doc/implementation.md](doc/implementation.md) | Design and implementation: data flow, modules, injection and settings bridge, composer placement, launcher and MSIX, runtime directory, state persistence |
