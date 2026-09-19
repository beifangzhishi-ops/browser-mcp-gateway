import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { patchWorkspaceWindowText } from '../scripts/patch-extension-workspace-window.mjs';
import { BrowserWorkspaceRouter } from '../sidecar/workspace.mjs';

// 固定版本扩展中创建窗口和输出窗口信息的原始片段。
const fixture = `function* create(url, background2, chrome) {
  const width = 480, height = 360;
            const newWindow2 = yield chrome.windows.create({
              url,
              width: typeof width === "number" ? width : DEFAULT_WINDOW_WIDTH,
              height: typeof height === "number" ? height : DEFAULT_WINDOW_HEIGHT,
              focused: background2 === true ? false : true
            });
  return {
                      windowId: newWindow2.id,
  };
}
function list(window2, tabs) {
  return {
              windowId: window2.id || 0,
              tabs
  };
}`;

test('仅本机工作区引导请求创建弹出窗口，普通导航保持原有窗口类型', () => {
  const patched = patchWorkspaceWindowText(fixture);
  const { create, list } = new Function(patched.text + '; return { create, list };')();
  const bootstrap = 'http://localhost:18007/workspace-bootstrap?nonce=123-456-abcd&bmgWindow=popup-v1';
  for (const [url, background, popup] of [
    [bootstrap, true, true],
    [bootstrap.replace('localhost', '127.0.0.1'), true, true],
    [bootstrap, false, false],
    ['https://example.com', true, false],
    ['about:blank', false, false],
    [bootstrap.replace('localhost', 'example.com'), true, false],
    [bootstrap.replace('localhost', 'localhost.example.com'), true, false],
    [bootstrap.replace('http:', 'https:'), true, false],
    [bootstrap.replace('popup-v1', 'normal'), true, false],
    [bootstrap.replace('nonce=123-456-abcd', 'nonce='), true, false],
    [bootstrap.replace('/workspace-bootstrap?', '/other?'), true, false],
  ]) {
    let options;
    const iterator = create(url, background, { windows: { create(value) { options = value; } } });
    iterator.next();
    assert.equal(options.type, popup ? 'popup' : undefined, url);
    assert.equal(options.focused, !background);
    assert.equal(options.url, url);
    const response = iterator.next({ id: 17, type: popup ? 'popup' : 'normal' }).value;
    assert.equal(response.windowType, popup ? 'popup' : 'normal');
  }
  assert.deepEqual(list({ id: 17, type: 'popup' }, []), { windowId: 17, windowType: 'popup', tabs: [] });
  assert.equal(patchWorkspaceWindowText(patched.text).changed, false);
  assert.throws(() => patchWorkspaceWindowText(fixture.replace('newWindow2.id,', 'newWindow2.id || 0,')), /不匹配/);
  assert.throws(() => patchWorkspaceWindowText(patched.text.replace('windowType: newWindow2.type,', '')), /不完整/);
});

function message(data) {
  return { result: { content: [{ type: 'text', text: JSON.stringify(data) }] } };
}

test('未更新扩展返回普通窗口时，不移动窗口且只清理本次创建的引导标签页', async () => {
  for (const windowType of ['normal', undefined]) {
    const calls = [];
    const router = new BrowserWorkspaceRouter({
      enabled: true, idleTimeoutMs: 0,
      bootstrapUrl: 'http://localhost:18007/workspace-bootstrap',
      placeWindowOffscreen: async () => assert.fail('不应移动普通窗口'),
      callTool: async (name, args) => {
        calls.push({ name, args });
        return message({ windowId: 10, windowType, tabs: [{ tabId: 20 }] });
      },
    });
    await assert.rejects(router.ensureWorkspace(), { code: 'BMG_WORKSPACE_WINDOW_TYPE' });
    assert.deepEqual(calls.map(({ name }) => name), ['chrome_navigate', 'chrome_close_tabs']);
    assert.deepEqual(calls[1].args, { tabIds: [20] });
    assert.equal(router.windowId, null);
  }
});

test('旧普通工作区停止复用和空闲清理，保留记录与标签页供用户处理', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmg-popup-test-'));
  const stateFile = path.join(dir, 'workspace.json');
  const saved = JSON.stringify({ version: 1, windowId: 10, tabId: 20, hwnd: 30 });
  fs.writeFileSync(stateFile, saved);
  let now = 0;
  const router = new BrowserWorkspaceRouter({
    enabled: true, stateFile, idleTimeoutMs: 1000, clock: () => now,
    ensureWindowHidden: async () => assert.fail('不应隐藏旧普通工作区'),
    callTool: async (name) => {
      assert.equal(name, 'get_windows_and_tabs');
      return message({ windows: [{ windowId: 10, windowType: 'normal', tabs: [{ tabId: 20 }] }] });
    },
  });
  t.after(async () => { await router.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await assert.rejects(router.ensureWorkspace(), { code: 'BMG_WORKSPACE_WINDOW_TYPE' });
  assert.equal(router.windowId, 10);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), saved);
  now = 1001;
  await assert.rejects(router.cleanupIdleWorkspace(router.activityGeneration), { code: 'BMG_WORKSPACE_WINDOW_TYPE' });
});
