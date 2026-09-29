import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../build-exe.ps1", import.meta.url), "utf8");

test("build script attempts to stop a running widget but continues after a stop failure", () => {
  assert.match(source, /Get-Process -Name 'CodexUsageWidget' -ErrorAction SilentlyContinue/);
  assert.match(source, /Stop-Process -Id \$widget\.Id -Force -ErrorAction Stop/);
  assert.match(source, /catch \{\s+Write-Warning "Could not stop CodexUsageWidget process/);
  assert.ok(source.indexOf("Stop-Process") < source.indexOf("dotnet publish"));
  assert.ok(source.indexOf("continuing the build") < source.indexOf("dotnet publish"));
});

test("build script ends the widget's Node runtime so the next start is not treated as a duplicate", () => {
  assert.match(source, /Get-CimInstance Win32_Process -Filter "Name='node\.exe'"/);
  assert.match(source, /\$_\.CommandLine -like "\*\$runtimeNode\*" -and \$_\.CommandLine -like '\*main\.mjs\*'/);
  assert.match(source, /Stop-Process -Id \$runtime\.ProcessId -Force -ErrorAction Stop/);
  assert.match(source, /are still running; the next start would exit as 'already running'/);
  // The runtime child holds the health endpoint the next launch probes, so it has to go before the shell.
  assert.ok(source.indexOf("Stop-Process -Id $runtime.ProcessId") < source.indexOf("Get-Process -Name 'CodexUsageWidget'"));
  assert.ok(source.indexOf("Stop-Process -Id $runtime.ProcessId") < source.indexOf("dotnet publish"));
});
