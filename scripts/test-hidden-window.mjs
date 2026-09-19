import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { loadConfig } from '../sidecar/config.mjs';

// 本脚本会创建、隐藏、恢复并关闭一个测试窗口，仅供明确授权的实际试验。
const config = loadConfig();
const hiddenOnly = process.argv.includes('--hidden-only');
const token = `BMG-HIDE-${Date.now()}`;
const output = path.join(config.rootDir, '.state', '隐藏窗口试验', token);
let session = JSON.parse(fs.readFileSync(config.upstreamSessionFile, 'utf8')).sessionId;
const report = { 测试标记: token, 隐藏后直接关闭: hiddenOnly, 截图: [], 状态: [] };
let sequence = 0;

async function rpc(method, params, retried = false) {
  const response = await fetch(`${config.upstreamUrl}/mcp`, {
    method: 'POST', signal: AbortSignal.timeout(35000),
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': session },
    body: JSON.stringify({ jsonrpc: '2.0', id: `${token}-${++sequence}`, method, params }),
  });
  const body = await response.text();
  const invalidSession = response.status === 404 ||
    (response.status === 400 && /session/i.test(body) && /invalid|not found|no transport/i.test(body));
  if (invalidSession && !retried) {
    const initialized = await fetch(`${config.upstreamUrl}/mcp`, {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: `${token}-init`, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'BMG隐藏试验', version: '1.0' } } }),
    });
    const initialBody = await initialized.text();
    const initialLine = initialBody.split(/\r?\n/u).find((item) => item.startsWith('data:'));
    const initializeMessage = JSON.parse(initialLine ? initialLine.slice(5) : initialBody);
    session = initialized.headers.get('mcp-session-id');
    if (!initialized.ok || !session || !initializeMessage.result) throw new Error('上游会话初始化失败');
    const temporary = `${config.upstreamSessionFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, upstreamUrl: config.upstreamUrl, sessionId: session, initializeMessage }), { mode: 0o600 });
    fs.renameSync(temporary, config.upstreamSessionFile);
    return rpc(method, params, true);
  }
  if (!response.ok) throw new Error(`上游接口返回 ${response.status}，请先连接 BMG 扩展。`);
  const line = body.split(/\r?\n/u).find((item) => item.startsWith('data:'));
  const message = JSON.parse(line ? line.slice(5) : body);
  if (message.error) throw new Error(JSON.stringify(message.error));
  return message.result;
}

async function call(name, args) {
  let result = await rpc('tools/call', { name, arguments: args });
  for (let depth = 0; depth < 4; depth++) {
    if (result?.isError || result?.success === false) {
      const detail = result.error || result.message || result.content?.find((item) => item.type === 'text')?.text || '未提供原因';
      throw new Error(`工具 ${name} 返回错误：${String(detail).slice(0, 600)}`);
    }
    const text = result?.content?.find((item) => item.type === 'text')?.text;
    if (!text) break;
    try { result = JSON.parse(text); } catch { return { text }; }
    if (result?.data?.content) result = result.data;
  }
  return result;
}

const loaded = new Set();
const loadWaiters = new Map();
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname !== `/${token}` && url.pathname !== `/${token}/ready`) {
    response.writeHead(404); response.end(); return;
  }
  const stage = url.searchParams.get('stage') === '2' ? '2' : '1';
  if (url.pathname.endsWith('/ready')) {
    loaded.add(stage); loadWaiters.get(stage)?.();
    response.writeHead(204); response.end(); return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(`<!doctype html><meta charset="utf-8"><title>${token}</title>
