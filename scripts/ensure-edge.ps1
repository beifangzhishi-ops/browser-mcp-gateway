[CmdletBinding()]
param(
    [int]$Port = 18007,
    [string]$BootstrapStateFile = "",
    [switch]$SkipInitialHide
)

$ErrorActionPreference = "Stop"
$sessionId = (Get-Process -Id $PID).SessionId
$existing = Get-Process -Name msedge -ErrorAction SilentlyContinue |
    Where-Object { $_.SessionId -eq $sessionId } | Select-Object -First 1
if ($null -ne $existing) { return }

$candidates = @(
    (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"),
    (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe"),
    (Join-Path $env:LOCALAPPDATA "Microsoft\Edge\Application\msedge.exe")
)
$edge = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $edge) { throw "Microsoft Edge executable was not found." }

if ([string]::IsNullOrWhiteSpace($BootstrapStateFile)) {
    $repoRoot = Split-Path -Parent $PSScriptRoot
    $BootstrapStateFile = Join-Path $repoRoot ".state\bmg-edge-bootstrap.json"
}
$stateDir = Split-Path -Parent $BootstrapStateFile
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
$nonce = "startup-" + [Guid]::NewGuid().ToString("N")
$windowMarker = Get-Random -Minimum 1 -Maximum 2147483647
$createdAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$bootstrapUrl = "http://127.0.0.1:$Port/workspace-bootstrap?nonce=$nonce"
[pscustomobject]@{
    version = 1
    nonce = $nonce
    windowMarker = $windowMarker
    createdAtMs = $createdAtMs
} | ConvertTo-Json | Set-Content -LiteralPath $BootstrapStateFile -Encoding UTF8

try {
    Start-Process -FilePath $edge -ArgumentList @("--no-first-run", "--new-window", $bootstrapUrl) -WindowStyle Hidden | Out-Null
}
catch {
    Remove-Item -LiteralPath $BootstrapStateFile -Force -ErrorAction SilentlyContinue
    throw
}

if (-not $SkipInitialHide) {
    $hideScript = Join-Path $PSScriptRoot "hide-workspace-window.ps1"
    $powershell = Join-Path $PSHOME "powershell.exe"
    $hideArgs = @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $hideScript,
        "-Nonce", $nonce, "-WindowMarker", [string]$windowMarker, "-TimeoutMs", "7000"
    )
    & $powershell @hideArgs | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "BMG startup Edge was launched but could not be true-hidden immediately; sidecar recovery will retry ownership claim."
    }
}
