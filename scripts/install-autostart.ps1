[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "bmg-common.ps1")

$repoRoot = $script:BmgRepoRoot
$startScript = Join-Path $PSScriptRoot "start.ps1"
$startupDir = [Environment]::GetFolderPath("Startup")
if ([string]::IsNullOrWhiteSpace($startupDir)) {
    throw "Unable to resolve the current user's Startup folder."
}
if (-not (Test-Path -LiteralPath $startScript)) {
    throw "BMG start script is missing: $startScript"
}

$shortcutPath = Join-Path $startupDir "BMG Sidecar.lnk"
$powershellPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $powershellPath
$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`""
$shortcut.WorkingDirectory = $repoRoot
$shortcut.WindowStyle = 7
$shortcut.Description = "Start BMG sidecar at user sign-in."
$shortcut.Save()

Write-Output "BMG autostart installed for the current user."
Write-Output "Shortcut: $shortcutPath"