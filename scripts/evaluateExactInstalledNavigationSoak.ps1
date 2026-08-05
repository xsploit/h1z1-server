param(
  [Parameter(Mandatory = $true)][string]$RunMetadataPath
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $RunMetadataPath)) {
  throw "Run metadata is missing: $RunMetadataPath"
}
$run = Get-Content -LiteralPath $RunMetadataPath -Raw | ConvertFrom-Json
foreach ($requiredPath in @($run.resultPath, $run.reportPath, $run.stdoutPath, $run.stderrPath)) {
  if (-not (Test-Path -LiteralPath $requiredPath)) {
    throw "Soak output is incomplete: $requiredPath"
  }
}

$result = Get-Content -LiteralPath $run.resultPath -Raw | ConvertFrom-Json
$report = Get-Content -LiteralPath $run.reportPath -Raw | ConvertFrom-Json
$stdout = Get-Content -LiteralPath $run.stdoutPath -Raw
$stderr = Get-Content -LiteralPath $run.stderrPath -Raw
$failures = [System.Collections.Generic.List[string]]::new()
$warnings = [System.Collections.Generic.List[string]]::new()

function Require([bool]$Condition, [string]$Message) {
  if (-not $Condition) { $failures.Add($Message) }
}

Require ($result.exitCode -eq 0) "worker exit code was $($result.exitCode)"
Require ($result.reportExists -eq $true) 'worker did not observe the final report'
Require ($report.validation.passed -eq $true) "validator failed: $($report.validation.failures -join '; ')"
Require ($report.wallTargetReached -eq $true) 'wall-clock target was not reached'
Require ($report.wallSeconds -ge $run.durationSeconds) "workload ran $($report.wallSeconds)s, requested $($run.durationSeconds)s"
Require ($report.registeredFakeClients -eq $report.fakePlayers) "registered fake clients diverged: $($report.registeredFakeClients)/$($report.fakePlayers)"
Require ($report.activeAgents -eq $report.expectedActiveAgents) "final agent accounting diverged: $($report.activeAgents)/$($report.expectedActiveAgents)"
Require ($report.invalidIndexes.Count -eq 0) "invalid Crowd indexes: $($report.invalidIndexes -join ',')"
Require ($report.crowdHealthy -eq $true) 'Crowd health latch is false'
Require ($report.obstacleUpdatesHealthy -eq $true) 'obstacle-update health latch is false'
Require ($report.nativeNpcChurn.created -eq $report.nativeNpcChurn.deleted) "native churn diverged: $($report.nativeNpcChurn.created)/$($report.nativeNpcChurn.deleted)"
Require ($report.nativeNpcChurn.afterChurnAgents -eq $report.nativeNpcChurn.baselineAgents) "native Crowd did not return to baseline after churn: $($report.nativeNpcChurn.afterChurnAgents)/$($report.nativeNpcChurn.baselineAgents)"
Require ($report.crowdCapacityProbe.enabled -eq $true) 'native Crowd capacity probe was not enabled'
Require ($report.crowdCapacityProbe.created -eq ($report.crowdCapacityProbe.capacity - $report.crowdCapacityProbe.baselineAgents)) 'native Crowd capacity probe did not fill every available slot'
Require ($report.crowdCapacityProbe.overflowRejected -eq $true) 'native Crowd overflow was not rejected'
Require ($report.crowdCapacityProbe.afterProbeAgents -eq $report.crowdCapacityProbe.baselineAgents) 'native Crowd did not return to baseline after the capacity probe'
Require ($report.crowdCapacityProbe.rejectedAgentDelta -eq 1) 'capacity probe did not record exactly one rejected agent'
Require ($report.nativeNpcChurn.peakUtilization -le 0.9) "Crowd peak exceeded 90%: $($report.nativeNpcChurn.peakUtilization)"
Require ($report.streaming.activeNavMeshTiles -le ($report.streaming.maxNavMeshTiles * 0.9)) "navmesh tile use exceeded 90%: $($report.streaming.activeNavMeshTiles)/$($report.streaming.maxNavMeshTiles)"
Require ($report.memoryTelemetry.gcAvailable -eq $true) 'forced-GC telemetry was unavailable'
Require ($report.memoryTelemetry.forceGcSamples -eq $true) 'forced-GC sampling was not enabled'

$samples = @($report.memoryTelemetry.samples)
Require ($samples.Count -ge 2) "too few memory samples: $($samples.Count)"
foreach ($sample in $samples) {
  Require ($null -ne $sample.afterGc) "sample at $($sample.wallSeconds)s has no post-GC snapshot"
  Require ($sample.crowdHealthy -eq $true) "Crowd unhealthy at $($sample.wallSeconds)s"
  Require ($sample.obstacleUpdatesHealthy -eq $true) "obstacle updates unhealthy at $($sample.wallSeconds)s"
  Require ($sample.agentUtilization -le 0.9) "Crowd exceeded 90% at $($sample.wallSeconds)s"
  Require ($sample.wasmUtilization -le 0.9) "WASM linear memory exceeded 90% at $($sample.wallSeconds)s"
  Require ($sample.pendingObstacleRequests -eq 0) "obstacle requests pending at $($sample.wallSeconds)s: $($sample.pendingObstacleRequests)"
}

