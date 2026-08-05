param(
  [string]$QuickStartRoot = 'C:\Users\SUBSECT\Documents\H1Z1-2016\H1EmuServerFiles\h1z1-server-QuickStart-master',
  [string]$CleanWorktree = 'C:\Users\SUBSECT\Documents\Codex\2026-07-27\https-dev-epicgames-com-documentation-unreal\work\h1z1-nav64-dev-pr',
  [string]$OutputDirectory = 'C:\Users\SUBSECT\Documents\Codex\2026-07-27\https-dev-epicgames-com-documentation-unreal\work\staging',
  [int]$DurationSeconds = 7200,
  [int]$ExtraNpcs = 500,
  [int]$FakePlayers = 100,
  [int]$NpcChurnWaves = 50,
  [int]$NpcChurnWaveSize = 50,
  [int]$MemorySampleSeconds = 300,
  [string]$RunName = ''
)

$ErrorActionPreference = 'Stop'

if ($DurationSeconds -lt 1) { throw 'DurationSeconds must be positive.' }
if ($FakePlayers -lt 1 -or $FakePlayers -gt 100) {
  throw 'FakePlayers must be between 1 and 100.'
}
foreach ($value in @($ExtraNpcs, $NpcChurnWaves, $NpcChurnWaveSize, $MemorySampleSeconds)) {
  if ($value -lt 0) { throw 'Soak counts and sampling interval cannot be negative.' }
}

$runtimeRoot = Join-Path $QuickStartRoot 'node_modules\h1z1-server'
$nodePath = Join-Path $QuickStartRoot 'node-v24.18.0-win-x64\node.exe'
$cachePath = Join-Path $runtimeRoot 'data\2016\collision'
$transitionsPath = Join-Path $runtimeRoot 'data\2016\navigationTransitions.json'
$corePath = Join-Path $runtimeRoot 'runtime\navigation64\core.mjs'
$wasmPath = Join-Path $runtimeRoot 'runtime\navigation64\wasm-compat.mjs'
$validatorPath = Join-Path $PSScriptRoot 'validateWorldNpcCrowd.ts'
$cleanRecastPath = Join-Path $CleanWorktree 'out\utils\recast.js'
$installedRecastPath = Join-Path $runtimeRoot 'out\utils\recast.js'

foreach ($requiredPath in @(
  $nodePath,
  $cachePath,
  $transitionsPath,
  $corePath,
  $wasmPath,
  $validatorPath,
  $cleanRecastPath,
  $installedRecastPath
)) {
  if (-not (Test-Path -LiteralPath $requiredPath)) {
    throw "Required soak input is missing: $requiredPath"
  }
}

$cleanStatus = (& git -C $CleanWorktree status --porcelain) -join "`n"
if ($LASTEXITCODE -ne 0) { throw 'Failed to inspect the clean PR worktree.' }
if ($cleanStatus) { throw "Clean PR worktree has uncommitted changes:`n$cleanStatus" }
$cleanCommit = (& git -C $CleanWorktree rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Failed to resolve the clean PR commit.' }
$cleanHash = (Get-FileHash -LiteralPath $cleanRecastPath -Algorithm SHA256).Hash
$installedHash = (Get-FileHash -LiteralPath $installedRecastPath -Algorithm SHA256).Hash
if ($cleanHash -ne $installedHash) {
  throw "Installed server does not match clean PR recast.js: installed=$installedHash clean=$cleanHash"
}

$conflicts = Get-CimInstance Win32_Process | Where-Object {
  $_.ProcessId -ne $PID -and
  $_.Name -match 'node|powershell' -and
  $_.CommandLine -match 'h1emu-2016|ZoneServer2016|validateWorldNpcCrowd'
}
if ($conflicts) {
  $details = ($conflicts | ForEach-Object { "$($_.ProcessId): $($_.CommandLine)" }) -join "`n"
  throw "A server or navigation validator is already running:`n$details"
}

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
if (-not $RunName) {
  $RunName = 'exact-clean-nav64-{0}s-{1}' -f $DurationSeconds, (Get-Date -Format 'yyyyMMdd-HHmmss')
}
$prefix = Join-Path $OutputDirectory $RunName
$reportPath = "$prefix.json"
$stdoutPath = "$prefix.out.log"
$stderrPath = "$prefix.err.log"
$metadataPath = "$prefix.run.json"

$env:H1Z1_VALIDATION_RUNTIME_ROOT = $runtimeRoot
$env:NAV_MONOLITHIC_64 = '1'
$env:NAV_STREAMING = '0'
$env:NAV_CACHE_DIR = $cachePath
$env:NAV_TRANSITIONS_PATH = $transitionsPath
$env:NAV_64_CORE_MODULE = $corePath
$env:NAV_64_WASM_MODULE = $wasmPath
$env:NAV_WORLD_CROWD_FAKE_PLAYERS = [string]$FakePlayers
$env:NAV_WORLD_CROWD_SOAK_SECONDS = [string]$DurationSeconds
$env:NAV_WORLD_CROWD_MEMORY_SAMPLE_SECONDS = [string]$MemorySampleSeconds
$env:NAV_WORLD_CROWD_FORCE_GC_SAMPLES = '1'
$env:NAV_WORLD_CROWD_NPC_CHURN_WAVES = [string]$NpcChurnWaves
$env:NAV_WORLD_CROWD_NPC_CHURN_SIZE = [string]$NpcChurnWaveSize
$env:NAV_WORLD_CROWD_REPORT = $reportPath

$arguments = @(
  '--expose-gc',
  '--import',
  'tsx',
  ('"{0}"' -f $validatorPath),
  '966.83',
  '14',
  '-2691.36',
  [string]$ExtraNpcs,
  '20000000',
  'compiled',
  ('"{0}"' -f $cachePath),
  'tour',
  'churn'
)
$process = Start-Process -FilePath $nodePath `
  -ArgumentList $arguments `
  -WorkingDirectory (Split-Path $PSScriptRoot -Parent) `
  -RedirectStandardOutput $stdoutPath `
  -RedirectStandardError $stderrPath `
  -WindowStyle Hidden `
  -PassThru

$runtimeManifest = Get-Content (Join-Path $runtimeRoot 'runtime\navigation64\runtime-manifest.json') -Raw | ConvertFrom-Json
$metadata = [ordered]@{
  schemaVersion = 1
  runName = $RunName
  startedAt = (Get-Date).ToUniversalTime().ToString('o')
  processId = $process.Id
  durationSeconds = $DurationSeconds
  cleanCommit = $cleanCommit
  cleanWorktree = $CleanWorktree
  installedRuntimeRoot = $runtimeRoot
  installedRecastSha256 = $installedHash.ToLowerInvariant()
  navigation64ArtifactId = $runtimeManifest.artifactId
  fakePlayers = $FakePlayers
  extraNpcs = $ExtraNpcs
  npcChurnWaves = $NpcChurnWaves
  npcChurnWaveSize = $NpcChurnWaveSize
  memorySampleSeconds = $MemorySampleSeconds
  reportPath = $reportPath
  stdoutPath = $stdoutPath
  stderrPath = $stderrPath
}
$metadata | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $metadataPath -Encoding utf8

[pscustomobject]$metadata
