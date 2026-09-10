[CmdletBinding(DefaultParameterSetName = 'Nonce')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Nonce')]
    [ValidatePattern('^[A-Za-z0-9._-]+$')]
    [string]$Nonce,
    [Parameter(Mandatory = $true, ParameterSetName = 'Hwnd')]
    [long]$TargetHwnd,
    [int]$TimeoutMs = 7000
)

$ErrorActionPreference = 'Stop'
if ($PSCmdlet.ParameterSetName -eq 'Hwnd' -and $TargetHwnd -le 0) {
    throw "BMG workspace HWND must be a positive integer."
}
$needle = if ($PSCmdlet.ParameterSetName -eq 'Nonce') { "BMG GPT Workspace $Nonce" } else { $null }

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class BmgWorkspaceWin32 {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
}
"@

$GWL_EXSTYLE = -20
$WS_EX_TOOLWINDOW = [int64]0x00000080
$WS_EX_APPWINDOW = [int64]0x00040000
$SWP_NOSIZE = 0x0001
$SWP_NOZORDER = 0x0004
$SWP_NOACTIVATE = 0x0010
$SWP_FRAMECHANGED = 0x0020

$deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
do {
    $matches = [System.Collections.Generic.List[System.IntPtr]]::new()
    [BmgWorkspaceWin32]::EnumWindows({
        param([IntPtr]$hWnd, [IntPtr]$lParam)
        if (-not [BmgWorkspaceWin32]::IsWindowVisible($hWnd)) { return $true }

        [uint32]$processId = 0
        [void][BmgWorkspaceWin32]::GetWindowThreadProcessId($hWnd, [ref]$processId)
        try { $process = Get-Process -Id $processId -ErrorAction Stop } catch { return $true }
        if ($process.ProcessName -ne 'msedge') { return $true }
        if ($PSCmdlet.ParameterSetName -eq 'Nonce') {
            $title = [System.Text.StringBuilder]::new(1024)
            [void][BmgWorkspaceWin32]::GetWindowText($hWnd, $title, $title.Capacity)
            if (-not $title.ToString().Contains($needle)) { return $true }
        } else {
            if ([int64]$hWnd -ne $TargetHwnd) { return $true }
        }

        $matches.Add($hWnd)
        return $true
    }, [IntPtr]::Zero) | Out-Null

    if ($matches.Count -gt 1) {
        throw "Multiple Edge windows matched the BMG workspace nonce. Refusing to modify any window."
    }
    if ($matches.Count -eq 1) {
        $hWnd = $matches[0]
        if ([BmgWorkspaceWin32]::IsIconic($hWnd)) {
            [void][BmgWorkspaceWin32]::ShowWindowAsync($hWnd, 4) # SW_SHOWNOACTIVATE
            Start-Sleep -Milliseconds 100
        }

        $oldExStyle = [BmgWorkspaceWin32]::GetWindowLongPtr($hWnd, $GWL_EXSTYLE).ToInt64()
        $newExStyle = ($oldExStyle -band (-bnot $WS_EX_APPWINDOW)) -bor $WS_EX_TOOLWINDOW
        if ($newExStyle -ne $oldExStyle) {
            [void][BmgWorkspaceWin32]::SetWindowLongPtr($hWnd, $GWL_EXSTYLE, [IntPtr]$newExStyle)
        }
        $flags = $SWP_NOSIZE -bor $SWP_NOZORDER -bor $SWP_NOACTIVATE -bor $SWP_FRAMECHANGED
        if (-not [BmgWorkspaceWin32]::SetWindowPos(
            $hWnd,
            [IntPtr]::Zero,
            -32000,
            -32000,
            0,
            0,
            [uint32]$flags
        )) {
            throw "SetWindowPos failed for the BMG workspace window."
        }

        $verifiedExStyle = [BmgWorkspaceWin32]::GetWindowLongPtr($hWnd, $GWL_EXSTYLE).ToInt64()
        $verifiedRect = New-Object BmgWorkspaceWin32+RECT
        [void][BmgWorkspaceWin32]::GetWindowRect($hWnd, [ref]$verifiedRect)
        if (($verifiedExStyle -band $WS_EX_APPWINDOW) -ne 0 -or ($verifiedExStyle -band $WS_EX_TOOLWINDOW) -eq 0) {
            throw "BMG workspace window style verification failed."
        }
        if ($verifiedRect.Left -gt -30000 -or $verifiedRect.Top -gt -30000) {
            throw "BMG workspace off-screen placement verification failed."
        }

        [pscustomobject]@{
            hwnd = [int64]$hWnd
            left = $verifiedRect.Left
            top = $verifiedRect.Top
            appWindow = $false
            toolWindow = $true
            exStyle = ('0x{0:X}' -f $verifiedExStyle)
        } | ConvertTo-Json -Compress
        exit 0
    }
    Start-Sleep -Milliseconds 100
} while ([DateTime]::UtcNow -lt $deadline)

throw "Timed out waiting for the BMG workspace Edge window."
