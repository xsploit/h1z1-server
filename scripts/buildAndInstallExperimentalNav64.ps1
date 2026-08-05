param(
    [Parameter(Mandatory = $true)]
    [string]$H1Z1Assets,

    [Parameter(Mandatory = $true)]
    [string]$QuickStartRoot,

    [string]$PackageRoot,

    [string]$WorkRoot,

    [switch]$Plan,

    [switch]$SkipInstall,

    [switch]$Rebuild
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($PackageRoot)) {
    $PackageRoot = Split-Path -Parent $PSScriptRoot
}
if ([string]::IsNullOrWhiteSpace($WorkRoot)) {
    $WorkRoot = Join-Path $env:LOCALAPPDATA 'H1Emu\Nav64Builder'
}

$PYDMOD_REPOSITORY = 'https://github.com/ryanjsims/pydmod.git'
$PYDMOD_COMMIT = 'd220703826b39bdccd54956782e57809696226b5'
$TOOLING_COMMIT = 'ee3e2721c062bb0d5b3d0ed401aaa2025fbe71a5'
$BAKER_COMMIT = '2646f66a7eae3d601579f86752cbf699ae2c3915'
$EXPECTED_COLLISION_SHA256 = 'ce8ca93c8b3d3607d829b323580b6cad60723ea46c7f46eb0e8f16ed38656065'
$EXPECTED_SEMANTICS_SHA256 = '827cb61bbdfbe54f2e7aa24894ace987bbf5e071702a0810b69bf921daa5d36e'
$EXPECTED_HEIGHTMAP_SHA256 = '78799a6429aaf910cc5c38fe4d8ebfa15d79096c272e77faa3cc2a089ecadc21'
$EXPECTED_TRANSITIONS_SHA256 = '386481477e016caa9bfb46e2c49242176cfbba7573df4259dc24c7f5dcaa360e'

function Get-Sha256([string]$Path) {
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-Hash([string]$Path, [string]$Expected, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Label was not produced: $Path"
    }
    $actual = Get-Sha256 $Path
    if ($actual -ne $Expected) {
        throw "$Label does not match the tested 2016 client artifact. expected=$Expected actual=$actual path=$Path"
    }
}

function Invoke-Logged(
    [string]$Label,
    [string]$File,
    [object[]]$Arguments,
    [string]$WorkingDirectory,
    [string]$Log
) {
    $exitCode = 1
    "=== $Label started $((Get-Date).ToUniversalTime().ToString('o')) ===" | Tee-Object -FilePath $Log -Append
    Push-Location $WorkingDirectory
    try {
        $oldPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        & $File @Arguments 2>&1 | Tee-Object -FilePath $Log -Append
        $exitCode = $LASTEXITCODE
        $ErrorActionPreference = $oldPreference
    } finally {
        Pop-Location
    }
    if ($exitCode -ne 0) {
        throw "$Label failed with exit code $exitCode. See $Log"
    }
    "=== $Label complete $((Get-Date).ToUniversalTime().ToString('o')) ===" | Tee-Object -FilePath $Log -Append
}

function New-ArtifactManifest([string]$ArtifactRoot) {
    $records = @(Get-ChildItem -LiteralPath (Join-Path $ArtifactRoot 'collision') -Filter 'z1_cache_*.bin' -File | Sort-Object { [int]($_.BaseName -replace '^z1_cache_', '') } | ForEach-Object {
            [ordered]@{
                path = "collision/$($_.Name)"
                size = $_.Length
                sha256 = Get-Sha256 $_.FullName
            }
        })
    $collision = Join-Path $ArtifactRoot 'collision\z1_collision.bin'
    $heightmap = Join-Path $ArtifactRoot 'zoneData\heightmap.png'
    $transitions = Join-Path $ArtifactRoot 'navigationTransitions.json'
    $identity = [ordered]@{
        schemaVersion = 1
        provenance = [ordered]@{
            status = 'locally-generated-from-user-client'
            pydmodCommit = $PYDMOD_COMMIT
            toolingCommit = $TOOLING_COMMIT
            recastCommit = $BAKER_COMMIT
        }
        runtime = [ordered]@{
            cache = [ordered]@{ format = 'TSET'; parts = $records }
            collision = [ordered]@{ file = [ordered]@{ path = 'collision/z1_collision.bin'; size = (Get-Item $collision).Length; sha256 = Get-Sha256 $collision } }
            heightmap = [ordered]@{ file = [ordered]@{ path = 'zoneData/heightmap.png'; size = (Get-Item $heightmap).Length; sha256 = Get-Sha256 $heightmap } }
            transitions = [ordered]@{ file = [ordered]@{ path = 'navigationTransitions.json'; size = (Get-Item $transitions).Length; sha256 = Get-Sha256 $transitions }; count = 177 }
        }
    }
    $identityJson = $identity | ConvertTo-Json -Depth 8 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($identityJson)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $artifactId = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
    $identity.artifactId = $artifactId
    $identity | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $ArtifactRoot 'navigation-artifact-manifest.json') -Encoding UTF8
}

