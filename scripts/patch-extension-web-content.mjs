import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = 'BMG_WEB_CONTENT_FALLBACK_V1';
const INTERACTIVE_MARKER = 'BMG_INTERACTIVE_WORKSPACE_TARGET_V1';
const WINDOW_GEOMETRY_MARKER = 'BMG_NATURAL_NEW_WINDOW_GEOMETRY_V1';
const URL_PATTERN_MARKER = 'BMG_SAFE_URL_PATTERN_HOSTS_V1';
const COMPUTER_TARGET_TAB_MARKER = 'BMG_COMPUTER_TARGET_TAB_V1';
const COMPUTER_COORDINATE_CDP_MARKER = 'BMG_COMPUTER_COORDINATE_CDP_V1';
const CLASS_ANCHOR = '  class WebFetcherTool extends BaseBrowserToolExecutor {';
const HELPER_OLD = "const pingActions = ['search_tabs_content_ping', 'chrome_web_fetcher_ping'];";
const HELPER_NEW =
  "const pingActions = ['search_tabs_content_ping', 'chrome_web_fetcher_ping', 'chrome_get_web_content_ping'];";

const HTML_CALL_OLD = `const htmlResponse = yield this.sendMessageToTab(tab.id, {
              action: TOOL_MESSAGE_TYPES.WEB_FETCHER_GET_HTML_CONTENT,
              selector
            });`;
const HTML_CALL_NEW = `const htmlResponse = yield webContentMessageWithFallback(
              this, tab.id, TOOL_MESSAGE_TYPES.WEB_FETCHER_GET_HTML_CONTENT, selector, true
            );`;

const TEXT_CALL_OLD = `const textResponse = yield this.sendMessageToTab(tab.id, {
              action: TOOL_MESSAGE_TYPES.WEB_FETCHER_GET_TEXT_CONTENT,
              selector
            });`;
const TEXT_CALL_NEW = `const textResponse = yield webContentMessageWithFallback(
              this, tab.id, TOOL_MESSAGE_TYPES.WEB_FETCHER_GET_TEXT_CONTENT, selector, false
            );`;
const INTERACTIVE_ARGS_OLD = 'const { textQuery, selector, includeCoordinates = true, types } = args;';
const INTERACTIVE_ARGS_NEW =
  'const { textQuery, selector, includeCoordinates = true, types, tabId: explicitTabId, windowId } = args;';
const INTERACTIVE_TAB_OLD = `          const tabs = yield chrome.tabs.query({ active: true, currentWindow: true });
          if (!tabs[0]) {
            return createErrorResponse("No active tab found");
          }
          const tab = tabs[0];`;
const INTERACTIVE_TAB_NEW = `          // ${INTERACTIVE_MARKER}
          let tab;
          if (typeof explicitTabId === "number") {
            tab = yield chrome.tabs.get(explicitTabId);
          } else {
            const tabs = typeof windowId === "number"
              ? yield chrome.tabs.query({ active: true, windowId })
              : yield chrome.tabs.query({ active: true, currentWindow: true });
            if (!tabs[0]) {
              return createErrorResponse("No active tab found");
            }
            tab = tabs[0];
          }`;
const WINDOW_CREATE_OLD = `            const newWindow2 = yield chrome.windows.create({
              url,
              width: typeof width === "number" ? width : DEFAULT_WINDOW_WIDTH,
              height: typeof height === "number" ? height : DEFAULT_WINDOW_HEIGHT,
              focused: background2 === true ? false : true
            });`;
const WINDOW_CREATE_NEW = `            // ${WINDOW_GEOMETRY_MARKER}
            const createWindowOptions = {
              url,
              focused: background2 === true ? false : true
            };
            if (typeof width === "number") createWindowOptions.width = width;
            if (typeof height === "number") createWindowOptions.height = height;
            const newWindow2 = yield chrome.windows.create(createWindowOptions);`;
const URL_PATTERN_OLD = `                const hostNoWww = u.host.replace(/^www\\./, "");
                const hostWithWww = hostNoWww.startsWith("www.") ? hostNoWww : \`www.\${hostNoWww}\`;
                patterns2.add(\`\${u.protocol}//\${u.host}\${pathWildcard}\`);
                patterns2.add(\`\${u.protocol}//\${hostNoWww}\${pathWildcard}\`);
                patterns2.add(\`\${u.protocol}//\${hostWithWww}\${pathWildcard}\`);
                const altProtocol = u.protocol === "https:" ? "http:" : "https:";
                patterns2.add(\`\${altProtocol}//\${u.host}\${pathWildcard}\`);
                patterns2.add(\`\${altProtocol}//\${hostNoWww}\${pathWildcard}\`);
                patterns2.add(\`\${altProtocol}//\${hostWithWww}\${pathWildcard}\`);`;