<style>body{margin:0;background:${stage === '1' ? '#582ca0' : '#087f6e'};color:white;font:28px system-ui}main{padding:32px}#色块{height:160px;background:${stage === '1' ? '#ffd33d' : '#ff607d'};border:8px solid white}footer{margin-top:600px}</style>
<main><h1>真正隐藏窗口测试 · 阶段${stage === '1' ? '一' : '二'}</h1><p>测试标记：${token}</p><div id="色块"></div><p>阶段二必须出现绿色背景与红色色块。</p><footer>页面底部标记</footer></main>
<script>fetch('/${token}/ready?stage=${stage}');</script>`);
});

function waitLoaded(stage) {
  if (loaded.has(stage)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('测试页加载超时')), 15000);
    loadWaiters.set(stage, () => { clearTimeout(timer); resolve(); });
  });
}

let tabId, windowId, controller, controlLines, controllerExit;
const replies = [];
const pending = [];
function nextReply() {
  if (replies.length) return Promise.resolve(replies.shift());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('窗口控制器未响应')), 10000);
    pending.push((value) => { clearTimeout(timer); resolve(value); });
  });
}
async function control(action) {
  const reply = nextReply();
  controller.stdin.write(`${action}\n`);
  const value = await reply;
  if (value.error) throw new Error(value.error);
  report.状态.push({ 操作: action, ...value });
  return value;
}
async function screenshot(label) {
  const before = await control('检查');
  const entry = { 名称: label, 截图前: before };
  try {
    const shot = await call('chrome_screenshot', {
      tabId, windowId, background: true, fullPage: false, storeBase64: true, savePng: false,
    });
    if (!shot?.base64Data || !['image/jpeg', 'image/png'].includes(shot.mimeType)) {
      throw new Error('截图接口未返回可识别的图片');
    }
    const file = path.join(output, `${label}.${shot.mimeType === 'image/png' ? 'png' : 'jpg'}`);
    fs.writeFileSync(file, Buffer.from(shot.base64Data, 'base64'));
    entry.文件 = file;
    console.log(`已保存：${label}`);
  } catch (error) {
    entry.错误 = error.message;
    console.log(`截图失败：${label}，${error.message}`);
  }
  entry.截图后 = await control('检查');
  report.截图.push(entry);
}

try {
  await rpc('tools/list', {});
  fs.mkdirSync(output, { recursive: true });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://localhost:${server.address().port}/${token}`;
  const created = await call('chrome_navigate', { url, newWindow: true, background: true, width: 960, height: 720 });
  windowId = created?.windowId;
  tabId = created?.tabId ?? created?.tabs?.[0]?.tabId;
  if (!Number.isInteger(windowId) || !Number.isInteger(tabId)) throw new Error('未取得测试窗口 ID');
  await waitLoaded('1');
  controller = spawn('python', ['-u', path.join(config.rootDir, 'scripts', 'probe-hidden-window.py'), token], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  controllerExit = once(controller, 'exit');
  controlLines = createInterface({ input: controller.stdout });
  controlLines.on('line', (line) => {
    let value;
    try { value = JSON.parse(line); } catch { value = { error: '窗口控制器输出格式错误' }; }
    if (pending.length) pending.shift()(value); else replies.push(value);
  });
  controller.stderr.on('data', () => {});
  const initial = await nextReply();
  if (initial.error) throw new Error(initial.error);
  report.初始窗口 = initial;
  if (!hiddenOnly) await screenshot('一_可见窗口');
  const hidden = await control('隐藏');
  if (hidden.visible || JSON.stringify(hidden.rect) !== JSON.stringify(initial.rect)) {
    throw new Error('真正隐藏未成功，或窗口坐标发生变化');
  }
  if (hiddenOnly) {
    console.log('测试窗口已真正隐藏，10 秒后开始截图；可以照常操作普通 Edge 窗口。');
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
  await screenshot('二_隐藏窗口');
  await call('chrome_navigate', { url: `${url}?stage=2`, tabId, windowId, newWindow: false, background: true });
  await waitLoaded('2');
  const content = await call('chrome_get_web_content', { tabId, windowId, background: true, textContent: true });
  report.隐藏后内容已更新 = JSON.stringify(content).includes('真正隐藏窗口测试 · 阶段二');
  await screenshot('三_隐藏中更新内容');
  if (!hiddenOnly) {
    await control('显示');
    await screenshot('四_恢复可见');
  }
  report.完成 = true;
} catch (error) {
  report.错误 = error.message;
  console.error(`试验未完成：${error.message}`);
  process.exitCode = 1;
} finally {
  if (hiddenOnly && tabId) {
    try {
      await call('chrome_close_tabs', { tabIds: [tabId] });
      report.测试标签已关闭 = true;
      tabId = null;
    } catch { console.error('隐藏中的测试标签未能关闭，将先恢复以便人工处理。'); }
  }
  if (controller?.stdin.writable) {
    controller.stdin.end(hiddenOnly && report.测试标签已关闭 ? '结束不恢复\n' : '结束\n');
    await controllerExit;
    controlLines.close();
  }
  if (tabId) {
    try { await call('chrome_close_tabs', { tabIds: [tabId] }); report.测试标签已关闭 = true; }
    catch { report.测试标签已关闭 = false; console.error('测试标签关闭失败，请手动关闭带测试标记的窗口。'); }
  }
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  if (fs.existsSync(output)) {
    fs.writeFileSync(path.join(output, '试验记录.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log(`试验输出：${output}`);
  }
}
