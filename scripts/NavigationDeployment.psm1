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
    'Get-NavigationRuntimeClosure',
    'New-NavigationDeploymentStage',
    'Test-NavigationDeploymentStage',
    'Invoke-NavigationRuntimeReplacement'
)
