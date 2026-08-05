param(
  [Parameter(Mandatory = $true)][string]$NodePath,
  [Parameter(Mandatory = $true)][string]$WorkingDirectory,
  [Parameter(Mandatory = $true)][string]$ValidatorPath,
  [Parameter(Mandatory = $true)][string]$CachePath,
  [Parameter(Mandatory = $true)][int]$ExtraNpcs,
  [Parameter(Mandatory = $true)][string]$StdoutPath,
  [Parameter(Mandatory = $true)][string]$StderrPath,
  [Parameter(Mandatory = $true)][string]$ReportPath,
  [Parameter(Mandatory = $true)][string]$ResultPath
)

$ErrorActionPreference = 'Stop'
$startedAt = (Get-Date).ToUniversalTime()
$exitCode = -1
$errorText = $null

function Get-Sha256([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
      return ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    } finally {
      $sha.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

try {
  $nodeArguments = @(
    '--expose-gc',
    '--import',
    'tsx',
    ('"{0}"' -f $ValidatorPath),
    '966.83',
    '14',
    '-2691.36',
    [string]$ExtraNpcs,
    '20000000',
    'compiled',
    ('"{0}"' -f $CachePath),
    'tour',
    'churn'
  )
  $nodeProcess = Start-Process -FilePath $NodePath `
    -ArgumentList $nodeArguments `
    -WorkingDirectory $WorkingDirectory `
    -RedirectStandardOutput $StdoutPath `
    -RedirectStandardError $StderrPath `
    -WindowStyle Hidden `
    -Wait `
    -PassThru
  $exitCode = $nodeProcess.ExitCode
} catch {
  $errorText = $_.Exception.ToString()
  $errorText | Add-Content -LiteralPath $StderrPath
} finally {
  try {
    $endedAt = (Get-Date).ToUniversalTime()
    $result = [ordered]@{
      schemaVersion = 1
      startedAt = $startedAt.ToString('o')
      endedAt = $endedAt.ToString('o')
      wallSeconds = [math]::Round(($endedAt - $startedAt).TotalSeconds, 3)
      exitCode = $exitCode
      launcherError = $errorText
      reportExists = Test-Path -LiteralPath $ReportPath
      reportSha256 = if (Test-Path -LiteralPath $ReportPath) {
        Get-Sha256 $ReportPath
      } else { $null }
      stdoutSha256 = if (Test-Path -LiteralPath $StdoutPath) {
        Get-Sha256 $StdoutPath
      } else { $null }
      stderrSha256 = if (Test-Path -LiteralPath $StderrPath) {
        Get-Sha256 $StderrPath
      } else { $null }
      stdoutBytes = if (Test-Path -LiteralPath $StdoutPath) {
        (Get-Item -LiteralPath $StdoutPath).Length
      } else { 0 }
      stderrBytes = if (Test-Path -LiteralPath $StderrPath) {
        (Get-Item -LiteralPath $StderrPath).Length
      } else { 0 }
    }
    $result | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $ResultPath -Encoding utf8
  } catch {
    $_ | Out-String | Set-Content -LiteralPath "$ResultPath.error.txt" -Encoding utf8
    throw
  }
}

exit $exitCode