$assets = (Resolve-Path -LiteralPath $H1Z1Assets).Path
$quickStart = (Resolve-Path -LiteralPath $QuickStartRoot).Path
$package = (Resolve-Path -LiteralPath $PackageRoot).Path
$work = [System.IO.Path]::GetFullPath($WorkRoot)
$tools = Join-Path $package 'tooling\forgelight'
$baker = Join-Path $package 'tooling\bin\navmesh-builder.exe'
$cnkWheel = Join-Path $package 'tooling\python\pycnkdec-0.0.1-cp312-cp312-win_amd64.whl'
$transitionsSource = Join-Path $package 'tooling\navigationTransitions.json'
$installer = Join-Path $package 'scripts\installExperimentalNav64Preview.ps1'
$pydmod = Join-Path $work 'pydmod'
$venvPython = Join-Path $pydmod '.nav64-venv\Scripts\python.exe'
$artifact = Join-Path $work 'artifact\data\2016'
$collisionDirectory = Join-Path $artifact 'collision'
$collision = Join-Path $collisionDirectory 'z1_collision.bin'
$metadata = Join-Path $collisionDirectory 'z1_collision.metadata.json'
$instanceIds = Join-Path $collisionDirectory 'z1_collision.instance_ids.bin'
$semantics = Join-Path $collisionDirectory 'z1_collision.semantics.bin'
$heightmap = Join-Path $artifact 'zoneData\heightmap.png'
$transitions = Join-Path $artifact 'navigationTransitions.json'
$bakeRoot = Join-Path $work 'bake'
$logRoot = Join-Path $work 'logs'

if (@(Get-ChildItem -LiteralPath $assets -Filter 'Assets_*.pack' -File).Count -eq 0) {
    throw "No Assets_*.pack files were found in $assets"
}
foreach ($required in @($tools, $baker, $cnkWheel, $transitionsSource, $installer)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Preview tooling is missing: $required" }
}
Assert-Hash $transitionsSource $EXPECTED_TRANSITIONS_SHA256 'authored transitions'
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git is required.' }
if (-not (Get-Command py -ErrorAction SilentlyContinue)) { throw 'The Python launcher is required with Python 3.12 installed.' }
& py -3.12 -c 'import sys; print(sys.version)' *> $null
if ($LASTEXITCODE -ne 0) { throw 'Python 3.12 is required. Install it, then rerun this command.' }

if ($Plan) {
    [pscustomobject]@{
        Status = 'Plan only; no files changed'
        Assets = $assets
        QuickStart = $quickStart
        WorkRoot = $work
        PydmodCommit = $PYDMOD_COMMIT
        ToolingCommit = $TOOLING_COMMIT
        BakerCommit = $BAKER_COMMIT
        EstimatedBake = '90-120 minutes after extraction'
        Install = -not $SkipInstall
    } | Format-List
    return
}

New-Item -ItemType Directory -Path $work, $collisionDirectory, (Join-Path $artifact 'zoneData'), $bakeRoot, $logRoot -Force | Out-Null
$setupLog = Join-Path $logRoot 'setup.log'
$extractLog = Join-Path $logRoot 'extract.log'
$bakeLog = Join-Path $logRoot 'bake.log'

