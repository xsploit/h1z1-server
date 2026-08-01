param(
    [Parameter(Mandatory = $true)]
    [string]$QuickStartRoot,

    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

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

$inUse = Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -like "*$installed*" }
if ($inUse) {
    throw "The installed server is in use by PID(s): $($inUse.ProcessId -join ', ')"
}

if (-not $SkipBuild) {
    & npm run build --prefix $sourceRoot
    if ($LASTEXITCODE -ne 0) {
        throw "Server build failed with exit code $LASTEXITCODE"
    }
}

& npm run navmesh-artifact-check --prefix $sourceRoot -- --bundle-root $bundleRoot
if ($LASTEXITCODE -ne 0) {
    throw "Artifact verification failed before deployment"
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupRoot = Join-Path $quickStart "backups\nav-artifact-contract-$stamp"
New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null

$runtimeFiles = @(
    'out\utils\recast.js',
    'out\utils\recast.js.map',
    'out\utils\recast.d.ts',
    'out\utils\navigationartifacts.js',
    'out\utils\navigationartifacts.js.map',
    'out\utils\navigationartifacts.d.ts'
)

foreach ($relativePath in $runtimeFiles) {
    $sourcePath = Join-Path $sourceRoot $relativePath
    $destinationPath = Join-Path $installed $relativePath
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "Built runtime file is missing: $sourcePath"
    }
    if (Test-Path -LiteralPath $destinationPath -PathType Leaf) {
        $backupPath = Join-Path $backupRoot $relativePath
        New-Item -ItemType Directory -Path (Split-Path $backupPath) -Force |
            Out-Null
        Copy-Item -LiteralPath $destinationPath -Destination $backupPath -Force
    }
    New-Item -ItemType Directory -Path (Split-Path $destinationPath) -Force |
        Out-Null
    Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Force
}

& npm run navmesh-artifact-check --prefix $sourceRoot -- --bundle-root $bundleRoot
if ($LASTEXITCODE -ne 0) {
    throw "Artifact verification failed after deployment"
}

$manifestValue = Get-Content -Raw -LiteralPath $manifest | ConvertFrom-Json
[pscustomobject]@{
    Status     = 'Navigation artifact contract deployed'
    ArtifactId = $manifestValue.artifactId
    Installed  = $installed
    Backup     = $backupRoot
} | Format-List
