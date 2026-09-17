[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "bmg-common.ps1")

$repoRoot = $script:BmgRepoRoot
$startScript = Join-Path $PSScriptRoot "start.ps1"
if (-not (Test-Path -LiteralPath $startScript)) {
    throw "BMG start script is missing: $startScript"
}

$taskName = "BMG Sidecar"
$powershellPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $powershellPath `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`" -EnsureWorkspace" `
    -WorkingDirectory $repoRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description "Start BMG and prepare its workspace at user logon; retry startup failures."
Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null

$startupDir = [Environment]::GetFolderPath("Startup")
if (-not [string]::IsNullOrWhiteSpace($startupDir)) {
    $legacyShortcut = Join-Path $startupDir "BMG Sidecar.lnk"
    if (Test-Path -LiteralPath $legacyShortcut) {
        Remove-Item -LiteralPath $legacyShortcut -Force
        Write-Output "Removed legacy Startup shortcut: $legacyShortcut"
    }
}

Write-Output "BMG autostart scheduled task installed for the current user."
Write-Output "Task: $taskName"
