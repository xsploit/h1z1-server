param(
    [Parameter(Mandatory = $true)]
    [string]$QuickStartRoot,

    [Parameter(Mandatory = $true)]
    [string]$NavigationBundleSourceRoot,

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
$installedBundleRoot = Join-Path $installed 'data\2016'
$bundleSourceRoot = (Resolve-Path -LiteralPath $NavigationBundleSourceRoot).Path
$sourceManifest = Join-Path $bundleSourceRoot 'navigation-artifact-manifest.json'

if (-not (Test-Path -LiteralPath $installed -PathType Container)) {
    throw "Installed h1z1-server was not found: $installed"
}
if (-not (Test-Path -LiteralPath $sourceManifest -PathType Leaf)) {
    throw "Staged navigation artifact manifest was not found: $sourceManifest"
}
$installedPrefix = [System.IO.Path]::GetFullPath($installed).TrimEnd('\', '/') + '\'
if ($bundleSourceRoot -eq $installedBundleRoot -or
    $bundleSourceRoot.StartsWith(
        $installedPrefix,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
    throw 'NavigationBundleSourceRoot must be staged outside the installed server.'
}

if (-not $Plan) {
    $inUse = Get-CimInstance Win32_Process |
        Where-Object {
            $_.Name -like 'node*' -and
            ($_.CommandLine -like "*$installed*" -or
                $_.CommandLine -like "*$quickStart*" -or
                $_.CommandLine -match 'h1emu-2016\.js|h1z1-server-demo-2016')
        }
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

& npm run navmesh-artifact-check --prefix $sourceRoot -- `
    --bundle-root $bundleSourceRoot
if ($LASTEXITCODE -ne 0) {
    throw 'Staged artifact verification failed before deployment.'
}

$deploymentPlan = @(New-NavigationDeploymentFilePlan `
        -SourceRoot $sourceRoot `
        -RuntimeRelativePaths $runtimeFiles `
        -BundleRoot $bundleSourceRoot `
        -DestinationRoot $installed)
$bundleFileCount = @($deploymentPlan | Where-Object {
        $_.Kind -in @('bundle', 'manifest')
    }).Count
$obsoleteCacheParts = @($deploymentPlan | Where-Object {
        $_.Action -eq 'Remove'
    }).Count

if ($Plan) {
    $deploymentPlan
    [pscustomobject]@{
        Status                  = 'Navigation deployment plan; no files changed'
        Installed               = $installed
        BundleSource            = $bundleSourceRoot
        RuntimeFileCount        = $runtimeFiles.Count
        BundleFileCount         = $bundleFileCount
        ObsoleteCacheParts      = $obsoleteCacheParts
        IncludesNavigationAreas = 'out\utils\navigationareas.js' -in $runtimeFiles
    }
    return
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupRoot = Join-Path $quickStart "backups\nav-artifact-contract-$stamp"
$stageRoot = Join-Path $quickStart (
    "backups\.nav-artifact-stage-$stamp-$([guid]::NewGuid().ToString('N'))"
)
if ([System.IO.Path]::GetPathRoot($stageRoot) -ne
    [System.IO.Path]::GetPathRoot($installed)) {
    throw 'Deployment stage and installed server must be on the same filesystem.'
}

try {
    New-NavigationDeploymentStageFromPlan `
        -StageRoot $stageRoot `
        -FilePlan $deploymentPlan

    $postReplaceValidation = {
        & npm run navmesh-artifact-check --prefix $sourceRoot -- `
            --bundle-root $installedBundleRoot
        if ($LASTEXITCODE -ne 0) {
            throw 'Artifact verification failed after deployment.'
        }
    }.GetNewClosure()

    $null = Invoke-NavigationFileReplacement `
        -StageRoot $stageRoot `
        -DestinationRoot $installed `
        -BackupRoot $backupRoot `
        -FilePlan $deploymentPlan `
        -PostReplaceValidation $postReplaceValidation
} finally {
    if (Test-Path -LiteralPath $stageRoot -PathType Container) {
        Remove-Item -LiteralPath $stageRoot -Recurse -Force
    }
}

$manifestValue = Get-Content -Raw -LiteralPath $sourceManifest | ConvertFrom-Json
[pscustomobject]@{
    Status                    = 'Navigation runtime and bundle deployed'
    ArtifactId                = $manifestValue.artifactId
    Installed                 = $installed
    Backup                    = $backupRoot
    RuntimeFileCount          = $runtimeFiles.Count
    BundleFileCount           = $bundleFileCount
    ObsoleteCachePartsRemoved = $obsoleteCacheParts
} | Format-List
