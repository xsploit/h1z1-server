param(
    [Parameter(Mandatory = $true)]
    [string]$RuntimeBundleRoot,

    [Parameter(Mandatory = $true)]
    [string]$OutputRoot,

    [Parameter(Mandatory = $true)]
    [string]$ToolingRoot,

    [Parameter(Mandatory = $true)]
    [string]$BakerRoot,

    [Parameter(Mandatory = $true)]
    [string]$PythonWheelRoot,

    [Parameter(Mandatory = $true)]
    [string]$NavigationTransitionsFile,

    [Parameter(Mandatory = $true)]
    [string]$BakeNavigationTransitionsFile,

    [string]$Version = '0.3.0'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runtimeSource = Join-Path (Resolve-Path -LiteralPath $RuntimeBundleRoot).Path 'runtime\navigation64'
$toolingSource = (Resolve-Path -LiteralPath $ToolingRoot).Path
$bakerSource = (Resolve-Path -LiteralPath $BakerRoot).Path
$pythonWheelSource = (Resolve-Path -LiteralPath $PythonWheelRoot).Path
$transitionSource = (Resolve-Path -LiteralPath $NavigationTransitionsFile).Path
$bakeTransitionSource = (Resolve-Path -LiteralPath $BakeNavigationTransitionsFile).Path
$output = [System.IO.Path]::GetFullPath($OutputRoot)
$commit = (& git -C $repo rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Unable to resolve source commit.' }
$toolingCommit = (& git -C $toolingSource rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Unable to resolve tooling commit.' }
$bakerCommit = (& git -C $bakerSource rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Unable to resolve baker commit.' }
if (-not (Test-Path -LiteralPath (Join-Path $repo 'out\utils\recast.js') -PathType Leaf)) {
    throw 'Compiled server output is missing. Run npm run build first.'
}
$runtimeManifestPath = Join-Path $runtimeSource 'runtime-manifest.json'
if (-not (Test-Path -LiteralPath $runtimeManifestPath -PathType Leaf)) {
    throw "Runtime manifest not found: $runtimeManifestPath"
}
$runtimeManifest = Get-Content -Raw -LiteralPath $runtimeManifestPath | ConvertFrom-Json
if ($runtimeManifest.mode -ne 'monolithic64' -or $runtimeManifest.abi.polyRefBits -ne 64) {
    throw 'Runtime bundle is not a DT_POLYREF64 monolithic runtime.'
}

New-Item -ItemType Directory -Path $output -Force | Out-Null
$name = "h1emu-nav64-experimental-$Version"
$stage = Join-Path $output $name
$zip = Join-Path $output "$name.zip"
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }

New-Item -ItemType Directory -Path (Join-Path $stage 'payload\runtime') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stage 'scripts') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stage 'tooling\forgelight\policies') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stage 'tooling\bin') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stage 'tooling\python') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $repo 'out') -Destination (Join-Path $stage 'payload\out') -Recurse
Copy-Item -LiteralPath $runtimeSource -Destination (Join-Path $stage 'payload\runtime\navigation64') -Recurse
foreach ($script in @(
        'experimentalNav64Bootstrap.js',
        'buildAndInstallExperimentalNav64.ps1',
        'installExperimentalNav64Preview.ps1',
        'rollbackExperimentalNav64Preview.ps1',
        'startExperimentalNav64Setup.ps1'
    )) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $script) -Destination (Join-Path $stage "scripts\$script")
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'INSTALL-NAV64.cmd') -Destination (Join-Path $stage 'INSTALL-NAV64.cmd')
$forgelightFiles = @(
    'artifact_bundle.py',
    'cdta.py',
    'collision_classification.py',
    'collision_semantic_policy.py',
    'export_z1_heightmap.py',
    'export_z1_instanced.py',
    'h1sem.py'
)
foreach ($file in $forgelightFiles) {
    Copy-Item -LiteralPath (Join-Path $toolingSource "tools\forgelight\$file") -Destination (Join-Path $stage "tooling\forgelight\$file")
}
Copy-Item -LiteralPath (Join-Path $toolingSource 'tools\forgelight\policies\z1_collision.semantic_policy.json') -Destination (Join-Path $stage 'tooling\forgelight\policies\z1_collision.semantic_policy.json')
Copy-Item -LiteralPath $transitionSource -Destination (Join-Path $stage 'tooling\navigationTransitions.json')
Copy-Item -LiteralPath $bakeTransitionSource -Destination (Join-Path $stage 'tooling\navigationTransitions.bake.json')
$polyRef64Baker = Join-Path $bakerSource 'build-polyref64\Release\navmesh-builder.exe'
if (-not (Test-Path -LiteralPath $polyRef64Baker -PathType Leaf)) {
    throw "DT_POLYREF64 baker not found: $polyRef64Baker"
}
Copy-Item -LiteralPath $polyRef64Baker -Destination (Join-Path $stage 'tooling\bin\navmesh-builder.exe')
Copy-Item -LiteralPath (Join-Path $bakerSource 'recastnavigation\License.txt') -Destination (Join-Path $stage 'tooling\LICENSE.recast-navigation.txt')
$cnkWheel = @(Get-ChildItem -LiteralPath $pythonWheelSource -Filter 'pycnkdec-0.0.1-cp312-cp312-win_amd64.whl' -File)
if ($cnkWheel.Count -ne 1) { throw 'Expected exactly one pinned CPython 3.12 pycnkdec wheel.' }
Copy-Item -LiteralPath $cnkWheel[0].FullName -Destination (Join-Path $stage 'tooling\python\pycnkdec-0.0.1-cp312-cp312-win_amd64.whl')
Copy-Item -LiteralPath (Join-Path $pythonWheelSource 'LICENSE.pycnkdec.txt') -Destination (Join-Path $stage 'tooling\python\LICENSE.pycnkdec.txt')
Copy-Item -LiteralPath (Join-Path $repo 'docs\experimental-nav64-preview.md') -Destination (Join-Path $stage 'README.md')
Copy-Item -LiteralPath (Join-Path $repo 'LICENSE') -Destination (Join-Path $stage 'LICENSE')

