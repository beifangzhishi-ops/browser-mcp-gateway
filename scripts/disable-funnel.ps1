[CmdletBinding()]
param(
    [switch]$Apply
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "bmg-common.ps1")

$routes = @(
    "/bmg/mcp",
    "/bmg/authorize",
    "/bmg/token",
    "/bmg/register",
    "/bmg/revoke",
    "/bmg/oauth/consent",
    "/.well-known/oauth-authorization-server/bmg",
    "/.well-known/oauth-protected-resource/bmg/mcp",
    "/bmg/.well-known/oauth-authorization-server",
    "/bmg/mcp/.well-known/oauth-protected-resource"
)

Write-Output "BMG Funnel 停用预览：仅列出精确 BMG 路径，不执行修改。"
foreach ($route in $routes) {
    Write-Output ("  tailscale funnel --https=443 --set-path={0} off" -f $route)
}
if (-not $Apply) {
    Write-Output "如需未来实际应用，必须显式传入 -Apply；本次未调用 Tailscale。"
    exit 0
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated PowerShell window."
}
$tailscalePath = Join-Path $env:ProgramFiles "Tailscale\tailscale.exe"
if (-not (Test-Path -LiteralPath $tailscalePath)) {
    $tailscale = Get-Command tailscale.exe -CommandType Application -ErrorAction Stop |
        Select-Object -First 1
    $tailscalePath = $tailscale.Source
}
foreach ($route in $routes) {
    $arguments = @(
        "funnel",
        "--https=443",
        "--set-path=$route",
        "--yes",
        "off"
    )
    & $tailscalePath @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to disable BMG Funnel path $route."
    }
}
Write-Output "BMG Funnel 路径已按清单停用。"
