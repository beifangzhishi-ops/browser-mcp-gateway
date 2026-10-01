import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL_TARGET_MARKER = 'BMG_UPSTREAM_TOOL_TARGETS_V1';
const FLOW_WORKSPACE_MARKER = 'BMG_FLOW_WORKSPACE_V1';

function replaceExactlyOnce(text, oldText, newText, label) {
  const first = text.indexOf(oldText);
  if (first < 0) throw new Error(label + ' anchor was not found');
  if (text.indexOf(oldText, first + oldText.length) >= 0) {
    throw new Error(label + ' anchor matched more than once');
  }
  return text.slice(0, first) + newText + text.slice(first + oldText.length);
}

function replacePatternExactlyOnce(text, pattern, replacement, label) {
  const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
  const matches = [...text.matchAll(new RegExp(pattern.source, flags))];
  if (matches.length !== 1) {
    throw new Error(label + ' anchor matched ' + matches.length + ' times; expected 1');
  }
  return text.replace(pattern, replacement);
}

function replaceInBlock(text, startAnchor, endAnchor, transform, label) {
  const start = text.indexOf(startAnchor);
  if (start < 0) throw new Error(label + ' start anchor was not found');
  const end = text.indexOf(endAnchor, start + startAnchor.length);
  if (end < 0) throw new Error(label + ' end anchor was not found');
  const block = text.slice(start, end);
  const next = transform(block);
  return text.slice(0, start) + next + text.slice(end);
}

const TARGET_HELPER = `  // ${TOOL_TARGET_MARKER}
  function bmgResolveToolTab(args) {
    return __async(this, null, function* () {
      if (args && Number.isInteger(args.tabId)) {
        try {
          return yield chrome.tabs.get(args.tabId);
        } catch (e) {
          return null;
        }
      }
      const query = args && Number.isInteger(args.windowId)
        ? { active: true, windowId: args.windowId }
        : { active: true, currentWindow: true };
      const tabs = yield chrome.tabs.query(query);
      return tabs[0] || null;
    });
  }
`;

function patchCloseTabs(block) {
  let next = replaceExactlyOnce(
    block,
    '        const { tabIds, url } = args;',
    '        const { tabIds, url, windowId } = args;',
    'close-tabs target args',
  );
  next = replaceExactlyOnce(
    next,
    '            const tabs = yield chrome.tabs.query({ url: urlPattern });',
    '            const tabs = yield chrome.tabs.query(Number.isInteger(windowId) ? { url: urlPattern, windowId } : { url: urlPattern });',
    'close-tabs URL query',
  );
  next = replaceExactlyOnce(
    next,
    '            const validTabIds = existingTabs.filter((tab) => tab !== null).map((tab) => tab.id).filter((id) => id !== void 0);',
    '            const validTabIds = existingTabs.filter((tab) => tab !== null && (!Number.isInteger(windowId) || tab.windowId === windowId)).map((tab) => tab.id).filter((id) => id !== void 0);',
    'close-tabs ID ownership filter',
  );
  next = replaceExactlyOnce(
    next,
    '          const [activeTab] = yield chrome.tabs.query({ active: true, currentWindow: true });',
    '          const activeTab = yield bmgResolveToolTab(args);',
    'close-tabs active target',
  );
  return next;
}

function patchSwitchTab(block) {
  let next = replaceExactlyOnce(
    block,
    '        const { tabId, windowId } = args;',
    '        const { tabId, windowId, background = false } = args;',
    'switch-tab args',
  );
  next = replaceExactlyOnce(
    next,
    `        try {
          if (windowId !== void 0) {
            yield chrome.windows.update(windowId, { focused: true });
          }
          yield chrome.tabs.update(tabId, { active: true });`,
    `        try {
          const targetTab = yield chrome.tabs.get(tabId);
          if (windowId !== void 0 && targetTab.windowId !== windowId) {
            return createErrorResponse("Target tab is outside the requested window");
          }
          if (windowId !== void 0 && background === false) {
            yield chrome.windows.update(windowId, { focused: true });
          }
          yield chrome.tabs.update(tabId, { active: true });`,
    'switch-tab ownership',
  );
  return next;
}