if ($Rebuild) {
    $extractArchive = Join-Path $work ("extract-archive\" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    $previousExtraction = @($collision, $metadata, $instanceIds, $semantics, $heightmap)
    if (@($previousExtraction | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }).Count -gt 0) {
        New-Item -ItemType Directory -Path $extractArchive -Force | Out-Null
        foreach ($oldFile in $previousExtraction) {
            if (Test-Path -LiteralPath $oldFile -PathType Leaf) {
                Move-Item -LiteralPath $oldFile -Destination (Join-Path $extractArchive ([System.IO.Path]::GetFileName($oldFile)))
            }
        }
    }
}

if (-not (Test-Path -LiteralPath (Join-Path $pydmod '.git') -PathType Container)) {
    Invoke-Logged 'clone pydmod' 'git' @('clone', '--recurse-submodules', $PYDMOD_REPOSITORY, $pydmod) $work $setupLog
}
$pydmodHead = (& git -C $pydmod rev-parse HEAD).Trim()
if ($pydmodHead -ne $PYDMOD_COMMIT) {
    Invoke-Logged 'fetch pinned pydmod' 'git' @('-C', $pydmod, 'fetch', 'origin', $PYDMOD_COMMIT) $work $setupLog
    Invoke-Logged 'checkout pinned pydmod' 'git' @('-C', $pydmod, 'checkout', '--detach', $PYDMOD_COMMIT) $work $setupLog
    Invoke-Logged 'update pydmod submodules' 'git' @('-C', $pydmod, 'submodule', 'update', '--init', '--recursive') $work $setupLog
}

if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
    Invoke-Logged 'create Python environment' 'py' @('-3.12', '-m', 'venv', (Join-Path $pydmod '.nav64-venv')) $work $setupLog
    Invoke-Logged 'upgrade pip' $venvPython @('-m', 'pip', 'install', '--upgrade', 'pip') $pydmod $setupLog
    Invoke-Logged 'install Python dependencies' $venvPython @('-m', 'pip', 'install', 'numpy', 'scipy', 'pygltflib', 'Pillow', 'aabbtree', 'bitstruct', 'numpy-stl', 'numba') $pydmod $setupLog
    Invoke-Logged 'install DbgPack' $venvPython @('-m', 'pip', 'install', (Join-Path $pydmod 'dbg-pack')) $pydmod $setupLog
    Invoke-Logged 'install pinned CNK decoder' $venvPython @('-m', 'pip', 'install', $cnkWheel) $pydmod $setupLog
}

$extractionOutputs = @($collision, $metadata, $instanceIds, $semantics)
$missingExtractionOutputs = @($extractionOutputs | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) })
if ($Rebuild -or $missingExtractionOutputs.Count -gt 0) {
    $env:H1Z1_ASSETS = $assets
    $env:PYTHONPATH = $pydmod
    $env:COLLISION_OUT = $collision
    $env:COLLISION_METADATA_OUT = $metadata
    $env:COLLISION_INSTANCE_IDS_OUT = $instanceIds
    $env:COLLISION_SEMANTICS_OUT = $semantics
    $env:COLLISION_SEMANTIC_POLICY = Join-Path $tools 'policies\z1_collision.semantic_policy.json'
    $env:COLLISION_SEMANTIC_MODE = 'diagnostic'
    $env:COLLISION_DYNAMIC_DOOR_OBSTACLES_ACKNOWLEDGED = 'true'
    Invoke-Logged 'extract collision and semantics' $venvPython @((Join-Path $tools 'export_z1_instanced.py')) $pydmod $extractLog
}
Assert-Hash $collision $EXPECTED_COLLISION_SHA256 'collision artifact'
Assert-Hash $semantics $EXPECTED_SEMANTICS_SHA256 'semantic sidecar'
$metadataJson = Get-Content -Raw -LiteralPath $metadata | ConvertFrom-Json
if ($metadataJson.meshCount -ne 820 -or $metadataJson.instanceCount -ne 149976 -or $metadataJson.totalTriangleCount -ne 505628) {
    throw 'Collision metadata does not match the tested corpus (820 meshes, 149976 instances, 505628 triangles).'
}

