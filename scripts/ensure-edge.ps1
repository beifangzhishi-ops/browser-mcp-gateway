[CmdletBinding()]
param()

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
Start-Process -FilePath $edge -ArgumentList @("--no-first-run", "--new-window", "about:blank") -WindowStyle Hidden | Out-Null
