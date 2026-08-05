param(
    [Parameter(Mandatory = $true)]
    [string]$QuickStartRoot,

    [string]$PackageRoot,

    [string]$NavigationDataRoot,

    [switch]$Plan
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($PackageRoot)) {
    $PackageRoot = Split-Path -Parent $PSScriptRoot
}

function Get-Sha256([string]$Path) {
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-ServerIdle([string]$QuickStart) {
    $inUse = @(Get-CimInstance Win32_Process | Where-Object {
            $commandLine = [string]$_.CommandLine
            $_.Name -like 'node*' -and
            -not [string]::IsNullOrWhiteSpace($commandLine) -and
            ($commandLine.IndexOf($QuickStart, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
                $commandLine -match 'h1emu-2016\.js|h1z1-server-demo-2016')
        })
    if ($inUse.Count -gt 0) {
        throw "Stop H1Emu before installing. In-use Node PID(s): $($inUse.ProcessId -join ', ')"
    }
}

function Assert-Package([string]$Root) {
    $manifestPath = Join-Path $Root 'preview-manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "Preview manifest not found: $manifestPath"
    }
    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1 -or $manifest.kind -ne 'h1emu-nav64-experimental-preview') {
        throw 'Unsupported experimental preview manifest.'
    }
    foreach ($file in $manifest.files) {
        $path = Join-Path $Root ([string]$file.path)
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Preview file missing: $($file.path)"
        }
        $item = Get-Item -LiteralPath $path
        if ($item.Length -ne [long]$file.size -or (Get-Sha256 $path) -ne [string]$file.sha256) {
            throw "Preview file failed identity verification: $($file.path)"
        }
    }
    return $manifest
}

function Assert-NavigationData([string]$Root) {
    $required = @(
        'collision\z1_collision.bin',
        'zoneData\heightmap.png',
        'navigationTransitions.json'
    )
    foreach ($relative in $required) {
        if (-not (Test-Path -LiteralPath (Join-Path $Root $relative) -PathType Leaf)) {
            throw "Generated navigation data is missing: $relative"
        }
    }
    $cacheParts = @(Get-ChildItem -LiteralPath (Join-Path $Root 'collision') -Filter 'z1_cache_*.bin' -File)
    if ($cacheParts.Count -eq 0) {
        throw 'Generated navigation data contains no z1_cache_*.bin files.'
    }

    $artifactManifestPath = Join-Path $Root 'navigation-artifact-manifest.json'
    if (Test-Path -LiteralPath $artifactManifestPath -PathType Leaf) {
        $artifact = Get-Content -Raw -LiteralPath $artifactManifestPath | ConvertFrom-Json
        $records = @()
        $records += @($artifact.runtime.cache.parts)
        $records += @($artifact.runtime.collision.file)
        $records += @($artifact.runtime.heightmap.file)
        $records += @($artifact.runtime.transitions.file)
        foreach ($record in $records) {
            if ($null -eq $record) { continue }
            $path = Join-Path $Root ([string]$record.path)
            if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or
                (Get-Item -LiteralPath $path).Length -ne [long]$record.size -or
                (Get-Sha256 $path) -ne [string]$record.sha256) {
                throw "Navigation artifact file failed manifest verification: $($record.path)"
            }
        }
    }
    return $cacheParts.Count
}

$quickStart = (Resolve-Path -LiteralPath $QuickStartRoot).Path
$package = (Resolve-Path -LiteralPath $PackageRoot).Path
$installed = Join-Path $quickStart 'node_modules\h1z1-server'
$launcher = Join-Path $quickStart 'h1emu-2016.js'
$targetData = Join-Path $installed 'data\2016'
$payloadOut = Join-Path $package 'payload\out'
$payloadRuntime = Join-Path $package 'payload\runtime\navigation64'
$bootstrapSource = Join-Path $package 'scripts\experimentalNav64Bootstrap.js'

foreach ($required in @($installed, $payloadOut, $payloadRuntime)) {
    if (-not (Test-Path -LiteralPath $required -PathType Container)) {
        throw "Required directory not found: $required"
    }
}
foreach ($required in @($launcher, $bootstrapSource)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Required file not found: $required"
    }
}

$manifest = Assert-Package $package
$dataSource = if ([string]::IsNullOrWhiteSpace($NavigationDataRoot)) {
    $targetData
} else {
    (Resolve-Path -LiteralPath $NavigationDataRoot).Path
}
$cachePartCount = Assert-NavigationData $dataSource

if ($dataSource -ne $targetData) {
    $targetCollision = Join-Path $targetData 'collision'
    if ((Test-Path -LiteralPath (Join-Path $targetCollision 'z1_collision.bin')) -or
        @(Get-ChildItem -LiteralPath $targetCollision -Filter 'z1_cache_*.bin' -File -ErrorAction SilentlyContinue).Count -gt 0) {
        throw 'Target already contains generated navigation data. Omit -NavigationDataRoot to use it; this installer will not overwrite a previous bake.'
    }
}

if ($Plan) {
    [pscustomobject]@{
        Status = 'Plan only; no files changed'
        Version = $manifest.version
        SourceCommit = $manifest.sourceCommit
        QuickStart = $quickStart
        NavigationData = $dataSource
        CacheParts = $cachePartCount
    } | Format-List
    return
}

