import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = 'BMG_CDP_CONTENT_FALLBACK_V1';
const INTERACTION_MARKER = 'BMG_CDP_INTERACTION_FALLBACK_V1';
const CLASS_ANCHOR = '  class WebFetcherTool extends BaseBrowserToolExecutor {';
const CLICK_CLASS_ANCHOR = '  class ClickTool extends BaseBrowserToolExecutor {';

const HELPER = `  // ${MARKER}
  function bmgFastPromise(promise, label, timeoutMs = 1200) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error(label + " timed out")),
        timeoutMs
      ))
    ]);
  }

  async function bmgCdpEvaluate(tabId, expression) {
    let attached = false;
    try {
      await CDPHelper.attach(tabId);
      attached = true;
      const response = await CDPHelper.send(tabId, "Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true
      });
      if (response && response.exceptionDetails) {
        throw new Error(response.exceptionDetails.text || "CDP Runtime.evaluate failed");
      }
      return response && response.result ? response.result.value : void 0;
    } finally {
      if (attached) {
        try { await CDPHelper.detach(tabId); } catch (_) {}
      }
    }
  }

  async function bmgWebContentWithCdpFallback(tool, tabId, action, selector, asHtml) {
    try {
      return await bmgFastPromise(
        tool.sendMessageToTab(tabId, { action, selector }),
        "web content helper",
        1200
      );
    } catch (_) {
      const expression = \`(() => {
        const selector = \${JSON.stringify(selector ?? null)};
        const htmlMode = \${asHtml ? 'true' : 'false'};
        const node = selector ? document.querySelector(selector) : (htmlMode ? document.documentElement : document.body);
        if (!node) return { success: false, error: "Target content was not found" };
        if (htmlMode) {
          const value = selector ? node.outerHTML : document.documentElement.outerHTML;
          return { success: true, htmlContent: value.slice(0, 1000000), fallback: "cdp" };
        }
        const value = node.innerText || node.textContent || "";
        const meta = {
          title: document.title || "",
          description: document.querySelector('meta[name="description"]')?.content || "",
          author: document.querySelector('meta[name="author"]')?.content || "",
          keywords: document.querySelector('meta[name="keywords"]')?.content || "",
          published: document.querySelector('meta[property="article:published_time"]')?.content || "",
          siteName: document.querySelector('meta[property="og:site_name"]')?.content || ""
        };
        return { success: true, textContent: value.slice(0, 200000), metadata: meta, fallback: "cdp" };
      })()\`;
      return await bmgCdpEvaluate(tabId, expression);
    }
  }

  async function bmgInteractiveWithCdpFallback(tool, tabId, options) {
    try {
      return await bmgFastPromise(
        tool.sendMessageToTab(tabId, {
          action: TOOL_MESSAGE_TYPES.GET_INTERACTIVE_ELEMENTS,
          textQuery: options.textQuery,
          selector: options.selector,
          includeCoordinates: options.includeCoordinates,
          types: options.types
        }),
        "interactive elements helper",
        1200
      );
    } catch (_) {
      const expression = \`(() => {
        const options = \${JSON.stringify(options)};
        const config = {
          button: 'button, input[type="button"], input[type="submit"], [role="button"]',
          link: 'a[href], [role="link"]',
          input: 'input:not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"])',
          checkbox: 'input[type="checkbox"], [role="checkbox"]',
          radio: 'input[type="radio"], [role="radio"]',
          textarea: 'textarea, [role="textbox"], [role="searchbox"]',
          select: 'select, [role="combobox"]',
          tab: '[role="tab"]',
          interactive: '[onclick], [tabindex]:not([tabindex^="-"]), [role="menuitem"], [role="slider"], [role="option"], [role="treeitem"], [role="switch"]'
        };
        const visible = (el) => {
          if (!el || !el.isConnected) return false;
          const s = getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 || r.height > 0 || el.tagName === 'A';
        };
        const interactive = (el) => !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true' && !el.closest('[aria-hidden="true"]');
        const name = (el) => {
          const labelled = el.getAttribute('aria-labelledby');
          if (labelled) { const n = document.getElementById(labelled); if (n) return (n.textContent || '').trim(); }
          const aria = el.getAttribute('aria-label');
          if (aria) return aria.trim();
          if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) return (l.textContent || '').trim(); }
          const pl = el.closest('label');
          if (pl) return (pl.textContent || '').trim();
          return (el.getAttribute('placeholder') || el.getAttribute('value') || el.textContent || el.getAttribute('title') || '').trim();
        };
        const fuzzy = (text, query) => {
          if (!query) return true;
          text = String(text || '').toLowerCase(); query = String(query).toLowerCase();
          let i = 0, j = 0;
          while (i < text.length && j < query.length) { if (text[i] === query[j]) j++; i++; }
          return j === query.length;
        };
        const selectorFor = (el) => {
          if (el.id) return '#' + CSS.escape(el.id);
          for (const attr of ['data-testid', 'data-cy', 'name']) {
            const v = el.getAttribute(attr);
            if (v) return '[' + attr + '="' + CSS.escape(v) + '"]';
          }
          const parts = []; let cur = el;
          while (cur && cur.nodeType === 1 && cur.tagName !== 'BODY' && parts.length < 8) {
            let part = cur.tagName.toLowerCase();
            const parent = cur.parentElement;
            if (parent) {
              const same = [...parent.children].filter(x => x.tagName === cur.tagName);
              if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
            }
            parts.unshift(part); cur = parent;
          }
          return 'body > ' + parts.join(' > ');
        };
        let elements;
        if (options.selector) {
          try { elements = [...document.querySelectorAll(options.selector)]; } catch (e) { return { success: false, error: String(e.message || e) }; }
        } else {
          const types = Array.isArray(options.types) && options.types.length ? options.types : Object.keys(config);
          const combined = types.map(t => config[t]).filter(Boolean).join(', ');
          elements = combined ? [...document.querySelectorAll(combined)] : [];
        }
        const seen = new Set();
        const out = [];
        for (const el of elements) {
          if (seen.has(el) || !visible(el) || !interactive(el)) continue;
          seen.add(el);
          const text = name(el);
          if (!fuzzy(text, options.textQuery)) continue;
          let type = 'interactive';
          for (const [k, sel] of Object.entries(config)) { try { if (el.matches(sel)) { type = k; break; } } catch (_) {} }
          const item = { type, selector: selectorFor(el), text, isInteractive: true, disabled: false };
          if (options.includeCoordinates !== false) {
            const r = el.getBoundingClientRect();
            item.coordinates = { x: r.left + r.width / 2, y: r.top + r.height / 2, rect: { x:r.x, y:r.y, width:r.width, height:r.height, top:r.top, right:r.right, bottom:r.bottom, left:r.left } };
          }
          if (el.tagName === 'A') item.href = el.href;
          if ('checked' in el) item.checked = !!el.checked;
          out.push(item);
          if (out.length >= 500) break;
        }
        return { success: true, elements: out, fallback: "cdp" };
      })()\`;
      return await bmgCdpEvaluate(tabId, expression);
    }
  }
`;

