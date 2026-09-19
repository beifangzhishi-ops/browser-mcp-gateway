[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [long]$TargetHwnd,
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 2147483647)]
    [long]$WindowMarker
)

$ErrorActionPreference = 'Stop'
if ($TargetHwnd -le 0) {
    throw "BMG workspace HWND must be a positive integer."
}
$propertyName = "BMG_BROWSER_MCP_WORKSPACE_V1"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class BmgWorkspaceShowWin32 {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);
    [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int index, IntPtr value);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr GetProp(IntPtr hWnd, string lpString);
}
"@

$GWL_EXSTYLE = -20
$WS_EX_TOOLWINDOW = [int64]0x00000080
$WS_EX_APPWINDOW = [int64]0x00040000
$SWP_NOSIZE = 0x0001
$SWP_NOMOVE = 0x0002
$SWP_NOZORDER = 0x0004
$SWP_FRAMECHANGED = 0x0020
$SWP_SHOWWINDOW = 0x0040
$target = [IntPtr]$TargetHwnd
if (-not [BmgWorkspaceShowWin32]::IsWindow($target)) {
    throw "BMG workspace HWND no longer exists."
}
[uint32]$processId = 0
[void][BmgWorkspaceShowWin32]::GetWindowThreadProcessId($target, [ref]$processId)
try { $process = Get-Process -Id $processId -ErrorAction Stop } catch {
    throw "BMG workspace process no longer exists."
}
if ($process.ProcessName -ne 'msedge') {
    throw "BMG workspace HWND no longer belongs to Microsoft Edge."
}
$marker = [int64][BmgWorkspaceShowWin32]::GetProp($target, $propertyName)
if ($marker -ne $WindowMarker) {
    throw "BMG workspace ownership marker mismatch."
}
$before = New-Object BmgWorkspaceShowWin32+RECT
if (-not [BmgWorkspaceShowWin32]::GetWindowRect($target, [ref]$before)) {
    throw "BMG workspace geometry could not be read."
}
$oldExStyle = [BmgWorkspaceShowWin32]::GetWindowLongPtr($target, $GWL_EXSTYLE).ToInt64()
$newExStyle = ($oldExStyle -band (-bnot $WS_EX_TOOLWINDOW)) -bor $WS_EX_APPWINDOW
if ($newExStyle -ne $oldExStyle) {
    [void][BmgWorkspaceShowWin32]::SetWindowLongPtr($target, $GWL_EXSTYLE, [IntPtr]$newExStyle)
}
$flags = $SWP_NOSIZE -bor $SWP_NOMOVE -bor $SWP_NOZORDER -bor $SWP_FRAMECHANGED -bor $SWP_SHOWWINDOW
if (-not [BmgWorkspaceShowWin32]::SetWindowPos($target, [IntPtr]::Zero, 0, 0, 0, 0, [uint32]$flags)) {
    throw "SetWindowPos failed while showing the BMG workspace window."
}
if ([BmgWorkspaceShowWin32]::IsIconic($target)) {
    [void][BmgWorkspaceShowWin32]::ShowWindowAsync($target, 9) # SW_RESTORE
} else {
    [void][BmgWorkspaceShowWin32]::ShowWindowAsync($target, 5) # SW_SHOW
}
$foreground = [BmgWorkspaceShowWin32]::SetForegroundWindow($target)
Start-Sleep -Milliseconds 80

$after = New-Object BmgWorkspaceShowWin32+RECT
[void][BmgWorkspaceShowWin32]::GetWindowRect($target, [ref]$after)
$verifiedExStyle = [BmgWorkspaceShowWin32]::GetWindowLongPtr($target, $GWL_EXSTYLE).ToInt64()
if (-not [BmgWorkspaceShowWin32]::IsWindowVisible($target)) {
    throw "BMG workspace visible-state verification failed."
}
if (($verifiedExStyle -band $WS_EX_TOOLWINDOW) -ne 0 -or ($verifiedExStyle -band $WS_EX_APPWINDOW) -eq 0) {
    throw "BMG workspace visible window style verification failed."
}
if ([int64][BmgWorkspaceShowWin32]::GetProp($target, $propertyName) -ne $WindowMarker) {
    throw "BMG workspace ownership marker changed unexpectedly."
}
if ($after.Left -ne $before.Left -or $after.Top -ne $before.Top -or
    $after.Right -ne $before.Right -or $after.Bottom -ne $before.Bottom) {
    throw "BMG workspace show unexpectedly changed window geometry."
}

[pscustomobject]@{
    hwnd = [int64]$target
    processId = [int64]$processId
    processStartTimeUtc = $process.StartTime.ToUniversalTime().ToString("o")
    visible = $true
    foreground = [bool]$foreground
    minimized = [BmgWorkspaceShowWin32]::IsIconic($target)
    left = $after.Left
    top = $after.Top
    right = $after.Right
    bottom = $after.Bottom
    marker = $WindowMarker
    appWindow = $true
    toolWindow = $false
} | ConvertTo-Json -Compress
