import fs from 'node:fs';
import path from 'node:path';
import { randomInt } from 'node:crypto';

const STATE_VERSION = 2;
const STARTUP_STATE_VERSION = 1;
const STARTUP_STATE_CLAIM_GRACE_MS = 30 * 1000;
const STARTUP_STATE_MAX_AGE_MS = 10 * 60 * 1000;
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
    const windowMarker = asPositiveInteger(state.windowMarker);
    const processId = asPositiveInteger(state.processId);
    const processStartTimeUtc =
      typeof state.processStartTimeUtc === 'string' && state.processStartTimeUtc
        ? state.processStartTimeUtc
        : null;
    const visible = state.visible === true;
    return windowId && tabId && hwnd && windowMarker
      ? { windowId, tabId, hwnd, windowMarker, processId, processStartTimeUtc, visible }
      : null;
  } catch {
    return null;
  }
}

function loadStartupState(file, now) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/u, '');
    const state = JSON.parse(text);
    if (state?.version !== STARTUP_STATE_VERSION) return null;
    if (typeof state.nonce !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/u.test(state.nonce)) return null;
    const windowMarker = asPositiveInteger(state.windowMarker);
    if (!Number.isFinite(state.createdAtMs) || !windowMarker) return null;
    if (now - state.createdAtMs < 0 || now - state.createdAtMs > STARTUP_STATE_MAX_AGE_MS) return null;
    return { nonce: state.nonce, createdAtMs: state.createdAtMs, windowMarker };
  } catch {
    return null;
  }
}

function createWindowMarker() {
  return randomInt(1, 0x7fffffff);
}

