$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeCommand = Get-Command node -ErrorAction Stop
& $nodeCommand.Source (Join-Path $projectDirectory 'src\main.mjs')
