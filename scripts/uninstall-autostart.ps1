[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$startupDir = [Environment]::GetFolderPath("Startup")
if ([string]::IsNullOrWhiteSpace($startupDir)) {
    throw "Unable to resolve the current user's Startup folder."
}
$shortcutPath = Join-Path $startupDir "BMG Sidecar.lnk"
if (Test-Path -LiteralPath $shortcutPath) {
    Remove-Item -LiteralPath $shortcutPath -Force
    Write-Output "BMG autostart removed: $shortcutPath"
} else {
    Write-Output "BMG autostart was not installed."
}