function patchNetworkRequest(block) {
  return replacePatternExactlyOnce(
    block,
    /          const tabs = yield chrome\.tabs\.query\(\{ active: true, currentWindow: true \}\);\r?\n          if \(!\(\(_a2 = tabs\[0\]\) == null \? void 0 : _a2\.id\)\) \{\r?\n            return createErrorResponse\("No active tab found or tab has no ID\."\);\r?\n          \}\r?\n          const activeTabId = tabs\[0\]\.id;/u,
    `          const targetTab = yield bmgResolveToolTab(args);
          if (!(targetTab == null ? void 0 : targetTab.id)) {
            return createErrorResponse("No target tab found or tab has no ID.");
          }
          const activeTabId = targetTab.id;`,
    'network-request target',
  );
}

function patchBookmarkAdd(block) {
  return replaceExactlyOnce(
    block,
    `            const tabs = yield chrome.tabs.query({ active: true, currentWindow: true });
            if (!tabs[0] || !tabs[0].url) {
              return createErrorResponse("No active tab with valid URL found, and no URL provided");
            }
            bookmarkUrl = tabs[0].url;
            if (!bookmarkTitle) {
              bookmarkTitle = tabs[0].title || bookmarkUrl;
            }`,
    `            const targetTab = yield bmgResolveToolTab(args);
            if (!targetTab || !targetTab.url) {
              return createErrorResponse("No target tab with valid URL found, and no URL provided");
            }
            bookmarkUrl = targetTab.url;
            if (!bookmarkTitle) {
              bookmarkTitle = targetTab.title || bookmarkUrl;
            }`,
    'bookmark-add target',
  );
}

function patchDialog(block) {
  return replaceExactlyOnce(
    block,
    '          const [activeTab] = yield chrome.tabs.query({ active: true, currentWindow: true });',
    '          const activeTab = yield bmgResolveToolTab(args);',
    'dialog target',
  );
}

function patchPerformance(block) {
  let next = block;
  const oldText = '          const [activeTab] = yield chrome.tabs.query({ active: true, currentWindow: true });';
  let count = 0;
  while (next.includes(oldText)) {
    next = next.replace(oldText, '          const activeTab = yield bmgResolveToolTab(args);');
    count += 1;
  }
  if (count !== 3) throw new Error('performance target anchor matched ' + count + ' times; expected 3');
  return next;
}

function patchNetworkCaptureStart(block, debuggerMode) {
  let next = block;
  const anchor = debuggerMode
    ? `        let tabToOperateOn;
        try {
          if (targetUrl) {`
    : `        try {
          let tabToOperateOn;
          if (targetUrl) {`;
  const replacement = debuggerMode
    ? `        let tabToOperateOn;
        try {
          const bmgTargetTab = args && (Number.isInteger(args.tabId) || Number.isInteger(args.windowId))
            ? yield bmgResolveToolTab(args)
            : null;
          if (bmgTargetTab) {
            tabToOperateOn = bmgTargetTab;
            if (targetUrl && tabToOperateOn.id && tabToOperateOn.url !== targetUrl) {
              yield chrome.tabs.update(tabToOperateOn.id, { url: targetUrl });
              yield new Promise((resolve) => setTimeout(resolve, 500));
              tabToOperateOn = yield chrome.tabs.get(tabToOperateOn.id);
            }
          } else if (targetUrl) {`
    : `        try {
          let tabToOperateOn;
          const bmgTargetTab = args && (Number.isInteger(args.tabId) || Number.isInteger(args.windowId))
            ? yield bmgResolveToolTab(args)
            : null;
          if (bmgTargetTab) {
            tabToOperateOn = bmgTargetTab;
            if (targetUrl && tabToOperateOn.id && tabToOperateOn.url !== targetUrl) {
              yield chrome.tabs.update(tabToOperateOn.id, { url: targetUrl });
              yield new Promise((resolve) => setTimeout(resolve, 1e3));
              tabToOperateOn = yield chrome.tabs.get(tabToOperateOn.id);
            }
          } else if (targetUrl) {`;
  next = replaceExactlyOnce(next, anchor, replacement, debuggerMode ? 'debugger capture start target' : 'web capture start target');
  return next;
}