$forbidden = @(Get-ChildItem -LiteralPath $stage -Recurse -File | Where-Object {
        $_.Name -like 'Assets_*.pack' -or
        $_.Extension -in @('.pack', '.cnk') -or
        $_.Name -eq 'heightmap.png' -or
        $_.Name -eq 'z1_collision.bin' -or
        $_.Name -like 'z1_cache_*.bin'
    })
if ($forbidden.Count -gt 0) {
    throw "Package contains client-derived navigation/game data: $($forbidden.FullName -join ', ')"
}

$files = @(Get-ChildItem -LiteralPath $stage -Recurse -File | Sort-Object FullName | ForEach-Object {
        [pscustomobject]@{
            path = $_.FullName.Substring($stage.Length + 1).Replace('\', '/')
            size = $_.Length
            sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    })
[ordered]@{
    schemaVersion = 1
    kind = 'h1emu-nav64-experimental-preview'
    version = $Version
    sourceCommit = $commit
    toolingCommit = $toolingCommit
    bakerCommit = $bakerCommit
    bakerSha256 = (Get-FileHash -LiteralPath (Join-Path $stage 'tooling\bin\navmesh-builder.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
    transitionsSha256 = (Get-FileHash -LiteralPath (Join-Path $stage 'tooling\navigationTransitions.json') -Algorithm SHA256).Hash.ToLowerInvariant()
    bakeTransitionsSha256 = (Get-FileHash -LiteralPath (Join-Path $stage 'tooling\navigationTransitions.bake.json') -Algorithm SHA256).Hash.ToLowerInvariant()
    runtimeArtifactId = [string]$runtimeManifest.artifactId
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    includesNavigationData = $false
    files = $files
} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $stage 'preview-manifest.json') -Encoding UTF8

Compress-Archive -LiteralPath $stage -DestinationPath $zip -CompressionLevel Optimal
[pscustomobject]@{
    Status = 'Experimental preview packaged'
    Version = $Version
    SourceCommit = $commit
    RuntimeArtifact = [string]$runtimeManifest.artifactId
    Folder = $stage
    Archive = $zip
    ArchiveSha256 = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    IncludesNavigationData = $false
} | Format-List
