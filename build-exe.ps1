$ErrorActionPreference = 'Stop'
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
