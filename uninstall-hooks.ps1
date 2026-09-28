param(
    [string]$TargetHooksFile
)

$ErrorActionPreference = 'Stop'
$hooksFile = if ($TargetHooksFile) { $TargetHooksFile } else { Join-Path (Join-Path $env:USERPROFILE '.codex') 'hooks.json' }
if (-not (Test-Path -LiteralPath $hooksFile)) {
    Write-Host 'No hooks.json file exists.'
    exit 0
}

$configuration = Get-Content -Raw -LiteralPath $hooksFile | ConvertFrom-Json -AsHashtable
foreach ($eventName in @('Stop')) {
    if (-not $configuration.hooks.ContainsKey($eventName)) { continue }
    $kept = @()
    foreach ($entry in @($configuration.hooks[$eventName] | Where-Object { $null -ne $_ })) {
        $handlers = @($entry.hooks | Where-Object { $_.command -notlike '*codex-usage-overlay*hook-client.mjs*' })
        if ($handlers.Count -gt 0) {
            $entry.hooks = $handlers
            $kept += $entry
        }
    }
    if ($kept.Count -gt 0) { $configuration.hooks[$eventName] = $kept }
    else { $configuration.hooks.Remove($eventName) }
}
$configuration | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $hooksFile -Encoding utf8
Write-Host 'Removed Codex Usage Overlay hooks.'
