param(
  [string]$ClientConfigPath,
  [string]$ListenAddress = "127.0.0.1",
  [ValidateRange(1, 65535)][int]$Port = 4750,
  [string]$OutputDirectory = (Join-Path ($env:APPDATA ?? $env:LOCALAPPDATA) "h1emu\crashes"),
  [switch]$ConfigureClient
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$receiver = Join-Path $repoRoot "tools\crash-capture\soe-crash-server.mjs"

if ($ConfigureClient) {
  if (-not $ClientConfigPath) {
    throw "-ClientConfigPath is required with -ConfigureClient."
  }
  $resolvedConfig = (Resolve-Path -LiteralPath $ClientConfigPath).Path
  $backupPath = "$resolvedConfig.h1emu-crashcapture.bak"
  if (-not (Test-Path -LiteralPath $backupPath)) {
    Copy-Item -LiteralPath $resolvedConfig -Destination $backupPath
  }
  $contents = Get-Content -Raw -LiteralPath $resolvedConfig
  if ($contents -notmatch "(?m)^\[CrashReporter\]\s*$") {
    throw "The selected file has no [CrashReporter] section: $resolvedConfig"
  }
  $endpoint = "${ListenAddress}:$Port"
  $updated = [regex]::Replace(
    $contents,
    "(?ms)(^\[CrashReporter\]\s*.*?^Address=)[^\r\n]*",
    "`${1}$endpoint"
  )
  Set-Content -LiteralPath $resolvedConfig -Value $updated -NoNewline
  Write-Host "CrashReporter Address set to $endpoint"
  Write-Host "Backup: $backupPath"
}

Write-Host "Crash output: $OutputDirectory"
& node $receiver "--host=$ListenAddress" "--port=$Port" "--output=$OutputDirectory"
