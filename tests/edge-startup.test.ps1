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
. $entry
if ($script:starts.Count -ne 0) { throw "Existing Edge must be reused." }
$script:edgeRunning = $false
. $entry
if ($script:starts.Count -ne 1 -or $script:starts[0].Style -ne "Hidden") { throw "Missing Edge must start hidden once." }
if ($script:starts[0].Args -notcontains "about:blank") { throw "Expected blank startup page." }
$script:edgeRunning = $true
$script:edgeSession = 8
. $entry
if ($script:starts.Count -ne 2) { throw "Another session must not suppress startup." }
$script:edgeRunning = $false
$script:edgeInstalled = $false
$failed = $false
try { . $entry } catch { $failed = $true }
if (-not $failed -or $script:starts.Count -ne 2) { throw "Missing executable must fail without launch." }
Write-Output "Edge startup checks passed."
