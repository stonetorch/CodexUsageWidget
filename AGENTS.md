# Repository Guidelines

## Project Structure & Module Organization

`src/` contains the ESM runtime: CDP/app clients, DOM widget, quota estimation, persisted state, and hook server. Keep each module focused on one boundary or responsibility. `test/` mirrors these areas with executable `*.test.mjs` scripts. `launcher/` is the .NET 8 Windows launcher. Root PowerShell scripts install hooks, start source mode, and build or uninstall the application. `dist/` and `output/` are generated and ignored.

## Build, Test, and Development Commands

- `npm test` runs every Node assertion test in the project-defined order; run it before submitting JavaScript changes.
- `npm start` runs `src/main.mjs` in source mode.
- `npm run attach` starts source mode and attaches to an already running Codex instance.
- `./start.ps1` is the Windows convenience launcher for source development.
- `./build-exe.ps1` packages `dist/CodexUsageWidget.exe`; it requires Windows, Node.js 22+, and the .NET 8 SDK.

The application deliberately uses loopback-only local services. Keep CDP and hook endpoints local; do not introduce LAN-facing bindings or commit local runtime data.

## Widget Versioning

`WIDGET_IMPLEMENTATION_VERSION` lives in `src/widget-overlay.mjs` (paired with the derived `WIDGET_DISPLAY_VERSION` on the following line, shown at the bottom of the panel). It is the only place this number is stored: the launcher has no version field, and `package.json`'s `version` is the product version, unrelated to overlay staleness. The bootstrap markup, styles, and handlers are serialized into the injected expression, so a page that already carries the same version only refreshes its data and keeps the old DOM. Increment the constant for any change to the widget's markup, styles, injected helpers, or event handlers — otherwise the change never reaches pages that already have the overlay. Never edit the display string by hand; `test/widget-session.test.mjs` asserts it derives from the constant.

## Completion & Rebuild Handoff

After completing a change that affects the packaged application or runtime, tell the user to run `./build-exe.ps1` and restart the application to pick it up. Leave that rebuild and restart for the user to perform; do not start either automatically.

## Coding Style & Naming Conventions

Use ESM (`.mjs`) and Node built-ins where possible. Match the existing style: two-space indentation, double-quoted strings, semicolons, `camelCase` functions and variables, and `UPPER_SNAKE_CASE` constants. Name modules by responsibility with kebab-case filenames, for example `quota-estimator.mjs` and `hook-server.mjs`. Prefer small exported functions with explicit validation at external boundaries. No formatter or linter is configured, so preserve nearby formatting and avoid unrelated rewrites.

## Testing Guidelines

Tests use `node:assert/strict` and run directly with Node. Add or extend `test/<area>.test.mjs` when behavior changes, with clear normal and edge-case assertions. Add new files to the `test` script. For UI-facing work, retain deterministic geometry/session cases and manually verify the widget after rebuilding when practical.

## Commit & Pull Request Guidelines

Recent history favors concise, imperative subjects, often `feat(scope): summary` (for example, `feat(quota): add Terra and Luna model weights`); plain imperative summaries are also used. Keep commits narrow. Pull requests should include the behavioral change, test result, linked issue when available, and screenshots for visible widget or settings changes. Call out hook, launcher, port, or packaging changes because they affect local installation and trust.