$wasmSizes = @($samples | Select-Object -ExpandProperty wasmHeapMb -Unique)
Require ($wasmSizes.Count -eq 1) "WASM linear-memory allocation changed during the run: $($wasmSizes -join ',') MiB"
Require ($report.memory.wasmMemory.maximumMb -eq 2048) "unexpected WASM maximum memory: $($report.memory.wasmMemory.maximumMb) MiB"
Require (@($report.memory.wasmMemory.growthEvents).Count -eq 0) 'WASM linear memory grew after the post-load baseline'

$faultPattern = 'memory access out of bounds|crowd disabled|tilecache update failed|Unhandled rejection|RuntimeError|Aborted\('
Require (-not ($stdout -match $faultPattern)) 'stdout contains a navigation/WASM fault signature'
Require (-not ($stderr -match $faultPattern)) 'stderr contains a navigation/WASM fault signature'
Require (-not ($stdout -match 'CharacterId .* not found when applying damage from npc')) 'stdout contains missing fake-character damage targets'

$steadySamples = @($samples | Where-Object { $_.wallSeconds -ge 600 -and $null -ne $_.afterGc })
$rssSlopeMbPerHour = $null
$rssEndVsBaselineRatio = $null
$heapEndVsBaselineRatio = $null
if ($run.durationSeconds -ge 1200) {
  Require ($steadySamples.Count -ge 3) "too few post-warmup samples: $($steadySamples.Count)"
  if ($steadySamples.Count -ge 2) {
    $n = [double]$steadySamples.Count
    $sumX = [double](($steadySamples | Measure-Object -Property wallSeconds -Sum).Sum)
    $sumY = [double](($steadySamples | ForEach-Object { $_.afterGc.rssMb } | Measure-Object -Sum).Sum)
    $sumXY = [double](($steadySamples | ForEach-Object { $_.wallSeconds * $_.afterGc.rssMb } | Measure-Object -Sum).Sum)
    $sumXX = [double](($steadySamples | ForEach-Object { $_.wallSeconds * $_.wallSeconds } | Measure-Object -Sum).Sum)
    $denominator = ($n * $sumXX) - ($sumX * $sumX)
    if ($denominator -ne 0) {
      $rssSlopeMbPerHour = [math]::Round(((($n * $sumXY) - ($sumX * $sumY)) / $denominator) * 3600, 3)
      Require ($rssSlopeMbPerHour -le 5) "post-warmup post-GC RSS slope was $rssSlopeMbPerHour MiB/hour"
    }
    $baseline = $steadySamples[0].afterGc
    $final = $steadySamples[-1].afterGc
    $rssEndVsBaselineRatio = [math]::Round($final.rssMb / $baseline.rssMb, 4)
    $heapEndVsBaselineRatio = [math]::Round($final.heapUsedMb / $baseline.heapUsedMb, 4)
    Require ($rssEndVsBaselineRatio -le 1.02) "final post-GC RSS was $rssEndVsBaselineRatio x the 10-minute baseline"
    Require ($heapEndVsBaselineRatio -le 1.10) "final post-GC JS heap was $heapEndVsBaselineRatio x the 10-minute baseline"
  }
} else {
  $warnings.Add('Duration was below 20 minutes; steady-state memory thresholds were not evaluated.')
}

$evaluation = [ordered]@{
  schemaVersion = 1
  evaluatedAt = (Get-Date).ToUniversalTime().ToString('o')
  passed = $failures.Count -eq 0
  failures = $failures
  warnings = $warnings
  runName = $run.runName
  cleanCommit = $run.cleanCommit
  durationSeconds = $run.durationSeconds
  workloadWallSeconds = $report.wallSeconds
  crowdPeakUtilization = $report.nativeNpcChurn.peakUtilization
  navTileUtilization = [math]::Round($report.streaming.activeNavMeshTiles / $report.streaming.maxNavMeshTiles, 4)
  compressedLayersWithoutActiveTile = $report.streaming.compressedLayersWithoutActiveTile
  wasmHeapSizesMb = $wasmSizes
  wasmMaximumMb = $report.memory.wasmMemory.maximumMb
  wasmEndUtilization = $report.memory.wasmMemory.endUtilization
  wasmGrowthEvents = @($report.memory.wasmMemory.growthEvents)
  postWarmupSamples = $steadySamples.Count
  rssSlopeMbPerHour = $rssSlopeMbPerHour
  rssEndVsBaselineRatio = $rssEndVsBaselineRatio
  heapEndVsBaselineRatio = $heapEndVsBaselineRatio
  reportSha256 = $result.reportSha256
  stdoutSha256 = $result.stdoutSha256
  stderrSha256 = $result.stderrSha256
}

$evaluationPath = [System.IO.Path]::ChangeExtension($RunMetadataPath, '.evaluation.json')
$evaluation | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $evaluationPath -Encoding utf8
$evaluation | ConvertTo-Json -Depth 6
if ($failures.Count) { exit 1 }