function patchNetworkCaptureStop(block, debuggerMode) {
  let next = replaceExactlyOnce(
    block,
    '    execute() {',
    '    execute(args = {}) {',
    debuggerMode ? 'debugger capture stop args' : 'web capture stop args',
  );
  const activeAnchor = debuggerMode
    ? `        const activeTabs = yield chrome.tabs.query({ active: true, currentWindow: true });
        const activeTabId = (_a2 = activeTabs[0]) == null ? void 0 : _a2.id;`
    : `          const activeTabs = yield chrome.tabs.query({ active: true, currentWindow: true });
          const activeTabId = (_a2 = activeTabs[0]) == null ? void 0 : _a2.id;`;
  const indent = debuggerMode ? '        ' : '          ';
  const captureMap = debuggerMode ? 'startTool["captureData"]' : 'startTool.captureData';
  const activeReplacement = `${indent}const requestedTabId = Number.isInteger(args == null ? void 0 : args.tabId) ? args.tabId : null;
${indent}if (requestedTabId && !${captureMap}.has(requestedTabId)) {
${indent}  return createErrorResponse("No active network capture found for the requested tab.");
${indent}}
${indent}const activeTabs = requestedTabId ? [] : yield chrome.tabs.query({ active: true, currentWindow: true });
${indent}const activeTabId = requestedTabId || ((_a2 = activeTabs[0]) == null ? void 0 : _a2.id);`;
  next = replaceExactlyOnce(
    next,
    activeAnchor,
    activeReplacement,
    debuggerMode ? 'debugger capture stop target' : 'web capture stop target',
  );
  next = replaceExactlyOnce(
    next,
    debuggerMode ? '        if (ongoingCaptures.length > 1) {' : '          if (ongoingCaptures.length > 1) {',
    debuggerMode ? '        if (!requestedTabId && ongoingCaptures.length > 1) {' : '          if (!requestedTabId && ongoingCaptures.length > 1) {',
    debuggerMode ? 'debugger capture stop scope' : 'web capture stop scope',
  );
  return next;
}

function patchUnifiedNetworkCapture(block) {
  let next = replaceExactlyOnce(
    block,
    `          inactivityTimeout: args.inactivityTimeout,
          includeStatic: args.includeStatic`,
    `          inactivityTimeout: args.inactivityTimeout,
          includeStatic: args.includeStatic,
          tabId: args.tabId,
          windowId: args.windowId,
          background: args.background`,
    'unified capture start target',
  );
  next = replaceExactlyOnce(
    next,
    '        const result2 = yield delegateStop.execute();',
    '        const result2 = yield delegateStop.execute(args);',
    'unified capture stop target',
  );
  return next;
}

function patchDebuggerChildTabScope(block) {
  let next = replaceExactlyOnce(
    block,
    `          const openerCaptureInfo = this.captureData.get(openerTabId);
          if (!openerCaptureInfo) return;`,
    `          const openerCaptureInfo = this.captureData.get(openerTabId);
          if (!openerCaptureInfo) return;
          if (openerCaptureInfo.windowId !== void 0 && tab.windowId !== openerCaptureInfo.windowId) return;`,
    'debugger child-tab ownership',
  );
  next = replaceExactlyOnce(
    next,
    `            tabTitle: tab.title,
            maxCaptureTime,`,
    `            tabTitle: tab.title,
            windowId: tab.windowId,
            maxCaptureTime,`,
    'debugger capture window identity',
  );
  return next;
}

