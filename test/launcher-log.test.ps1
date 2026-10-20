param([string]$SourcePath, [string]$TestDirectory)
$ErrorActionPreference = 'Stop'
Add-Type -Path $SourcePath

$primaryPath = Join-Path $TestDirectory 'launcher.log'
$normal = [LauncherLog]::Open($TestDirectory)
try { $normal.WriteLine('normal startup') } finally { $normal.Dispose() }
if ((Get-Content -LiteralPath $primaryPath -Raw) -notmatch 'normal startup') { throw 'Primary log was not written' }

# Match the old launcher's sharing mode: readers are allowed, other writers fail.
$held = [System.IO.File]::Open($primaryPath, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
try {
    $first = [LauncherLog]::Open($TestDirectory)
    $second = [LauncherLog]::Open($TestDirectory)
    try {
        $first.WriteLine('first fallback startup')
        $second.WriteLine('second fallback startup')
    } finally { $first.Dispose(); $second.Dispose() }
} finally { $held.Dispose() }
$fallbacks = @(Get-ChildItem -LiteralPath $TestDirectory -Filter 'launcher-*.log')
if ($fallbacks.Count -ne 2) { throw 'Concurrent launches did not get separate fallback logs' }
$contents = ($fallbacks | ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw }) -join "`n"
if ($contents -notmatch 'first fallback startup' -or $contents -notmatch 'second fallback startup') { throw 'Fallback output was lost' }
if ((Get-Content -LiteralPath $primaryPath -Raw).Trim() -ne 'normal startup') { throw 'Locked primary log was modified' }

# A file in place of the directory makes both candidate paths unavailable.
$blocked = Join-Path $TestDirectory 'blocked'
Set-Content -LiteralPath $blocked -Value 'not a directory'
$unavailable = [LauncherLog]::Open($blocked)
if (-not [object]::ReferenceEquals($unavailable, [System.IO.TextWriter]::Null)) { throw 'Unavailable logs should use the null writer' }
$unavailable.WriteLine('startup can continue without a log')
$unavailable.Dispose()
Write-Output 'launcher log: ok (primary, locked log, concurrent fallbacks, unavailable directory)'
