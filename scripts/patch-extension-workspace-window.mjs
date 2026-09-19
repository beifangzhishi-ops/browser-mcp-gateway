import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = 'BMG_WORKSPACE_POPUP_V1';
const CREATE = `            const newWindow2 = yield chrome.windows.create({
              url,
              width: typeof width === "number" ? width : DEFAULT_WINDOW_WIDTH,
              height: typeof height === "number" ? height : DEFAULT_WINDOW_HEIGHT,
              focused: background2 === true ? false : true
            });`;
const CREATE_POPUP = `            // ${MARKER}
            const bmgUrl = new URL(url);
            const bmgWorkspace = background2 === true && bmgUrl.protocol === "http:" &&
              ["localhost", "127.0.0.1"].includes(bmgUrl.hostname) &&
              !bmgUrl.username && !bmgUrl.password &&
              bmgUrl.pathname === "/workspace-bootstrap" &&
              bmgUrl.searchParams.get("bmgWindow") === "popup-v1" &&
              /^[A-Za-z0-9._-]+$/.test(bmgUrl.searchParams.get("nonce") || "");
            const newWindow2 = yield chrome.windows.create({
              url,
              ...(bmgWorkspace ? { type: "popup" } : {}),
              width: typeof width === "number" ? width : DEFAULT_WINDOW_WIDTH,
              height: typeof height === "number" ? height : DEFAULT_WINDOW_HEIGHT,
              focused: background2 === true ? false : true
            });`;
const RESULT = '                      windowId: newWindow2.id,\n';
const LIST = '              windowId: window2.id || 0,\n              tabs';

function replaceOnce(text, before, after) {
  if (text.split(before).length !== 2) {
    throw new Error('工作区窗口补丁与扩展版本不匹配，未写入文件。');
  }
  return text.replace(before, after);
}

export function patchWorkspaceWindowText(source) {
  const text = source.replace(/\r\n/g, '\n');
  const replacements = [
    [CREATE, CREATE_POPUP],
    [RESULT, RESULT + '                      windowType: newWindow2.type,\n'],
    [LIST, '              windowId: window2.id || 0,\n              windowType: window2.type,\n              tabs'],
  ];
  if (text.includes(MARKER)) {
    if (!replacements.every(([, after]) => text.includes(after))) {
      throw new Error('工作区窗口补丁不完整，请重新安装扩展文件。');
    }
    return { text: source, changed: false };
  }
  return {
    text: replacements.reduce((value, [before, after]) => replaceOnce(value, before, after), text),
    changed: true,
  };
}

export function patchExtensionWorkspaceWindow(extensionDir) {
  const file = path.join(extensionDir, 'background.js');
  const result = patchWorkspaceWindowText(fs.readFileSync(file, 'utf8'));
  if (result.changed) fs.writeFileSync(file, result.text, 'utf8');
  return result.changed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('用法：node scripts/patch-extension-workspace-window.mjs <扩展目录>');
  const changed = patchExtensionWorkspaceWindow(path.resolve(process.argv[2]));
  console.log(changed ? '已应用工作区弹出窗口补丁；请在 Edge 中重载扩展。' : '工作区弹出窗口补丁已存在。');
}