Assert-ServerIdle $quickStart

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $quickStart "backups\experimental-nav64-$stamp"
$bootstrapTarget = Join-Path $quickStart 'experimental-nav64-bootstrap.js'
$bootstrapLine = 'require("./experimental-nav64-bootstrap")({ quickStartRoot: __dirname });'
$createdData = $false

try {
    New-Item -ItemType Directory -Path $backup | Out-Null
    Copy-Item -LiteralPath (Join-Path $installed 'out') -Destination (Join-Path $backup 'out') -Recurse
    if (Test-Path -LiteralPath (Join-Path $installed 'runtime\navigation64')) {
        New-Item -ItemType Directory -Path (Join-Path $backup 'runtime') | Out-Null
        Copy-Item -LiteralPath (Join-Path $installed 'runtime\navigation64') -Destination (Join-Path $backup 'runtime\navigation64') -Recurse
    }
    Copy-Item -LiteralPath $launcher -Destination (Join-Path $backup 'h1emu-2016.js')
    if (Test-Path -LiteralPath $bootstrapTarget) {
        Copy-Item -LiteralPath $bootstrapTarget -Destination (Join-Path $backup 'experimental-nav64-bootstrap.js')
    }

    Remove-Item -LiteralPath (Join-Path $installed 'out') -Recurse -Force
    Copy-Item -LiteralPath $payloadOut -Destination (Join-Path $installed 'out') -Recurse
    New-Item -ItemType Directory -Path (Join-Path $installed 'runtime') -Force | Out-Null
    if (Test-Path -LiteralPath (Join-Path $installed 'runtime\navigation64')) {
        Remove-Item -LiteralPath (Join-Path $installed 'runtime\navigation64') -Recurse -Force
    }
    Copy-Item -LiteralPath $payloadRuntime -Destination (Join-Path $installed 'runtime\navigation64') -Recurse

    if ($dataSource -ne $targetData) {
        New-Item -ItemType Directory -Path $targetData -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $dataSource 'collision') -Destination (Join-Path $targetData 'collision') -Recurse
        New-Item -ItemType Directory -Path (Join-Path $targetData 'zoneData') -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $dataSource 'zoneData\heightmap.png') -Destination (Join-Path $targetData 'zoneData\heightmap.png')
        Copy-Item -LiteralPath (Join-Path $dataSource 'navigationTransitions.json') -Destination (Join-Path $targetData 'navigationTransitions.json')
        if (Test-Path -LiteralPath (Join-Path $dataSource 'navigation-artifact-manifest.json')) {
            Copy-Item -LiteralPath (Join-Path $dataSource 'navigation-artifact-manifest.json') -Destination (Join-Path $targetData 'navigation-artifact-manifest.json')
        }
        $createdData = $true
    }

    Copy-Item -LiteralPath $bootstrapSource -Destination $bootstrapTarget -Force
    $launcherText = [System.IO.File]::ReadAllText($launcher)
    if (-not $launcherText.Contains($bootstrapLine)) {
        $lineBreak = if ($launcherText.Contains("`r`n")) { "`r`n" } else { "`n" }
        if ($launcherText.StartsWith('#!')) {
            $firstBreak = $launcherText.IndexOf($lineBreak)
            if ($firstBreak -lt 0) { throw 'QuickStart launcher has an invalid shebang.' }
            $launcherText = $launcherText.Insert(
                $firstBreak + $lineBreak.Length,
                "$bootstrapLine$lineBreak"
            )
        } else {
            $launcherText = "$bootstrapLine$lineBreak$launcherText"
        }
        [System.IO.File]::WriteAllText($launcher, $launcherText)
    }

    [pscustomobject]@{
        schemaVersion = 1
        packageVersion = [string]$manifest.version
        sourceCommit = [string]$manifest.sourceCommit
        quickStart = $quickStart
        createdNavigationData = $createdData
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $backup 'rollback-manifest.json') -Encoding UTF8

    & node --check $launcher
    if ($LASTEXITCODE -ne 0) { throw 'Installed launcher failed syntax validation.' }
    & node --check $bootstrapTarget
    if ($LASTEXITCODE -ne 0) { throw 'Installed bootstrap failed syntax validation.' }
    & node -e "for(const name of ['@napi-rs/canvas','three','three-mesh-bvh'])require.resolve(name,{paths:[process.argv[1]]})" $quickStart
    if ($LASTEXITCODE -ne 0) { throw 'Required npm dependencies are missing from QuickStart.' }
    $null = Assert-NavigationData $targetData
} catch {
    throw "Installation stopped. Existing files are preserved in $backup. $($_.Exception.Message)"
}

[pscustomobject]@{
    Status = 'Experimental navigation64 preview installed'
    Version = $manifest.version
    SourceCommit = $manifest.sourceCommit
    RuntimeArtifact = $manifest.runtimeArtifactId
    QuickStart = $quickStart
    Backup = $backup
    CacheParts = $cachePartCount
    Next = 'Run npm run start-2016 and require the monolithic64 ready line before joining.'
} | Format-List
