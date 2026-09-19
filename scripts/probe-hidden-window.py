"""独立试验的 Windows 窗口控制器：只接受带随机测试标记的 Edge 窗口。"""
import ctypes as c
from ctypes import wintypes as w
import json
import sys
import threading
import time


def main():
    token = sys.argv[1]
    if not token.startswith('BMG-HIDE-') or not token.replace('-', '').isalnum():
        raise ValueError('无效的测试标记')
    user = c.WinDLL('user32', use_last_error=True)
    kernel = c.WinDLL('kernel32', use_last_error=True)
    enum_proc = c.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)
    event_proc = c.WINFUNCTYPE(None, w.HANDLE, w.DWORD, w.HWND, w.LONG, w.LONG, w.DWORD, w.DWORD)
    user.EnumWindows.argtypes = [enum_proc, w.LPARAM]
    user.GetWindowTextW.argtypes = [w.HWND, w.LPWSTR, c.c_int]
    user.GetWindowThreadProcessId.argtypes = [w.HWND, c.POINTER(w.DWORD)]
    user.IsWindowVisible.argtypes = [w.HWND]
    user.IsIconic.argtypes = [w.HWND]
    user.GetWindowRect.argtypes = [w.HWND, c.POINTER(w.RECT)]
    user.ShowWindowAsync.argtypes = [w.HWND, c.c_int]
    user.SetWinEventHook.argtypes = [w.DWORD, w.DWORD, w.HMODULE, event_proc, w.DWORD, w.DWORD, w.DWORD]
    user.SetWinEventHook.restype = w.HANDLE
    user.UnhookWinEvent.argtypes = [w.HANDLE]
    user.PeekMessageW.argtypes = [c.POINTER(w.MSG), w.HWND, w.UINT, w.UINT, w.UINT]
    user.TranslateMessage.argtypes = [c.POINTER(w.MSG)]
    user.DispatchMessageW.argtypes = [c.POINTER(w.MSG)]
    kernel.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
    kernel.OpenProcess.restype = w.HANDLE
    kernel.QueryFullProcessImageNameW.argtypes = [w.HANDLE, w.DWORD, w.LPWSTR, c.POINTER(w.DWORD)]
    kernel.CloseHandle.argtypes = [w.HANDLE]

    def identity(hwnd):
        title = c.create_unicode_buffer(1024)
        user.GetWindowTextW(hwnd, title, len(title))
        pid = w.DWORD()
        user.GetWindowThreadProcessId(hwnd, c.byref(pid))
        process = kernel.OpenProcess(0x1000, False, pid.value)
        if not process:
            return None
        try:
            exe = c.create_unicode_buffer(32768)
            size = w.DWORD(len(exe))
            if not kernel.QueryFullProcessImageNameW(process, 0, exe, c.byref(size)):
                return None
            if token in title.value and exe.value.lower().endswith('\\msedge.exe'):
                return pid.value
        finally:
            kernel.CloseHandle(process)
        return None

    matches = []

    @enum_proc
    def collect(hwnd, _):
        pid = identity(hwnd)
        if pid:
            matches.append((hwnd, pid))
        return True

    user.EnumWindows(collect, 0)
    if len(matches) != 1:
        raise RuntimeError('未找到唯一的专用测试窗口')
    hwnd, pid = matches[0]
    originally_visible = bool(user.IsWindowVisible(hwnd))
    events = []
    stop = threading.Event()
    ready = threading.Event()
    hook_error = []

    @event_proc
    def record(_, event, target, object_id, child_id, _thread, _tick):
        if target == hwnd and object_id == 0 and child_id == 0:
            events.append({'event': '显示' if event == 0x8002 else '隐藏', 'time': time.time()})

    def watch():
        hook = user.SetWinEventHook(0x8002, 0x8003, None, record, pid, 0, 0)
        if not hook:
            hook_error.append('无法监听窗口显示事件')
        ready.set()
        try:
            message = w.MSG()
            while not stop.is_set():
                while user.PeekMessageW(c.byref(message), None, 0, 0, 1):
                    user.TranslateMessage(c.byref(message))
                    user.DispatchMessageW(c.byref(message))
                stop.wait(0.01)
        finally:
            if hook:
                user.UnhookWinEvent(hook)

    monitor = threading.Thread(target=watch, daemon=True)
    monitor.start()
    ready.wait(3)
    if not ready.is_set() or hook_error:
        raise RuntimeError('窗口事件监听启动失败')

    def snapshot():
        if identity(hwnd) != pid:
            raise RuntimeError('测试窗口身份已改变，停止操作')
        rect = w.RECT()
        if not user.GetWindowRect(hwnd, c.byref(rect)):
            raise RuntimeError('无法读取测试窗口坐标')
        return {'hwnd': hwnd, 'visible': bool(user.IsWindowVisible(hwnd)),
                'minimized': bool(user.IsIconic(hwnd)),
                'rect': [rect.left, rect.top, rect.right, rect.bottom], 'events': list(events)}

    def visibility(visible):
        snapshot()
        user.ShowWindowAsync(hwnd, 4 if visible else 0)
        deadline = time.monotonic() + 3
        while bool(user.IsWindowVisible(hwnd)) != visible:
            if time.monotonic() > deadline:
                raise RuntimeError('窗口可见状态未按预期改变')
            time.sleep(0.01)
        return snapshot()

    def emit(value):
        print(json.dumps(value, ensure_ascii=True), flush=True)

    try:
        emit(snapshot())
        for command in sys.stdin:
            action = command.strip()
            if action == '结束不恢复':
                originally_visible = False
                break
            if action == '结束':
                break
            try:
                if action == '隐藏':
                    emit(visibility(False))
                elif action == '显示':
                    emit(visibility(True))
                elif action == '检查':
                    emit(snapshot())
                else:
                    raise ValueError('未知操作')
            except Exception as error:
                emit({'error': str(error)})
    finally:
        if originally_visible and identity(hwnd) == pid and not user.IsWindowVisible(hwnd):
            visibility(True)
        stop.set()
        monitor.join(2)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'error': str(error)}, ensure_ascii=True), flush=True)
        sys.exit(1)
