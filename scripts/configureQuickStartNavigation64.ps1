param(
    [Parameter(Mandatory = $true)]
    [string]$QuickStartRoot,

    [Alias('DryRun', 'List')]
    [switch]$Plan
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Import-Module (Join-Path $PSScriptRoot 'NavigationDeployment.psm1') -Force

$sourceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$tsxCli = Join-Path $sourceRoot 'node_modules\tsx\dist\cli.mjs'
$quickStart = (Resolve-Path -LiteralPath $QuickStartRoot).Path
$launcherPath = Join-Path $quickStart 'h1emu-2016.js'
$runtimeRoot = Join-Path $quickStart 'node_modules\h1z1-server\runtime\navigation64'
$runtimeSelectorPath = Join-Path $quickStart 'node_modules\h1z1-server\out\utils\navigationruntime.js'
$recastRuntimePath = Join-Path $quickStart 'node_modules\h1z1-server\out\utils\recast.js'
$bootstrapSource = Join-Path $PSScriptRoot 'quickstartNavigation64Bootstrap.js'
$bootstrapLine = 'require("./navigation64-bootstrap")({ enableByDefault: true });'

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
                    $commandLine.IndexOf(
                        $quickStart,
                        [System.StringComparison]::OrdinalIgnoreCase
                    ) -ge 0) -or
                $commandLine -match 'h1emu-2016\.js|h1z1-server-demo-2016')
        })
    if ($inUse.Count -gt 0) {
        throw "The installed server is in use by PID(s): $($inUse.ProcessId -join ', ')"
    }
}

if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
    throw "QuickStart launcher was not found: $launcherPath"
}
if (-not (Test-Path -LiteralPath $bootstrapSource -PathType Leaf)) {
    throw "Navigation64 bootstrap source was not found: $bootstrapSource"
}
foreach ($requiredRuntimeFile in @($runtimeSelectorPath, $recastRuntimePath)) {
    if (-not (Test-Path -LiteralPath $requiredRuntimeFile -PathType Leaf)) {
        throw "Installed h1z1-server does not contain the navigation64 integration: $requiredRuntimeFile"
    }
}
$runtimeSelectorText = [System.IO.File]::ReadAllText($runtimeSelectorPath)
$recastRuntimeText = [System.IO.File]::ReadAllText($recastRuntimePath)
if (-not $runtimeSelectorText.Contains('selectNavigationRuntime') -or
    -not $recastRuntimeText.Contains('NAV_MONOLITHIC_64') -or
    -not $recastRuntimeText.Contains('require("./navigationruntime")')) {
    throw 'Installed h1z1-server is not a compatible navigation64 build.'
}

if (-not (Test-Path -LiteralPath $tsxCli -PathType Leaf)) {
    throw "This checkout's tsx runtime was not found: $tsxCli"
}
& node $tsxCli (Join-Path $PSScriptRoot 'verifyNavigation64Runtime.ts') `
    --runtime-root $runtimeRoot
if ($LASTEXITCODE -ne 0) {
    throw 'Install and verify the packaged navigation64 runtime before configuring Play.'
}

$launcherText = [System.IO.File]::ReadAllText($launcherPath)
$alreadyConfigured = $launcherText.Contains($bootstrapLine)
if ($Plan) {
    [pscustomobject]@{
        Status            = 'QuickStart navigation64 configuration plan; no files changed'
        QuickStart        = $quickStart
        Launcher          = $launcherPath
        RuntimeRoot       = $runtimeRoot
        AlreadyConfigured = $alreadyConfigured
        LauncherAction    = if ($alreadyConfigured) { 'Keep' } else { 'Inject bootstrap' }
        BootstrapAction   = if (Test-Path -LiteralPath (Join-Path $quickStart 'navigation64-bootstrap.js')) {
            'Replace'
        } else {
            'Create'
        }
    } | Format-List
    return
}

Assert-QuickStartIdle

if (-not $alreadyConfigured) {
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
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$sourceStage = Join-Path $quickStart (
    "backups\.navigation64-launcher-source-$stamp-$([guid]::NewGuid().ToString('N'))"
)
$replacementStage = Join-Path $quickStart (
    "backups\.navigation64-launcher-stage-$stamp-$([guid]::NewGuid().ToString('N'))"
)
$backupRoot = Join-Path $quickStart "backups\navigation64-launcher-$stamp"
$relativePaths = @('h1emu-2016.js', 'navigation64-bootstrap.js')

try {
    New-Item -ItemType Directory -Path $sourceStage | Out-Null
    [System.IO.File]::WriteAllText(
        (Join-Path $sourceStage 'h1emu-2016.js'),
        $launcherText
    )
    Copy-Item `
        -LiteralPath $bootstrapSource `
        -Destination (Join-Path $sourceStage 'navigation64-bootstrap.js')

    New-NavigationDeploymentStage `
        -SourceRoot $sourceStage `
        -StageRoot $replacementStage `
        -RelativePaths $relativePaths

    $postReplaceValidation = {
        & node --check (Join-Path $quickStart 'h1emu-2016.js')
        if ($LASTEXITCODE -ne 0) { throw 'Configured QuickStart launcher has invalid syntax.' }
        & node --check (Join-Path $quickStart 'navigation64-bootstrap.js')
        if ($LASTEXITCODE -ne 0) { throw 'Installed navigation64 bootstrap has invalid syntax.' }
        & node -e (
            'const configure=require(process.argv[1]);' +
            'const env={};const result=configure({environment:env,quickStartRoot:process.argv[2],enableByDefault:true});' +
            'if(!result.enabled||env.NAV_MONOLITHIC_64!=="1"||env.NAV_STREAMING!=="0")process.exit(1);' +
            'console.log(JSON.stringify(result));'
        ) (Join-Path $quickStart 'navigation64-bootstrap.js') $quickStart
        if ($LASTEXITCODE -ne 0) { throw 'Installed navigation64 bootstrap failed its smoke test.' }
    }.GetNewClosure()

    Assert-QuickStartIdle
    $null = Invoke-NavigationRuntimeReplacement `
        -SourceRoot $sourceStage `
        -StageRoot $replacementStage `
        -DestinationRoot $quickStart `
        -BackupRoot $backupRoot `
        -RelativePaths $relativePaths `
        -PostReplaceValidation $postReplaceValidation
} finally {
    foreach ($temporaryRoot in @($replacementStage, $sourceStage)) {
        if (Test-Path -LiteralPath $temporaryRoot -PathType Container) {
            Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
        }
    }
}

[pscustomobject]@{
    Status      = 'QuickStart Play configured for packaged navigation64 runtime'
    QuickStart  = $quickStart
    Launcher    = $launcherPath
    RuntimeRoot = $runtimeRoot
    Backup      = $backupRoot
} | Format-List
