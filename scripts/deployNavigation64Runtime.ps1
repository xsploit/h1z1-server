param(
    [Parameter(Mandatory = $true)]
    [string]$QuickStartRoot,

    [Parameter(Mandatory = $true)]
    [string]$RuntimeBundleSourceRoot,

    [Alias('DryRun', 'List')]
    [switch]$Plan
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Import-Module (Join-Path $PSScriptRoot 'NavigationDeployment.psm1') -Force

$sourceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$tsxCli = Join-Path $sourceRoot 'node_modules\tsx\dist\cli.mjs'
$quickStart = (Resolve-Path -LiteralPath $QuickStartRoot).Path
$bundleRoot = (Resolve-Path -LiteralPath $RuntimeBundleSourceRoot).Path
$installed = Join-Path $quickStart 'node_modules\h1z1-server'
$runtimeRelativePaths = @(
    'runtime\navigation64\core.mjs'
    'runtime\navigation64\wasm-compat.mjs'
    'runtime\navigation64\runtime-manifest.json'
)

function Assert-QuickStartIdle {
    $processes = @(Get-CimInstance Win32_Process)
    $hiddenNodeProcesses = @($processes | Where-Object {
            $_.Name -like 'node*' -and
            [string]::IsNullOrWhiteSpace([string]$_.CommandLine)
        })
    if ($hiddenNodeProcesses.Count -gt 0) {
        throw "Cannot prove the installed server is stopped because Node command lines are unavailable for PID(s): $($hiddenNodeProcesses.ProcessId -join ', ')"
    }
    $inUse = @($processes | Where-Object {
            $commandLine = [string]$_.CommandLine
            -not [string]::IsNullOrWhiteSpace($commandLine) -and
            (($_.Name -like 'node*' -and
                    ($commandLine.IndexOf(
                            $installed,
                            [System.StringComparison]::OrdinalIgnoreCase
                        ) -ge 0 -or
                        $commandLine.IndexOf(
                            $quickStart,
                            [System.StringComparison]::OrdinalIgnoreCase
                        ) -ge 0)) -or
                $commandLine -match 'h1emu-2016\.js|h1z1-server-demo-2016')
        })
    if ($inUse.Count -gt 0) {
        throw "The installed server is in use by PID(s): $($inUse.ProcessId -join ', ')"
    }
}

if (-not (Test-Path -LiteralPath $installed -PathType Container)) {
    throw "Installed h1z1-server was not found: $installed"
}
$installedPrefix = [System.IO.Path]::GetFullPath($installed).TrimEnd('\', '/') + '\'
if ($bundleRoot -eq $installed -or
    $bundleRoot.StartsWith($installedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'RuntimeBundleSourceRoot must be staged outside the installed server.'
}

if (-not (Test-Path -LiteralPath $tsxCli -PathType Leaf)) {
    throw "This checkout's tsx runtime was not found: $tsxCli"
}
& node $tsxCli (Join-Path $sourceRoot 'scripts\verifyNavigation64Runtime.ts') `
    --runtime-root (Join-Path $bundleRoot 'runtime\navigation64')
if ($LASTEXITCODE -ne 0) {
    throw 'Staged navigation 64-bit runtime verification failed.'
}

$planRecords = foreach ($relativePath in $runtimeRelativePaths) {
    $sourcePath = Join-Path $bundleRoot $relativePath
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "Packaged runtime file is missing: $sourcePath"
    }
    $destinationPath = Join-Path $installed $relativePath
    [pscustomobject]@{
        RelativePath = $relativePath
        Action       = if (Test-Path -LiteralPath $destinationPath -PathType Leaf) {
            'Replace'
        } else {
            'Create'
        }
        Bytes        = (Get-Item -LiteralPath $sourcePath).Length
        Sha256       = Get-NavigationFileSha256 -Path $sourcePath
        Destination  = $destinationPath
    }
}

if ($Plan) {
    $planRecords
    [pscustomobject]@{
        Status      = 'Navigation 64-bit runtime deployment plan; no files changed'
        Installed   = $installed
        BundleRoot  = $bundleRoot
        RuntimeRoot = Join-Path $installed 'runtime\navigation64'
        FileCount   = $runtimeRelativePaths.Count
    } | Format-List
    return
}

Assert-QuickStartIdle

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupRoot = Join-Path $quickStart "backups\navigation64-runtime-$stamp"
$stageRoot = Join-Path $quickStart (
    "backups\.navigation64-stage-$stamp-$([guid]::NewGuid().ToString('N'))"
)

try {
    New-NavigationDeploymentStage `
        -SourceRoot $bundleRoot `
        -StageRoot $stageRoot `
        -RelativePaths $runtimeRelativePaths

    $postReplaceValidation = {
        & node $tsxCli (Join-Path $sourceRoot 'scripts\verifyNavigation64Runtime.ts') `
            --runtime-root (Join-Path $installed 'runtime\navigation64')
        if ($LASTEXITCODE -ne 0) {
            throw 'Installed navigation 64-bit runtime verification failed.'
        }
    }.GetNewClosure()

    Assert-QuickStartIdle
    $null = Invoke-NavigationRuntimeReplacement `
        -SourceRoot $bundleRoot `
        -StageRoot $stageRoot `
        -DestinationRoot $installed `
        -BackupRoot $backupRoot `
        -RelativePaths $runtimeRelativePaths `
        -PostReplaceValidation $postReplaceValidation
} finally {
    if (Test-Path -LiteralPath $stageRoot -PathType Container) {
        Remove-Item -LiteralPath $stageRoot -Recurse -Force
    }
}

$manifest = Get-Content -Raw -LiteralPath (
    Join-Path $bundleRoot 'runtime\navigation64\runtime-manifest.json'
) | ConvertFrom-Json
[pscustomobject]@{
    Status      = 'Navigation 64-bit runtime deployed'
    ArtifactId  = $manifest.artifactId
    Installed   = $installed
    RuntimeRoot = Join-Path $installed 'runtime\navigation64'
    Backup      = $backupRoot
    FileCount   = $runtimeRelativePaths.Count
} | Format-List
