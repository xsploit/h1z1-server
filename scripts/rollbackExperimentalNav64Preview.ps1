param(
    [Parameter(Mandatory = $true)]
    [string]$QuickStartRoot,

    [Parameter(Mandatory = $true)]
    [string]$BackupRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$quickStart = (Resolve-Path -LiteralPath $QuickStartRoot).Path
$backup = (Resolve-Path -LiteralPath $BackupRoot).Path
$installed = Join-Path $quickStart 'node_modules\h1z1-server'
$manifestPath = Join-Path $backup 'rollback-manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Rollback manifest not found: $manifestPath"
}
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
if ([string]$manifest.quickStart -ne $quickStart) {
    throw 'Backup belongs to a different QuickStart installation.'
}

$inUse = @(Get-CimInstance Win32_Process | Where-Object {
        $commandLine = [string]$_.CommandLine
        $_.Name -like 'node*' -and
        -not [string]::IsNullOrWhiteSpace($commandLine) -and
        ($commandLine.IndexOf($quickStart, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
            $commandLine -match 'h1emu-2016\.js|h1z1-server-demo-2016')
    })
if ($inUse.Count -gt 0) {
    throw "Stop H1Emu before rollback. In-use Node PID(s): $($inUse.ProcessId -join ', ')"
}

Remove-Item -LiteralPath (Join-Path $installed 'out') -Recurse -Force
Copy-Item -LiteralPath (Join-Path $backup 'out') -Destination (Join-Path $installed 'out') -Recurse

$runtimeTarget = Join-Path $installed 'runtime\navigation64'
if (Test-Path -LiteralPath $runtimeTarget) {
    Remove-Item -LiteralPath $runtimeTarget -Recurse -Force
}
if (Test-Path -LiteralPath (Join-Path $backup 'runtime\navigation64')) {
    New-Item -ItemType Directory -Path (Join-Path $installed 'runtime') -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $backup 'runtime\navigation64') -Destination $runtimeTarget -Recurse
}

Copy-Item -LiteralPath (Join-Path $backup 'h1emu-2016.js') -Destination (Join-Path $quickStart 'h1emu-2016.js') -Force
$bootstrapTarget = Join-Path $quickStart 'experimental-nav64-bootstrap.js'
if (Test-Path -LiteralPath (Join-Path $backup 'experimental-nav64-bootstrap.js')) {
    Copy-Item -LiteralPath (Join-Path $backup 'experimental-nav64-bootstrap.js') -Destination $bootstrapTarget -Force
} elseif (Test-Path -LiteralPath $bootstrapTarget) {
    Remove-Item -LiteralPath $bootstrapTarget -Force
}

if ($manifest.createdNavigationData -eq $true) {
    foreach ($path in @(
            (Join-Path $installed 'data\2016\collision'),
            (Join-Path $installed 'data\2016\zoneData\heightmap.png'),
            (Join-Path $installed 'data\2016\navigationTransitions.json'),
            (Join-Path $installed 'data\2016\navigation-artifact-manifest.json')
        )) {
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }
    }
}

& node --check (Join-Path $quickStart 'h1emu-2016.js')
if ($LASTEXITCODE -ne 0) { throw 'Restored launcher failed syntax validation.' }

[pscustomobject]@{
    Status = 'Experimental navigation64 preview rolled back'
    QuickStart = $quickStart
    Backup = $backup
} | Format-List