const URL_PATTERN_NEW = `                // ${URL_PATTERN_MARKER}
                const hostNoWww = u.host.replace(/^www\\./, "");
                const hostnameNoWww = u.hostname.replace(/^www\\./, "");
                const isIpLiteral = /^\\d{1,3}(?:\\.\\d{1,3}){3}$/.test(hostnameNoWww) || hostnameNoWww.includes(":");
                const hostWithWww =
                  hostnameNoWww !== "localhost" && !isIpLiteral ? \`www.\${hostNoWww}\` : null;
                patterns2.add(\`\${u.protocol}//\${u.host}\${pathWildcard}\`);
                patterns2.add(\`\${u.protocol}//\${hostNoWww}\${pathWildcard}\`);
                if (hostWithWww) patterns2.add(\`\${u.protocol}//\${hostWithWww}\${pathWildcard}\`);
                const altProtocol = u.protocol === "https:" ? "http:" : "https:";
                patterns2.add(\`\${altProtocol}//\${u.host}\${pathWildcard}\`);
                patterns2.add(\`\${altProtocol}//\${hostNoWww}\${pathWildcard}\`);
                if (hostWithWww) patterns2.add(\`\${altProtocol}//\${hostWithWww}\${pathWildcard}\`);`;
const FALLBACK_HELPER = `  // ${MARKER}
  function webContentMessageWithFallback(tool, tabId, action, selector, asHtml) {
    return __async(this, null, function* () {
      try {
        return yield Promise.race([
          tool.sendMessageToTab(tabId, { action, selector }),
          new Promise((_, reject) => setTimeout(
            () => reject(new Error("web content helper timeout")),
            1500
          ))
        ]);
      } catch (_error) {
        const results = yield chrome.scripting.executeScript({
          target: { tabId },
          func: (targetSelector, htmlMode) => {
            const node = targetSelector
              ? document.querySelector(targetSelector)
              : htmlMode ? document.documentElement : document.body;
            if (!node) return { success: false, error: "Target content was not found" };
            if (htmlMode) {
              const value = targetSelector ? node.outerHTML : document.documentElement.outerHTML;
              return { success: true, htmlContent: value.slice(0, 1000000), fallback: true };
            }
            const value = node.innerText || node.textContent || "";
            return { success: true, textContent: value.slice(0, 200000), fallback: true };
          },
          args: [selector ?? null, asHtml]
        });
        const fallback = results && results[0] ? results[0].result : null;
        return fallback || { success: false, error: "Direct web content fallback failed" };
      }
    });
  }
`;

function replaceExactlyOnce(text, oldText, newText, label) {
  const first = text.indexOf(oldText);
  if (first < 0) throw new Error(`${label} anchor was not found`);
  if (text.indexOf(oldText, first + oldText.length) >= 0) {
    throw new Error(`${label} anchor matched more than once`);
  }
  return text.slice(0, first) + newText + text.slice(first + oldText.length);
}

