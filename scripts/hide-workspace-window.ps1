[CmdletBinding(DefaultParameterSetName = 'Nonce')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Nonce')]
    [ValidatePattern('^[A-Za-z0-9._-]+$')]
    [string]$Nonce,
    [Parameter(Mandatory = $true, ParameterSetName = 'Hwnd')]
    [long]$TargetHwnd,
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 2147483647)]
    [long]$WindowMarker,
    [Parameter(ParameterSetName = 'Hwnd')]
    [switch]$InspectOnly,
    [int]$TimeoutMs = 7000
)

$ErrorActionPreference = 'Stop'
if ($PSCmdlet.ParameterSetName -eq 'Hwnd' -and $TargetHwnd -le 0) {
    throw "BMG workspace HWND must be a positive integer."
}
$needle = if ($PSCmdlet.ParameterSetName -eq 'Nonce') { "BMG GPT Workspace $Nonce" } else { $null }
$propertyName = "BMG_BROWSER_MCP_WORKSPACE_V1"

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class BmgWorkspaceWin32 {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct FLASHWINFO {
        public uint cbSize;
        public IntPtr hwnd;
        public uint dwFlags;
        public uint uCount;
        public uint dwTimeout;
    }
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll")] public static extern bool FlashWindowEx(ref FLASHWINFO pwfi);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr GetProp(IntPtr hWnd, string lpString);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool SetProp(IntPtr hWnd, string lpString, IntPtr hData);
}
"@

$GWL_EXSTYLE = -20
$WS_EX_TOOLWINDOW = [int64]0x00000080
$WS_EX_APPWINDOW = [int64]0x00040000
$SWP_NOSIZE = 0x0001
$SWP_NOMOVE = 0x0002
$SWP_NOZORDER = 0x0004
$SWP_NOACTIVATE = 0x0010
$SWP_FRAMECHANGED = 0x0020
$FLASHW_STOP = 0x00000000

function Clear-BmgWindowAttention([IntPtr]$Hwnd) {
    $flash = New-Object BmgWorkspaceWin32+FLASHWINFO
    $flash.cbSize = [Runtime.InteropServices.Marshal]::SizeOf([type][BmgWorkspaceWin32+FLASHWINFO])
    $flash.hwnd = $Hwnd
    $flash.dwFlags = $FLASHW_STOP
    $flash.uCount = 0
    $flash.dwTimeout = 0
    [void][BmgWorkspaceWin32]::FlashWindowEx([ref]$flash)
}

function Get-BmgWindowInfo([IntPtr]$Hwnd) {
    if (-not [BmgWorkspaceWin32]::IsWindow($Hwnd)) {
        throw "BMG workspace HWND no longer exists."
    }
    [uint32]$processId = 0
    [void][BmgWorkspaceWin32]::GetWindowThreadProcessId($Hwnd, [ref]$processId)
    try { $process = Get-Process -Id $processId -ErrorAction Stop } catch {
        throw "BMG workspace process no longer exists."
    }
    if ($process.ProcessName -ne 'msedge') {
        throw "BMG workspace HWND no longer belongs to Microsoft Edge."
    }
    $rect = New-Object BmgWorkspaceWin32+RECT
    if (-not [BmgWorkspaceWin32]::GetWindowRect($Hwnd, [ref]$rect)) {
        throw "BMG workspace geometry could not be read."
    }
    $exStyle = [BmgWorkspaceWin32]::GetWindowLongPtr($Hwnd, $GWL_EXSTYLE).ToInt64()
    [pscustomobject]@{
        hwnd = [int64]$Hwnd
        processId = [int64]$processId
        processStartTimeUtc = $process.StartTime.ToUniversalTime().ToString("o")
        visible = [BmgWorkspaceWin32]::IsWindowVisible($Hwnd)
        minimized = [BmgWorkspaceWin32]::IsIconic($Hwnd)
        left = $rect.Left
        top = $rect.Top
        right = $rect.Right
        bottom = $rect.Bottom
        exStyle = $exStyle
        appWindow = (($exStyle -band $WS_EX_APPWINDOW) -ne 0)
        toolWindow = (($exStyle -band $WS_EX_TOOLWINDOW) -ne 0)
        marker = [int64][BmgWorkspaceWin32]::GetProp($Hwnd, $propertyName)
    }
}

$deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
do {
    $target = [IntPtr]::Zero
    if ($PSCmdlet.ParameterSetName -eq 'Hwnd') {
        $target = [IntPtr]$TargetHwnd
    } else {
        $matches = [System.Collections.Generic.List[System.IntPtr]]::new()
        [BmgWorkspaceWin32]::EnumWindows({
            param([IntPtr]$hWnd, [IntPtr]$lParam)
            [uint32]$processId = 0
            [void][BmgWorkspaceWin32]::GetWindowThreadProcessId($hWnd, [ref]$processId)
            try { $process = Get-Process -Id $processId -ErrorAction Stop } catch { return $true }
            if ($process.ProcessName -ne 'msedge') { return $true }
            $title = [System.Text.StringBuilder]::new(1024)
            [void][BmgWorkspaceWin32]::GetWindowText($hWnd, $title, $title.Capacity)
            if ($title.ToString().Contains($needle)) { $matches.Add($hWnd) }
            return $true
        }, [IntPtr]::Zero) | Out-Null
        if ($matches.Count -gt 1) {
            throw "Multiple Edge windows matched the BMG workspace nonce. Refusing to modify any window."
        }
        if ($matches.Count -eq 1) { $target = $matches[0] }
    }
    if ($target -ne [IntPtr]::Zero) {
        $info = Get-BmgWindowInfo $target
        if ($PSCmdlet.ParameterSetName -eq 'Nonce') {
            if ($info.marker -ne 0 -and $info.marker -ne $WindowMarker) {
                throw "BMG workspace window already carries a different ownership marker."
            }
            if (-not [BmgWorkspaceWin32]::SetProp($target, $propertyName, [IntPtr]$WindowMarker)) {
                throw "BMG workspace ownership marker could not be set."
            }
        } elseif ($info.marker -ne $WindowMarker) {
            throw "BMG workspace ownership marker mismatch."
        }

        if ($InspectOnly) {
            $info = Get-BmgWindowInfo $target
            $info | ConvertTo-Json -Compress
            exit 0
        }
        if ([BmgWorkspaceWin32]::IsIconic($target)) {
            [void][BmgWorkspaceWin32]::ShowWindowAsync($target, 4) # SW_SHOWNOACTIVATE
            Start-Sleep -Milliseconds 80
        }
        $before = Get-BmgWindowInfo $target
        $oldExStyle = $before.exStyle
        $newExStyle = ($oldExStyle -band (-bnot $WS_EX_APPWINDOW)) -bor $WS_EX_TOOLWINDOW
        if ($newExStyle -ne $oldExStyle) {
            [void][BmgWorkspaceWin32]::SetWindowLongPtr($target, $GWL_EXSTYLE, [IntPtr]$newExStyle)
        }
        $flags = $SWP_NOSIZE -bor $SWP_NOMOVE -bor $SWP_NOZORDER -bor $SWP_NOACTIVATE -bor $SWP_FRAMECHANGED
        if (-not [BmgWorkspaceWin32]::SetWindowPos($target, [IntPtr]::Zero, 0, 0, 0, 0, [uint32]$flags)) {
            throw "SetWindowPos failed while applying BMG workspace window style."
        }
        [void][BmgWorkspaceWin32]::ShowWindowAsync($target, 0) # SW_HIDE
        Clear-BmgWindowAttention $target
        Start-Sleep -Milliseconds 80
        $after = Get-BmgWindowInfo $target
        if ($after.visible -or $after.minimized) {
            throw "BMG workspace true-hide verification failed."
        }
        if ($after.appWindow -or -not $after.toolWindow -or $after.marker -ne $WindowMarker) {
            throw "BMG workspace ownership/style verification failed."
        }
        if ($after.left -ne $before.left -or $after.top -ne $before.top -or
            $after.right -ne $before.right -or $after.bottom -ne $before.bottom) {
            throw "BMG workspace hide unexpectedly changed window geometry."
        }
        $after | ConvertTo-Json -Compress
        exit 0
    }
    Start-Sleep -Milliseconds 100
} while ([DateTime]::UtcNow -lt $deadline)

throw "Timed out waiting for the BMG workspace Edge window."
