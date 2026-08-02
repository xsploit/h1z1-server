Set-StrictMode -Version Latest

function Get-NavigationFileSha256 {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $stream = [System.IO.File]::OpenRead($Path)
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString(
                $algorithm.ComputeHash($stream)
            )).Replace('-', '').ToLowerInvariant()
    } finally {
        $algorithm.Dispose()
        $stream.Dispose()
    }
}

function Get-NavigationPropertyValue {
    param(
        [AllowNull()]
        [object]$InputObject,

        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    if ($null -eq $InputObject) {
        return $null
    }
    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $null
    }
    return $property.Value
}

function Resolve-NavigationScopedPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root,

        [Parameter(Mandatory = $true)]
        [string]$RelativePath
    )

    if ([string]::IsNullOrWhiteSpace($RelativePath) -or
        [System.IO.Path]::IsPathRooted($RelativePath)) {
        throw "Navigation path must be relative: $RelativePath"
    }
    $rootPath = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    $candidate = [System.IO.Path]::GetFullPath((Join-Path $rootPath $RelativePath))
    $prefix = $rootPath + [System.IO.Path]::DirectorySeparatorChar
    if (-not $candidate.StartsWith(
            $prefix,
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
        throw "Navigation path escaped its scoped root: $RelativePath"
    }
    return $candidate
}

function Get-NavigationBundleFileRecords {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$BundleRoot
    )

    $root = (Resolve-Path -LiteralPath $BundleRoot).Path
    $manifestPath = Join-Path $root 'navigation-artifact-manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "Navigation artifact manifest was not found: $manifestPath"
    }
    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    $records = [System.Collections.Generic.List[object]]::new()
    $seen = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )

    function Add-ManifestFileRecord {
        param(
            [AllowNull()]
            [object]$Record,
            [string]$Label
        )
        if ($null -eq $Record) {
            return
        }
        $relativePath = [string](Get-NavigationPropertyValue $Record 'path')
        $sizeValue = Get-NavigationPropertyValue $Record 'size'
        $sha256 = [string](Get-NavigationPropertyValue $Record 'sha256')
        if ([string]::IsNullOrWhiteSpace($relativePath) -or
            $null -eq $sizeValue -or
            [string]::IsNullOrWhiteSpace($sha256)) {
            throw "Navigation manifest has an invalid $Label file record."
        }
        $size = [long]$sizeValue
        if ($size -lt 0 -or $sha256 -notmatch '^[0-9a-fA-F]{64}$') {
            throw "Navigation manifest has an invalid $Label size or SHA-256."
        }
        $requestedPath = $relativePath.Replace('/', '\')
        $sourcePath = Resolve-NavigationScopedPath `
            -Root $root `
            -RelativePath $requestedPath
        $normalized = Get-RelativePathCompat -BasePath $root -Path $sourcePath
        if (-not $seen.Add($normalized)) {
            throw "Navigation manifest contains a duplicate file path: $relativePath"
        }
        if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
            throw "Manifested navigation file is missing: $relativePath"
        }
        $item = Get-Item -LiteralPath $sourcePath
        if ($item.Length -ne $size) {
            throw "Manifested navigation file size mismatch: $relativePath"
        }
        if ((Get-NavigationFileSha256 -Path $sourcePath) -ne $sha256.ToLowerInvariant()) {
            throw "Manifested navigation file SHA-256 mismatch: $relativePath"
        }
        $records.Add([pscustomobject]@{
                BundleRelativePath = $normalized
                SourcePath         = $sourcePath
                Bytes              = $size
                Sha256             = $sha256.ToLowerInvariant()
            })
    }

    $runtime = Get-NavigationPropertyValue $manifest 'runtime'
    $cache = Get-NavigationPropertyValue $runtime 'cache'
    $parts = @(Get-NavigationPropertyValue $cache 'parts')
    if ($parts.Count -eq 0) {
        throw 'Navigation manifest does not declare any cache parts.'
    }
    foreach ($part in $parts) {
        Add-ManifestFileRecord $part 'cache part'
    }
    foreach ($name in @(
            'collision',
            'heightmap',
            'navigationMetadata',
            'semantics',
            'transitions'
        )) {
        $entry = Get-NavigationPropertyValue $runtime $name
        Add-ManifestFileRecord (Get-NavigationPropertyValue $entry 'file') $name
    }
    $provenance = Get-NavigationPropertyValue $manifest 'provenance'
    $sourceReport = Get-NavigationPropertyValue $provenance 'sourceReport'
    Add-ManifestFileRecord (
        Get-NavigationPropertyValue $sourceReport 'file'
    ) 'source report'
    $composition = Get-NavigationPropertyValue $provenance 'composition'
    if ($null -ne $composition) {
        foreach ($name in @('base', 'regional')) {
            $component = Get-NavigationPropertyValue $composition $name
            Add-ManifestFileRecord (
                Get-NavigationPropertyValue $component 'manifest'
            ) "$name composition manifest"
        }
        $mergeReport = Get-NavigationPropertyValue $composition 'mergeReport'
        Add-ManifestFileRecord $mergeReport 'cache merge report'
    }

    return @($records | Sort-Object BundleRelativePath)
}