if ($Rebuild -or -not (Test-Path -LiteralPath $heightmap -PathType Leaf)) {
    $env:H1Z1_ASSETS = $assets
    $env:PYTHONPATH = $pydmod
    Invoke-Logged 'extract terrain heightmap' $venvPython @((Join-Path $tools 'export_z1_heightmap.py'), '--assets', $assets, '--output', $heightmap) $pydmod $extractLog
}
Assert-Hash $heightmap $EXPECTED_HEIGHTMAP_SHA256 'heightmap artifact'
Copy-Item -LiteralPath $transitionsSource -Destination $transitions -Force

$existingCache = @(Get-ChildItem -LiteralPath $bakeRoot -Filter 'z1_cache_*.bin' -File -ErrorAction SilentlyContinue)
if ($Rebuild -and $existingCache.Count -gt 0) {
    $archive = Join-Path $work ("bake-archive\" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    New-Item -ItemType Directory -Path $archive -Force | Out-Null
    foreach ($oldFile in @(Get-ChildItem -LiteralPath $bakeRoot -File)) {
        Move-Item -LiteralPath $oldFile.FullName -Destination (Join-Path $archive $oldFile.Name)
    }
    $existingCache = @()
}
if ($Rebuild -or $existingCache.Count -ne 22 -or -not (Select-String -LiteralPath $bakeLog -SimpleMatch 'Cache layers : 104935 total' -Quiet -ErrorAction SilentlyContinue)) {
    if ($existingCache.Count -gt 0) {
        throw "A partial or mismatched bake exists in $bakeRoot. Move it aside or rerun with -Rebuild."
    }
    $arguments = @(
        'placeholder.obj', (Join-Path $bakeRoot 'nav.bin'),
        '--profile', 'human',
        '--agent-climb', '1.3',
        '--dynamic-door-obstacles',
        '--geometry-source', 'forgelight',
        '--forgelight-collision', $collision,
        '--forgelight-semantics', $semantics,
        '--forgelight-heightmap', $heightmap,
        '--forgelight-transitions', $transitions,
        '--global-bounds', '-4096', '-100', '-4096', '4096', '500', '4096'
    )
    Invoke-Logged 'full Z1 navigation bake' $baker $arguments $bakeRoot $bakeLog
}
if (-not (Select-String -LiteralPath $bakeLog -SimpleMatch 'Cache layers : 104935 total' -Quiet)) {
    throw "Bake completed without the tested 104935-layer result. Do not install it; inspect $bakeLog"
}
$cacheParts = @(Get-ChildItem -LiteralPath $bakeRoot -Filter 'z1_cache_*.bin' -File | Sort-Object { [int]($_.BaseName -replace '^z1_cache_', '') })
if ($cacheParts.Count -ne 22) { throw "Expected 22 cache parts, found $($cacheParts.Count)." }
foreach ($part in $cacheParts) { Copy-Item -LiteralPath $part.FullName -Destination (Join-Path $collisionDirectory $part.Name) -Force }
if (Test-Path -LiteralPath (Join-Path $bakeRoot 'z1_0.bin')) {
    Copy-Item -LiteralPath (Join-Path $bakeRoot 'z1_0.bin') -Destination (Join-Path $collisionDirectory 'z1_0.bin') -Force
}
New-ArtifactManifest $artifact

if (-not $SkipInstall) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $installer -QuickStartRoot $quickStart -PackageRoot $package -NavigationDataRoot $artifact
    if ($LASTEXITCODE -ne 0) { throw 'Preview installation failed after a successful bake.' }
}

[pscustomobject]@{
    Status = if ($SkipInstall) { 'Navigation artifact built and verified' } else { 'Navigation artifact built, verified, and preview installed' }
    Artifact = $artifact
    CacheParts = $cacheParts.Count
    Logs = $logRoot
    BakeLog = $bakeLog
    Next = if ($SkipInstall) { 'Run the preview installer with -NavigationDataRoot pointing to this artifact.' } else { 'Start H1Emu and require the monolithic64 ready line before joining.' }
} | Format-List
