$ErrorActionPreference = "Stop"
$script:edgeInstalled = $true
$script:starts = @()

function Test-Path {
    param([string]$LiteralPath)
    if ($script:stateFile -and $LiteralPath -eq $script:stateFile) {
        return Microsoft.PowerShell.Management\Test-Path -LiteralPath $LiteralPath
    }
    return $script:edgeInstalled
}
function Start-Process {
    param([string]$FilePath, [string[]]$ArgumentList, [string]$WindowStyle)
    $script:starts += [pscustomobject]@{ FilePath = $FilePath; Args = $ArgumentList; Style = $WindowStyle }
}

$entry = Join-Path $PSScriptRoot "..\scripts\ensure-edge.ps1"
$stateDir = Join-Path $PSScriptRoot "..\.state"
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
$script:stateFile = Join-Path $stateDir ("bmg-edge-startup-test-" + [Guid]::NewGuid().ToString("N") + ".json")
$stateFile = $script:stateFile
$invoke = { . $entry -Port 18007 -BootstrapStateFile $stateFile -SkipInitialHide }

& $invoke
if ($script:starts.Count -ne 1 -or $script:starts[0].Style -ne "Hidden") { throw "Workspace recovery must start one hidden Edge bootstrap window." }
$bootstrap = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
$expectedUrl = "http://127.0.0.1:18007/workspace-bootstrap?nonce=$($bootstrap.nonce)"
if ($script:starts[0].Args -notcontains $expectedUrl) { throw "Startup Edge must use the owned bootstrap URL." }
if ([int]$bootstrap.version -ne 1 -or [string]::IsNullOrWhiteSpace($bootstrap.nonce) -or
    [int64]$bootstrap.windowMarker -le 0) {
    throw "Bootstrap ownership state is invalid."
}

& $invoke
if ($script:starts.Count -ne 1) { throw "An active bootstrap claim must suppress duplicate recovery windows." }

$entryText = Get-Content -LiteralPath $entry -Raw
if ($entryText -notmatch '"-Retire"' -or $entryText -notmatch 'action=retire') {
    throw "Stale bootstrap recovery must retire the owned window before replacement."
}

$script:edgeInstalled = $false
$failed = $false
try { & $invoke } catch { $failed = $true }
if (-not $failed -or $script:starts.Count -ne 1) { throw "Missing executable must fail without launch." }
Remove-Item -LiteralPath $stateFile -Force -ErrorAction SilentlyContinue
Write-Output "Edge startup checks passed."
