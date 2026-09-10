[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "bmg-common.ps1")

$repoRoot = $script:BmgRepoRoot
$port = Get-BmgPort
$stateDir = Join-Path $repoRoot ".state"
$logsDir = Join-Path $repoRoot "logs"
$pidFile = Join-Path $stateDir "bmg-sidecar.pid"
$stdoutLog = Join-Path $logsDir "bmg-sidecar.out.log"
$stderrLog = Join-Path $logsDir "bmg-sidecar.err.log"
$entrypoint = Join-Path $repoRoot "sidecar\server.mjs"

if (-not (Test-Path -LiteralPath (Join-Path $repoRoot "config\.env"))) {
    throw "BMG config/.env is missing. Run scripts\enable-oauth.ps1 first."
}
if (-not (Test-Path -LiteralPath $entrypoint)) {
    throw "BMG sidecar entrypoint is missing: $entrypoint"
}

New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null

$listenerPid = Get-BmgLoopbackListenerPid -Port $port
if ($null -ne $listenerPid) {
    $recordedPid = ""
    if (Test-Path -LiteralPath $pidFile) {
        $recordedPid = (Get-Content -LiteralPath $pidFile -Raw).Trim()
    }
    $health = Get-BmgHealth -Port $port
    if ($recordedPid -eq [string]$listenerPid -and $null -ne $health) {
        Write-Output "BMG sidecar is already running. PID=$listenerPid Port=$port"
        exit 0
    }
    throw "Port $port is already owned by an unverified process. Refusing to start BMG."
}

Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
$node = Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1
$startParameters = @{
    FilePath = $node.Source
    ArgumentList = @($entrypoint)
    WorkingDirectory = $repoRoot
    WindowStyle = "Hidden"
    RedirectStandardOutput = $stdoutLog
    RedirectStandardError = $stderrLog
    PassThru = $true
}
$process = Start-Process @startParameters

$healthy = $false
for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 250
    $health = Get-BmgHealth -Port $port
    if ($null -ne $health) {
        $healthy = $true
        break
    }
}

if (-not $healthy) {
    if (-not $process.HasExited) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
    throw "BMG sidecar did not become healthy. Check logs\bmg-sidecar.err.log."
}

$listenerPid = Get-BmgLoopbackListenerPid -Port $port
if ($null -eq $listenerPid) {
    if (-not $process.HasExited) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
    throw "BMG sidecar is healthy but its listener PID could not be resolved."
}
$listenerProcess = Get-BmgProcess -ProcessId $listenerPid
if (-not (Test-BmgProcessCommandLine -Process $listenerProcess)) {
    if (-not $process.HasExited) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
    throw "BMG listener PID could not be verified as sidecar/server.mjs."
}

Set-Content -LiteralPath $pidFile -Value ([string]$listenerPid) -Encoding ASCII
Write-Output "BMG sidecar started. PID=$listenerPid Port=$port"
Write-Output "Local health: http://127.0.0.1:$port/health"
Write-Output "Logs: $logsDir"