export function patchUpstreamToolTargets(text) {
  if (text.includes(TOOL_TARGET_MARKER)) return { text, changed: false };
  let next = replaceExactlyOnce(
    text,
    '  class SwitchTabTool extends BaseBrowserToolExecutor {',
    TARGET_HELPER + '  class SwitchTabTool extends BaseBrowserToolExecutor {',
    'target helper insertion',
  );
  next = replaceInBlock(next, '  class CloseTabsTool extends BaseBrowserToolExecutor {', '  const closeTabsTool = new CloseTabsTool();', patchCloseTabs, 'close-tabs block');
  next = replaceInBlock(next, '  class SwitchTabTool extends BaseBrowserToolExecutor {', '  const switchTabTool = new SwitchTabTool();', patchSwitchTab, 'switch-tab block');
  next = replaceInBlock(next, '  class NetworkRequestTool extends BaseBrowserToolExecutor {', '  const networkRequestTool = new NetworkRequestTool();', patchNetworkRequest, 'network-request block');
  next = replaceInBlock(next, '  const _NetworkCaptureStartTool = class _NetworkCaptureStartTool extends BaseBrowserToolExecutor {', '  let NetworkCaptureStartTool = _NetworkCaptureStartTool;', (block) => patchNetworkCaptureStart(block, false), 'web capture start block');
  next = replaceInBlock(next, '  const _NetworkCaptureStopTool = class _NetworkCaptureStopTool extends BaseBrowserToolExecutor {', '  let NetworkCaptureStopTool = _NetworkCaptureStopTool;', (block) => patchNetworkCaptureStop(block, false), 'web capture stop block');
  next = replaceInBlock(next, '  const _NetworkDebuggerStartTool = class _NetworkDebuggerStartTool extends BaseBrowserToolExecutor {', '  let NetworkDebuggerStartTool = _NetworkDebuggerStartTool;', (block) => patchDebuggerChildTabScope(patchNetworkCaptureStart(block, true)), 'debugger capture start block');
  next = replaceInBlock(next, '  const _NetworkDebuggerStopTool = class _NetworkDebuggerStopTool extends BaseBrowserToolExecutor {', '  let NetworkDebuggerStopTool = _NetworkDebuggerStopTool;', (block) => patchNetworkCaptureStop(block, true), 'debugger capture stop block');
  next = replaceInBlock(next, '  class NetworkCaptureTool extends BaseBrowserToolExecutor {', '  const networkCaptureTool = new NetworkCaptureTool();', patchUnifiedNetworkCapture, 'unified network capture block');
  next = replaceInBlock(next, '  class BookmarkAddTool extends BaseBrowserToolExecutor {', '  const bookmarkAddTool = new BookmarkAddTool();', patchBookmarkAdd, 'bookmark-add block');
  next = replaceInBlock(next, '  class HandleDialogTool extends BaseBrowserToolExecutor {', '  const handleDialogTool = new HandleDialogTool();', patchDialog, 'dialog block');
  next = replaceInBlock(next, '  class PerformanceStartTraceTool extends BaseBrowserToolExecutor {', '  const performanceStartTraceTool = new PerformanceStartTraceTool();', patchPerformance, 'performance block');
  return { text: next, changed: true };
}

