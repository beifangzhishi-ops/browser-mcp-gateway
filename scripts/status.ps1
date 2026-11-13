[CmdletBinding()]
param(
    [int]$Port = 12306,
    [switch]$IncludeLegacyFunnel
)

$ErrorActionPreference = "Continue"

function Show-CommandVersion([string]$Name, [string[]]$CommandArgs) {
    $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $command) {
        Write-Output "${Name}: not found"
        return
    }
    try {
        $value = & $command.Source @CommandArgs 2>$null | Select-Object -First 1
        Write-Output "${Name}: $value"
    }
    catch {
        Write-Output "${Name}: installed, version check failed"
    }
}

Show-CommandVersion "node.exe" @("--version")
Show-CommandVersion "npm.cmd" @("--version")
Show-CommandVersion "mcp-chrome-bridge.cmd" @("--version")

$hostName = "com.chromemcp.nativehost"
$edgeManifest = Join-Path $env:APPDATA "Microsoft\Edge\NativeMessagingHosts\$hostName.json"
$edgeRegistryKey = "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\$hostName"

Write-Output ""
Write-Output "Edge Native Messaging manifest: $(Test-Path -LiteralPath $edgeManifest)"
try {
    & reg.exe query $edgeRegistryKey /ve | Out-Host
}
catch {
    Write-Output "Edge Native Messaging registry key not found."
}

$portReady = Test-NetConnection -ComputerName 127.0.0.1 -Port $Port -InformationLevel Quiet -WarningAction SilentlyContinue
Write-Output "Local MCP port 127.0.0.1:$Port listening: $portReady"

$sidecarReady = Test-NetConnection -ComputerName 127.0.0.1 -Port 18007 -InformationLevel Quiet -WarningAction SilentlyContinue
Write-Output "Local Sidecar port 127.0.0.1:18007 listening: $sidecarReady"
if ($sidecarReady) {
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:18007/health' -TimeoutSec 3 -ErrorAction Stop
        Write-Output "Local Sidecar health: $($health.status -eq 'ok')"
    }
    catch {
        Write-Output "Local Sidecar health: unavailable"
    }
}

if ($IncludeLegacyFunnel) {
    Write-Output ""
    $tailscalePath = Join-Path $env:ProgramFiles "Tailscale\tailscale.exe"
    if (-not (Test-Path -LiteralPath $tailscalePath)) {
        $tailscale = Get-Command tailscale.exe -ErrorAction SilentlyContinue
        if ($null -ne $tailscale) {
            $tailscalePath = $tailscale.Source
        }
    }
    if (Test-Path -LiteralPath $tailscalePath) {
        & $tailscalePath funnel status
    }
    else {
        Write-Output "Tailscale CLI not found."
    }
}
