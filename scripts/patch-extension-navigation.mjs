import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_BACKGROUND_MARKER = 'BMG_DEFAULT_BACKGROUND_V1';
const LEGACY_NAVIGATION_SETTLE_MARKER = 'BMG_NAVIGATION_SETTLE_V1';
const NAVIGATION_SETTLE_MARKER = 'BMG_NAVIGATION_SETTLE_V2';
const NAVIGATION_TARGET_MARKER = 'BMG_EXPLICIT_TARGET_NAVIGATION_V1';
const SAFE_URL_PATTERN_MARKER = 'BMG_SAFE_NAVIGATION_URL_PATTERNS_V1';

function lines(values) {
  return values.join('\n');
}

function replaceExactlyOnce(text, oldText, newText, label) {
  const first = text.indexOf(oldText);
  if (first < 0) throw new Error(label + ' anchor was not found');
  if (text.indexOf(oldText, first + oldText.length) >= 0) {
    throw new Error(label + ' anchor matched more than once');
  }
  return text.slice(0, first) + newText + text.slice(first + oldText.length);
}

function replaceExpectedCount(text, oldText, newText, expected, label) {
  let next = text;
  let count = 0;
  while (next.includes(oldText)) {
    next = next.replace(oldText, newText);
    count += 1;
  }
  if (count !== expected) {
    throw new Error(label + ' anchor matched ' + count + ' times; expected ' + expected);
  }
  return next;
}

const NAVIGATION_HELPER = lines([
  '  // ' + NAVIGATION_SETTLE_MARKER,
  '  function bmgWaitForNavigation(tabId, expectedUrl, previousUrl, timeoutMs = 10000) {',
  '    return new Promise((resolve, reject) => {',
  '      let finished = false;',
  '      let sawNavigation = false;',
  '      let lastTab = null;',
  '      let timer = null;',
  '      let poll = null;',
  '      const cleanup = () => {',
  '        if (timer) clearTimeout(timer);',
  '        if (poll) clearInterval(poll);',
  '        chrome.tabs.onUpdated.removeListener(onUpdated);',
  '        chrome.tabs.onRemoved.removeListener(onRemoved);',
  '      };',
  '      const finish = (tab) => {',
  '        if (finished) return;',
  '        finished = true;',
  '        cleanup();',
  '        resolve(tab);',
  '      };',
  '      const fail = (error) => {',
  '        if (finished) return;',
  '        finished = true;',
  '        cleanup();',
  '        reject(error);',
  '      };',
  '      const ready = (tab) => {',
  '        if (!tab) return false;',
  '        const current = tab.url || "";',
  '        if (current === expectedUrl) return true;',
  '        if (tab.status !== "complete") return false;',
  '        return sawNavigation && current && current !== (previousUrl || "");',
  '      };',
  '      const check = () => {',
  '        chrome.tabs.get(tabId).then((tab) => {',
  '          lastTab = tab;',
  '          if (ready(tab)) finish(tab);',
  '        }).catch(fail);',
  '      };',
  '      const onUpdated = (updatedTabId, changeInfo, tab) => {',
  '        if (updatedTabId !== tabId || finished) return;',
  '        if (changeInfo.status === "loading" || typeof changeInfo.url === "string") {',
  '          sawNavigation = true;',
  '        }',
  '        lastTab = tab;',
  '        if (ready(tab)) finish(tab);',
  '      };',
  '      const onRemoved = (removedTabId) => {',
  '        if (removedTabId === tabId) {',
  '          fail(new Error("Tab " + tabId + " was closed before navigation completed"));',
  '        }',
  '      };',
  '      chrome.tabs.onUpdated.addListener(onUpdated);',
  '      chrome.tabs.onRemoved.addListener(onRemoved);',
  '      poll = setInterval(check, 50);',
  '      timer = setTimeout(() => {',
  '        const actualUrl = lastTab && lastTab.url ? lastTab.url : previousUrl || "";',
  '        fail(new Error(',
  '          "Navigation in tab " + tabId + " did not settle within " + timeoutMs +',
  '          " ms. Expected: " + expectedUrl + ". Actual: " + actualUrl',
  '        ));',
  '      }, timeoutMs);',
  '      check();',
  '    });',
  '  }',
  '',
]);