const FLOW_HELPERS = `  // ${FLOW_WORKSPACE_MARKER}
  let bmgFlowWindowId = null;
  let bmgFlowTabId = null;
  const BMG_FLOW_TARGET_TOOLS = new Set([
    "performance_start_trace", "performance_stop_trace", "performance_analyze_insight",
    "chrome_read_page", "chrome_computer", "chrome_navigate", "chrome_screenshot",
    "chrome_get_web_content", "chrome_network_request", "chrome_network_capture",
    "chrome_javascript", "chrome_click_element", "chrome_fill_or_select",
    "chrome_request_element_selection", "chrome_keyboard", "chrome_console",
    "chrome_upload_file", "chrome_handle_dialog", "chrome_gif_recorder", "chrome_bookmark_add",
    "chrome_inject_script", "chrome_send_command_to_inject_script",
    "chrome_network_capture_start", "chrome_network_capture_stop",
    "chrome_network_debugger_start", "chrome_network_debugger_stop"
  ]);
  function bmgFlowTabsQuery(queryInfo = {}) {
    if (!Number.isInteger(bmgFlowWindowId)) return chrome.tabs.query(queryInfo);
    const scoped = __spreadValues({}, queryInfo || {});
    delete scoped.currentWindow;
    scoped.windowId = bmgFlowWindowId;
    return chrome.tabs.query(scoped);
  }
  function bmgFlowTabsGet(tabId) {
    return __async(this, null, function* () {
      const tab = yield chrome.tabs.get(tabId);
      if (Number.isInteger(bmgFlowWindowId) && tab.windowId !== bmgFlowWindowId) {
        throw new Error("Flow attempted to access a tab outside the BMG workspace");
      }
      return tab;
    });
  }
  function bmgFlowTabsCreate(createInfo = {}) {
    return __async(this, null, function* () {
      const scoped = __spreadValues({}, createInfo || {});
      if (Number.isInteger(bmgFlowWindowId)) scoped.windowId = bmgFlowWindowId;
      const tab = yield chrome.tabs.create(scoped);
      if (Number.isInteger(bmgFlowWindowId) && tab.windowId !== bmgFlowWindowId) {
        throw new Error("Flow created a tab outside the BMG workspace");
      }
      if (tab.id && scoped.active !== false) bmgFlowTabId = tab.id;
      return tab;
    });
  }
  function bmgFlowTabsUpdate(tabId, updateInfo) {
    return __async(this, null, function* () {
      if (Number.isInteger(bmgFlowWindowId)) yield bmgFlowTabsGet(tabId);
      const tab = yield chrome.tabs.update(tabId, updateInfo);
      if (tab && tab.id && updateInfo && updateInfo.active === true) bmgFlowTabId = tab.id;
      return tab;
    });
  }
  function bmgFlowTabsRemove(tabIds) {
    return __async(this, null, function* () {
      const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
      if (Number.isInteger(bmgFlowWindowId)) {
        for (const id of ids) yield bmgFlowTabsGet(id);
      }
      yield chrome.tabs.remove(tabIds);
      if (ids.includes(bmgFlowTabId) && Number.isInteger(bmgFlowWindowId)) {
        const remaining = yield chrome.tabs.query({ windowId: bmgFlowWindowId });
        const active = remaining.find((tab) => tab.active) || remaining[0];
        bmgFlowTabId = active && active.id || null;
      }
    });
  }
  function bmgFlowTabsSendMessage(tabId, ...rest) {
    return __async(this, null, function* () {
      if (Number.isInteger(bmgFlowWindowId)) yield bmgFlowTabsGet(tabId);
      return yield chrome.tabs.sendMessage(tabId, ...rest);
    });
  }
  function bmgFlowScriptingExecuteScript(injection) {
    return __async(this, null, function* () {
      const tabId = injection && injection.target && injection.target.tabId;
      if (Number.isInteger(bmgFlowWindowId)) {
        if (!Number.isInteger(tabId)) {
          throw new Error("Flow script execution is missing a target tab");
        }
        yield bmgFlowTabsGet(tabId);
      }
      return yield chrome.scripting.executeScript(injection);
    });
  }
  function bmgFlowWebNavigationGetAllFrames(details) {
    return __async(this, null, function* () {
      const tabId = details && details.tabId;
      if (Number.isInteger(bmgFlowWindowId)) {
        if (!Number.isInteger(tabId)) {
          throw new Error("Flow frame lookup is missing a target tab");
        }
        yield bmgFlowTabsGet(tabId);
      }
      return yield chrome.webNavigation.getAllFrames(details);
    });
  }
  function bmgFlowWindowsCreate(createInfo = {}) {
    return __async(this, null, function* () {
      if (!Number.isInteger(bmgFlowWindowId)) return yield chrome.windows.create(createInfo);
      const tab = yield bmgFlowTabsCreate({
        url: createInfo && createInfo.url || "about:blank",
        active: true
      });
      return { id: bmgFlowWindowId, focused: false, tabs: [tab] };
    });
  }
  function bmgFlowWindowsUpdate(windowId, updateInfo = {}) {
    return __async(this, null, function* () {
      if (!Number.isInteger(bmgFlowWindowId)) return yield chrome.windows.update(windowId, updateInfo);
      if (windowId !== bmgFlowWindowId) {
        throw new Error("Flow attempted to update a window outside the BMG workspace");
      }
      const safe = __spreadValues({}, updateInfo || {});
      delete safe.focused;
      if (Object.keys(safe).length > 0) return yield chrome.windows.update(windowId, safe);
      return yield chrome.windows.get(windowId);
    });
  }
`;

