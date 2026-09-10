[CmdletBinding()]
param(
    [switch]$Apply
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "bmg-common.ps1")

$repoRoot = $script:BmgRepoRoot
$sidecarPort = Get-BmgPort
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

Write-Output "BMG Funnel 预览：仅列出精确 BMG 路径，不执行修改。"
foreach ($route in $routes) {
    Write-Output ("  {0} -> http://127.0.0.1:{1}{0}" -f $route, $sidecarPort)
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
$health = Get-BmgHealth -Port $sidecarPort
if ($null -eq $health) {
    throw "BMG sidecar is not healthy on 127.0.0.1:$sidecarPort."
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
        "--bg",
        "--https=443",
        "--set-path=$route",
        "http://127.0.0.1:$sidecarPort$route"
    )
    & $tailscalePath @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to configure BMG Funnel path $route."
    }
}
Write-Output "BMG Funnel 路径已按清单应用。"