function bootstrapTabMatches(tab, bootstrapUrl, nonce) {
  if (typeof tab?.url !== 'string') return false;
  try {
    const expected = new URL(bootstrapUrl);
    const actual = new URL(tab.url);
    return actual.origin === expected.origin &&
      actual.pathname === expected.pathname &&
      actual.searchParams.get('nonce') === nonce;
  } catch {
    return false;
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
    startupStateFile = null,
    callTool,
    bootstrapUrl,
    claimWindow = async () => {},
    inspectWindow = async () => {},
    ensureWindowHidden = async () => {},
    showWindow = async () => {},
    recoverBrowser = null,
    recoveryDelaysMs = [1000, 2500, 5000],
    wait = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
    idleTimeoutMs = 30 * 60 * 1000,
    clock = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    logger = console,
  } = {}) {
    this.enabled = enabled === true;
    this.stateFile = stateFile;
    this.startupStateFile = startupStateFile;
    this.callTool = callTool;
    this.bootstrapUrl = bootstrapUrl;
    this.claimWindow = claimWindow;
    this.inspectWindow = inspectWindow;
    this.ensureWindowHidden = ensureWindowHidden;
    this.showWindow = showWindow;
    this.recoverBrowser = typeof recoverBrowser === 'function' ? recoverBrowser : null;
    this.recoveryDelaysMs = Array.isArray(recoveryDelaysMs)
      ? recoveryDelaysMs.map(Number).filter((delay) => Number.isFinite(delay) && delay >= 0)
      : [];
    this.wait = wait;
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
    this.windowMarker = state?.windowMarker || null;
    this.processId = state?.processId || null;
    this.processStartTimeUtc = state?.processStartTimeUtc || null;
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
    const tabs = Array.isArray(targetWindow.tabs) ? targetWindow.tabs : [];
    const tabIds = [...new Set(tabs.map((tab) => asPositiveInteger(tab?.tabId)).filter(Boolean))];
    if (tabIds.length === 0) {
      this.reset();
      return;
    }
    const keepTabId = tabIds.includes(this.tabId)
      ? this.tabId
      : asPositiveInteger(tabs.find((tab) => tab?.active)?.tabId) || tabIds[0];
    if (generation !== this.activityGeneration) return;
    const blankMessage = await this.callTool('chrome_navigate', {
      url: 'about:blank',
      tabId: keepTabId,
      windowId: targetWindowId,
      newWindow: false,
      background: true,
    });
    if (toolResultIsError(blankMessage)) {
      throw new Error('BMG workspace tab could not be reset to about:blank.');
    }
    if (generation !== this.activityGeneration) return;
    const extraTabIds = tabIds.filter((tabId) => tabId !== keepTabId);
    if (extraTabIds.length > 0) {
      const closeMessage = await this.callTool('chrome_close_tabs', { tabIds: extraTabIds });
      const closeData = parseToolData(closeMessage);
      if (toolResultIsError(closeMessage) || closeData?.success === false) {
        throw new Error('BMG workspace extra tabs could not be closed.');
      }
    }
    if (this.hwnd && this.windowMarker) {
      const hidden = await this.ensureWindowHidden(this.hwnd, this.windowMarker);
      this.updateWindowIdentity(hidden);
    }
    this.lastActivityAt = this.clock();
    this.activityGeneration += 1;
    this.remember(targetWindowId, keepTabId, this.hwnd, false);
    this.logger?.log?.(`BMG workspace reset to one hidden about:blank tab after idle timeout.`);
  }

  updateWindowIdentity(info) {
    const processId = asPositiveInteger(info?.processId);
    const processStartTimeUtc =
      typeof info?.processStartTimeUtc === 'string' && info.processStartTimeUtc
        ? info.processStartTimeUtc
        : null;
    if (processId) this.processId = processId;
    if (processStartTimeUtc) this.processStartTimeUtc = processStartTimeUtc;
  }

  reset() {
    this.clearIdleTimer();
    this.activityGeneration += 1;
    this.windowId = null;
    this.tabId = null;
    this.hwnd = null;
    this.windowMarker = null;
    this.processId = null;
    this.processStartTimeUtc = null;
    this.visible = false;
    this.validated = false;
    removeState(this.stateFile);
  }

  remember(windowId, tabId, hwnd = this.hwnd, visible = this.visible) {
    const validWindowId = asPositiveInteger(windowId);
    const validTabId = asPositiveInteger(tabId);
    const validHwnd = asPositiveInteger(hwnd);
    const validWindowMarker = asPositiveInteger(this.windowMarker);
    if (!validWindowId || !validTabId || !validHwnd || !validWindowMarker) return false;
    this.windowId = validWindowId;
    this.tabId = validTabId;
    this.hwnd = validHwnd;
    this.visible = visible === true;
    this.validated = true;
    saveState(this.stateFile, {
      windowId: validWindowId,
      tabId: validTabId,
      hwnd: validHwnd,
      windowMarker: validWindowMarker,
      ...(this.processId ? { processId: this.processId } : {}),
      ...(this.processStartTimeUtc ? { processStartTimeUtc: this.processStartTimeUtc } : {}),
      visible: this.visible,
    });
    this.scheduleIdleCleanup();
    return true;
  }

  async validatePersistedWorkspace() {
    if (!this.windowId || !this.tabId || !this.hwnd || !this.windowMarker) return null;
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

    try {
      const info = await this.inspectWindow(this.hwnd, this.windowMarker);
      const actualProcessId = asPositiveInteger(info?.processId);
      const actualStart =
        typeof info?.processStartTimeUtc === 'string' ? info.processStartTimeUtc : null;
      if (this.processId && actualProcessId && this.processId !== actualProcessId) {
        throw new Error('BMG workspace Edge process changed.');
      }
      if (this.processStartTimeUtc && actualStart && this.processStartTimeUtc !== actualStart) {
        throw new Error('BMG workspace Edge process start time changed.');
      }
      this.updateWindowIdentity(info);
      let visible = this.visible === true && info?.visible === true;
      if (!visible) {
        const hidden = await this.ensureWindowHidden(this.hwnd, this.windowMarker);
        this.updateWindowIdentity(hidden);
        visible = false;
      }
      this.remember(this.windowId, selectedTabId, this.hwnd, visible);
      return {
        windowId: this.windowId,
        tabId: this.tabId,
        hwnd: this.hwnd,
        visible: this.visible,
      };
    } catch {
      this.logger?.error?.('BMG workspace ownership validation failed; stale state will be retired without touching that window.');
      this.reset();
      return null;
    }
  }

  async claimStartupWorkspace() {
    if (!this.startupStateFile) return null;
    const startup = loadStartupState(this.startupStateFile, this.clock());
    if (!startup) {
      removeState(this.startupStateFile);
      return null;
    }

    const message = await this.callTool('get_windows_and_tabs', {});
    if (toolResultIsError(message)) {
      throw new Error('BMG startup workspace could not enumerate browser windows yet.');
    }
    const data = parseToolData(message);
    const windows = Array.isArray(data?.windows) ? data.windows : [];
    const matches = [];
    for (const browserWindow of windows) {
      const windowId = asPositiveInteger(browserWindow?.windowId);
      if (!windowId) continue;
      for (const tab of Array.isArray(browserWindow?.tabs) ? browserWindow.tabs : []) {
        const tabId = asPositiveInteger(tab?.tabId);
        if (tabId && bootstrapTabMatches(tab, this.bootstrapUrl, startup.nonce)) {
          matches.push({ windowId, tabId });
        }
      }
    }
    if (matches.length === 0) {
      if (this.clock() - startup.createdAtMs <= STARTUP_STATE_CLAIM_GRACE_MS) {
        throw new Error('BMG startup Edge window is not visible to the extension yet.');
      }
      removeState(this.startupStateFile);
      return null;
    }
    if (matches.length !== 1) {
      throw new Error('Multiple browser tabs matched the BMG startup nonce; refusing to claim any window.');
    }

    const windowMarker = startup.windowMarker;
    const placement = await this.claimWindow(startup.nonce, windowMarker);
    const hwnd = asPositiveInteger(placement?.hwnd);
    if (!hwnd) throw new Error('BMG startup workspace HWND could not be captured.');
    this.windowMarker = windowMarker;
    this.updateWindowIdentity(placement);
    if (!this.remember(matches[0].windowId, matches[0].tabId, hwnd, false)) {
      throw new Error('BMG startup workspace identity could not be persisted.');
    }
    removeState(this.startupStateFile);
    return {
      windowId: this.windowId,
      tabId: this.tabId,
      hwnd: this.hwnd,
      visible: false,
    };
  }

  async createWorkspace() {
    const startupWorkspace = await this.claimStartupWorkspace();
    if (startupWorkspace) return startupWorkspace;

    const nonce = `${this.clock()}-${process.pid}-${randomInt(0, 0xffffffff).toString(16)}`;
    const separator = this.bootstrapUrl.includes('?') ? '&' : '?';
    const url = `${this.bootstrapUrl}${separator}nonce=${encodeURIComponent(nonce)}`;
    const windowMarker = createWindowMarker();
    const message = await this.callTool('chrome_navigate', {
      url,
      newWindow: true,
      background: true,
    });
    const data = parseToolData(message);
    const windowId = asPositiveInteger(data?.windowId);
    const firstTab = Array.isArray(data?.tabs) ? data.tabs[0] : null;
    const tabId = asPositiveInteger(data?.tabId ?? firstTab?.tabId);
    if (!windowId || !tabId) {
      throw new Error('BMG workspace window could not be created.');
    }
    try {
      const placement = await this.claimWindow(nonce, windowMarker);
      const hwnd = asPositiveInteger(placement?.hwnd);
      this.windowMarker = windowMarker;
      this.updateWindowIdentity(placement);
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

  async prepareWorkspaceOnce() {
    try {
      const persisted = await this.validatePersistedWorkspace();
      if (persisted) return persisted;
    } catch {
      this.reset();
    }
    return this.createWorkspace();
  }

  async prepareWorkspaceWithRecovery() {
    try {
      return await this.prepareWorkspaceOnce();
    } catch (firstError) {
      if (!this.recoverBrowser || this.recoveryDelaysMs.length === 0) throw firstError;
      await this.recoverBrowser();
      let lastError = firstError;
      for (const delay of this.recoveryDelaysMs) {
        if (delay > 0) await this.wait(delay);
        try {
          return await this.prepareWorkspaceOnce();
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    }
  }

  async ensureWorkspace({ revalidate = false } = {}) {
    if (!this.enabled) return null;
    if (this.idleCleanup) await this.idleCleanup;
    if (revalidate) this.validated = false;
    if (this.windowId && this.tabId && this.validated) {
      return { windowId: this.windowId, tabId: this.tabId, hwnd: this.hwnd, visible: this.visible };
    }
    if (this.initializing) return this.initializing;
    const task = this.prepareWorkspaceWithRecovery();
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
    const result = await this.showWindow(workspace.hwnd, this.windowMarker);
    this.updateWindowIdentity(result);
    this.remember(workspace.windowId, workspace.tabId, workspace.hwnd, true);
    return { ...workspace, visible: true, foreground: result?.foreground === true };
  }

  async hideWorkspace() {
    if (!this.enabled) throw new Error('BMG workspace mode is disabled.');
    this.markActivity();
    this.validated = false;
    const workspace = await this.ensureWorkspace();
    const result = await this.ensureWindowHidden(workspace.hwnd, this.windowMarker);
    this.updateWindowIdentity(result);
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
    } else if (name === 'chrome_close_tabs') {
      const data = parseToolData(message);
      if (data?.success === true) this.reset();
      return;
    }
    if (TARGET_TOOLS.has(name) && this.hwnd && this.windowMarker) {
      try {
        const hidden = await this.ensureWindowHidden(this.hwnd, this.windowMarker);
        this.updateWindowIdentity(hidden);
        this.remember(this.windowId, this.tabId, this.hwnd, false);
      } catch {
        this.validated = false;
        this.logger?.error?.('BMG workspace HWND maintenance failed; browser result remains valid.');
      }
    }
  }
}

export const workspaceToolDataForTest = parseToolData;
