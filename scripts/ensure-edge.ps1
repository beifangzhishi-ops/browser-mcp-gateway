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
$hideScript = Join-Path $PSScriptRoot "hide-workspace-window.ps1"
$powershell = Join-Path $PSHOME "powershell.exe"

function Invoke-BmgWindowHelper([string[]]$HelperArgs) {
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $output = @(& $powershell @HelperArgs 2>&1)
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }
    [pscustomobject]@{ ExitCode = $exitCode; Output = $output }
}

if (Test-Path -LiteralPath $BootstrapStateFile) {
    $existingBootstrap = $null
    try {
        $existingBootstrap = Get-Content -LiteralPath $BootstrapStateFile -Raw | ConvertFrom-Json
        $createdAtMs = [int64]$existingBootstrap.createdAtMs
        $ageMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $createdAtMs
        $validBootstrap = (
            [int]$existingBootstrap.version -eq 1 -and
            $existingBootstrap.nonce -match '^[A-Za-z0-9._-]{1,100}$' -and
            [int64]$existingBootstrap.windowMarker -gt 0 -and
            $ageMs -ge 0
        )
        if ($validBootstrap -and $ageMs -le $startupStateClaimGraceMs) {
            Write-Output "BMG bootstrap action=reuse"
            return
        }
        if ($validBootstrap) {
            $retireArgs = @(
                "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $hideScript,
                "-Nonce", [string]$existingBootstrap.nonce,
                "-WindowMarker", [string][int64]$existingBootstrap.windowMarker,
                "-Retire", "-TimeoutMs", "7000"
            )
            $retireResult = Invoke-BmgWindowHelper $retireArgs
            if ($retireResult.ExitCode -ne 0) {
                Write-Output "BMG bootstrap action=blocked"
                throw "BMG stale bootstrap could not be retired: $($retireResult.Output -join ' ')"
            }
            Remove-Item -LiteralPath $BootstrapStateFile -Force -ErrorAction SilentlyContinue
            Write-Output "BMG bootstrap action=retire"
        } else {
            Remove-Item -LiteralPath $BootstrapStateFile -Force -ErrorAction SilentlyContinue
        }
    }
    catch {
        if ($existingBootstrap -and $validBootstrap) { throw }
        Remove-Item -LiteralPath $BootstrapStateFile -Force -ErrorAction SilentlyContinue
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
    Write-Output "BMG bootstrap action=create"
}
catch {
    Remove-Item -LiteralPath $BootstrapStateFile -Force -ErrorAction SilentlyContinue
    throw
}

if (-not $SkipInitialHide) {
    $hideArgs = @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $hideScript,
        "-Nonce", $nonce, "-WindowMarker", [string]$windowMarker, "-TimeoutMs", "7000"
    )
    $hideResult = Invoke-BmgWindowHelper $hideArgs
    if ($hideResult.ExitCode -ne 0) {
        Write-Output "BMG bootstrap action=initial-hide-failed"
        Write-Warning "BMG startup Edge was launched but could not be true-hidden immediately; sidecar recovery will retry ownership claim."
    }
}