const WEB_INJECT_OLD = '          yield this.injectContentScript(tab.id, ["inject-scripts/web-fetcher-helper.js"]);';
const WEB_INJECT_NEW = `          try {
            yield bmgFastPromise(
              this.injectContentScript(tab.id, ["inject-scripts/web-fetcher-helper.js"]),
              "web fetcher injection",
              1200
            );
          } catch (error) {
            console.warn("BMG web fetcher helper unavailable; using CDP fallback", error);
          }`;

const INTERACTIVE_OLD = `          yield this.injectContentScript(tab.id, ["inject-scripts/interactive-elements-helper.js"]);
          const result2 = yield this.sendMessageToTab(tab.id, {
            action: TOOL_MESSAGE_TYPES.GET_INTERACTIVE_ELEMENTS,
            textQuery,
            selector,
            includeCoordinates,
            types
          });`;

const INTERACTIVE_NEW = `          try {
            yield bmgFastPromise(
              this.injectContentScript(tab.id, ["inject-scripts/interactive-elements-helper.js"]),
              "interactive helper injection",
              1200
            );
          } catch (error) {
            console.warn("BMG interactive helper unavailable; using CDP fallback", error);
          }
          const result2 = yield bmgInteractiveWithCdpFallback(this, tab.id, {
            textQuery,
            selector,
            includeCoordinates,
            types
          });`;