export function patchNavigationTargetSelection(text) {
  const hasTargetMarker = text.includes(NAVIGATION_TARGET_MARKER);
  const hasPatternMarker = text.includes(SAFE_URL_PATTERN_MARKER);
  if (hasTargetMarker || hasPatternMarker) {
    if (hasTargetMarker && hasPatternMarker) return { text, changed: false };
    throw new Error('navigation target patch markers are inconsistent');
  }

  let next = text;
  next = replaceExactlyOnce(
    next,
    lines([
      '          console.log(`Checking if URL is already open: ${url}`);',
      '          const buildUrlPatterns = (input) => {',
    ]),
    lines([
      '          // ' + NAVIGATION_TARGET_MARKER,
      '          const explicitTab = yield this.tryGetTab(tabId);',
      '          console.log(`Checking if URL is already open: ${url}`);',
      '          const buildUrlPatterns = (input) => {',
    ]),
    'explicit navigation target',
  );

  next = replaceExactlyOnce(
    next,
    lines([
      '                const hostNoWww = u.host.replace(/^www\\./, "");',
      '                const hostWithWww = hostNoWww.startsWith("www.") ? hostNoWww : `www.${hostNoWww}`;',
      '                patterns2.add(`${u.protocol}//${u.host}${pathWildcard}`);',
      '                patterns2.add(`${u.protocol}//${hostNoWww}${pathWildcard}`);',
      '                patterns2.add(`${u.protocol}//${hostWithWww}${pathWildcard}`);',
      '                const altProtocol = u.protocol === "https:" ? "http:" : "https:";',
      '                patterns2.add(`${altProtocol}//${u.host}${pathWildcard}`);',
      '                patterns2.add(`${altProtocol}//${hostNoWww}${pathWildcard}`);',
      '                patterns2.add(`${altProtocol}//${hostWithWww}${pathWildcard}`);',
    ]),
    lines([
      '                // ' + SAFE_URL_PATTERN_MARKER,
      '                if (u.protocol !== "http:" && u.protocol !== "https:") return [];',
      '                const hostNoWww = u.host.replace(/^www\\./, "");',
      '                const hostnameNoWww = u.hostname.replace(/^www\\./, "");',
      '                const isIpLiteral = /^\\d{1,3}(?:\\.\\d{1,3}){3}$/.test(hostnameNoWww) || hostnameNoWww.includes(":");',
      '                const hostWithWww =',
      '                  hostnameNoWww !== "localhost" && !isIpLiteral ? `www.${hostNoWww}` : null;',
      '                patterns2.add(`${u.protocol}//${u.host}${pathWildcard}`);',
      '                patterns2.add(`${u.protocol}//${hostNoWww}${pathWildcard}`);',
      '                if (hostWithWww) patterns2.add(`${u.protocol}//${hostWithWww}${pathWildcard}`);',
      '                const altProtocol = u.protocol === "https:" ? "http:" : "https:";',
      '                patterns2.add(`${altProtocol}//${u.host}${pathWildcard}`);',
      '                patterns2.add(`${altProtocol}//${hostNoWww}${pathWildcard}`);',
      '                if (hostWithWww) patterns2.add(`${altProtocol}//${hostWithWww}${pathWildcard}`);',
    ]),
    'safe navigation URL patterns',
  );

  next = replaceExactlyOnce(
    next,
    lines([
      '              } else {',
      '                patterns2.add(input);',
      '              }',
      '            } catch (e) {',
      '              patterns2.add(input.endsWith("/") ? `${input}*` : `${input}/*`);',
      '            }',
      '            return Array.from(patterns2);',
    ]),
    lines([
      '              } else if (/^https?:\\/\\//i.test(input)) {',
      '                patterns2.add(input);',
      '              }',
      '            } catch (e) {',
      '              return [];',
      '            }',
      '            return Array.from(patterns2);',
    ]),
    'non-http navigation URL patterns',
  );

  next = replaceExactlyOnce(
    next,
    lines([
      '          const urlPatterns = buildUrlPatterns(url);',
      '          const candidateTabs = yield chrome.tabs.query({ url: urlPatterns });',
    ]),
    lines([
      '          const urlPatterns = explicitTab ? [] : buildUrlPatterns(url);',
      '          const candidateTabs = urlPatterns.length > 0',
      '            ? yield chrome.tabs.query({ url: urlPatterns })',
      '            : [];',
    ]),
    'conditional navigation URL query',
  );

  next = replaceExactlyOnce(
    next,
    lines([
      '          const explicitTab = yield this.tryGetTab(tabId);',
      '          const existingTab = explicitTab || pickBestMatch(url, candidateTabs);',
    ]),
    '          const existingTab = explicitTab || pickBestMatch(url, candidateTabs);',
    'late explicit navigation target',
  );

  return { text: next, changed: true };
}

