import fs from 'node:fs';
import path from 'node:path';

const STATE_VERSION = 1;
const TARGET_TOOLS = new Set([
  'chrome_navigate',
  'chrome_screenshot',
  'chrome_go_back_or_forward',
  'chrome_get_web_content',
  'chrome_click_element',
  'chrome_fill_or_select',
  'chrome_get_interactive_elements',
  'chrome_keyboard',
  'chrome_network_debugger_start',
  'chrome_network_capture_start',
  'chrome_inject_script',
  'chrome_send_command_to_inject_script',
  'chrome_console',
  'chrome_upload_file',
]);
const BACKGROUND_TOOLS = new Set([
  'chrome_navigate',
  'chrome_screenshot',
  'chrome_get_web_content',
  'chrome_network_debugger_start',
  'chrome_inject_script',
  'chrome_console',
]);

function asPositiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function parseTextContent(content) {
  if (!Array.isArray(content)) return null;
  const textItem = content.find((item) => item?.type === 'text' && typeof item.text === 'string');
  if (!textItem) return null;
  try {
    return JSON.parse(textItem.text);
  } catch {
    return null;
  }
}

function parseToolData(message) {
  const outer = parseTextContent(message?.result?.content);
  if (!outer) return null;
  const nested = parseTextContent(outer?.data?.content);
  return nested || outer;
}

function toolResultIsError(message) {
  if (message?.result?.isError === true) return true;
  const outer = parseTextContent(message?.result?.content);
  return outer?.data?.isError === true;
}

function loadState(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (state?.version !== STATE_VERSION) return null;
    const windowId = asPositiveInteger(state.windowId);
    const tabId = asPositiveInteger(state.tabId);
    const hwnd = asPositiveInteger(state.hwnd);
    const visible = state.visible === true;
    return windowId && tabId ? { windowId, tabId, hwnd, visible } : null;
  } catch {
    return null;
  }
}

