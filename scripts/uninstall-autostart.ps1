[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$taskName = "BMG Sidecar"
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($null -ne $task) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Output "BMG scheduled autostart removed: $taskName"
} else {
    Write-Output "BMG scheduled autostart was not installed."
}

$startupDir = [Environment]::GetFolderPath("Startup")
if (-not [string]::IsNullOrWhiteSpace($startupDir)) {
    $legacyShortcut = Join-Path $startupDir "BMG Sidecar.lnk"
    if (Test-Path -LiteralPath $legacyShortcut) {
        Remove-Item -LiteralPath $legacyShortcut -Force
        Write-Output "Removed legacy Startup shortcut: $legacyShortcut"
    }
}