function patchDefaultBackground(text) {
  if (text.includes(DEFAULT_BACKGROUND_MARKER)) return { text, changed: false };
  let next = text;
  next = replaceExactlyOnce(
    next,
    lines(['          background: background2,', '          windowId']),
    lines([
      '          // ' + DEFAULT_BACKGROUND_MARKER,
      '          background: background2 = true,',
      '          windowId',
    ]),
    'navigate background default',
  );
  next = replaceExpectedCount(
    next,
    'const background2 = args.background === true;',
    'const background2 = args.background !== false;',
    2,
    'boolean background defaults',
  );
  next = replaceExactlyOnce(
    next,
    'const { url, type, jsScript, tabId, windowId, background: background2 } = args;',
    'const { url, type, jsScript, tabId, windowId, background: background2 = true } = args;',
    'inject-script background default',
  );
  next = replaceExactlyOnce(
    next,
    'background: background2 = false,',
    'background: background2 = true,',
    'console background default',
  );
  next = replaceExactlyOnce(
    next,
    'navigateToUrl(url, background2 = false, windowId) {',
    'navigateToUrl(url, background2 = true, windowId) {',
    'console navigate background default',
  );
  next = replaceExactlyOnce(
    next,
    lines([
      '              const fallbackWindow = yield chrome.windows.create({',
      '                url,',
      '                width: DEFAULT_WINDOW_WIDTH,',
      '                height: DEFAULT_WINDOW_HEIGHT,',
      '                focused: true',
      '              });',
    ]),
    lines([
      '              const fallbackWindow = yield chrome.windows.create({',
      '                url,',
      '                width: DEFAULT_WINDOW_WIDTH,',
      '                height: DEFAULT_WINDOW_HEIGHT,',
      '                focused: background2 === true ? false : true',
      '              });',
    ]),
    'fallback window focus default',
  );
  return { text: next, changed: true };
}

