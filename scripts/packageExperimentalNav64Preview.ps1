param(
    [Parameter(Mandatory = $true)]
    [string]$RuntimeBundleRoot,

    [Parameter(Mandatory = $true)]
    [string]$OutputRoot,

    [string]$Version = '0.1.0'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runtimeSource = Join-Path (Resolve-Path -LiteralPath $RuntimeBundleRoot).Path 'runtime\navigation64'
$output = [System.IO.Path]::GetFullPath($OutputRoot)
$commit = (& git -C $repo rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Unable to resolve source commit.' }
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
Copy-Item -LiteralPath (Join-Path $repo 'out') -Destination (Join-Path $stage 'payload\out') -Recurse
Copy-Item -LiteralPath $runtimeSource -Destination (Join-Path $stage 'payload\runtime\navigation64') -Recurse
foreach ($script in @(
        'experimentalNav64Bootstrap.js',
        'installExperimentalNav64Preview.ps1',
        'rollbackExperimentalNav64Preview.ps1'
    )) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $script) -Destination (Join-Path $stage "scripts\$script")
}
Copy-Item -LiteralPath (Join-Path $repo 'docs\experimental-nav64-preview.md') -Destination (Join-Path $stage 'README.md')
Copy-Item -LiteralPath (Join-Path $repo 'LICENSE') -Destination (Join-Path $stage 'LICENSE')

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
