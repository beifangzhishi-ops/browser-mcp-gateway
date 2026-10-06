# 仅由已完成归属校验的工作区隐藏/显示脚本调用。
if (-not ('BmgWorkspaceTaskbar' -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class BmgWorkspaceTaskbar {
    [ComImport, Guid("56FDF342-FD6D-11D0-958A-006097C9A090"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ITaskbarList {
        [PreserveSig] int HrInit();
        [PreserveSig] int AddTab(IntPtr hwnd);
        [PreserveSig] int DeleteTab(IntPtr hwnd);
        [PreserveSig] int ActivateTab(IntPtr hwnd);
        [PreserveSig] int SetActiveAlt(IntPtr hwnd);
    }
    [ComImport, Guid("56FDF344-FD6D-11D0-958A-006097C9A090")]
    private class TaskbarList { }
    public static void Update(IntPtr hwnd, bool show) {
        ITaskbarList taskbar = (ITaskbarList)new TaskbarList();
        try {
            Marshal.ThrowExceptionForHR(taskbar.HrInit());
            Marshal.ThrowExceptionForHR(show ? taskbar.AddTab(hwnd) : taskbar.DeleteTab(hwnd));
        } finally {
            Marshal.FinalReleaseComObject(taskbar);
        }
    }
}
"@
}
