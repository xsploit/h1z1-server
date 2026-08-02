$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Import-Module (Join-Path $PSScriptRoot 'NavigationDeployment.psm1') -Force

function Assert-True {
    param(
        [Parameter(Mandatory = $true)]
        [bool]$Condition,

        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

function Write-TestFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$Content
    )

    New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force |
        Out-Null
    [System.IO.File]::WriteAllText($Path, $Content)
}

$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) (
    "h1z1-navigation-deployment-$([guid]::NewGuid().ToString('N'))"
)
$sourceRoot = Join-Path $testRoot 'source'
$destinationRoot = Join-Path $testRoot 'destination'

try {
    $newFiles = [ordered]@{
        'out\utils\recast.js' = 'require("./navigationareas");'
        'out\utils\recast.js.map' = '{"version":3}'
        'out\utils\recast.d.ts' = 'export declare const recast: boolean;'
        'out\utils\navigationareas.js' = 'exports.NavigationArea = { Terrain: 1 };'
        'out\utils\navigationareas.js.map' = '{"version":3}'
        'out\utils\navigationareas.d.ts' = 'export declare enum NavigationArea { Terrain = 1 }'
    }
    foreach ($entry in $newFiles.GetEnumerator()) {
        Write-TestFile `
            -Path (Join-Path $sourceRoot $entry.Key) `
            -Content $entry.Value
        Write-TestFile `
            -Path (Join-Path $destinationRoot $entry.Key) `
            -Content "old:$($entry.Key)"
    }

    $closure = @(Get-NavigationRuntimeClosure -SourceRoot $sourceRoot)
    Assert-True `
        -Condition ($closure.Count -eq $newFiles.Count) `
        -Message "Expected $($newFiles.Count) runtime files, found $($closure.Count)."
    Assert-True `
        -Condition ('out\utils\navigationareas.js' -in $closure) `
        -Message 'The runtime closure omitted navigationareas.js.'

    $oldHashes = @{}
    foreach ($relativePath in $closure) {
        $oldHashes[$relativePath] = Get-NavigationFileSha256 `
            -Path (Join-Path $destinationRoot $relativePath)
    }

    $stageOne = Join-Path $testRoot 'stage-one'
    $backupOne = Join-Path $testRoot 'backup-one'
    New-NavigationDeploymentStage `
        -SourceRoot $sourceRoot `
        -StageRoot $stageOne `
        -RelativePaths $closure
    $injectedFailure = $false
    try {
        Invoke-NavigationRuntimeReplacement `
            -SourceRoot $sourceRoot `
            -StageRoot $stageOne `
            -DestinationRoot $destinationRoot `
            -BackupRoot $backupOne `
            -RelativePaths $closure `
            -TestFailureAfter 1
    } catch {
        $injectedFailure = $_.Exception.Message -like '*rolled back*'
    }
    Assert-True `
        -Condition $injectedFailure `
        -Message 'Injected partial replacement did not report a rollback.'
    foreach ($relativePath in $closure) {
        $actual = Get-NavigationFileSha256 `
            -Path (Join-Path $destinationRoot $relativePath)
        Assert-True `
            -Condition ($actual -eq $oldHashes[$relativePath]) `
            -Message "Partial replacement was not rolled back: $relativePath"
    }

    $stageTwo = Join-Path $testRoot 'stage-two'
    $backupTwo = Join-Path $testRoot 'backup-two'
    New-NavigationDeploymentStage `
        -SourceRoot $sourceRoot `
        -StageRoot $stageTwo `
        -RelativePaths $closure
    $validationFailure = $false
    try {
        Invoke-NavigationRuntimeReplacement `
            -SourceRoot $sourceRoot `
            -StageRoot $stageTwo `
            -DestinationRoot $destinationRoot `
            -BackupRoot $backupTwo `
            -RelativePaths $closure `
            -PostReplaceValidation { throw 'Injected post-replace validation failure.' }
    } catch {
        $validationFailure = $_.Exception.Message -like '*rolled back*'
    }
    Assert-True `
        -Condition $validationFailure `
        -Message 'Post-replace validation failure did not report a rollback.'
    foreach ($relativePath in $closure) {
        $actual = Get-NavigationFileSha256 `
            -Path (Join-Path $destinationRoot $relativePath)
        Assert-True `
            -Condition ($actual -eq $oldHashes[$relativePath]) `
            -Message "Validation failure was not rolled back: $relativePath"
    }

    $stageThree = Join-Path $testRoot 'stage-three'
    $backupThree = Join-Path $testRoot 'backup-three'
    New-NavigationDeploymentStage `
        -SourceRoot $sourceRoot `
        -StageRoot $stageThree `
        -RelativePaths $closure
    $null = Invoke-NavigationRuntimeReplacement `
        -SourceRoot $sourceRoot `
        -StageRoot $stageThree `
        -DestinationRoot $destinationRoot `
        -BackupRoot $backupThree `
        -RelativePaths $closure
    foreach ($relativePath in $closure) {
        $sourceHash = Get-NavigationFileSha256 `
            -Path (Join-Path $sourceRoot $relativePath)
        $destinationHash = Get-NavigationFileSha256 `
            -Path (Join-Path $destinationRoot $relativePath)
        Assert-True `
            -Condition ($sourceHash -eq $destinationHash) `
            -Message "Successful deployment hash mismatch: $relativePath"
    }

    $repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    $actualClosure = @(Get-NavigationRuntimeClosure -SourceRoot $repositoryRoot)
    foreach ($requiredFile in @(
            'out\utils\recast.js',
            'out\utils\navigationareas.js',
            'out\utils\navigationartifacts.js',
            'out\utils\runtimewatchdog.js'
        )) {
        Assert-True `
            -Condition ($requiredFile -in $actualClosure) `
            -Message "Actual runtime closure omitted $requiredFile."
    }

    [pscustomobject]@{
        Status = 'Navigation deployment tests passed'
        FixtureFiles = $closure.Count
        ActualRuntimeFiles = $actualClosure.Count
        IncludesNavigationAreas = 'out\utils\navigationareas.js' -in $actualClosure
        PartialFailureRolledBack = $injectedFailure
        ValidationFailureRolledBack = $validationFailure
    } | Format-List
} finally {
    if (Test-Path -LiteralPath $testRoot -PathType Container) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
