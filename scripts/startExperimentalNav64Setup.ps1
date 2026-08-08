param(
    [string]$H1Z1Assets,
    [string]$QuickStartRoot,
    [string]$WorkRoot,
    [switch]$Plan,
    [switch]$Yes
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$package = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$builder = Join-Path $PSScriptRoot 'buildAndInstallExperimentalNav64.ps1'

function Resolve-AssetsDirectory([string]$Candidate) {
    if ([string]::IsNullOrWhiteSpace($Candidate)) { return $null }
    $root = [System.IO.Path]::GetFullPath($Candidate)
    foreach ($path in @($root, (Join-Path $root 'Assets'), (Join-Path $root 'Resources\Assets'))) {
        if ((Test-Path -LiteralPath $path -PathType Container) -and
            @(Get-ChildItem -LiteralPath $path -Filter 'Assets_*.pack' -File -ErrorAction SilentlyContinue).Count -gt 0) {
            return (Resolve-Path -LiteralPath $path).Path
        }
    }
    return $null
}

function Resolve-QuickStartDirectory([string]$Candidate) {
    if ([string]::IsNullOrWhiteSpace($Candidate)) { return $null }
    $root = [System.IO.Path]::GetFullPath($Candidate)
    if (Test-Path -LiteralPath (Join-Path $root 'h1emu-2016.js') -PathType Leaf) {
        return (Resolve-Path -LiteralPath $root).Path
    }
    return $null
}

function Select-Folder([string]$Description) {
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = $Description
    $dialog.ShowNewFolderButton = $false
    if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
        throw 'Setup was cancelled.'
    }
    return $dialog.SelectedPath
}

if ([string]::IsNullOrWhiteSpace($H1Z1Assets)) {
    $assetCandidates = @(
        (Join-Path $env:USERPROFILE 'Documents\H1Z1-2016\Resources\Assets'),
        (Join-Path ${env:ProgramFiles(x86)} 'Steam\steamapps\content\app_295110\depot_295111\Resources\Assets'),
        (Join-Path ${env:ProgramFiles(x86)} 'Steam\steamapps\common\H1Z1\Resources\Assets'),
        (Join-Path $env:ProgramFiles 'Steam\steamapps\common\H1Z1\Resources\Assets')
    )
    foreach ($candidate in $assetCandidates) {
        $resolved = Resolve-AssetsDirectory $candidate
        if ($null -ne $resolved) { $H1Z1Assets = $resolved; break }
    }
}
$H1Z1Assets = Resolve-AssetsDirectory $H1Z1Assets
if ($null -eq $H1Z1Assets) {
    $selected = Select-Folder 'Select the H1Z1 2016 folder, Resources folder, or Resources\Assets folder.'
    $H1Z1Assets = Resolve-AssetsDirectory $selected
}
if ($null -eq $H1Z1Assets) { throw 'The selected folder does not contain Resources\Assets\Assets_*.pack.' }

if ([string]::IsNullOrWhiteSpace($QuickStartRoot)) {
    $quickStartCandidates = @(
        (Join-Path $env:USERPROFILE 'Documents\H1Z1-2016\H1EmuServerFiles\h1z1-server-QuickStart-master'),
        (Join-Path $env:ProgramFiles 'H1Emu\h1z1-server-QuickStart-master'),
        (Join-Path ${env:ProgramFiles(x86)} 'H1Emu\h1z1-server-QuickStart-master')
    )
    foreach ($candidate in $quickStartCandidates) {
        $resolved = Resolve-QuickStartDirectory $candidate
        if ($null -ne $resolved) { $QuickStartRoot = $resolved; break }
    }
}
$QuickStartRoot = Resolve-QuickStartDirectory $QuickStartRoot
if ($null -eq $QuickStartRoot) {
    $selected = Select-Folder 'Select the H1Emu QuickStart folder containing h1emu-2016.js.'
    $QuickStartRoot = Resolve-QuickStartDirectory $selected
}
if ($null -eq $QuickStartRoot) { throw 'The selected folder is not an H1Emu 2016 QuickStart installation.' }

Write-Host ''
Write-Host 'H1Emu Nav64 experimental setup' -ForegroundColor Cyan
Write-Host "  H1Z1 assets : $H1Z1Assets"
Write-Host "  QuickStart  : $QuickStartRoot"
Write-Host "  Work files  : $(if ($WorkRoot) { $WorkRoot } else { '%LOCALAPPDATA%\H1Emu\Nav64Builder' })"
Write-Host '  Release data: generated locally; no H1Z1 client files are included in this package.'
Write-Host ''

$arguments = @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $builder,
    '-H1Z1Assets', $H1Z1Assets,
    '-QuickStartRoot', $QuickStartRoot,
    '-PackageRoot', $package
)
if (-not [string]::IsNullOrWhiteSpace($WorkRoot)) { $arguments += @('-WorkRoot', $WorkRoot) }
if ($Plan) { $arguments += '-Plan' }

if (-not $Plan -and -not $Yes) {
    Write-Host 'The first build normally takes about 90-120 minutes and can be resumed.' -ForegroundColor Yellow
    $answer = Read-Host 'Type YES to build and install, or anything else to cancel'
    if ($answer -cne 'YES') { Write-Host 'Cancelled. No files were changed.'; return }
}

& powershell.exe @arguments
if ($LASTEXITCODE -ne 0) { throw "Nav64 setup failed with exit code $LASTEXITCODE. Read the printed log path above." }

