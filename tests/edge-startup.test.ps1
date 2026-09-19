$ErrorActionPreference = "Stop"
$script:edgeRunning = $true
$script:edgeSession = 7
$script:edgeInstalled = $true
$script:starts = @()

function Get-Process {
    [CmdletBinding()]
    param([int]$Id, [string]$Name)
    if ($Id) { return [pscustomobject]@{ SessionId = 7 } }
    if ($script:edgeRunning) { return [pscustomobject]@{ SessionId = $script:edgeSession } }
}
function Test-Path {
    param([string]$LiteralPath)
    return $script:edgeInstalled
}
function Start-Process {
    param([string]$FilePath, [string[]]$ArgumentList, [string]$WindowStyle)
    $script:starts += [pscustomobject]@{ FilePath = $FilePath; Args = $ArgumentList; Style = $WindowStyle }
}

$entry = Join-Path $PSScriptRoot "..\scripts\ensure-edge.ps1"
$stateFile = Join-Path ([System.IO.Path]::GetTempPath()) ("bmg-edge-startup-" + [Guid]::NewGuid().ToString("N") + ".json")
$invoke = { . $entry -Port 18007 -BootstrapStateFile $stateFile -SkipInitialHide }

& $invoke
if ($script:starts.Count -ne 0) { throw "Existing Edge must be reused." }

$script:edgeRunning = $false
& $invoke
if ($script:starts.Count -ne 1 -or $script:starts[0].Style -ne "Hidden") { throw "Missing Edge must start hidden once." }
$bootstrap = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
$expectedUrl = "http://127.0.0.1:18007/workspace-bootstrap?nonce=$($bootstrap.nonce)"
if ($script:starts[0].Args -notcontains $expectedUrl) { throw "Startup Edge must use the owned bootstrap URL." }
if ([int]$bootstrap.version -ne 1 -or [string]::IsNullOrWhiteSpace($bootstrap.nonce) -or
    [int64]$bootstrap.windowMarker -le 0) {
    throw "Bootstrap ownership state is invalid."
}

$script:edgeRunning = $true
$script:edgeSession = 8
& $invoke
if ($script:starts.Count -ne 2) { throw "Another session must not suppress startup." }

$script:edgeRunning = $false
$script:edgeInstalled = $false
$failed = $false
try { & $invoke } catch { $failed = $true }
if (-not $failed -or $script:starts.Count -ne 2) { throw "Missing executable must fail without launch." }
Remove-Item -LiteralPath $stateFile -Force -ErrorAction SilentlyContinue
Write-Output "Edge startup checks passed."