function patchComputerTargetTab(text) {
  if (text.includes(COMPUTER_TARGET_TAB_MARKER)) return { text, changed: false };
  const startAnchor = '  class ComputerTool extends BaseBrowserToolExecutor {';
  const endAnchor = '  const computerTool = new ComputerTool();';
  const start = text.indexOf(startAnchor);
  if (start < 0) throw new Error('computer tool class anchor was not found');
  const end = text.indexOf(endAnchor, start);
  if (end < 0) throw new Error('computer tool end anchor was not found');
  let block = text.slice(start, end);
  const delegatePattern = /(yield (?:clickTool|fillTool|keyboardTool)\.execute\(\{)(\r?\n)(\s+)/gu;
  let count = 0;
  block = block.replace(delegatePattern, (_match, call, newline, indent) => {
    count += 1;
    return [
      call,
      newline,
      indent + 'tabId: tab.id,',
      newline,
      indent + 'windowId: tab.windowId,',
      newline,
      indent,
    ].join('');
  });
  const singleLineKeyboard = 'yield keyboardTool.execute({ keys: repeatedKeys });';
  if (block.includes(singleLineKeyboard)) {
    block = block.replace(
      singleLineKeyboard,
      'yield keyboardTool.execute({ tabId: tab.id, windowId: tab.windowId, keys: repeatedKeys });',
    );
    count += 1;
  }
  if (count !== 9) {
    throw new Error('computer target-tab delegate count was ' + count + '; expected 9');
  }
  block = block.replace(
    startAnchor,
    startAnchor + '\n    // ' + COMPUTER_TARGET_TAB_MARKER,
  );
  return {
    text: text.slice(0, start) + block + text.slice(end),
    changed: true,
  };
}

function patchComputerCoordinateClick(text) {
  if (text.includes(COMPUTER_COORDINATE_CDP_MARKER)) return { text, changed: false };
  const pattern = /            const coord = project\(params\.coordinates\);\r?\n            const domResult = yield clickTool\.execute\(\{\r?\n              tabId: tab\.id,\r?\n              windowId: tab\.windowId,\r?\n              coordinates: coord,\r?\n              waitForNavigation: false,\r?\n              timeout: TIMEOUTS\.DEFAULT_WAIT \* 5,\r?\n              button: params\.action === "right_click" \? "right" : "left",\r?\n              modifiers: params\.modifiers\r?\n            \}\);\r?\n            if \(!domResult\.isError\) \{\r?\n              return domResult;\r?\n            \}\r?\n            try \{/u;
  const match = text.match(pattern);
  if (!match) throw new Error('computer coordinate click anchor was not found');
  const newline = match[0].includes('\r\n') ? '\r\n' : '\n';
  const replacement = [
    '            // ' + COMPUTER_COORDINATE_CDP_MARKER,
    '            const coord = project(params.coordinates);',
    '            try {',
  ].join(newline);
  return { text: text.replace(pattern, replacement), changed: true };
}

export function patchWebContentBackgroundText(text) {
  let next = text;
  let changed = false;
  if (!next.includes(MARKER)) {
    next = replaceExactlyOnce(next, CLASS_ANCHOR, FALLBACK_HELPER + CLASS_ANCHOR, 'class');
    next = replaceExactlyOnce(next, HTML_CALL_OLD, HTML_CALL_NEW, 'html call');
    next = replaceExactlyOnce(next, TEXT_CALL_OLD, TEXT_CALL_NEW, 'text call');
    changed = true;
  }
  if (!next.includes(INTERACTIVE_MARKER)) {
    next = replaceExactlyOnce(next, INTERACTIVE_ARGS_OLD, INTERACTIVE_ARGS_NEW, 'interactive args');
    next = replaceExactlyOnce(next, INTERACTIVE_TAB_OLD, INTERACTIVE_TAB_NEW, 'interactive tab');
    changed = true;
  }
  if (!next.includes(WINDOW_GEOMETRY_MARKER)) {
    next = replaceExactlyOnce(next, WINDOW_CREATE_OLD, WINDOW_CREATE_NEW, 'new-window geometry');
    changed = true;
  }
  if (!next.includes(URL_PATTERN_MARKER)) {
    next = replaceExactlyOnce(next, URL_PATTERN_OLD, URL_PATTERN_NEW, 'safe URL patterns');
    changed = true;
  }
  const computerTarget = patchComputerTargetTab(next);
  next = computerTarget.text;
  changed = changed || computerTarget.changed;
  const coordinateClick = patchComputerCoordinateClick(next);
  next = coordinateClick.text;
  changed = changed || coordinateClick.changed;
  return { text: next, changed };
}

export function patchWebContentHelperText(text) {
  if (text.includes('chrome_get_web_content_ping')) return { text, changed: false };
  return { text: replaceExactlyOnce(text, HELPER_OLD, HELPER_NEW, 'helper ping'), changed: true };
}
export function patchExtensionWebContent(extensionDir) {
  const backgroundPath = path.join(extensionDir, 'background.js');
  const helperPath = path.join(extensionDir, 'inject-scripts', 'web-fetcher-helper.js');
  const background = fs.readFileSync(backgroundPath, 'utf8');
  const helper = fs.readFileSync(helperPath, 'utf8');
  const patchedBackground = patchWebContentBackgroundText(background);
  const patchedHelper = patchWebContentHelperText(helper);
  if (patchedBackground.changed) fs.writeFileSync(backgroundPath, patchedBackground.text, 'utf8');
  if (patchedHelper.changed) fs.writeFileSync(helperPath, patchedHelper.text, 'utf8');
  return { backgroundChanged: patchedBackground.changed, helperChanged: patchedHelper.changed };
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const extensionDir = process.argv[2];
  if (!extensionDir) throw new Error('Usage: node patch-extension-web-content.mjs <extension-dir>');
  const result = patchExtensionWebContent(path.resolve(extensionDir));
  console.log(
    `BMG web-content extension patch: background=${result.backgroundChanged ? 'patched' : 'already'} helper=${result.helperChanged ? 'patched' : 'already'}`,
  );
}