function patchFlowApiCalls(block) {
  return block
    .replaceAll('chrome.tabs.query(', 'bmgFlowTabsQuery(')
    .replaceAll('chrome.tabs.get(', 'bmgFlowTabsGet(')
    .replaceAll('chrome.tabs.create(', 'bmgFlowTabsCreate(')
    .replaceAll('chrome.tabs.update(', 'bmgFlowTabsUpdate(')
    .replaceAll('chrome.tabs.remove(', 'bmgFlowTabsRemove(')
    .replaceAll('chrome.tabs.sendMessage(', 'bmgFlowTabsSendMessage(')
    .replaceAll('chrome.scripting.executeScript(', 'bmgFlowScriptingExecuteScript(')
    .replaceAll('chrome.webNavigation.getAllFrames(', 'bmgFlowWebNavigationGetAllFrames(')
    .replaceAll('chrome.windows.create(', 'bmgFlowWindowsCreate(')
    .replaceAll('chrome.windows.update(', 'bmgFlowWindowsUpdate(');
}

function patchFlowRunTool(block) {
  const oldRun = `        const result2 = yield runFlow(flow, {
          tabTarget,
          refresh,
          captureNetwork,
          returnLogs,
          timeoutMs,
          startUrl,
          args: vars
        });`;
  const newRun = `        const flowVars = vars && typeof vars === "object" ? __spreadValues({}, vars) : {};
        const requestedTabId = Number(flowVars.__bmg_workspace_tab_id);
        const requestedWindowId = Number(flowVars.__bmg_workspace_window_id);
        delete flowVars.__bmg_workspace_tab_id;
        delete flowVars.__bmg_workspace_window_id;
        const resolvedTabTarget = tabTarget !== void 0 ? tabTarget : flowVars.tabTarget;
        const resolvedRefresh = refresh !== void 0 ? refresh : flowVars.refresh;
        const resolvedCaptureNetwork = captureNetwork !== void 0 ? captureNetwork : flowVars.captureNetwork;
        const resolvedReturnLogs = returnLogs !== void 0 ? returnLogs : flowVars.returnLogs;
        const resolvedTimeoutMs = timeoutMs !== void 0 ? timeoutMs : flowVars.timeoutMs;
        const resolvedStartUrl = startUrl !== void 0 ? startUrl : flowVars.startUrl;
        delete flowVars.tabTarget;
        delete flowVars.refresh;
        delete flowVars.captureNetwork;
        delete flowVars.returnLogs;
        delete flowVars.timeoutMs;
        delete flowVars.startUrl;
        const hasBmgTarget = Number.isInteger(requestedTabId) && requestedTabId > 0 && Number.isInteger(requestedWindowId) && requestedWindowId > 0;
        if (hasBmgTarget && Number.isInteger(bmgFlowWindowId)) {
          return createErrorResponse("Another BMG flow is already running");
        }
        const previousWindowId = bmgFlowWindowId;
        const previousTabId = bmgFlowTabId;
        if (hasBmgTarget) {
          const targetTab = yield chrome.tabs.get(requestedTabId);
          if (targetTab.windowId !== requestedWindowId) {
            return createErrorResponse("BMG flow target tab does not belong to the requested workspace window");
          }
          bmgFlowWindowId = requestedWindowId;
          bmgFlowTabId = requestedTabId;
        }
        let result2;
        try {
          result2 = yield runFlow(flow, {
            tabTarget: resolvedTabTarget,
            refresh: resolvedRefresh,
            captureNetwork: resolvedCaptureNetwork,
            returnLogs: resolvedReturnLogs,
            timeoutMs: resolvedTimeoutMs,
            startUrl: resolvedStartUrl,
            args: flowVars
          });
        } finally {
          if (hasBmgTarget) {
            bmgFlowWindowId = previousWindowId;
            bmgFlowTabId = previousTabId;
          }
        }`;
  return replaceExactlyOnce(block, oldRun, newRun, 'flow run target context');
}

