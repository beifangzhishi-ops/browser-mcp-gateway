[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "bmg-common.ps1")

$repoRoot = $script:BmgRepoRoot
$port = Get-BmgPort
$stateDir = Join-Path $repoRoot ".state"
$pidFile = Join-Path $stateDir "bmg-sidecar.pid"
$listenerPid = Get-BmgLoopbackListenerPid -Port $port

if ($null -eq $listenerPid) {
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    Write-Output "BMG sidecar is not listening on port $port."
    Write-Output "Upstream 12306 and Edge lifecycle were not modified."
    exit 0
}

if (-not (Test-Path -LiteralPath $pidFile)) {
    throw "Port $port is listening without the BMG PID file. Refusing to stop it."
}
$recordedPid = (Get-Content -LiteralPath $pidFile -Raw).Trim()
if ($recordedPid -notmatch "^\d+$" -or $recordedPid -ne [string]$listenerPid) {
    throw "BMG PID file does not match the exact listener PID. Refusing to stop anything."
}
$health = Get-BmgHealth -Port $port
if ($null -eq $health) {
    throw "The exact listener PID did not answer as BMG sidecar health. Refusing to stop it."
}
$listenerProcess = Get-BmgProcess -ProcessId $listenerPid
if (-not (Test-BmgProcessCommandLine -Process $listenerProcess)) {
    throw "The exact listener PID command line is not BMG sidecar/server.mjs. Refusing to stop it."
}

Stop-Process -Id $listenerPid -ErrorAction Stop
$stopped = $false
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 250
    if ($null -eq (Get-BmgLoopbackListenerPid -Port $port)) {
        $stopped = $true
        break
    }
}
if (-not $stopped) {
    $remainingPid = Get-BmgLoopbackListenerPid -Port $port
    if ($remainingPid -ne $listenerPid) {
        throw "Port $port changed ownership while stopping. Refusing further action."
    }
    Stop-Process -Id $listenerPid -Force -ErrorAction Stop
    Start-Sleep -Milliseconds 250
}
if ($null -ne (Get-BmgLoopbackListenerPid -Port $port)) {
    throw "BMG sidecar listener did not stop."
}
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
Write-Output "BMG sidecar stopped. PID=$listenerPid Port=$port"
Write-Output "Upstream 12306 and Edge lifecycle were not modified."