function patchNavigationSettle(text) {
  if (text.includes(NAVIGATION_SETTLE_MARKER)) return { text, changed: false };
  if (text.includes(LEGACY_NAVIGATION_SETTLE_MARKER)) {
    let upgraded = replaceExactlyOnce(
      text,
      lines([
        '      const ready = (tab) => {',
        '        if (!tab || tab.status !== "complete") return false;',
        '        const current = tab.url || "";',
        '        if (current === expectedUrl) return true;',
        '        return sawNavigation && current && current !== (previousUrl || "");',
        '      };',
      ]),
      lines([
        '      const ready = (tab) => {',
        '        if (!tab) return false;',
        '        const current = tab.url || "";',
        '        if (current === expectedUrl) return true;',
        '        if (tab.status !== "complete") return false;',
        '        return sawNavigation && current && current !== (previousUrl || "");',
        '      };',
      ]),
      'legacy navigation ready predicate',
    );
    upgraded = replaceExactlyOnce(
      upgraded,
      '// ' + LEGACY_NAVIGATION_SETTLE_MARKER,
      '// ' + NAVIGATION_SETTLE_MARKER,
      'legacy navigation marker',
    );
    return { text: upgraded, changed: true };
  }
  let next = replaceExactlyOnce(
    text,
    '  class NavigateTool extends BaseBrowserToolExecutor {',
    NAVIGATION_HELPER + '  class NavigateTool extends BaseBrowserToolExecutor {',
    'navigate class',
  );

  next = replaceExactlyOnce(
    next,
    lines([
      '            if (explicitTab && typeof explicitTab.id === "number") {',
      '              yield chrome.tabs.update(explicitTab.id, { url });',
      '            }',
      '            yield this.ensureFocus(existingTab, {',
      '              activate: background2 !== true,',
      '              focusWindow: background2 !== true',
      '            });',
    ]),
    lines([
      '            let updatedTab = existingTab;',
      '            if (explicitTab && typeof explicitTab.id === "number") {',
      '              const previousUrl = explicitTab.url || "";',
      '              yield chrome.tabs.update(explicitTab.id, { url });',
      '              updatedTab = yield bmgWaitForNavigation(',
      '                explicitTab.id, url, previousUrl',
      '              );',
      '            } else {',
      '              updatedTab = yield chrome.tabs.get(existingTab.id);',
      '            }',
      '            yield this.ensureFocus(updatedTab, {',
      '              activate: background2 !== true,',
      '              focusWindow: background2 !== true',
      '            });',
    ]),
    'existing-tab navigation settle',
  );
  next = replaceExactlyOnce(
    next,
    '            const updatedTab = yield chrome.tabs.get(existingTab.id);\n',
    '',
    'remove stale existing-tab read',
  );

  next = replaceExactlyOnce(
    next,
    lines([
      '              const firstTab = (_a2 = newWindow2.tabs) == null ? void 0 : _a2[0];',
      '              if (firstTab == null ? void 0 : firstTab.id) {',
      '                yield this.triggerAutoCapture(firstTab.id, firstTab.url);',
      '              }',
    ]),
    lines([
      '              const firstTab = (_a2 = newWindow2.tabs) == null ? void 0 : _a2[0];',
      '              const settledFirstTab = (firstTab == null ? void 0 : firstTab.id)',
      '                ? yield bmgWaitForNavigation(firstTab.id, url, firstTab.url || "")',
      '                : firstTab;',
      '              if (settledFirstTab == null ? void 0 : settledFirstTab.id) {',
      '                yield this.triggerAutoCapture(settledFirstTab.id, settledFirstTab.url);',
      '              }',
    ]),
    'new-window navigation settle',
  );
  next = replaceExactlyOnce(
    next,
    lines([
      '                        tabId: tab.id,',
      '                        url: tab.url',
    ]),
    lines([
      '                        tabId: tab.id,',
      '                        url: settledFirstTab && tab.id === settledFirstTab.id ? settledFirstTab.url : tab.url',
    ]),
    'new-window response settle',
  );

  next = replaceExactlyOnce(
    next,
    lines([
      '              const newTab = yield chrome.tabs.create({',
      '                url,',
      '                windowId: targetWindow.id,',
      '                active: background2 === true ? false : true',
      '              });',
      '              if (background2 !== true) {',
    ]),
    lines([
      '              const newTab = yield chrome.tabs.create({',
      '                url,',
      '                windowId: targetWindow.id,',
      '                active: background2 === true ? false : true',
      '              });',
      '              const settledTab = newTab.id',
      '                ? yield bmgWaitForNavigation(newTab.id, url, newTab.url || "")',
      '                : newTab;',
      '              if (background2 !== true) {',
    ]),
    'new-tab navigation settle',
  );
  next = replaceExactlyOnce(
    next,
    lines([
      '              if (newTab.id) {',
      '                yield this.triggerAutoCapture(newTab.id, newTab.url);',
      '              }',
    ]),
    lines([
      '              if (settledTab.id) {',
      '                yield this.triggerAutoCapture(settledTab.id, settledTab.url);',
      '              }',
    ]),
    'new-tab capture settle',
  );
  next = replaceExactlyOnce(
    next,
    lines([
      '                      tabId: newTab.id,',
      '                      windowId: targetWindow.id,',
      '                      url: newTab.url',
    ]),
    lines([
      '                      tabId: settledTab.id,',
      '                      windowId: targetWindow.id,',
      '                      url: settledTab.url',
    ]),
    'new-tab response settle',
  );

  next = replaceExactlyOnce(
    next,
    lines([
      '                const firstTab = (_b2 = fallbackWindow.tabs) == null ? void 0 : _b2[0];',
      '                if (firstTab == null ? void 0 : firstTab.id) {',
      '                  yield this.triggerAutoCapture(firstTab.id, firstTab.url);',
      '                }',
    ]),
    lines([
      '                const firstTab = (_b2 = fallbackWindow.tabs) == null ? void 0 : _b2[0];',
      '                const settledFallbackTab = (firstTab == null ? void 0 : firstTab.id)',
      '                  ? yield bmgWaitForNavigation(firstTab.id, url, firstTab.url || "")',
      '                  : firstTab;',
      '                if (settledFallbackTab == null ? void 0 : settledFallbackTab.id) {',
      '                  yield this.triggerAutoCapture(settledFallbackTab.id, settledFallbackTab.url);',
      '                }',
    ]),
    'fallback-window navigation settle',
  );
  next = replaceExactlyOnce(
    next,
    lines([
      '                          tabId: tab.id,',
      '                          url: tab.url',
    ]),
    lines([
      '                          tabId: tab.id,',
      '                          url: settledFallbackTab && tab.id === settledFallbackTab.id ? settledFallbackTab.url : tab.url',
    ]),
    'fallback-window response settle',
  );

  return { text: next, changed: true };
}

export function patchNavigationBackgroundText(text) {
  const background = patchDefaultBackground(text);
  const target = patchNavigationTargetSelection(background.text);
  const navigation = patchNavigationSettle(target.text);
  return {
    text: navigation.text,
    changed: background.changed || target.changed || navigation.changed,
  };
}

export function patchExtensionNavigation(extensionDir) {
  const backgroundPath = path.join(extensionDir, 'background.js');
  const background = fs.readFileSync(backgroundPath, 'utf8');
  const patched = patchNavigationBackgroundText(background);
  if (patched.changed) fs.writeFileSync(backgroundPath, patched.text, 'utf8');
  return { backgroundChanged: patched.changed };
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const extensionDir = process.argv[2];
  if (!extensionDir) throw new Error('Usage: node patch-extension-navigation.mjs <extension-dir>');
  const result = patchExtensionNavigation(path.resolve(extensionDir));
  console.log(
    'BMG navigation extension patch: background=' +
      (result.backgroundChanged ? 'patched' : 'already'),
  );
}
