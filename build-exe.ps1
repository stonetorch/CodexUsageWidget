$ErrorActionPreference = 'Stop'
# The launcher is only a shell around the bundled Node runtime, and the widget answers /health from
# that child. Stopping the shell alone orphans a widget that makes every later start exit as "usage
# widget is already running", so end the runtime child first and let the shell follow.
$runtimeNode = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'CodexUsageOverlay\runtime\node.exe'
function Get-WidgetRuntimeProcess {
  @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$runtimeNode*" -and $_.CommandLine -like '*main.mjs*' }
  )
}
foreach ($runtime in Get-WidgetRuntimeProcess) {
  try {
    Stop-Process -Id $runtime.ProcessId -Force -ErrorAction Stop
    Write-Host "Stopped widget runtime process $($runtime.ProcessId)."
  } catch {
    Write-Warning "Could not stop widget runtime process $($runtime.ProcessId); continuing the build: $($_.Exception.Message)"
  }
}
$survivors = Get-WidgetRuntimeProcess
for ($attempt = 0; $attempt -lt 20 -and $survivors; $attempt++) {
  Start-Sleep -Milliseconds 150
  $survivors = Get-WidgetRuntimeProcess
}
if ($survivors) {
  Write-Warning "Widget runtime processes $($survivors.ProcessId -join ', ') are still running; the next start would exit as 'already running'."
}
$runningWidgets = @(Get-Process -Name 'CodexUsageWidget' -ErrorAction SilentlyContinue)
foreach ($widget in $runningWidgets) {
  try {
    Stop-Process -Id $widget.Id -Force -ErrorAction Stop
    Write-Host "Stopped running CodexUsageWidget process $($widget.Id)."
  } catch {
    Write-Warning "Could not stop CodexUsageWidget process $($widget.Id); continuing the build: $($_.Exception.Message)"
  }
}
$projectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeExecutable = (Get-Command node -ErrorAction Stop).Source
$outputDirectory = Join-Path $projectDirectory 'dist'
dotnet publish (Join-Path $projectDirectory 'launcher\CodexUsageWidget.csproj') `
  --configuration Release `
  --runtime win-x64 `
  --output $outputDirectory `
  --self-contained true `
  --ignore-failed-sources `
  "-p:NodeExecutable=$nodeExecutable"
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed with exit code $LASTEXITCODE" }
$symbolsFile = Join-Path $outputDirectory 'CodexUsageWidget.pdb'
if (Test-Path -LiteralPath $symbolsFile) { Remove-Item -LiteralPath $symbolsFile }
Write-Host "Executable: $(Join-Path $outputDirectory 'CodexUsageWidget.exe')"