function New-NavigationDeploymentFilePlan {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$SourceRoot,

        [Parameter(Mandatory = $true)]
        [string[]]$RuntimeRelativePaths,

        [Parameter(Mandatory = $true)]
        [string]$BundleRoot,

        [Parameter(Mandatory = $true)]
        [string]$DestinationRoot
    )

    $source = (Resolve-Path -LiteralPath $SourceRoot).Path
    $bundle = (Resolve-Path -LiteralPath $BundleRoot).Path
    $destination = [System.IO.Path]::GetFullPath($DestinationRoot)
    $entries = [System.Collections.Generic.List[object]]::new()
    $seen = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )

    function Add-DeploymentSource {
        param(
            [string]$RelativePath,
            [string]$SourcePath,
            [long]$Bytes,
            [string]$Sha256,
            [string]$Kind
        )
        $requestedPath = $RelativePath.Replace('/', '\')
        $target = Resolve-NavigationScopedPath `
            -Root $destination `
            -RelativePath $requestedPath
        $normalized = Get-RelativePathCompat `
            -BasePath $destination `
            -Path $target
        if (-not $seen.Add($normalized)) {
            throw "Deployment plan contains a duplicate target: $normalized"
        }
        $entries.Add([pscustomobject]@{
                RelativePath = $normalized
                SourcePath   = $SourcePath
                Action       = if (Test-Path -LiteralPath $target -PathType Leaf) {
                    'Replace'
                } else {
                    'Create'
                }
                Bytes        = $Bytes
                Sha256       = $Sha256
                Kind         = $Kind
            })
    }

    foreach ($relativePath in ($RuntimeRelativePaths | Sort-Object)) {
        $sourcePath = Resolve-NavigationScopedPath `
            -Root $source `
            -RelativePath $relativePath
        if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
            throw "Built runtime file is missing: $sourcePath"
        }
        Add-DeploymentSource `
            -RelativePath $relativePath `
            -SourcePath $sourcePath `
            -Bytes (Get-Item -LiteralPath $sourcePath).Length `
            -Sha256 (Get-NavigationFileSha256 -Path $sourcePath) `
            -Kind 'runtime'
    }

    $bundleRecords = @(Get-NavigationBundleFileRecords -BundleRoot $bundle)
    $expectedCacheTargets = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    foreach ($record in $bundleRecords) {
        $targetRelative = Join-Path 'data\2016' $record.BundleRelativePath
        Add-DeploymentSource `
            -RelativePath $targetRelative `
            -SourcePath $record.SourcePath `
            -Bytes $record.Bytes `
            -Sha256 $record.Sha256 `
            -Kind 'bundle'
        if ($record.BundleRelativePath -match '^collision\\z1_cache_\d+\.bin$') {
            [void]$expectedCacheTargets.Add($targetRelative)
        }
    }

    $installedCache = Join-Path $destination 'data\2016\collision'
    if (Test-Path -LiteralPath $installedCache -PathType Container) {
        foreach ($file in Get-ChildItem -LiteralPath $installedCache -File) {
            if ($file.Name -notmatch '^z1_cache_\d+\.bin$') {
                continue
            }
            $relativePath = Join-Path 'data\2016\collision' $file.Name
            if (-not $expectedCacheTargets.Contains($relativePath)) {
                if (-not $seen.Add($relativePath)) {
                    throw "Deployment plan contains a duplicate target: $relativePath"
                }
                $entries.Add([pscustomobject]@{
                        RelativePath = $relativePath
                        SourcePath   = $null
                        Action       = 'Remove'
                        Bytes        = $file.Length
                        Sha256       = $null
                        Kind         = 'obsolete-cache'
                    })
            }
        }
    }

    $manifestPath = Join-Path $bundle 'navigation-artifact-manifest.json'
    Add-DeploymentSource `
        -RelativePath 'data\2016\navigation-artifact-manifest.json' `
        -SourcePath $manifestPath `
        -Bytes (Get-Item -LiteralPath $manifestPath).Length `
        -Sha256 (Get-NavigationFileSha256 -Path $manifestPath) `
        -Kind 'manifest'

    return @($entries)
}

function New-NavigationDeploymentStageFromPlan {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$StageRoot,

        [Parameter(Mandatory = $true)]
        [object[]]$FilePlan
    )

    if (Test-Path -LiteralPath $StageRoot) {
        throw "Deployment stage already exists: $StageRoot"
    }
    New-Item -ItemType Directory -Path $StageRoot | Out-Null
    foreach ($entry in $FilePlan) {
        if ($entry.Action -eq 'Remove') {
            continue
        }
        $stagePath = Resolve-NavigationScopedPath `
            -Root $StageRoot `
            -RelativePath $entry.RelativePath
        New-Item -ItemType Directory -Path (Split-Path -Parent $stagePath) -Force |
            Out-Null
        Copy-Item -LiteralPath $entry.SourcePath -Destination $stagePath
        if ((Get-Item -LiteralPath $stagePath).Length -ne $entry.Bytes -or
            (Get-NavigationFileSha256 -Path $stagePath) -ne $entry.Sha256) {
            throw "Staged deployment file verification failed: $($entry.RelativePath)"
        }
    }
}

function Invoke-NavigationFileReplacement {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$StageRoot,

        [Parameter(Mandatory = $true)]
        [string]$DestinationRoot,

        [Parameter(Mandatory = $true)]
        [string]$BackupRoot,

        [Parameter(Mandatory = $true)]
        [object[]]$FilePlan,

        [scriptblock]$PostReplaceValidation,

        [int]$TestFailureAfter = -1
    )

    if (Test-Path -LiteralPath $BackupRoot) {
        throw "Deployment backup already exists: $BackupRoot"
    }
    New-Item -ItemType Directory -Path $BackupRoot | Out-Null
    $records = @()
    foreach ($entry in $FilePlan) {
        $destinationPath = Resolve-NavigationScopedPath `
            -Root $DestinationRoot `
            -RelativePath $entry.RelativePath
        $backupPath = Resolve-NavigationScopedPath `
            -Root $BackupRoot `
            -RelativePath $entry.RelativePath
        $existed = Test-Path -LiteralPath $destinationPath -PathType Leaf
        if ($existed) {
            New-Item -ItemType Directory -Path (Split-Path -Parent $backupPath) -Force |
                Out-Null
            Copy-Item -LiteralPath $destinationPath -Destination $backupPath
            if ((Get-NavigationFileSha256 -Path $destinationPath) -ne
                (Get-NavigationFileSha256 -Path $backupPath)) {
                throw "Backup hash mismatch: $($entry.RelativePath)"
            }
        }
        $records += [pscustomobject]@{
            RelativePath = $entry.RelativePath
            Destination  = $destinationPath
            Backup       = $backupPath
            Existed      = $existed
            Action       = $entry.Action
            Sha256       = $entry.Sha256
        }
    }
    [System.IO.File]::WriteAllText(
        (Join-Path $BackupRoot 'deployment-plan.json'),
        (($FilePlan | ConvertTo-Json -Depth 4) + [Environment]::NewLine)
    )

    $completed = [System.Collections.Generic.List[object]]::new()
    try {
        foreach ($record in $records) {
            if ($record.Action -eq 'Remove') {
                if ($record.Existed) {
                    Remove-Item -LiteralPath $record.Destination -Force
                }
            } else {
                $stagePath = Resolve-NavigationScopedPath `
                    -Root $StageRoot `
                    -RelativePath $record.RelativePath
                New-Item -ItemType Directory `
                    -Path (Split-Path -Parent $record.Destination) `
                    -Force | Out-Null
                if ($record.Existed) {
                    $swap = "$($record.Destination).swap-$([guid]::NewGuid().ToString('N'))"
                    try {
                        [System.IO.File]::Replace(
                            $stagePath,
                            $record.Destination,
                            $swap,
                            $true
                        )
                    } finally {
                        if (Test-Path -LiteralPath $swap -PathType Leaf) {
                            Remove-Item -LiteralPath $swap -Force -ErrorAction SilentlyContinue
                        }
                    }
                } else {
                    [System.IO.File]::Move($stagePath, $record.Destination)
                }
                # Record the mutation before verification so a hash failure also
                # restores the file that was just replaced or created.
                $completed.Add($record)
                if ((Get-NavigationFileSha256 -Path $record.Destination) -ne
                    $record.Sha256) {
                    throw "Installed file hash mismatch: $($record.RelativePath)"
                }
            }
            if ($record.Action -eq 'Remove') {
                $completed.Add($record)
            }
            if ($TestFailureAfter -ge 0 -and
                $completed.Count -ge $TestFailureAfter) {
                throw "Injected deployment failure after $TestFailureAfter operation(s)."
            }
        }
        if ($PostReplaceValidation) {
            & $PostReplaceValidation
        }
    } catch {
        $deploymentError = $_
        $rollbackErrors = @()
        $rollbackRecords = @($completed)
        [array]::Reverse($rollbackRecords)
        foreach ($record in $rollbackRecords) {
            try {
                if ($record.Existed) {
                    $candidate = "$($record.Destination).rollback-$([guid]::NewGuid().ToString('N'))"
                    Copy-Item -LiteralPath $record.Backup -Destination $candidate
                    if (Test-Path -LiteralPath $record.Destination -PathType Leaf) {
                        $swap = "$($record.Destination).swap-$([guid]::NewGuid().ToString('N'))"
                        try {
                            [System.IO.File]::Replace(
                                $candidate,
                                $record.Destination,
                                $swap,
                                $true
                            )
                        } finally {
                            if (Test-Path -LiteralPath $swap -PathType Leaf) {
                                Remove-Item -LiteralPath $swap -Force -ErrorAction SilentlyContinue
                            }
                        }
                    } else {
                        [System.IO.File]::Move($candidate, $record.Destination)
                    }
                    if ((Get-NavigationFileSha256 -Path $record.Destination) -ne
                        (Get-NavigationFileSha256 -Path $record.Backup)) {
                        throw "Rollback hash mismatch: $($record.RelativePath)"
                    }
                } elseif (Test-Path -LiteralPath $record.Destination -PathType Leaf) {
                    Remove-Item -LiteralPath $record.Destination -Force
                }
            } catch {
                $rollbackErrors += $_.Exception.Message
            }
        }
        if ($rollbackErrors.Count -gt 0) {
            throw "Deployment failed: $($deploymentError.Exception.Message); rollback also failed: $($rollbackErrors -join '; ')"
        }
        throw "Deployment failed and was rolled back: $($deploymentError.Exception.Message)"
    }
    return $records
}

function Get-RelativePathCompat {
    param(
        [Parameter(Mandatory = $true)]
        [string]$BasePath,

        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $baseWithSeparator = [System.IO.Path]::GetFullPath($BasePath).TrimEnd('\', '/') + '\'
    $baseUri = [System.Uri]$baseWithSeparator
    $pathUri = [System.Uri][System.IO.Path]::GetFullPath($Path)
    return [System.Uri]::UnescapeDataString(
        $baseUri.MakeRelativeUri($pathUri).ToString()
    ).Replace('/', '\')
}

function Resolve-LocalRuntimeDependency {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Importer,

        [Parameter(Mandatory = $true)]
        [string]$Request
    )

    $basePath = [System.IO.Path]::GetFullPath(
        (Join-Path (Split-Path -Parent $Importer) $Request)
    )
    $candidates = if ([System.IO.Path]::HasExtension($basePath)) {
        @($basePath)
    } else {
        @("$basePath.js", "$basePath.json", (Join-Path $basePath 'index.js'))
    }

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return [System.IO.Path]::GetFullPath($candidate)
        }
    }

    throw "Local runtime dependency '$Request' imported by '$Importer' was not built."
}

function Get-NavigationRuntimeClosure {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$SourceRoot,

        [string]$EntryRelativePath = 'out\utils\recast.js'
    )

    $root = (Resolve-Path -LiteralPath $SourceRoot).Path
    $rootPrefix = $root.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    $entry = [System.IO.Path]::GetFullPath((Join-Path $root $EntryRelativePath))
    if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
        throw "Navigation runtime entry point was not built: $entry"
    }

    $queue = [System.Collections.Generic.Queue[string]]::new()
    $queue.Enqueue($entry)
    $runtimeFiles = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    $visitedModules = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )

    while ($queue.Count -gt 0) {
        $module = $queue.Dequeue()
        if (-not $visitedModules.Add($module)) {
            continue
        }
        if (-not $module.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Runtime dependency escaped the source root: $module"
        }

        [void]$runtimeFiles.Add($module)
        if ([System.IO.Path]::GetExtension($module) -ne '.js') {
            continue
        }

        foreach ($companionSuffix in @('.map', '.d.ts')) {
            $companion = if ($companionSuffix -eq '.map') {
                "$module.map"
            } else {
                [System.IO.Path]::ChangeExtension($module, $companionSuffix)
            }
            if (Test-Path -LiteralPath $companion -PathType Leaf) {
                [void]$runtimeFiles.Add([System.IO.Path]::GetFullPath($companion))
            }
        }

        $content = Get-Content -Raw -LiteralPath $module
        $matches = [regex]::Matches(
            $content,
            'require\(\s*["''](?<request>\.[^"'']+)["'']\s*\)'
        )
        foreach ($match in $matches) {
            $dependency = Resolve-LocalRuntimeDependency `
                -Importer $module `
                -Request $match.Groups['request'].Value
            if (-not $dependency.StartsWith(
                    $rootPrefix,
                    [System.StringComparison]::OrdinalIgnoreCase
                )) {
                throw "Runtime dependency escaped the source root: $dependency"
            }
            $queue.Enqueue($dependency)
        }
    }

    return @(
        $runtimeFiles |
            ForEach-Object {
                Get-RelativePathCompat -BasePath $root -Path $_
            } |
            Sort-Object
    )
}

function Test-NavigationDeploymentStage {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$SourceRoot,

        [Parameter(Mandatory = $true)]
        [string]$StageRoot,

        [Parameter(Mandatory = $true)]
        [string[]]$RelativePaths
    )

    foreach ($relativePath in $RelativePaths) {
        $sourcePath = Join-Path $SourceRoot $relativePath
        $stagePath = Join-Path $StageRoot $relativePath
        if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
            throw "Built runtime file is missing: $sourcePath"
        }
        if (-not (Test-Path -LiteralPath $stagePath -PathType Leaf)) {
            throw "Staged runtime file is missing: $stagePath"
        }
        $sourceHash = Get-NavigationFileSha256 -Path $sourcePath
        $stageHash = Get-NavigationFileSha256 -Path $stagePath
        if ($sourceHash -ne $stageHash) {
            throw "Staged runtime file hash mismatch: $relativePath"
        }
    }
}

function New-NavigationDeploymentStage {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$SourceRoot,

        [Parameter(Mandatory = $true)]
        [string]$StageRoot,

        [Parameter(Mandatory = $true)]
        [string[]]$RelativePaths
    )

    if (Test-Path -LiteralPath $StageRoot) {
        throw "Deployment stage already exists: $StageRoot"
    }
    New-Item -ItemType Directory -Path $StageRoot | Out-Null

    foreach ($relativePath in $RelativePaths) {
        $sourcePath = Join-Path $SourceRoot $relativePath
        if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
            throw "Built runtime file is missing: $sourcePath"
        }
        $stagePath = Join-Path $StageRoot $relativePath
        New-Item -ItemType Directory -Path (Split-Path -Parent $stagePath) -Force |
            Out-Null
        Copy-Item -LiteralPath $sourcePath -Destination $stagePath
    }

    Test-NavigationDeploymentStage `
        -SourceRoot $SourceRoot `
        -StageRoot $StageRoot `
        -RelativePaths $RelativePaths
}