function patchHandleCallTool(block) {
  return replaceExactlyOnce(
    block,
    `    try {
      return yield tool.execute(param.args);
    } catch (error) {`,
    `    try {
      let callArgs = param.args;
      if (Number.isInteger(bmgFlowWindowId)) {
        if (param.name === TOOL_NAMES.BROWSER.SWITCH_TAB || param.name === TOOL_NAMES.BROWSER.CLOSE_TABS) {
          callArgs = __spreadValues({}, callArgs || {});
          callArgs.windowId = bmgFlowWindowId;
          callArgs.background = true;
        } else if (BMG_FLOW_TARGET_TOOLS.has(param.name)) {
          callArgs = __spreadValues({}, callArgs || {});
          callArgs.tabId = bmgFlowTabId;
          callArgs.windowId = bmgFlowWindowId;
          callArgs.background = true;
        }
      }
      const result2 = yield tool.execute(callArgs);
      if (Number.isInteger(bmgFlowWindowId) && param.name === TOOL_NAMES.BROWSER.SWITCH_TAB && !(result2 == null ? void 0 : result2.isError) && callArgs && Number.isInteger(callArgs.tabId)) {
        const switched = yield bmgFlowTabsGet(callArgs.tabId);
        bmgFlowTabId = switched.id;
      }
      return result2;
    } catch (error) {`,
    'flow nested tool routing',
  );
}

export function patchFlowWorkspace(text) {
  if (text.includes(FLOW_WORKSPACE_MARKER)) return { text, changed: false };
  let next = replaceExactlyOnce(
    text,
    '  function ensureTab(options) {',
    FLOW_HELPERS + '  function ensureTab(options) {',
    'flow helper insertion',
  );
  next = replaceInBlock(
    next,
    '  function ensureTab(options) {',
    '  class FlowRunTool {',
    patchFlowApiCalls,
    'flow runtime API block',
  );
  next = replaceInBlock(
    next,
    '  class FlowRunTool {',
    '  class ListPublishedTool {',
    patchFlowRunTool,
    'flow run tool block',
  );
  next = replaceInBlock(
    next,
    '  const handleCallTool = (param) => __async(null, null, function* () {',
    '  const RR_V3_KEEPALIVE_PORT_NAME =',
    patchHandleCallTool,
    'handleCallTool block',
  );
  return { text: next, changed: true };
}

export function patchUpstreamToolsBackgroundText(text) {
  const targets = patchUpstreamToolTargets(text);
  const flow = patchFlowWorkspace(targets.text);
  return { text: flow.text, changed: targets.changed || flow.changed };
}

export function patchExtensionUpstreamTools(extensionDir) {
  const backgroundPath = path.join(extensionDir, 'background.js');
  const original = fs.readFileSync(backgroundPath, 'utf8');
  const patched = patchUpstreamToolsBackgroundText(original);
  if (patched.changed) fs.writeFileSync(backgroundPath, patched.text, 'utf8');
  return { backgroundChanged: patched.changed };
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const extensionDir = process.argv[2];
  if (!extensionDir) throw new Error('Usage: node patch-extension-upstream-tools.mjs <extension-dir>');
  const result = patchExtensionUpstreamTools(path.resolve(extensionDir));
  console.log(
    'BMG upstream-tools extension patch: background=' +
      (result.backgroundChanged ? 'patched' : 'already'),
  );
}
