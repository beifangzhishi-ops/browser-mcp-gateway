[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [long]$TargetHwnd
)

$ErrorActionPreference = 'Stop'
if ($TargetHwnd -le 0) {
    throw "BMG workspace HWND must be a positive integer."
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class BmgWorkspaceShowWin32 {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);
    [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int index, IntPtr value);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
}
"@
$GWL_EXSTYLE = -20
$WS_EX_TOOLWINDOW = [int64]0x00000080
$WS_EX_APPWINDOW = [int64]0x00040000
$SWP_FRAMECHANGED = 0x0020
$SWP_SHOWWINDOW = 0x0040

$target = [IntPtr]::Zero
[BmgWorkspaceShowWin32]::EnumWindows({
    param([IntPtr]$hWnd, [IntPtr]$lParam)
    if ([int64]$hWnd -ne $TargetHwnd) { return $true }
    if (-not [BmgWorkspaceShowWin32]::IsWindowVisible($hWnd)) { return $true }
    [uint32]$processId = 0
    [void][BmgWorkspaceShowWin32]::GetWindowThreadProcessId($hWnd, [ref]$processId)
    try { $process = Get-Process -Id $processId -ErrorAction Stop } catch { return $true }
    if ($process.ProcessName -ne 'msedge') { return $true }
    $script:target = $hWnd
    return $false
}, [IntPtr]::Zero) | Out-Null

if ($target -eq [IntPtr]::Zero) {
    throw "BMG workspace HWND is not a visible Edge top-level window."
}

$oldExStyle = [BmgWorkspaceShowWin32]::GetWindowLongPtr($target, $GWL_EXSTYLE).ToInt64()
$newExStyle = ($oldExStyle -band (-bnot $WS_EX_TOOLWINDOW)) -bor $WS_EX_APPWINDOW
if ($newExStyle -ne $oldExStyle) {
    [void][BmgWorkspaceShowWin32]::SetWindowLongPtr($target, $GWL_EXSTYLE, [IntPtr]$newExStyle)
}
$screenWidth = [BmgWorkspaceShowWin32]::GetSystemMetrics(0)
$screenHeight = [BmgWorkspaceShowWin32]::GetSystemMetrics(1)
$width = [Math]::Max(800, [Math]::Min(1200, $screenWidth - 160))
$height = [Math]::Max(600, [Math]::Min(900, $screenHeight - 160))
$x = [Math]::Max(40, [int](($screenWidth - $width) / 2))
$y = [Math]::Max(40, [int](($screenHeight - $height) / 2))

[void][BmgWorkspaceShowWin32]::ShowWindowAsync($target, 9) # SW_RESTORE
$flags = $SWP_FRAMECHANGED -bor $SWP_SHOWWINDOW
if (-not [BmgWorkspaceShowWin32]::SetWindowPos(
    $target,
    [IntPtr]::Zero,
    $x,
    $y,
    $width,
    $height,
    [uint32]$flags
)) {
    throw "SetWindowPos failed while showing the BMG workspace window."
}
$foreground = [BmgWorkspaceShowWin32]::SetForegroundWindow($target)
$verifiedExStyle = [BmgWorkspaceShowWin32]::GetWindowLongPtr($target, $GWL_EXSTYLE).ToInt64()
if (($verifiedExStyle -band $WS_EX_TOOLWINDOW) -ne 0 -or ($verifiedExStyle -band $WS_EX_APPWINDOW) -eq 0) {
    throw "BMG workspace visible window style verification failed."
}

[pscustomobject]@{
    hwnd = [int64]$target
    visible = $true
    foreground = [bool]$foreground
    x = $x
    y = $y
    width = $width
    height = $height
    appWindow = $true
    toolWindow = $false
} | ConvertTo-Json -Compress