function Invoke-NavigationRuntimeReplacement {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$SourceRoot,

        [Parameter(Mandatory = $true)]
        [string]$StageRoot,

        [Parameter(Mandatory = $true)]
        [string]$DestinationRoot,

        [Parameter(Mandatory = $true)]
        [string]$BackupRoot,

        [Parameter(Mandatory = $true)]
        [string[]]$RelativePaths,

        [scriptblock]$PostReplaceValidation,

        [int]$TestFailureAfter = -1
    )

    Test-NavigationDeploymentStage `
        -SourceRoot $SourceRoot `
        -StageRoot $StageRoot `
        -RelativePaths $RelativePaths

    if (Test-Path -LiteralPath $BackupRoot) {
        throw "Deployment backup already exists: $BackupRoot"
    }
    New-Item -ItemType Directory -Path $BackupRoot | Out-Null

    $records = @()
    foreach ($relativePath in $RelativePaths) {
        $destinationPath = Join-Path $DestinationRoot $relativePath
        $backupPath = Join-Path $BackupRoot $relativePath
        $existed = Test-Path -LiteralPath $destinationPath -PathType Leaf
        if ($existed) {
            New-Item -ItemType Directory -Path (Split-Path -Parent $backupPath) -Force |
                Out-Null
            Copy-Item -LiteralPath $destinationPath -Destination $backupPath
            if ((Get-NavigationFileSha256 -Path $destinationPath) -ne
                (Get-NavigationFileSha256 -Path $backupPath)) {
                throw "Backup hash mismatch: $relativePath"
            }
        }
        $records += [pscustomobject]@{
            RelativePath = $relativePath
            Destination  = $destinationPath
            Backup       = $backupPath
            Existed      = $existed
            SourceHash   = Get-NavigationFileSha256 -Path (Join-Path $SourceRoot $relativePath)
        }
    }

    $planPath = Join-Path $BackupRoot 'deployment-plan.json'
    [System.IO.File]::WriteAllText(
        $planPath,
        (($records | ConvertTo-Json -Depth 3) + [Environment]::NewLine)
    )

    $completed = [System.Collections.Generic.List[object]]::new()
    try {
        foreach ($record in $records) {
            $stagePath = Join-Path $StageRoot $record.RelativePath
            New-Item -ItemType Directory `
                -Path (Split-Path -Parent $record.Destination) `
                -Force | Out-Null

            if ($record.Existed) {
                $swapBackup = "$($record.Destination).swap-$([guid]::NewGuid().ToString('N'))"
                try {
                    [System.IO.File]::Replace(
                        $stagePath,
                        $record.Destination,
                        $swapBackup,
                        $true
                    )
                } finally {
                    if (Test-Path -LiteralPath $swapBackup -PathType Leaf) {
                        Remove-Item -LiteralPath $swapBackup -Force -ErrorAction SilentlyContinue
                    }
                }
            } else {
                [System.IO.File]::Move($stagePath, $record.Destination)
            }
            $completed.Add($record)

            if ((Get-NavigationFileSha256 -Path $record.Destination) -ne $record.SourceHash) {
                throw "Installed runtime file hash mismatch: $($record.RelativePath)"
            }
            if ($TestFailureAfter -ge 0 -and
                $completed.Count -ge $TestFailureAfter) {
                throw "Injected deployment failure after $TestFailureAfter replacement(s)."
            }
        }

        if ($PostReplaceValidation) {
            & $PostReplaceValidation
        }
    } catch {
        $deploymentError = $_
        $rollbackErrors = @()
        $rollbackRecords = @($completed)
        [array]::Reverse($rollbackRecords)
        foreach ($record in $rollbackRecords) {
            try {
                if ($record.Existed) {
                    if (-not (Test-Path -LiteralPath $record.Backup -PathType Leaf)) {
                        throw "Backup is missing: $($record.Backup)"
                    }
                    $rollbackCandidate = "$($record.Destination).rollback-$([guid]::NewGuid().ToString('N'))"
                    Copy-Item -LiteralPath $record.Backup -Destination $rollbackCandidate
                    if (Test-Path -LiteralPath $record.Destination -PathType Leaf) {
                        $rollbackSwapBackup = "$($record.Destination).swap-$([guid]::NewGuid().ToString('N'))"
                        try {
                            [System.IO.File]::Replace(
                                $rollbackCandidate,
                                $record.Destination,
                                $rollbackSwapBackup,
                                $true
                            )
                        } finally {
                            if (Test-Path -LiteralPath $rollbackSwapBackup -PathType Leaf) {
                                Remove-Item `
                                    -LiteralPath $rollbackSwapBackup `
                                    -Force `
                                    -ErrorAction SilentlyContinue
                            }
                        }
                    } else {
                        [System.IO.File]::Move(
                            $rollbackCandidate,
                            $record.Destination
                        )
                    }
                    if ((Get-NavigationFileSha256 -Path $record.Destination) -ne
                        (Get-NavigationFileSha256 -Path $record.Backup)) {
                        throw "Rollback hash mismatch: $($record.RelativePath)"
                    }
                } elseif (Test-Path -LiteralPath $record.Destination -PathType Leaf) {
                    Remove-Item -LiteralPath $record.Destination -Force
                }
            } catch {
                $rollbackErrors += $_.Exception.Message
            }
        }

        if ($rollbackErrors.Count -gt 0) {
            throw "Deployment failed: $($deploymentError.Exception.Message); rollback also failed: $($rollbackErrors -join '; ')"
        }
        throw "Deployment failed and was rolled back: $($deploymentError.Exception.Message)"
    }

    return $records
}

Export-ModuleMember -Function @(
    'Get-NavigationFileSha256',
    'Get-NavigationBundleFileRecords',
    'Get-NavigationRuntimeClosure',
    'New-NavigationDeploymentFilePlan',
    'New-NavigationDeploymentStage',
    'New-NavigationDeploymentStageFromPlan',
    'Test-NavigationDeploymentStage',
    'Invoke-NavigationFileReplacement',
    'Invoke-NavigationRuntimeReplacement'
)
