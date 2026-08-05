param(
    [Parameter(Mandatory = $true)]
    [string]$QuickStartRoot,

    [Parameter(Mandatory = $true)]
    [string]$ServerSourceRoot,

    [Alias('DryRun', 'List')]
    [switch]$Plan
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Import-Module (Join-Path $PSScriptRoot 'NavigationDeployment.psm1') -Force

$quickStart = (Resolve-Path -LiteralPath $QuickStartRoot).Path
$sourceRoot = (Resolve-Path -LiteralPath $ServerSourceRoot).Path
$installed = Join-Path $quickStart 'node_modules\h1z1-server'
$sourceOut = Join-Path $sourceRoot 'out'
$installedOut = Join-Path $installed 'out'

function Assert-QuickStartIdle {
    $processes = @(Get-CimInstance Win32_Process)
    $hiddenNodeProcesses = @($processes | Where-Object {
            $_.Name -like 'node*' -and
            [string]::IsNullOrWhiteSpace([string]$_.CommandLine)
        })
    if ($hiddenNodeProcesses.Count -gt 0) {
        throw "Cannot prove QuickStart is idle because Node command lines are unavailable for PID(s): $($hiddenNodeProcesses.ProcessId -join ', ')"
    }
    $inUse = @($processes | Where-Object {
            $commandLine = [string]$_.CommandLine
            -not [string]::IsNullOrWhiteSpace($commandLine) -and
            $_.Name -like 'node*' -and
            ($commandLine.IndexOf(
                    $installed,
                    [System.StringComparison]::OrdinalIgnoreCase
                ) -ge 0 -or
                $commandLine.IndexOf(
                    $quickStart,
                    [System.StringComparison]::OrdinalIgnoreCase
                ) -ge 0 -or
                $commandLine -match 'h1emu-2016\.js|h1z1-server-demo-2016')
        })
    if ($inUse.Count -gt 0) {
        throw "The installed server is in use by PID(s): $($inUse.ProcessId -join ', ')"
    }
}

function Get-RelativePathForDeployment {
    param(
        [Parameter(Mandatory = $true)]
        [string]$BasePath,

        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $baseWithSeparator = [System.IO.Path]::GetFullPath($BasePath).TrimEnd(
        '\', '/'
    ) + '\'
    $baseUri = [System.Uri]$baseWithSeparator
    $pathUri = [System.Uri][System.IO.Path]::GetFullPath($Path)
    [System.Uri]::UnescapeDataString(
        $baseUri.MakeRelativeUri($pathUri).ToString()
    ).Replace('/', '\')
}

foreach ($requiredPath in @($installed, $sourceOut, $installedOut)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Container)) {
        throw "Required directory was not found: $requiredPath"
    }
}

$sourcePackage = Get-Content -Raw -LiteralPath (
    Join-Path $sourceRoot 'package.json'
) | ConvertFrom-Json
$installedPackage = Get-Content -Raw -LiteralPath (
    Join-Path $installed 'package.json'
) | ConvertFrom-Json
if ($sourcePackage.name -ne 'h1z1-server' -or
    $installedPackage.name -ne 'h1z1-server') {
    throw 'Source and destination must both be h1z1-server packages.'
}
if ($sourcePackage.version -ne $installedPackage.version) {
    throw "Package version mismatch: source=$($sourcePackage.version), installed=$($installedPackage.version)"
}

$sourceCommit = (& git -C $sourceRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $sourceCommit -notmatch '^[0-9a-f]{40}$') {
    throw 'ServerSourceRoot is not a readable Git checkout.'
}
$sourceStatus = @(& git -C $sourceRoot status --porcelain)
if ($LASTEXITCODE -ne 0 -or $sourceStatus.Count -gt 0) {
    throw 'ServerSourceRoot must be tracked-clean before deployment.'
}

$relativePaths = @(
    Get-ChildItem -LiteralPath $sourceOut -Recurse -File |
        ForEach-Object {
            $relative = Get-RelativePathForDeployment `
                -BasePath $sourceRoot `
                -Path $_.FullName
            if ([System.IO.Path]::IsPathRooted($relative) -or
                $relative.StartsWith('..')) {
                throw "Built file escaped ServerSourceRoot: $($_.FullName)"
            }
            $relative
        } |
        Sort-Object -Unique
)
if ($relativePaths.Count -lt 1) {
    throw 'The source build contains no compiled output files.'
}
foreach ($requiredRelativePath in @(
        'out\utils\recast.js',
        'out\utils\navigationruntime.js',
        'out\utils\monolithicnavigation.js',
        'out\servers\ZoneServer2016\zoneserver.js'
    )) {
    if ($requiredRelativePath -notin $relativePaths) {
        throw "Clean build is missing required runtime file: $requiredRelativePath"
    }
}

$replacementCount = @($relativePaths | Where-Object {
        Test-Path -LiteralPath (Join-Path $installed $_) -PathType Leaf
    }).Count
$creationCount = $relativePaths.Count - $replacementCount
$keySourceHash = Get-NavigationFileSha256 -Path (
    Join-Path $sourceRoot 'out\utils\recast.js'
)
$keyInstalledHash = Get-NavigationFileSha256 -Path (
    Join-Path $installed 'out\utils\recast.js'
)

if ($Plan) {
    [pscustomobject]@{
        Status               = 'Clean server build deployment plan; no files changed'
        SourceRoot           = $sourceRoot
        SourceCommit         = $sourceCommit
        QuickStart           = $quickStart
        Installed            = $installed
        CompiledFiles        = $relativePaths.Count
        FilesReplaced        = $replacementCount
        FilesCreated         = $creationCount
        SourceRecastSha256   = $keySourceHash
        InstalledRecastSha256 = $keyInstalledHash
    } | Format-List
    return
}

Assert-QuickStartIdle

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupRoot = Join-Path $quickStart "backups\clean-server-build-$stamp"
$stageRoot = Join-Path $quickStart (
    "backups\.clean-server-stage-$stamp-$([guid]::NewGuid().ToString('N'))"
)
if ([System.IO.Path]::GetPathRoot($stageRoot) -ne
    [System.IO.Path]::GetPathRoot($installed)) {
    throw 'Deployment stage and installed server must be on the same filesystem.'
}

try {
    New-NavigationDeploymentStage `
        -SourceRoot $sourceRoot `
        -StageRoot $stageRoot `
        -RelativePaths $relativePaths

    $postReplaceValidation = {
        $installedRecast = Join-Path $installed 'out\utils\recast.js'
        if ((Get-NavigationFileSha256 -Path $installedRecast) -ne $keySourceHash) {
            throw 'Installed recast.js does not match the clean source build.'
        }
        & node -e (
            'const p=require(process.argv[1]);' +
            'if(typeof p.ZoneServer2016!=="function")process.exit(1);' +
            'console.log("clean server module load passed");'
        ) $installed
        if ($LASTEXITCODE -ne 0) {
            throw 'Installed clean server module failed to load.'
        }
    }.GetNewClosure()

    Assert-QuickStartIdle
    $null = Invoke-NavigationRuntimeReplacement `
        -SourceRoot $sourceRoot `
        -StageRoot $stageRoot `
        -DestinationRoot $installed `
        -BackupRoot $backupRoot `
        -RelativePaths $relativePaths `
        -PostReplaceValidation $postReplaceValidation
} finally {
    if (Test-Path -LiteralPath $stageRoot -PathType Container) {
        Remove-Item -LiteralPath $stageRoot -Recurse -Force
    }
}

[pscustomobject]@{
    Status              = 'Clean server build deployed'
    SourceRoot          = $sourceRoot
    SourceCommit        = $sourceCommit
    Installed           = $installed
    CompiledFiles       = $relativePaths.Count
    RecastSha256        = $keySourceHash
    Backup              = $backupRoot
} | Format-List