const INTERACTION_HELPER = `  // ${INTERACTION_MARKER}
  async function bmgCdpClickSelector(tabId, selector, button = "left") {
    const expression = "(() => {" +
      "const el=document.querySelector(" + JSON.stringify(selector) + ");" +
      "if(!el)return {success:false,error:'Target element was not found'};" +
      "el.scrollIntoView({block:'center',inline:'nearest',behavior:'auto'});" +
      "const r=el.getBoundingClientRect();" +
      "if(!(r.width>0||r.height>0))return {success:false,error:'Target element is not visible'};" +
      "return {success:true,x:r.left+r.width/2,y:r.top+r.height/2,tag:el.tagName,text:(el.innerText||el.textContent||'').trim().slice(0,200)};" +
      "})()";
    const target = await bmgCdpEvaluate(tabId, expression);
    if (!target || target.success !== true) {
      return target || { success: false, error: "CDP target resolution failed" };
    }
    let attached = false;
    try {
      await CDPHelper.attach(tabId);
      attached = true;
      await CDPHelper.dispatchMouseEvent(tabId, { type: "mouseMoved", x: target.x, y: target.y, button: "none", buttons: 0 });
      await CDPHelper.dispatchMouseEvent(tabId, { type: "mousePressed", x: target.x, y: target.y, button, buttons: button === "right" ? 2 : 1, clickCount: 1 });
      await CDPHelper.dispatchMouseEvent(tabId, { type: "mouseReleased", x: target.x, y: target.y, button, buttons: 0, clickCount: 1 });
      return {
        success: true,
        message: "Click operation successful via CDP fallback",
        navigationOccurred: false,
        elementInfo: { tagName: target.tag, text: target.text }
      };
    } finally {
      if (attached) { try { await CDPHelper.detach(tabId); } catch (_) {} }
    }
  }

  async function bmgCdpFillSelector(tabId, selector, value) {
    const expression = "(() => {" +
      "const el=document.querySelector(" + JSON.stringify(selector) + ");" +
      "if(!el)return {success:false,error:'Target element was not found'};" +
      "const v=" + JSON.stringify(String(value)) + ";" +
      "let proto=null;" +
      "if(el instanceof HTMLInputElement)proto=HTMLInputElement.prototype;" +
      "else if(el instanceof HTMLTextAreaElement)proto=HTMLTextAreaElement.prototype;" +
      "else if(el instanceof HTMLSelectElement)proto=HTMLSelectElement.prototype;" +
      "const setter=proto?Object.getOwnPropertyDescriptor(proto,'value')?.set:null;" +
      "if(setter)setter.call(el,v);else if('value' in el)el.value=v;else return {success:false,error:'Target element does not accept a value'};" +
      "el.dispatchEvent(new Event('input',{bubbles:true,composed:true}));" +
      "el.dispatchEvent(new Event('change',{bubbles:true,composed:true}));" +
      "return {success:true,message:'Fill operation successful via CDP fallback',elementInfo:{tagName:el.tagName,value:'value' in el?String(el.value):''}};" +
      "})()";
    return await bmgCdpEvaluate(tabId, expression);
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

function replacePatternExactlyOnce(text, pattern, replacement, label) {
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`${label} matched ${matches.length} times; expected exactly once`);
  }
  return text.replace(pattern, replacement);
}

function patchInteractionFallback(text) {
  if (text.includes(INTERACTION_MARKER)) return { text, changed: false };
  let next = replaceExactlyOnce(
    text,
    CLICK_CLASS_ANCHOR,
    INTERACTION_HELPER + CLICK_CLASS_ANCHOR,
    'click class',
  );

  const readPagePattern = /          yield this\.injectContentScript\(\r?\n            tab\.id,\r?\n            \["inject-scripts\/accessibility-tree-helper\.js"\],\r?\n            false,\r?\n            "ISOLATED",\r?\n            true\r?\n          \);\r?\n          const resp = yield this\.sendMessageToTab\(tab\.id, \{\r?\n            action: TOOL_MESSAGE_TYPES\.GENERATE_ACCESSIBILITY_TREE,\r?\n            filter: filter \|\| null,\r?\n            depth: requestedDepth,\r?\n            refId: focusRefId \|\| void 0\r?\n          \}\);/gu;
  const readPageReplacement = `          let resp = null;
          try {
            yield bmgFastPromise(
              this.injectContentScript(tab.id, ["inject-scripts/accessibility-tree-helper.js"], false, "ISOLATED", true),
              "read page accessibility injection",
              1200
            );
            resp = yield bmgFastPromise(
              this.sendMessageToTab(tab.id, {
                action: TOOL_MESSAGE_TYPES.GENERATE_ACCESSIBILITY_TREE,
                filter: filter || null,
                depth: requestedDepth,
                refId: focusRefId || void 0
              }),
              "read page accessibility helper",
              1200
            );
          } catch (error) {
            console.warn("BMG read_page accessibility helper unavailable; using interactive/CDP fallback", error);
          }`;
  next = replacePatternExactlyOnce(next, readPagePattern, readPageReplacement, 'read page accessibility helper');

  const readFallbackPattern = /            yield this\.injectContentScript\(tab\.id, \["inject-scripts\/interactive-elements-helper\.js"\]\);\r?\n            const fallback = yield this\.sendMessageToTab\(tab\.id, \{\r?\n              action: TOOL_MESSAGE_TYPES\.GET_INTERACTIVE_ELEMENTS,\r?\n              includeCoordinates: true\r?\n            \}\);/gu;
  const readFallbackReplacement = `            try {
              yield bmgFastPromise(
                this.injectContentScript(tab.id, ["inject-scripts/interactive-elements-helper.js"]),
                "read page interactive injection",
                1200
              );
            } catch (error) {
              console.warn("BMG read_page interactive helper unavailable; using CDP fallback", error);
            }
            const fallback = yield bmgInteractiveWithCdpFallback(this, tab.id, { includeCoordinates: true });`;
  next = replacePatternExactlyOnce(next, readFallbackPattern, readFallbackReplacement, 'read page interactive fallback');

  const clickPattern = /          yield this\.injectContentScript\(tab\.id, \["inject-scripts\/click-helper\.js"\]\);\r?\n          const result2 = yield this\.sendMessageToTab\(\r?\n            tab\.id,\r?\n            \{\r?\n              action: TOOL_MESSAGE_TYPES\.CLICK_ELEMENT,\r?\n              selector: finalSelector,\r?\n              coordinates,\r?\n              ref: finalRef,\r?\n              waitForNavigation: waitForNavigation2,\r?\n              timeout,\r?\n              double: args\.double === true,\r?\n              button,\r?\n              bubbles,\r?\n              cancelable,\r?\n              modifiers\r?\n            \},\r?\n            frameId\r?\n          \);/gu;
  const clickReplacement = `          try {
            yield bmgFastPromise(
              this.injectContentScript(tab.id, ["inject-scripts/click-helper.js"]),
              "click helper injection",
              1200
            );
          } catch (error) {
            console.warn("BMG click helper injection unavailable", error);
          }
          let result2;
          try {
            result2 = yield bmgFastPromise(
              this.sendMessageToTab(
                tab.id,
                {
                  action: TOOL_MESSAGE_TYPES.CLICK_ELEMENT,
                  selector: finalSelector,
                  coordinates,
                  ref: finalRef,
                  waitForNavigation: waitForNavigation2,
                  timeout,
                  double: args.double === true,
                  button,
                  bubbles,
                  cancelable,
                  modifiers
                },
                frameId
              ),
              "click helper",
              1200
            );
          } catch (helperError) {
            if (finalSelector && selectorType === "css" && frameId === void 0 && args.double !== true && !modifiers) {
              result2 = yield bmgCdpClickSelector(tab.id, finalSelector, button === "right" ? "right" : "left");
            } else {
              throw helperError;
            }
          }
          if (!result2 || result2.success === false || result2.error) {
            return createErrorResponse((result2 == null ? void 0 : result2.error) || "Click operation failed");
          }`;
  next = replacePatternExactlyOnce(next, clickPattern, clickReplacement, 'click helper');

  const fillPattern = /          yield this\.injectContentScript\(tab\.id, \["inject-scripts\/fill-helper\.js"\]\);\r?\n          const result2 = yield this\.sendMessageToTab\(\r?\n            tab\.id,\r?\n            \{\r?\n              action: TOOL_MESSAGE_TYPES\.FILL_ELEMENT,\r?\n              selector: finalSelector,\r?\n              ref: finalRef,\r?\n              value\r?\n            \},\r?\n            frameId\r?\n          \);/gu;
  const fillReplacement = `          try {
            yield bmgFastPromise(
              this.injectContentScript(tab.id, ["inject-scripts/fill-helper.js"]),
              "fill helper injection",
              1200
            );
          } catch (error) {
            console.warn("BMG fill helper injection unavailable", error);
          }
          let result2;
          try {
            result2 = yield bmgFastPromise(
              this.sendMessageToTab(
                tab.id,
                {
                  action: TOOL_MESSAGE_TYPES.FILL_ELEMENT,
                  selector: finalSelector,
                  ref: finalRef,
                  value
                },
                frameId
              ),
              "fill helper",
              1200
            );
          } catch (helperError) {
            if (finalSelector && selectorType === "css" && frameId === void 0) {
              result2 = yield bmgCdpFillSelector(tab.id, finalSelector, value);
            } else {
              throw helperError;
            }
          }`;
  next = replacePatternExactlyOnce(next, fillPattern, fillReplacement, 'fill helper');

  return { text: next, changed: true };
}

export function patchContentCdpBackgroundText(text) {
  let next = text;
  let changed = false;
  if (!next.includes(MARKER)) {
    next = replaceExactlyOnce(next, CLASS_ANCHOR, HELPER + CLASS_ANCHOR, 'web fetcher class');
    next = replaceExactlyOnce(next, WEB_INJECT_OLD, WEB_INJECT_NEW, 'web fetcher injection');
    const webBlockStart = next.indexOf(CLASS_ANCHOR);
    const webBlockEnd = next.indexOf('  const webFetcherTool = new WebFetcherTool();', webBlockStart);
    if (webBlockStart < 0 || webBlockEnd < 0) throw new Error('web fetcher block was not found');
    const webBlock = next.slice(webBlockStart, webBlockEnd).replaceAll(
      'webContentMessageWithFallback(',
      'bmgWebContentWithCdpFallback(',
    );
    next = next.slice(0, webBlockStart) + webBlock + next.slice(webBlockEnd);
    next = replaceExactlyOnce(next, INTERACTIVE_OLD, INTERACTIVE_NEW, 'interactive helper');
    changed = true;
  }
  const interaction = patchInteractionFallback(next);
  next = interaction.text;
  changed = changed || interaction.changed;
  return { text: next, changed };
}

export function patchExtensionContentCdp(extensionDir) {
  const backgroundPath = path.join(extensionDir, 'background.js');
  const original = fs.readFileSync(backgroundPath, 'utf8');
  const patched = patchContentCdpBackgroundText(original);
  if (patched.changed) fs.writeFileSync(backgroundPath, patched.text, 'utf8');
  return { backgroundChanged: patched.changed };
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const extensionDir = process.argv[2];
  if (!extensionDir) throw new Error('Usage: node patch-extension-content-cdp.mjs <extension-dir>');
  const result = patchExtensionContentCdp(path.resolve(extensionDir));
  console.log(`BMG content CDP fallback patch: background=${result.backgroundChanged ? 'patched' : 'already'}`);
}
