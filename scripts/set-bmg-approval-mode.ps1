param(
  [ValidateSet('Timed','Totp','Off')]
  [string]$Mode,
  [switch]$Status,
  [switch]$RevokeAll
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$path = Join-Path $root 'config\approval-policy.json'
$directory = Split-Path -Parent $path
New-Item -ItemType Directory -Force $directory | Out-Null

function Read-Policy {
  if (-not (Test-Path -LiteralPath $path)) {
    return [ordered]@{ version = 1; mode = 'timed'; revision = 0 }
  }
  try {
    $value = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    if ($value.version -ne 1) { throw 'version must be 1' }
    if ($value.mode -notin @('timed','totp','off')) { throw 'mode must be timed, totp or off' }
    $revision = [int64]$value.revision
    if ($revision -lt 0) { throw 'revision must be non-negative' }
    return [ordered]@{ version = 1; mode = [string]$value.mode; revision = $revision }
  } catch {
    throw "Invalid approval policy at $path : $($_.Exception.Message)"
  }
}

function Write-Policy($policy) {
  $tmp = "$path.tmp"
  $json = $policy | ConvertTo-Json -Compress
  $json | Set-Content -LiteralPath $tmp -Encoding UTF8
  Move-Item -LiteralPath $tmp -Destination $path -Force
}

$policy = Read-Policy
$changed = $false

if ($Mode) {
  $nextMode = $Mode.ToLowerInvariant()
  if ($policy.mode -ne $nextMode) {
    $policy.mode = $nextMode
    $policy.revision = [int64]$policy.revision + 1
    $changed = $true
  }
}

if ($RevokeAll) {
  $policy.revision = [int64]$policy.revision + 1
  $changed = $true
}

if ($changed) {
  Write-Policy $policy
}

if ($Status -or (-not $Mode -and -not $RevokeAll)) {
  $policy = Read-Policy
  [pscustomobject]@{
    mode = $policy.mode
    revision = $policy.revision
    default_duration_seconds = 21600
  } | Format-List
} else {
  $policy = Read-Policy
  Write-Output ("BMG approval mode: " + $policy.mode)
  Write-Output ("Policy revision: " + $policy.revision)
}
