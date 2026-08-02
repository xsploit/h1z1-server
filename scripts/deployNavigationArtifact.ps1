param(
    [Parameter(Mandatory = $true)]
    [string]$QuickStartRoot,

    [switch]$SkipBuild,

    [Alias('DryRun', 'List')]
    [switch]$Plan
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Import-Module (Join-Path $PSScriptRoot 'NavigationDeployment.psm1') -Force

$sourceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$quickStart = (Resolve-Path -LiteralPath $QuickStartRoot).Path
$installed = Join-Path $quickStart 'node_modules\h1z1-server'
$bundleRoot = Join-Path $installed 'data\2016'
$manifest = Join-Path $bundleRoot 'navigation-artifact-manifest.json'

if (-not (Test-Path -LiteralPath $installed -PathType Container)) {
    throw "Installed h1z1-server was not found: $installed"
}
if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) {
    throw "Navigation artifact manifest was not found: $manifest"
}

if (-not $Plan) {
    $inUse = Get-CimInstance Win32_Process |
        Where-Object { $_.CommandLine -like "*$installed*" }
    if ($inUse) {
        throw "The installed server is in use by PID(s): $($inUse.ProcessId -join ', ')"
    }
}

if (-not $SkipBuild -and -not $Plan) {
    & npm run build --prefix $sourceRoot
    if ($LASTEXITCODE -ne 0) {
        throw "Server build failed with exit code $LASTEXITCODE"
    }
}

$runtimeFiles = @(
    Get-NavigationRuntimeClosure `
        -SourceRoot $sourceRoot `
        -EntryRelativePath 'out\utils\recast.js'
)
if ('out\utils\navigationareas.js' -notin $runtimeFiles) {
    throw 'Navigation runtime closure is incomplete: navigationareas.js is absent.'
}

& npm run navmesh-artifact-check --prefix $sourceRoot -- --bundle-root $bundleRoot
if ($LASTEXITCODE -ne 0) {
    throw "Artifact verification failed before deployment"
}

$deploymentPlan = @(
    foreach ($relativePath in $runtimeFiles) {
        $sourcePath = Join-Path $sourceRoot $relativePath
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
        }
    }
)

if ($Plan) {
    $deploymentPlan
    [pscustomobject]@{
        Status      = 'Navigation runtime deployment plan; no files changed'
        Installed   = $installed
        RuntimeFileCount = $runtimeFiles.Count
        IncludesNavigationAreas = 'out\utils\navigationareas.js' -in $runtimeFiles
    }
    return
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupRoot = Join-Path $quickStart "backups\nav-artifact-contract-$stamp"
$stageRoot = Join-Path $quickStart (
    "backups\.nav-artifact-stage-$stamp-$([guid]::NewGuid().ToString('N'))"
)

try {
    New-NavigationDeploymentStage `
        -SourceRoot $sourceRoot `
        -StageRoot $stageRoot `
        -RelativePaths $runtimeFiles

    $postReplaceValidation = {
        & npm run navmesh-artifact-check --prefix $sourceRoot -- --bundle-root $bundleRoot
        if ($LASTEXITCODE -ne 0) {
            throw "Artifact verification failed after deployment"
        }
    }.GetNewClosure()

    $null = Invoke-NavigationRuntimeReplacement `
        -SourceRoot $sourceRoot `
        -StageRoot $stageRoot `
        -DestinationRoot $installed `
        -BackupRoot $backupRoot `
        -RelativePaths $runtimeFiles `
        -PostReplaceValidation $postReplaceValidation
} finally {
    if (Test-Path -LiteralPath $stageRoot -PathType Container) {
        Remove-Item -LiteralPath $stageRoot -Recurse -Force
    }
}

$manifestValue = Get-Content -Raw -LiteralPath $manifest | ConvertFrom-Json
[pscustomobject]@{
    Status     = 'Navigation artifact contract deployed'
    ArtifactId = $manifestValue.artifactId
    Installed  = $installed
    Backup     = $backupRoot
    RuntimeFileCount = $runtimeFiles.Count
} | Format-List
