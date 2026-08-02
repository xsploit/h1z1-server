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

function New-FixtureArtifactRecord {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root,

        [Parameter(Mandatory = $true)]
        [string]$RelativePath
    )

    $path = Join-Path $Root $RelativePath
    return [ordered]@{
        path   = $RelativePath.Replace('\', '/')
        size   = (Get-Item -LiteralPath $path).Length
        sha256 = Get-NavigationFileSha256 -Path $path
    }
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

    # Runtime and manifested bundle files must commit or roll back together.
    $bundleRoot = Join-Path $testRoot 'staged-bundle'
    $bundleFiles = [ordered]@{
        'collision\z1_cache_0.bin' = 'new-cache-zero'
        'collision\z1_collision.bin' = 'new-collision'
        'navigationTransitions.json' = '[]'
    }
    foreach ($entry in $bundleFiles.GetEnumerator()) {
        Write-TestFile `
            -Path (Join-Path $bundleRoot $entry.Key) `
            -Content $entry.Value
    }
    $fixtureManifest = [ordered]@{
        runtime = [ordered]@{
            cache = [ordered]@{
                parts = @(
                    New-FixtureArtifactRecord `
                        -Root $bundleRoot `
                        -RelativePath 'collision\z1_cache_0.bin'
                )
            }
            collision = [ordered]@{
                file = New-FixtureArtifactRecord `
                    -Root $bundleRoot `
                    -RelativePath 'collision\z1_collision.bin'
            }
            heightmap = $null
            navigationMetadata = $null
            semantics = $null
            transitions = [ordered]@{
                file = New-FixtureArtifactRecord `
                    -Root $bundleRoot `
                    -RelativePath 'navigationTransitions.json'
            }
        }
        provenance = [ordered]@{
            sourceReport = $null
            composition = $null
        }
    }
    $manifestPath = Join-Path $bundleRoot 'navigation-artifact-manifest.json'
    [System.IO.File]::WriteAllText(
        $manifestPath,
        (($fixtureManifest | ConvertTo-Json -Depth 8) + [Environment]::NewLine)
    )

    $combinedDestination = Join-Path $testRoot 'combined-destination'
    foreach ($entry in $newFiles.GetEnumerator()) {
        Write-TestFile `
            -Path (Join-Path $combinedDestination $entry.Key) `
            -Content "old:$($entry.Key)"
    }
    foreach ($entry in $bundleFiles.GetEnumerator()) {
        Write-TestFile `
            -Path (Join-Path $combinedDestination "data\2016\$($entry.Key)") `
            -Content "old:$($entry.Key)"
    }
    Write-TestFile `
        -Path (Join-Path $combinedDestination 'data\2016\collision\z1_cache_1.bin') `
        -Content 'obsolete-cache-one'
    Write-TestFile `
        -Path (Join-Path $combinedDestination 'data\2016\navigation-artifact-manifest.json') `
        -Content 'old-manifest'
    Write-TestFile `
        -Path (Join-Path $combinedDestination 'data\2016\loot.json') `
        -Content 'unrelated-quickstart-data'

    $combinedPlan = @(New-NavigationDeploymentFilePlan `
            -SourceRoot $sourceRoot `
            -RuntimeRelativePaths $closure `
            -BundleRoot $bundleRoot `
            -DestinationRoot $combinedDestination)
    Assert-True `
        -Condition (@($combinedPlan | Where-Object Kind -eq 'manifest').Count -eq 1) `
        -Message 'Combined plan did not include the staged manifest.'
    Assert-True `
        -Condition (@($combinedPlan | Where-Object Action -eq 'Remove').Count -eq 1) `
        -Message 'Combined plan did not scope the obsolete cache part.'
    Assert-True `
        -Condition (-not ($combinedPlan.RelativePath -contains 'data\2016\loot.json')) `
        -Message 'Combined plan included unrelated QuickStart data.'

    $combinedOldHashes = @{}
    foreach ($entry in $combinedPlan) {
        $path = Join-Path $combinedDestination $entry.RelativePath
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            $combinedOldHashes[$entry.RelativePath] = Get-NavigationFileSha256 -Path $path
        }
    }
    $unrelatedHash = Get-NavigationFileSha256 `
        -Path (Join-Path $combinedDestination 'data\2016\loot.json')

    $combinedStageOne = Join-Path $testRoot 'combined-stage-one'
    $combinedBackupOne = Join-Path $testRoot 'combined-backup-one'
    New-NavigationDeploymentStageFromPlan `
        -StageRoot $combinedStageOne `
        -FilePlan $combinedPlan
    $combinedPartialRollback = $false
    try {
        Invoke-NavigationFileReplacement `
            -StageRoot $combinedStageOne `
            -DestinationRoot $combinedDestination `
            -BackupRoot $combinedBackupOne `
            -FilePlan $combinedPlan `
            -TestFailureAfter ($closure.Count + 2)
    } catch {
        $combinedPartialRollback = $_.Exception.Message -like '*rolled back*'
    }
    Assert-True `
        -Condition $combinedPartialRollback `
        -Message 'Combined partial deployment did not report rollback.'
    foreach ($entry in $combinedOldHashes.GetEnumerator()) {
        Assert-True `
            -Condition ((Get-NavigationFileSha256 `
                    -Path (Join-Path $combinedDestination $entry.Key)) -eq $entry.Value) `
            -Message "Combined partial rollback mismatch: $($entry.Key)"
    }

    $combinedStageTwo = Join-Path $testRoot 'combined-stage-two'
    $combinedBackupTwo = Join-Path $testRoot 'combined-backup-two'
    New-NavigationDeploymentStageFromPlan `
        -StageRoot $combinedStageTwo `
        -FilePlan $combinedPlan
    $combinedValidationRollback = $false
    try {
        Invoke-NavigationFileReplacement `
            -StageRoot $combinedStageTwo `
            -DestinationRoot $combinedDestination `
            -BackupRoot $combinedBackupTwo `
            -FilePlan $combinedPlan `
            -PostReplaceValidation { throw 'Injected bundle verification failure.' }
    } catch {
        $combinedValidationRollback = $_.Exception.Message -like '*rolled back*'
    }
    Assert-True `
        -Condition $combinedValidationRollback `
        -Message 'Combined post-verify failure did not report rollback.'
    foreach ($entry in $combinedOldHashes.GetEnumerator()) {
        Assert-True `
            -Condition ((Get-NavigationFileSha256 `
                    -Path (Join-Path $combinedDestination $entry.Key)) -eq $entry.Value) `
            -Message "Combined validation rollback mismatch: $($entry.Key)"
    }
    Assert-True `
        -Condition ((Get-NavigationFileSha256 `
                -Path (Join-Path $combinedDestination 'data\2016\loot.json')) -eq $unrelatedHash) `
        -Message 'Rollback changed unrelated QuickStart data.'

    $combinedStageThree = Join-Path $testRoot 'combined-stage-three'
    $combinedBackupThree = Join-Path $testRoot 'combined-backup-three'
    New-NavigationDeploymentStageFromPlan `
        -StageRoot $combinedStageThree `
        -FilePlan $combinedPlan
    $null = Invoke-NavigationFileReplacement `
        -StageRoot $combinedStageThree `
        -DestinationRoot $combinedDestination `
        -BackupRoot $combinedBackupThree `
        -FilePlan $combinedPlan
    Assert-True `
        -Condition (-not (Test-Path -LiteralPath (
                Join-Path $combinedDestination 'data\2016\collision\z1_cache_1.bin'
            ))) `
        -Message 'Successful deployment retained an obsolete cache part.'
    foreach ($entry in $combinedPlan | Where-Object { $_.Action -ne 'Remove' }) {
        Assert-True `
            -Condition ((Get-NavigationFileSha256 `
                    -Path (Join-Path $combinedDestination $entry.RelativePath)) -eq
                $entry.Sha256) `
            -Message "Combined deployment hash mismatch: $($entry.RelativePath)"
    }
    Assert-True `
        -Condition ((Get-NavigationFileSha256 `
                -Path (Join-Path $combinedDestination 'data\2016\loot.json')) -eq $unrelatedHash) `
        -Message 'Successful deployment changed unrelated QuickStart data.'

    $originalManifest = Get-Content -Raw -LiteralPath $manifestPath
    $fixtureManifest.runtime.cache.parts[0].path = '../escape.bin'
    [System.IO.File]::WriteAllText(
        $manifestPath,
        (($fixtureManifest | ConvertTo-Json -Depth 8) + [Environment]::NewLine)
    )
    $traversalRejected = $false
    try {
        $null = Get-NavigationBundleFileRecords -BundleRoot $bundleRoot
    } catch {
        $traversalRejected = $_.Exception.Message -like '*escaped*'
    }
    Assert-True `
        -Condition $traversalRejected `
        -Message 'Manifest path traversal was not rejected.'
    [System.IO.File]::WriteAllText($manifestPath, $originalManifest)

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
        BundlePartialFailureRolledBack = $combinedPartialRollback
        BundleValidationFailureRolledBack = $combinedValidationRollback
        UnrelatedDataPreserved = $true
        ManifestTraversalRejected = $traversalRejected
    } | Format-List
} finally {
    if (Test-Path -LiteralPath $testRoot -PathType Container) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