function saveState(file, state) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: STATE_VERSION, ...state }, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function removeState(file) {
  if (!file) return;
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export class BrowserWorkspaceRouter {
  constructor({
    enabled = false,
    stateFile = null,
    callTool,
    bootstrapUrl,
    placeWindowOffscreen = async () => {},
    ensureWindowHidden = async () => {},
    showWindow = async () => {},
    idleTimeoutMs = 30 * 60 * 1000,
    clock = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    logger = console,
  } = {}) {
    this.enabled = enabled === true;
    this.stateFile = stateFile;
    this.callTool = callTool;
    this.bootstrapUrl = bootstrapUrl;
    this.placeWindowOffscreen = placeWindowOffscreen;
    this.ensureWindowHidden = ensureWindowHidden;
    this.showWindow = showWindow;
    this.idleTimeoutMs = Number(idleTimeoutMs);
    this.clock = clock;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.logger = logger;
    if (!Number.isFinite(this.idleTimeoutMs) || this.idleTimeoutMs < 0) {
      throw new Error('BMG workspace idle timeout must be a non-negative number.');
    }
    this.idleTimer = null;
    this.idleCleanup = null;
    this.lastActivityAt = this.clock();
    this.activityGeneration = 0;
    const state = loadState(stateFile);
    this.windowId = state?.windowId || null;
    this.tabId = state?.tabId || null;
    this.hwnd = state?.hwnd || null;
    this.visible = state?.visible === true;
    this.validated = false;
    this.initializing = null;
    if (this.windowId && this.tabId) this.scheduleIdleCleanup();
  }

  clearIdleTimer() {
    if (this.idleTimer !== null) {
      this.clearTimer(this.idleTimer);
      this.idleTimer = null;
    }
  }

  markActivity() {
    if (!this.enabled || this.idleTimeoutMs === 0) return;
    this.lastActivityAt = this.clock();
    this.activityGeneration += 1;
    this.scheduleIdleCleanup();
  }

  scheduleIdleCleanup() {
    this.clearIdleTimer();
    if (!this.enabled || this.idleTimeoutMs === 0 || !this.windowId || !this.tabId) return;
    const generation = this.activityGeneration;
    const elapsed = Math.max(0, this.clock() - this.lastActivityAt);
    const delay = Math.max(1, this.idleTimeoutMs - elapsed);
    let timer = null;
    timer = this.setTimer(() => {
      if (this.idleTimer === timer) this.idleTimer = null;
      return this.runIdleCleanup(generation);
    }, delay);
    this.idleTimer = timer;
    timer?.unref?.();
  }

  async runIdleCleanup(generation) {
    if (this.idleCleanup) return this.idleCleanup;
    const cleanup = this.cleanupIdleWorkspace(generation);
    this.idleCleanup = cleanup;
    try {
      await cleanup;
    } catch (error) {
      this.logger?.error?.('BMG workspace idle cleanup failed; it will retry after the timeout.');
      this.lastActivityAt = this.clock();
      this.scheduleIdleCleanup();
    } finally {
      if (this.idleCleanup === cleanup) this.idleCleanup = null;
    }
  }

  async cleanupIdleWorkspace(generation) {
    if (!this.enabled || this.idleTimeoutMs === 0 || generation !== this.activityGeneration) return;
    const elapsed = Math.max(0, this.clock() - this.lastActivityAt);
    if (elapsed < this.idleTimeoutMs) {
      this.scheduleIdleCleanup();
      return;
    }
    if (!this.windowId) return;

    const targetWindowId = this.windowId;
    const message = await this.callTool('get_windows_and_tabs', {});
    if (generation !== this.activityGeneration) return;
    const data = parseToolData(message);
    const windows = Array.isArray(data?.windows) ? data.windows : [];
    const targetWindow = windows.find((item) => item?.windowId === targetWindowId);
    if (!targetWindow) {
      this.reset();
      return;
    }
    const tabIds = [...new Set(
      (Array.isArray(targetWindow.tabs) ? targetWindow.tabs : [])
        .map((tab) => asPositiveInteger(tab?.tabId))
        .filter(Boolean),
    )];
    if (tabIds.length === 0) {
      this.reset();
      return;
    }
    if (generation !== this.activityGeneration) return;
    const closeMessage = await this.callTool('chrome_close_tabs', { tabIds });
    const closeData = parseToolData(closeMessage);
    if (toolResultIsError(closeMessage) || closeData?.success === false) {
      throw new Error('BMG workspace tabs could not be closed.');
    }
    this.reset();
    this.logger?.log?.(`BMG workspace closed ${tabIds.length} tab(s) after idle timeout.`);
  }

  reset() {
    this.clearIdleTimer();
    this.activityGeneration += 1;
    this.windowId = null;
    this.tabId = null;
    this.hwnd = null;
    this.visible = false;
    this.validated = false;
    removeState(this.stateFile);
  }

  remember(windowId, tabId, hwnd = this.hwnd, visible = this.visible) {
    const validWindowId = asPositiveInteger(windowId);
    const validTabId = asPositiveInteger(tabId);
    const validHwnd = asPositiveInteger(hwnd);
    if (!validWindowId || !validTabId) return false;
    this.windowId = validWindowId;
    this.tabId = validTabId;
    this.hwnd = validHwnd;
    this.visible = visible === true;
    this.validated = true;
    saveState(this.stateFile, {
      windowId: validWindowId,
      tabId: validTabId,
      ...(validHwnd ? { hwnd: validHwnd } : {}),
      visible: this.visible,
    });
    this.scheduleIdleCleanup();
    return true;
  }

  async validatePersistedWorkspace() {
    if (!this.windowId || !this.tabId) return null;
    const message = await this.callTool('get_windows_and_tabs', {});
    const data = parseToolData(message);
    const windows = Array.isArray(data?.windows) ? data.windows : [];
    const targetWindow = windows.find((item) => item?.windowId === this.windowId);
    const tabs = Array.isArray(targetWindow?.tabs) ? targetWindow.tabs : [];
    const exact = tabs.find((tab) => tab?.tabId === this.tabId);
    const fallback = tabs.find((tab) => tab?.active) || tabs[0];
    const selectedTabId = asPositiveInteger(exact?.tabId ?? fallback?.tabId);
    if (!targetWindow || !selectedTabId) {
      this.reset();
      return null;
    }
    if (!this.hwnd) {
      try { await this.callTool('chrome_close_tabs', { tabIds: [selectedTabId] }); } catch {}
      this.reset();
      return null;
    }
    if (!this.visible) {
      try {
        await this.ensureWindowHidden(this.hwnd);
      } catch (error) {
        this.logger?.error?.('BMG workspace HWND validation failed; recreating workspace.');
        try { await this.callTool('chrome_close_tabs', { tabIds: [selectedTabId] }); } catch {}
        this.reset();
        return null;
      }
    }
    this.remember(this.windowId, selectedTabId, this.hwnd, this.visible);
    return { windowId: this.windowId, tabId: this.tabId, hwnd: this.hwnd, visible: this.visible };
  }

  async createWorkspace() {
    const nonce = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
    const separator = this.bootstrapUrl.includes('?') ? '&' : '?';
    const url = `${this.bootstrapUrl}${separator}nonce=${encodeURIComponent(nonce)}`;
    const message = await this.callTool('chrome_navigate', {
      url,
      newWindow: true,
      background: true,
      width: 480,
      height: 360,
    });
    const data = parseToolData(message);
    const windowId = asPositiveInteger(data?.windowId);
    const firstTab = Array.isArray(data?.tabs) ? data.tabs[0] : null;
    const tabId = asPositiveInteger(data?.tabId ?? firstTab?.tabId);
    if (!windowId || !tabId) {
      throw new Error('BMG workspace window could not be created.');
    }
    try {
      const placement = await this.placeWindowOffscreen(nonce);
      const hwnd = asPositiveInteger(placement?.hwnd);
      if (!hwnd || !this.remember(windowId, tabId, hwnd, false)) {
        throw new Error('BMG workspace HWND could not be captured.');
      }
    } catch (error) {
      try {
        await this.callTool('chrome_close_tabs', { tabIds: [tabId] });
      } catch {}
      this.reset();
      throw error;
    }
    return { windowId, tabId, hwnd: this.hwnd, visible: false };
  }

  async ensureWorkspace() {
    if (!this.enabled) return null;
    if (this.idleCleanup) await this.idleCleanup;
    if (this.windowId && this.tabId && this.validated) {
      return { windowId: this.windowId, tabId: this.tabId, hwnd: this.hwnd, visible: this.visible };
    }
    if (this.initializing) return this.initializing;
    const task = (async () => {
      try {
        const persisted = await this.validatePersistedWorkspace();
        if (persisted) return persisted;
      } catch {
        this.reset();
      }
      return this.createWorkspace();
    })();
    this.initializing = task;
    try {
      return await task;
    } finally {
      if (this.initializing === task) this.initializing = null;
    }
  }


  async showWorkspace() {
    if (!this.enabled) throw new Error('BMG workspace mode is disabled.');
    this.markActivity();
    this.validated = false;
    const workspace = await this.ensureWorkspace();
    const result = await this.showWindow(workspace.hwnd);
    this.remember(workspace.windowId, workspace.tabId, workspace.hwnd, true);
    return { ...workspace, visible: true, foreground: result?.foreground === true };
  }

  async hideWorkspace() {
    if (!this.enabled) throw new Error('BMG workspace mode is disabled.');
    this.markActivity();
    this.validated = false;
    const workspace = await this.ensureWorkspace();
    const result = await this.ensureWindowHidden(workspace.hwnd);
    this.remember(workspace.windowId, workspace.tabId, workspace.hwnd, false);
    return { ...workspace, visible: false, hidden: result?.hidden !== false };
  }

  async close() {
    this.clearIdleTimer();
    if (this.idleCleanup) await this.idleCleanup;
    this.clearIdleTimer();
  }

  async rewrite(payload) {
    if (!this.enabled || payload?.method !== 'tools/call') return payload;
    const name = payload.params?.name;
    if (typeof name !== 'string') return payload;
    this.markActivity();
    if (name === 'get_windows_and_tabs' || !TARGET_TOOLS.has(name) && name !== 'chrome_close_tabs') {
      return payload;
    }
    const workspace = await this.ensureWorkspace();
    const args = { ...(payload.params?.arguments || {}) };
    if (name === 'chrome_close_tabs') {
      delete args.url;
      args.tabIds = [workspace.tabId];
    } else {
      args.tabId = workspace.tabId;
      args.windowId = workspace.windowId;
      if (BACKGROUND_TOOLS.has(name)) args.background = true;
      if (name === 'chrome_navigate') {
        args.newWindow = false;
        delete args.width;
        delete args.height;
      }
    }
    return {
      ...payload,
      params: { ...payload.params, arguments: args },
    };
  }

  async observe(payload, message) {
    if (!this.enabled || payload?.method !== 'tools/call') return;
    const name = payload.params?.name;
    if (toolResultIsError(message)) {
      this.validated = false;
      return;
    }
    if (name === 'chrome_navigate') {
      const data = parseToolData(message);
      this.remember(
        data?.windowId ?? this.windowId,
        data?.tabId ?? this.tabId,
        this.hwnd,
        this.visible,
      );
      if (this.hwnd && !this.visible) {
        try {
          await this.ensureWindowHidden(this.hwnd);
        } catch {
          this.validated = false;
          this.logger?.error?.('BMG workspace HWND maintenance failed; browser result remains valid.');
        }
      }
    } else if (name === 'chrome_close_tabs') {
      const data = parseToolData(message);
      if (data?.success === true) this.reset();
    }
  }
}

export const workspaceToolDataForTest = parseToolData;
