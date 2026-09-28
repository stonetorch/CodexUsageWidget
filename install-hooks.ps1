param(
    [string]$TargetHooksFile
)

$ErrorActionPreference = 'Stop'

$projectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$hookClient = Join-Path $projectDirectory 'src\hook-client.mjs'
$nodeExecutable = (Get-Command node -ErrorAction Stop).Source
$codexDirectory = Join-Path $env:USERPROFILE '.codex'
$hooksFile = if ($TargetHooksFile) { $TargetHooksFile } else { Join-Path $codexDirectory 'hooks.json' }
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'

if (-not (Test-Path -LiteralPath (Split-Path -Parent $hooksFile))) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $hooksFile) | Out-Null
}

if (Test-Path -LiteralPath $hooksFile) {
    Copy-Item -LiteralPath $hooksFile -Destination "$hooksFile.$timestamp.bak"
    $configuration = Get-Content -Raw -LiteralPath $hooksFile | ConvertFrom-Json -AsHashtable
} else {
    $configuration = @{ hooks = @{} }
}

if (-not $configuration.ContainsKey('hooks')) {
    $configuration.hooks = @{}
}

$escapedNode = $nodeExecutable.Replace('"', '\"')
$escapedHook = $hookClient.Replace('"', '\"')
$command = '"{0}" "{1}"' -f $escapedNode, $escapedHook
$handler = @{
    type = 'command'
    command = $command
    async = $true
    timeout = 15
}

foreach ($eventName in @('Stop')) {
    $existing = @($configuration.hooks[$eventName] | Where-Object { $null -ne $_ })
    $alreadyInstalled = $false
    foreach ($entry in $existing) {
        foreach ($installedHandler in @($entry.hooks)) {
            if ($installedHandler.command -like '*codex-usage-overlay*hook-client.mjs*') {
                $alreadyInstalled = $true
            }
        }
    }
    if (-not $alreadyInstalled) {
        $configuration.hooks[$eventName] = @($existing) + @(@{ hooks = @($handler) })
    }
}

$json = $configuration | ConvertTo-Json -Depth 20
Set-Content -LiteralPath $hooksFile -Value $json -Encoding utf8
Write-Host "Installed Codex Usage Overlay Stop hook in $hooksFile"
Write-Host 'Codex will ask you to review and trust the new hook definition.'
