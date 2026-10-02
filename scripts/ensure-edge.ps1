[CmdletBinding()]
param(
    [int]$Port = 18007,
    [string]$BootstrapStateFile = "",
    [switch]$SkipInitialHide
)

$ErrorActionPreference = "Stop"
$startupStateClaimGraceMs = 30000

$candidates = @(
    ${env:ProgramFiles(x86)},
    $env:ProgramFiles,
    $env:LOCALAPPDATA
) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object {
    Join-Path $_ "Microsoft\Edge\Application\msedge.exe"
}
$edge = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $edge) { throw "Microsoft Edge executable was not found." }

if ([string]::IsNullOrWhiteSpace($BootstrapStateFile)) {
    $repoRoot = Split-Path -Parent $PSScriptRoot
    $BootstrapStateFile = Join-Path $repoRoot ".state\bmg-edge-bootstrap.json"
}
$stateDir = Split-Path -Parent $BootstrapStateFile
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null

if (Test-Path -LiteralPath $BootstrapStateFile) {
    try {
        $existingBootstrap = Get-Content -LiteralPath $BootstrapStateFile -Raw | ConvertFrom-Json
        $createdAtMs = [int64]$existingBootstrap.createdAtMs
        $ageMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $createdAtMs
        if (
            [int]$existingBootstrap.version -eq 1 -and
            $existingBootstrap.nonce -match '^[A-Za-z0-9._-]{1,100}$' -and
            [int64]$existingBootstrap.windowMarker -gt 0 -and
            $ageMs -ge 0 -and
            $ageMs -le $startupStateClaimGraceMs
        ) {
            return
        }
    }
    catch {
        # Invalid or stale startup state is replaced below.
    }
}

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
