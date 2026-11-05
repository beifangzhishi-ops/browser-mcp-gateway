import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { createBmgServer, closeBmgServer, listenBmgServer, workspaceLocalToolsForTest, augmentWorkspaceToolsForTest } from '../sidecar/server.mjs';
import { UpstreamDiagnostics, probeTcpPort } from '../sidecar/upstream-diagnostics.mjs';
import { createConfig } from '../sidecar/config.mjs';
import { BrowserWorkspaceRouter, WORKSPACE_RECOVERY_TIMEOUT_MS } from '../sidecar/workspace.mjs';
import { prepareWorkspace } from '../scripts/ensure-workspace.mjs';
import { execFileSync } from 'node:child_process';
import { OAuthStore, createPkceChallenge } from '../sidecar/oauth.mjs';
import {
  patchWebContentBackgroundText,
  patchWebContentHelperText,
} from '../scripts/patch-extension-web-content.mjs';
import {
  patchNavigationBackgroundText,
  patchNavigationTargetSelection,
} from '../scripts/patch-extension-navigation.mjs';
import {
  patchContentCdpBackgroundText,
} from '../scripts/patch-extension-content-cdp.mjs';
import {
  patchFlowWorkspace,
  patchUpstreamToolsBackgroundText,
} from '../scripts/patch-extension-upstream-tools.mjs';
import { toolCallFailed } from '../scripts/bmgctl-result.mjs';
import { inspectBrowserToolResponse } from '../scripts/check-bmg-live.mjs';
import { BmgApprovalGate } from '../sidecar/approval/index.mjs';
import { BmgTotpManager, totpForCounter } from '../sidecar/approval/totp.mjs';
import './web-unlock.test.mjs';

const ISSUER = 'https://bmg.example.test/bmg';
const RESOURCE = 'https://bmg.example.test/bmg/mcp';
const PROTECTED_METADATA =
  'https://bmg.example.test/.well-known/oauth-protected-resource/bmg/mcp';
const APPROVAL_SECRET = 'unit-test-approval-secret';

test('live acceptance rejects nested browser errors, malformed results and fallback-only reads', () => {
  const response = (payload, isError = false) => ({
    success: true,
    name: 'chrome_read_page',
    result: { isError, content: [{ type: 'text', text: JSON.stringify(payload) }] },
  });
  const realTree = response({ success: true, pageContent: '- button', fallbackUsed: false });
  assert.equal(inspectBrowserToolResponse(realTree, { requireAccessibilityTree: true }).passed, true);
  assert.deepEqual(inspectBrowserToolResponse(response({ success: true, pageContent: '- button', fallbackUsed: true }), {
    requireAccessibilityTree: true,
  }), { passed: false, reason: 'accessibility_tree_fallback_only' });
  assert.equal(inspectBrowserToolResponse(response({ success: false })).passed, false);
  assert.equal(inspectBrowserToolResponse(response({ success: true }, true)).passed, false);
  assert.equal(inspectBrowserToolResponse({ success: true, result: { isError: false, content: [{ type: 'text', text: 'not-json' }] } }).passed, false);
  assert.equal(inspectBrowserToolResponse({ success: false, result: { isError: false } }).passed, false);
});

test('实时验收区分成功主树的补读与主树失败的兜底', () => {
  const inspect = (payload) => inspectBrowserToolResponse({
    success: true,
    result: { isError: false, content: [{ type: 'text', text: JSON.stringify(payload) }] },
  }, { requireAccessibilityTree: true });
  const supplemented = {
    success: true, pageContent: '- document\n  - text', fallbackUsed: true,
    fallbackSource: 'get_interactive_elements', reason: 'sparse_tree', sparse: true,
    stats: { processed: 2, included: 2, durationMs: 0 },
  };
  assert.deepEqual(inspect(supplemented), {
    passed: true, reason: 'primary_tree_with_interactive_supplement',
  });
  for (const changed of [
    { reason: 'tree_failed' }, { reason: 'read page accessibility helper timed out' },
    { sparse: false }, { fallbackSource: 'cdp' },
    { pageContent: '' }, { pageContent: '  ' }, { stats: null },
    { stats: { processed: 0, included: 0 } },
    { stats: { processed: 2, included: 0 } },
    { stats: { processed: 1, included: 2 } },
    { stats: { processed: '2', included: 2 } },
  ]) {
    assert.deepEqual(inspect({ ...supplemented, ...changed }), {
      passed: false, reason: 'accessibility_tree_fallback_only',
    });
  }
});

test('BMG timed grant freezes its owner action, binds a card, prevents replay and revokes on policy change', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bmg-approval-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'config'));
  const policyFile = path.join(root, 'config', 'approval-policy.json');
  fs.writeFileSync(policyFile, JSON.stringify({ version: 1, mode: 'timed', revision: 0 }));
  const gate = new BmgApprovalGate({
    rootDir: root, logDir: root, logger: { error() {} },
  });
  const first = gate.authorize('chrome_navigate', { url: 'https://example.org/' });
  assert.equal(first.allowed, false);
  assert.equal(first.toolResult.structuredContent.classification, 'approval_required');
  const approvalId = first.toolResult.structuredContent.approval_id;
  const card = await gate.handleLocal('request_approval', {
    approval_id: approvalId, duration_seconds: 60,
  }, 'session-A');
  assert.equal(card.structuredContent.state, 'pending');
  assert.equal(card.structuredContent.requested_duration_seconds, 60);
  const nonce = card._meta.approval_nonce;
  const wrongSession = await gate.handleLocal('get_approval_status', {
    approval_id: approvalId, approval_nonce: nonce,
  }, 'session-B');
  assert.equal(wrongSession.isError, true);
  const valid = await gate.handleLocal('get_approval_status', {
    approval_id: approvalId, approval_nonce: nonce,
  }, 'session-A');
  assert.equal(valid.structuredContent.state, 'pending');

  let dispatches = 0;
  const executeFrozen = async (tool, args) => {
    dispatches++;
    assert.equal(tool, 'chrome_navigate');
    assert.deepEqual(args, { url: 'https://example.org/' });
    return { content: [{ type: 'text', text: 'navigated' }] };
  };
  const approveArgs = { approval_id: approvalId, approval_nonce: nonce, decision: 'approve' };
  const resolved = await gate.handleLocal('resolve_pending_action', approveArgs, 'session-A', executeFrozen);
  assert.equal(resolved.structuredContent.state, 'consumed');
  assert.equal(resolved.structuredContent.grant_active, true);
  assert.equal(dispatches, 1);
  const repeat = await gate.handleLocal('resolve_pending_action', approveArgs, 'session-A', executeFrozen);
  assert.equal(repeat.isError, true);
  assert.equal(dispatches, 1);
  const reused = gate.authorize('chrome_read_page', { approval_id: approvalId, tabId: 42 });
  assert.equal(reused.allowed, true);
  assert.deepEqual(reused.args, { tabId: 42 });

  fs.writeFileSync(policyFile, JSON.stringify({ version: 1, mode: 'totp', revision: 1 }));
  assert.equal(gate.authorize('chrome_read_page', { approval_id: approvalId }).allowed, false);
  assert.equal(gate.authorize('chrome_read_page', {}).toolResult.structuredContent.classification, 'bmg_code_required');
});

test('BMG TOTP checks the WCM-equivalent clock window and prevents replay', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bmg-totp-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const secret = Buffer.from('12345678901234567890');
  const file = path.join(root, 'replay.json');
  let now = 12_345_670_000;
  const manager = () => new BmgTotpManager({
    stateFile: file, secretProvider: () => secret, now: () => now,
  });
  const current = Math.floor(now / 30_000);
  const older = totpForCounter(secret, current - 10);
  assert.equal(manager().verify(older), true);
  assert.equal(manager().verify(older), false);
  const newest = totpForCounter(secret, current + 1);
  assert.equal(manager().verify(newest), true);
  assert.equal(manager().verify(newest), false);
  for (let i = 0; i < 5; i++) manager().verify('invalid');
  now += 30_000;
  assert.equal(manager().verify(totpForCounter(secret, Math.floor(now / 30_000))), false);
  now += 5 * 60_000;
  assert.equal(manager().verify(totpForCounter(secret, Math.floor(now / 30_000))), true);
  assert.equal(fs.readFileSync(file, 'utf8').includes(secret.toString('base64')), false);
});

test('BMG either mode accepts a phone code or a card independently and revokes both on policy change', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bmg-either-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'config'));
  const policyFile = path.join(root, 'config', 'approval-policy.json');
  fs.writeFileSync(policyFile, JSON.stringify({ version: 1, mode: 'either', revision: 0 }));
  const redeemed = new Set();
  const gate = new BmgApprovalGate({
    rootDir: root, logDir: root,
    totpManager: { verify: (code) => {
      if (code !== '654321' || redeemed.has(code)) return false;
      redeemed.add(code);
      return true;
    } },
  });

  const waiting = gate.authorize('chrome_navigate', { url: 'https://example.org/' });
  assert.equal(waiting.toolResult.structuredContent.classification, 'approval_required');
  assert.match(waiting.toolResult.structuredContent.output, /bmg_unlock/u);
  assert.match(waiting.toolResult.structuredContent.output, /code is blocked or redacted.*request_approval/u);
  let dispatches = 0;
  const phone = await gate.handleLocal('bmg_unlock', { code: '654321', duration_seconds: 300 });
  assert.equal(phone.structuredContent.classification, 'bmg_unlocked');
  assert.equal(phone.structuredContent.grant_active, true);
  assert.equal(gate.authorize('chrome_read_page', { approval_id: phone.structuredContent.approval_id }).allowed, true);
  assert.equal(dispatches, 0, 'Phone unlock must not dispatch the pending browser action');
  const repeatedCode = await gate.handleLocal('bmg_unlock', { code: '654321' });
  assert.equal(repeatedCode.isError, true);

  const card = await gate.handleLocal('request_approval', {
    approval_id: waiting.toolResult.structuredContent.approval_id, duration_seconds: 60,
  }, 'session-either');
  assert.equal(card.structuredContent.state, 'pending');
  const approved = await gate.handleLocal('resolve_pending_action', {
    approval_id: card.structuredContent.approval_id,
    approval_nonce: card._meta.approval_nonce, decision: 'approve',
  }, 'session-either', async () => {
    dispatches++;
    return { content: [{ type: 'text', text: 'navigated' }] };
  });
  assert.equal(approved.structuredContent.grant_active, true);
  assert.equal(dispatches, 1);
  assert.equal(gate.authorize('chrome_read_page', { approval_id: approved.structuredContent.approval_id }).allowed, true);
  assert.notEqual(phone.structuredContent.approval_id, approved.structuredContent.approval_id);

  fs.writeFileSync(policyFile, JSON.stringify({ version: 1, mode: 'either', revision: 1 }));
  assert.equal(gate.authorize('chrome_read_page', { approval_id: phone.structuredContent.approval_id }).allowed, false);
  assert.equal(gate.authorize('chrome_read_page', { approval_id: approved.structuredContent.approval_id }).allowed, false);
});

test('public BMG MCP cannot dispatch browser calls before approval and strips the grant on reuse', async (t) => {
  const fixture = await createTestRuntime({
    approvalMode: 'either',
    includeFailureTool: true,
    totpManager: { verify: (code) => code === '654321' },
  });
  t.after(async () => {
    await closeBmgServer(fixture.runtime);
    await fixture.fakeUpstream.close();
    fs.rmSync(fixture.rootDir, { recursive: true, force: true });
  });
  const client = fixture.runtime.store.registerClient({
    redirect_uris: ['http://127.0.0.1:19001/oauth/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  });
  const token = fixture.runtime.store.mintTokenPair({
    clientId: client.clientId, resource: RESOURCE, scope: 'mcp',
    tokenTtlSeconds: 3600,
  }).accessToken;
  let rpcId = 10;
  const call = async (method, params) => {
    const response = await requestJson(fixture.baseUrl, '/bmg/mcp', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    });
    assert.equal(response.response.status, 200);
    return parseSse(response.text).result;
  };
  await call('initialize', {
    protocolVersion: '2025-03-26', capabilities: {},
    clientInfo: { name: 'approval-unit', version: '1' },
  });
  const blocked = await call('tools/call', { name: 'safe_ping', arguments: {} });
  assert.equal(blocked.structuredContent.classification, 'approval_required');
  assert.equal(fixture.fakeUpstream.calls.filter((item) => item.payload?.method === 'tools/call').length, 0);
  const approvalId = blocked.structuredContent.approval_id;
  const card = await call('tools/call', {
    name: 'request_approval', arguments: { approval_id: approvalId, duration_seconds: 60 },
  });
  assert.equal(card.structuredContent.requested_duration_seconds, 60);
  assert.ok(card._meta.approval_nonce);
  const resource = await call('resources/read', { uri: 'ui://bmg/approval-v2.html' });
  assert.match(resource.contents[0].text, /BMG approval/u);
  const approved = await call('tools/call', {
    name: 'resolve_pending_action',
    arguments: { approval_id: approvalId, approval_nonce: card._meta.approval_nonce, decision: 'approve' },
  });
  assert.equal(approved.structuredContent.state, 'consumed');
  assert.equal(fixture.fakeUpstream.calls.filter((item) => item.payload?.method === 'tools/call').length, 1);
  const reused = await call('tools/call', {
    name: 'safe_ping', arguments: { approval_id: approvalId },
  });
  assert.equal(reused.content[0].text, 'pong from 12306');
  const lastCall = fixture.fakeUpstream.calls.filter((item) => item.payload?.method === 'tools/call').at(-1);
  assert.deepEqual(lastCall.payload.params.arguments, {});
  const repeated = await call('tools/call', {
    name: 'resolve_pending_action',
    arguments: { approval_id: approvalId, approval_nonce: card._meta.approval_nonce, decision: 'approve' },
  });
  assert.equal(repeated.isError, true);
  assert.equal(fixture.fakeUpstream.calls.filter((item) => item.payload?.method === 'tools/call').length, 2);
  const phone = await call('tools/call', {
    name: 'bmg_unlock', arguments: { code: '654321', duration_seconds: 60 },
  });
  assert.equal(phone.structuredContent.classification, 'bmg_unlocked');
  const phoneReused = await call('tools/call', {
    name: 'safe_ping', arguments: { approval_id: phone.structuredContent.approval_id },
  });
  assert.equal(phoneReused.content[0].text, 'pong from 12306');
  assert.deepEqual(fixture.fakeUpstream.calls.filter((item) => item.payload?.method === 'tools/call').at(-1).payload.params.arguments, {});
  const frozenFailure = await call('tools/call', { name: 'safe_fail', arguments: {} });
  assert.equal(frozenFailure.structuredContent.classification, 'approval_required');
  const failedId = frozenFailure.structuredContent.approval_id;
  const failureCard = await call('tools/call', {
    name: 'request_approval', arguments: { approval_id: failedId, duration_seconds: 60 },
  });
  const failedApproval = await call('tools/call', {
    name: 'resolve_pending_action',
    arguments: {
      approval_id: failedId, approval_nonce: failureCard._meta.approval_nonce, decision: 'approve',
    },
  });
  assert.equal(failedApproval.structuredContent.state, 'consumed');
  assert.equal(failedApproval.structuredContent.action_failed, true);
  assert.equal(failedApproval.structuredContent.grant_active, true);
  const failureLog = fs.readFileSync(path.join(fixture.rootDir, 'logs', 'bmg-upstream-diagnostics.jsonl'), 'utf8');
  assert.match(failureLog, /"event":"approved_owner_tool_failed","route":"upstream","failure_kind":"tool_result_error"/u);
  assert.doesNotMatch(failureLog, /private-content-must-not-be-logged/u);
  const readFailedApproval = await call('tools/call', {
    name: 'get_approval_status',
    arguments: { approval_id: failedId, approval_nonce: failureCard._meta.approval_nonce },
  });
  assert.equal(readFailedApproval.structuredContent.action_failed, true);
  assert.equal(readFailedApproval.structuredContent.state, 'consumed');
});

test('passive upstream diagnostics record transitions, safe failure codes and process evidence', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmg-diagnostics-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = Date.parse('2026-11-02T00:00:00Z');
  const observations = [
    { state: 'up' }, { state: 'up' },
    { state: 'down', code: 'ECONNREFUSED' }, { state: 'down', code: 'ECONNREFUSED' },
    { state: 'up' },
  ];
  const diagnostics = new UpstreamDiagnostics({
    logDir: dir, upstreamUrl: 'http://127.0.0.1:12306',
    now: () => clock,
    probe: async () => observations.shift(),
    snapshot: async () => ({ edge_count: 1, edge_pids: [42], node_count: 1, node_pids: [43] }),
  });
  for (let index = 0; index < 5; index += 1) {
    await diagnostics.pollOnce();
    clock += 30_000;
  }
  const secret = 'https://example.test/private?code=secret-value';
  diagnostics.requestFailure('request', Object.assign(new Error(secret), { code: 'ECONNRESET' }));
  diagnostics.requestFailure('initialize', new Error(secret), 503);
  const text = fs.readFileSync(path.join(dir, 'bmg-upstream-diagnostics.jsonl'), 'utf8');
  const events = text.trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map((event) => event.event), [
    'upstream_state_changed', 'upstream_state_changed', 'upstream_state_changed',
    'upstream_request_failed', 'upstream_request_failed',
  ]);
  assert.deepEqual(events.slice(0, 3).map((event) => event.state), ['up', 'down', 'up']);
  assert.equal(events[1].tcp_error, 'ECONNREFUSED');
  assert.equal(events[1].previous_duration_ms, 60_000);
  assert.deepEqual(events[1].processes.edge_pids, [42]);
  assert.equal(events[3].code, 'ECONNRESET');
  assert.equal(events[4].http_status, 503);
  assert.doesNotMatch(text, /secret-value|example\.test|private/u);
});

test('upstream TCP probe detects local listener availability without HTTP requests', async () => {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const target = { host: '127.0.0.1', port: server.address().port };
  assert.equal((await probeTcpPort(target)).state, 'up');
  await new Promise((resolve) => server.close(resolve));
  const missing = await probeTcpPort(target);
  assert.equal(missing.state, 'down');
  assert.equal(missing.code, 'ECONNREFUSED');
});

test('bmgctl propagates nested MCP tool failures', () => {
  assert.equal(toolCallFailed({ result: { isError: true } }), true);
  assert.equal(toolCallFailed({
    result: {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'success',
          data: { isError: true, content: [{ type: 'text', text: 'click failed' }] },
        }),
      }],
    },
  }), true);
  assert.equal(toolCallFailed({
    result: {
      content: [{
        type: 'text',
        text: JSON.stringify({ status: 'success', data: { isError: false } }),
      }],
    },
  }), false);
});

test('本机启动检查拒绝未授权请求并报告工作区未启用', async (t) => {
  const fixture = await createTestRuntime();
  t.after(async () => {
    await closeBmgServer(fixture.runtime);
    await fixture.fakeUpstream.close();
    fs.rmSync(fixture.rootDir, { recursive: true, force: true });
  });
  const requestPath = '/internal/ensure-workspace';
  const secretHeader = { 'x-bmg-local-secret': APPROVAL_SECRET };
  for (const options of [
    { method: 'POST' },
    { method: 'POST', headers: { 'x-bmg-local-secret': 'wrong' } },
    { method: 'GET', headers: secretHeader },
    { method: 'POST', headers: { ...secretHeader, origin: 'https://example.test' } },
    { method: 'OPTIONS', headers: secretHeader },
  ]) {
    const result = await requestJson(fixture.baseUrl, requestPath, options);
    assert.equal(result.response.status, 403);
  }
  const result = await requestJson(fixture.baseUrl, requestPath, { method: 'POST', headers: secretHeader });
  assert.equal(result.response.status, 409);
  assert.equal(fixture.fakeUpstream.calls.length, 0);
});

test('本机 tool-call 需要本机密钥并通过共享 MCP 会话执行', async (t) => {
  const fixture = await createTestRuntime();
  fixture.runtime.workspace.enabled = true;
  fixture.runtime.workspace.ensureWorkspace = async () => ({
    windowId: 101,
    tabId: 202,
    hwnd: 303,
    visible: false,
  });
  t.after(async () => {
    await closeBmgServer(fixture.runtime);
    await fixture.fakeUpstream.close();
    fs.rmSync(fixture.rootDir, { recursive: true, force: true });
  });
  const body = JSON.stringify({ name: 'safe_ping', arguments: {} });
  const denied = await requestJson(fixture.baseUrl, '/internal/tool-call', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  });
  assert.equal(denied.response.status, 403);
  const result = await requestJson(fixture.baseUrl, '/internal/tool-call', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-BMG-Local-Secret': APPROVAL_SECRET,
    },
    body,
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.json.success, true);
  assert.equal(result.json.name, 'safe_ping');
  assert.equal(result.json.result.content[0].text, 'pong from 12306');
  const upstreamCall = fixture.fakeUpstream.calls.find(
    (call) => call.payload?.method === 'tools/call',
  );
  assert.equal(upstreamCall.payload.params.name, 'safe_ping');

  const showRequests = [];
  fixture.runtime.workspace.showWorkspace = async (options) => {
    showRequests.push(options);
    return { visible: true, foreground: options?.activate === true };
  };
  for (const [args, foreground] of [[{}, false], [{ activate: true }, true]]) {
    const shown = await requestJson(fixture.baseUrl, '/internal/tool-call', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-BMG-Local-Secret': APPROVAL_SECRET,
      },
      body: JSON.stringify({ name: 'bmg_show_workspace', arguments: args }),
    });
    assert.equal(shown.response.status, 200);
    assert.equal(shown.json.result.visible, true);
    assert.equal(shown.json.result.foreground, foreground);
  }
  assert.deepEqual(showRequests, [{}, { activate: true }]);
});

test('启动检查初始化共享会话、合并并发请求并重建已关闭工作区', async (t) => {
  const fixture = await createTestRuntime({ initializeDelayMs: 20 });
  const router = fixture.runtime.workspace;
  router.enabled = true;
  let current = null;
  let created = 0;
  router.claimWindow = async (_nonce, marker) => ({ hwnd: 9000 + created, marker, visible: false });
  router.inspectWindow = async (hwnd, marker) => ({ hwnd, marker, visible: false });
  router.ensureWindowHidden = async (hwnd, marker) => ({ hwnd, marker, visible: false, hidden: true });
  router.callTool = async (name, args) => {
    if (name === 'get_windows_and_tabs') {
      return workspaceToolMessage({ windows: current ? [current] : [] });
    }
    assert.equal(name, 'chrome_navigate');
    assert.equal(args.newWindow, true);
    created += 1;
    current = { windowId: 1000 + created, tabs: [{ tabId: 2000 + created }] };
    return workspaceToolMessage(current);
  };
  t.after(async () => {
    await closeBmgServer(fixture.runtime);
    await fixture.fakeUpstream.close();
    fs.rmSync(fixture.rootDir, { recursive: true, force: true });
  });
  const check = () => requestJson(fixture.baseUrl, '/internal/ensure-workspace', {
    method: 'POST', headers: { 'x-bmg-local-secret': APPROVAL_SECRET },
  });
  const results = await Promise.all([check(), check()]);
  assert.ok(results.every((result) => result.response.status === 200));
  assert.equal(created, 1);
  assert.equal(fixture.fakeUpstream.calls.filter((call) => call.payload?.method === 'initialize').length, 1);
  assert.equal((await check()).json.workspace.windowId, 1001);
  assert.equal(created, 1);
  current = null;
  assert.equal((await check()).json.workspace.windowId, 1002);
  assert.equal(created, 2);
  router.callTool = async () => { throw new Error('模拟扩展暂未连接'); };
  assert.equal((await check()).response.status, 503);
});

test('启动流程复用工作区，失败后仅检查一次 Edge 并按间隔重试', async () => {
  let edgeChecks = 0;
  const waits = [];
  await prepareWorkspace({
    request: async () => ({ ok: true }),
    ensureEdge: async () => { edgeChecks += 1; },
    wait: async (delay) => { waits.push(delay); },
  });
  assert.equal(edgeChecks, 0);
  assert.deepEqual(waits, []);
  let attempt = 0;
  await prepareWorkspace({
    request: async () => ({ ok: ++attempt === 4, status: 503 }),
    ensureEdge: async () => { edgeChecks += 1; },
    wait: async (delay) => { waits.push(delay); },
  });
  assert.equal(edgeChecks, 1);
  assert.deepEqual(waits, [10000, 20000, 40000]);
});

test('启动流程遇到配置错误立即失败，扩展持续离线时有限重试', async () => {
  for (const status of [403, 404, 409]) {
    await assert.rejects(prepareWorkspace({
      request: async () => ({ ok: false, status }),
      ensureEdge: async () => assert.fail('配置错误不得启动 Edge'),
      wait: async () => assert.fail('配置错误不得重试'),
    }), /本机检查入口不可用/u);
  }
  let attempts = 0;
  await assert.rejects(prepareWorkspace({
    request: async () => { attempts += 1; return { ok: false, status: 503 }; },
    ensureEdge: async () => {}, wait: async () => {},
  }), /工作区启动失败/u);
  assert.equal(attempts, 4);
});

test('Windows startup recovery launches an owned bootstrap even when Edge already exists', {
  skip: process.platform !== 'win32',
}, () => {
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  execFileSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.resolve('tests/edge-startup.test.ps1')], { windowsHide: true, timeout: 15000 });
});

function readTextFile(relativePath) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

function requestJson(baseUrl, requestPath, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(requestPath, baseUrl);
    const request = http.request(target, {
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (incoming) => {
      const chunks = [];
      incoming.on('data', (chunk) => chunks.push(chunk));
      incoming.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {}
        const response = {
          status: incoming.statusCode || 0,
          headers: {
            get(name) {
              const value = incoming.headers[String(name).toLowerCase()];
              if (Array.isArray(value)) return value.join(', ');
              return value ?? null;
            },
          },
        };
        resolve({ response, text, json });
      });
      incoming.on('error', reject);
    });
    request.on('error', reject);
    if (options.body !== undefined && options.body !== null) request.write(options.body);
    request.end();
  });
}

function parseSse(text) {
  const dataLine = text
    .split(/\r?\n/u)
    .find((line) => line.startsWith('data:'));
  assert.ok(dataLine, 'SSE response must contain a data line');
  return JSON.parse(dataLine.slice('data:'.length).trim());
}

function collectRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

async function createFakeUpstream({ initializeDelayMs = 0, includeFailureTool = false } = {}) {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    const body = await collectRequestBody(request);
    let payload = null;
    try {
      payload = body ? JSON.parse(body) : null;
    } catch {}
    calls.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization || null,
      sessionId: request.headers['mcp-session-id'] || null,
      payload,
    });
    if (request.url === '/mcp' && request.method === 'DELETE') {
      response.statusCode = 204;
      response.end();
      return;
    }
    if (request.url !== '/mcp' || request.method !== 'POST') {
      response.statusCode = 404;
      response.end();
      return;
    }
    const method = payload && payload.method;
    let result;
    if (method === 'initialize') {
      if (initializeDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, initializeDelayMs));
      }
      result = {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-upstream', version: '1.0.0' },
      };
    } else if (method === 'tools/list') {
      result = {
        tools: [
          {
            name: 'safe_ping',
            description: 'A no-side-effect test tool',
            inputSchema: { type: 'object', properties: {} },
          },
          ...(includeFailureTool ? [{
            name: 'safe_fail', description: 'A test tool that returns a tool error',
            inputSchema: { type: 'object', properties: {} },
          }] : []),
        ],
      };
    } else if (method === 'tools/call' && payload.params?.name === 'safe_ping') {
      result = {
        content: [{ type: 'text', text: 'pong from 12306' }],
        isError: false,
      };
    } else if (includeFailureTool && method === 'tools/call' && payload.params?.name === 'safe_fail') {
      result = {
        content: [{ type: 'text', text: 'private-content-must-not-be-logged' }],
        isError: true,
      };
    } else {
      response.statusCode = 400;
      response.end();
      return;
    }
    response.statusCode = 200;
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('Mcp-Session-Id', 'fake-upstream-session');
    response.end(
      'event: message\n' +
        'data: ' +
        JSON.stringify({ jsonrpc: '2.0', id: payload.id, result }) +
        '\n\n',
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    calls,
    url: 'http://127.0.0.1:' + address.port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function createTestRuntime(options = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmg-sidecar-test-'));
  const fakeUpstream = await createFakeUpstream(options);
  fs.mkdirSync(path.join(rootDir, 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, 'config', 'approval-policy.json'),
    JSON.stringify({ version: 1, mode: options.approvalMode || 'off', revision: 0 }),
  );
  const config = createConfig({
    rootDir,
    readEnvFile: false,
    allowEphemeral: true,
    port: 0,
    issuer: ISSUER,
    resource: RESOURCE,
    approvalSecret: APPROVAL_SECRET,
    stateFile: path.join(rootDir, 'state', 'oauth.json'),
    approvalSecretFile: path.join(rootDir, 'state', 'approval-secret.txt'),
    logDir: path.join(rootDir, 'logs'),
  });
  const runtime = createBmgServer({
    config,
    upstreamUrl: fakeUpstream.url,
    registrationRateLimit: options.registrationRateLimit,
    registrationRateWindowMs: options.registrationRateWindowMs,
    workspaceRecoverBrowser: null,
    totpManager: options.totpManager,
    logger: { error() {}, log() {} },
  });
  await listenBmgServer(runtime);
  const address = runtime.server.address();
  return {
    runtime,
    fakeUpstream,
    baseUrl: 'http://127.0.0.1:' + address.port,
    rootDir,
  };
}

test('BMG fixed web unlock HTTP route pairs with mock OTP, rejects missing cookies, issues and claims once', async (t) => {
  let codeUsed = false;
  const fixture = await createTestRuntime({
    approvalMode: 'either',
    totpManager: {
      verify(code) {
        if (code !== '654321' || codeUsed) return false;
        codeUsed = true;
        return true;
      },
    },
  });
  t.after(async () => {
    await closeBmgServer(fixture.runtime);
    await fixture.fakeUpstream.close();
    fs.rmSync(fixture.rootDir, { recursive: true, force: true });
  });
  const url = fixture.baseUrl + '/bmg/unlock';
  const cookies = new Map();
  const absorb = (response) => {
    for (const item of response.headers.getSetCookie()) {
      const first = item.split(';')[0];
      const equal = first.indexOf('=');
      cookies.set(first.slice(0, equal), first.slice(equal + 1));
    }
  };
  const cookieHeader = () => [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  const csrfFrom = (html) => html.match(/name="csrf" value="([^"]+)"/)?.[1];
  const getPage = async () => {
    const response = await fetch(url, { headers: { Cookie: cookieHeader() } });
    absorb(response);
    return { response, html: await response.text() };
  };
  const postForm = async (fields, { cookiesEnabled = true } = {}) => {
    const response = await fetch(url, {
      method: 'POST', redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'null', 'Sec-Fetch-Site': 'cross-site',
        ...(cookiesEnabled ? { Cookie: cookieHeader() } : {}),
      },
      body: new URLSearchParams(fields).toString(),
    });
    absorb(response);
    return response;
  };
  let page = await getPage();
  assert.equal(page.response.status, 200);
  assert.match(page.response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(page.response.headers.get('cache-control'), /no-store/);
  assert.match(page.html, /BMG 临时解锁/);
  const initialCsrf = csrfFrom(page.html);
  assert.ok(initialCsrf);
  assert.equal((await postForm({ csrf: initialCsrf, action: 'pair', code: '654321' }, {
    cookiesEnabled: false,
  })).status, 403);
  assert.equal(codeUsed, false, 'missing CSRF cookie cannot redeem OTP');
  let response = await postForm({ csrf: initialCsrf, action: 'pair', code: '654321' });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/bmg/unlock?paired=1');
  assert.equal(codeUsed, true);
  assert.equal(fixture.runtime.approval.grants.snapshot().grant_count, 0, 'pairing is not unlocking');
  const browserState = fs.readFileSync(path.join(fixture.rootDir, '.state', 'bmg-web-browsers.json'), 'utf8');
  assert.ok(!browserState.includes(cookies.get('__Secure-bmg-web-pair')), 'only pairing token hash is persisted');
  page = await getPage();
  assert.doesNotMatch(page.html, /name="code"/);
  response = await postForm({ csrf: csrfFrom(page.html), action: 'unlock', duration_seconds: '300' });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/bmg/unlock?issued=1');
  assert.equal(fixture.runtime.approval.grants.snapshot().grant_count, 1);
  const claim = await fixture.runtime.approval.handleLocal('bmg_claim_web_unlock', {}, null);
  assert.equal(claim.structuredContent.classification, 'web_unlock_claimed');
  const id = claim.structuredContent.approval_id;
  assert.equal(fixture.runtime.approval.authorize('chrome_read_page', { approval_id: id }).allowed, true);
  const repeated = await fixture.runtime.approval.handleLocal('bmg_claim_web_unlock', {}, null);
  assert.equal(repeated.isError, true, 'one web grant may be claimed only once');
  assert.equal(fixture.runtime.approval.grants.active(id)?.grant_state, 'active');
  fs.writeFileSync(path.join(fixture.rootDir, 'config', 'approval-policy.json'), JSON.stringify({
    version: 1, mode: 'either', revision: 1,
  }));
  assert.equal(fixture.runtime.approval.authorize('chrome_read_page', { approval_id: id }).allowed, false);
  page = await getPage();
  assert.match(page.html, /name="code"/, 'policy revision forces browser re-pair');
  assert.equal((await fetch(url + '/other')).status, 404, 'no wildcard public unlock routes');
});

test('BMG identity and discovery expose the exact public metadata', async (t) => {
  const fixture = await createTestRuntime();
  t.after(async () => {
    await closeBmgServer(fixture.runtime);
    await fixture.fakeUpstream.close();
    fs.rmSync(fixture.rootDir, { recursive: true, force: true });
  });

  const health = await requestJson(fixture.baseUrl, '/health');
  assert.equal(health.response.status, 200);
  assert.equal(health.json.issuer, ISSUER);
  assert.equal(health.json.resource, RESOURCE);
  assert.equal(health.json.upstream, 'http://127.0.0.1:12306');

  const authorizationPaths = [
    '/.well-known/oauth-authorization-server/bmg',
    '/bmg/.well-known/oauth-authorization-server',
  ];
  for (const discoveryPath of authorizationPaths) {
    const result = await requestJson(fixture.baseUrl, discoveryPath);
    assert.equal(result.response.status, 200);
    assert.equal(result.json.issuer, ISSUER);
    assert.equal(result.json.authorization_endpoint, ISSUER + '/authorize');
    assert.equal(result.json.token_endpoint, ISSUER + '/token');
    assert.equal(result.json.registration_endpoint, ISSUER + '/register');
    assert.equal(result.json.revocation_endpoint, ISSUER + '/revoke');
    assert.deepEqual(result.json.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(result.json.grant_types_supported, ['authorization_code', 'refresh_token']);
  }

  const resourcePaths = [
    '/.well-known/oauth-protected-resource/bmg/mcp',
    '/bmg/mcp/.well-known/oauth-protected-resource',
  ];
  for (const discoveryPath of resourcePaths) {
    const result = await requestJson(fixture.baseUrl, discoveryPath);
    assert.equal(result.response.status, 200);
    assert.equal(result.json.resource, RESOURCE);
    assert.deepEqual(result.json.authorization_servers, [ISSUER]);
    assert.deepEqual(result.json.bearer_methods_supported, ['header']);
  }

  const unauthorized = await requestJson(fixture.baseUrl, '/bmg/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  assert.equal(unauthorized.response.status, 401);
  assert.ok(
    unauthorized.response.headers
      .get('www-authenticate')
      .includes('resource_metadata="' + PROTECTED_METADATA + '"'),
  );
});

test('OAuth registration, PKCE, bearer proxy, and revocation work end to end', async (t) => {
  const fixture = await createTestRuntime();
  t.after(async () => {
    await closeBmgServer(fixture.runtime);
    await fixture.fakeUpstream.close();
    fs.rmSync(fixture.rootDir, { recursive: true, force: true });
  });

  const redirectUri = 'http://127.0.0.1:19001/oauth/callback';
  const registration = await requestJson(fixture.baseUrl, '/bmg/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'BMG test client',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  assert.equal(registration.response.status, 201);
  assert.ok(registration.json.client_id);
  assert.equal(registration.json.token_endpoint_auth_method, 'none');
  const clientId = registration.json.client_id;

  const verifier = randomBytes(32).toString('base64url');
  const challenge = createPkceChallenge(verifier);
  const authorizationQuery = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: RESOURCE,
    scope: 'mcp',
    state: 'state-from-test',
  });
  const authorization = await requestJson(
    fixture.baseUrl,
    '/bmg/authorize?' + authorizationQuery.toString(),
  );
  assert.equal(authorization.response.status, 302);
  const consentLocation = new URL(authorization.response.headers.get('location'));
  assert.equal(consentLocation.pathname, '/bmg/oauth/consent');
  assert.equal(consentLocation.searchParams.get('code_challenge'), challenge);

  const consentPage = await requestJson(
    fixture.baseUrl,
    consentLocation.pathname + consentLocation.search,
  );
  assert.equal(consentPage.response.status, 200);
  assert.match(consentPage.text, /Approval secret/u);
  assert.equal(consentPage.text.includes(APPROVAL_SECRET), false);

  const consentForm = new URLSearchParams(consentLocation.search);
  consentForm.set('approval_secret', APPROVAL_SECRET);
  const consent = await requestJson(fixture.baseUrl, '/bmg/oauth/consent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: consentForm.toString(),
  });
  assert.equal(consent.response.status, 302);
  const callbackLocation = new URL(consent.response.headers.get('location'));
  assert.equal(callbackLocation.searchParams.get('state'), 'state-from-test');
  const authorizationCode = callbackLocation.searchParams.get('code');
  assert.ok(authorizationCode);

  const tokenForm = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    code: authorizationCode,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    resource: RESOURCE,
  });
  const token = await requestJson(fixture.baseUrl, '/bmg/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenForm.toString(),
  });
  assert.equal(token.response.status, 200);
  assert.equal(token.json.token_type, 'Bearer');
  assert.equal(token.json.resource, RESOURCE);
  assert.ok(token.json.access_token);
  assert.ok(token.json.refresh_token);
  const initialAccessToken = token.json.access_token;
  const initialRefreshToken = token.json.refresh_token;

  const refresh = await requestJson(fixture.baseUrl, '/bmg/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: initialRefreshToken,
      resource: RESOURCE,
    }).toString(),
  });
  assert.equal(refresh.response.status, 200);
  assert.ok(refresh.json.access_token);
  assert.ok(refresh.json.refresh_token);
  assert.notEqual(refresh.json.access_token, initialAccessToken);
  assert.notEqual(refresh.json.refresh_token, initialRefreshToken);
  const accessToken = refresh.json.access_token;
  const refreshToken = refresh.json.refresh_token;

  const replay = await requestJson(fixture.baseUrl, '/bmg/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: initialRefreshToken,
      resource: RESOURCE,
    }).toString(),
  });
  assert.equal(replay.response.status, 400);
  assert.equal(replay.json.error, 'invalid_grant');

  const initialize = await requestJson(fixture.baseUrl, '/bmg/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      },
    }),
  });
  assert.equal(initialize.response.status, 200);
  assert.match(initialize.response.headers.get('content-type'), /text\/event-stream/u);
  assert.equal(parseSse(initialize.text).result.serverInfo.name, 'fake-upstream');
  const sessionId = initialize.response.headers.get('mcp-session-id');
  assert.equal(sessionId, 'fake-upstream-session');

  const sseController = new AbortController();
  const sseProbe = await fetch(fixture.baseUrl + '/bmg/mcp', {
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Mcp-Session-Id': sessionId,
      Accept: 'text/event-stream',
    },
    signal: sseController.signal,
  });
  assert.equal(sseProbe.status, 200);
  assert.match(sseProbe.headers.get('content-type'), /text\/event-stream/u);
  assert.equal(sseProbe.headers.get('mcp-session-id'), sessionId);
  sseController.abort();

  const repeatedInitialize = await requestJson(fixture.baseUrl, '/bmg/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 10,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'second-client', version: '1' },
      },
    }),
  });
  assert.equal(repeatedInitialize.response.status, 200);
  assert.equal(repeatedInitialize.response.headers.get('mcp-session-id'), sessionId);
  assert.equal(parseSse(repeatedInitialize.text).id, 10);
  assert.equal(
    fixture.fakeUpstream.calls.filter((call) => call.payload?.method === 'initialize').length,
    1,
  );

  const tools = await requestJson(fixture.baseUrl, '/bmg/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Mcp-Session-Id': sessionId,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });
  assert.equal(tools.response.status, 200);
  assert.deepEqual(parseSse(tools.text).result.tools.map((tool) => tool.name), [
    'safe_ping', 'bmg_claim_web_unlock', 'bmg_unlock', 'approval_status', 'get_approval_status',
    'request_approval', 'resolve_pending_action',
  ]);

  const safeCall = await requestJson(fixture.baseUrl, '/bmg/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Mcp-Session-Id': sessionId,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'safe_ping', arguments: {} },
    }),
  });
  assert.equal(safeCall.response.status, 200);
  assert.equal(parseSse(safeCall.text).result.content[0].text, 'pong from 12306');
  assert.equal(safeCall.response.headers.get('transfer-encoding'), null);
  assert.equal(safeCall.response.headers.get('content-length'), String(Buffer.byteLength(safeCall.text)));
  assert.equal(fixture.fakeUpstream.calls.every((call) => call.authorization === null), true);

  const downstreamDelete = await requestJson(fixture.baseUrl, '/bmg/mcp', {
    method: 'DELETE',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Mcp-Session-Id': sessionId,
    },
  });
  assert.equal(downstreamDelete.response.status, 204);
  assert.equal(fixture.fakeUpstream.calls.filter((call) => call.method === 'DELETE').length, 0);

  const stateText = fs.readFileSync(path.join(fixture.rootDir, 'state', 'oauth.json'), 'utf8');
  for (const secret of [initialAccessToken, initialRefreshToken, accessToken, refreshToken]) {
    assert.equal(stateText.includes(secret), false);
  }
  assert.equal(stateText.includes(APPROVAL_SECRET), false);

  const revoke = await requestJson(fixture.baseUrl, '/bmg/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: refreshToken }).toString(),
  });
  assert.equal(revoke.response.status, 200);
  const callCountBeforeRevokedRequest = fixture.fakeUpstream.calls.length;
  const revoked = await requestJson(fixture.baseUrl, '/bmg/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }),
  });
  assert.equal(revoked.response.status, 401);
  assert.equal(fixture.fakeUpstream.calls.length, callCountBeforeRevokedRequest);

  const revokedRefresh = await requestJson(fixture.baseUrl, '/bmg/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refreshToken,
      resource: RESOURCE,
    }).toString(),
  });
  assert.equal(revokedRefresh.response.status, 400);
  assert.equal(revokedRefresh.json.error, 'invalid_grant');

  await closeBmgServer(fixture.runtime);
  const upstreamDeletes = fixture.fakeUpstream.calls.filter((call) => call.method === 'DELETE');
  assert.equal(upstreamDeletes.length, 0);
});

test('dynamic client registration is rate limited before state can grow quickly', async (t) => {
  const fixture = await createTestRuntime({ registrationRateLimit: 2, registrationRateWindowMs: 60_000 });
  t.after(async () => {
    await closeBmgServer(fixture.runtime);
    await fixture.fakeUpstream.close();
    fs.rmSync(fixture.rootDir, { recursive: true, force: true });
  });

  const register = (suffix) => requestJson(fixture.baseUrl, '/bmg/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [`https://client-${suffix}.example/callback`],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });

  assert.equal((await register('one')).response.status, 201);
  assert.equal((await register('two')).response.status, 201);
  const blocked = await register('three');
  assert.equal(blocked.response.status, 429);
  assert.equal(blocked.json.error, 'temporarily_unavailable');
  assert.ok(Number(blocked.response.headers.get('retry-after')) >= 1);
  const state = JSON.parse(fs.readFileSync(path.join(fixture.rootDir, 'state', 'oauth.json'), 'utf8'));
  assert.equal(Object.keys(state.clients).length, 2);
});

test('client cap preserves active clients and evicts only stale unreferenced clients', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmg-client-cap-test-'));
  let now = 0;
  try {
    const store = new OAuthStore(path.join(rootDir, 'oauth.json'), () => now, {
      maxClients: 2,
      staleClientRetentionMs: 1000,
    });
    const register = (name) => store.registerClient({
      redirect_uris: [`https://${name}.example/callback`],
      grant_types: ['authorization_code'],
      response_types: ['code'],
    });
    assert.throws(
      () => store.registerClient({
        redirect_uris: Array.from({ length: 17 }, (_, index) => `https://too-many-${index}.example/callback`),
      }),
      /cannot contain more than 16 URIs/u,
    );
    const active = register('active');
    store.createAuthorizationCode({
      clientId: active.clientId,
      redirectUri: active.redirectUris[0],
      codeChallenge: 'a'.repeat(43),
      codeChallengeMethod: 'S256',
      resource: RESOURCE,
      scope: 'mcp',
    });
    const stale = register('stale');
    let capacityError = null;
    try { register('blocked'); } catch (error) { capacityError = error; }
    assert.equal(capacityError?.status, 503);
    assert.equal(capacityError?.code, 'temporarily_unavailable');

    now = 2000;
    const replacement = register('replacement');
    assert.ok(store.getClient(active.clientId));
    assert.equal(store.getClient(stale.clientId), null);
    assert.ok(store.getClient(replacement.clientId));
    assert.equal(Object.keys(store.state.clients).length, 2);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('legacy OAuth v1 state loads without refresh token records', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmg-oauth-migration-test-'));
  try {
    const stateFile = path.join(rootDir, 'oauth.json');
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        version: 1,
        clients: {
          legacy_client: {
            clientId: 'legacy_client',
            clientName: 'ChatGPT',
            redirectUris: ['https://chatgpt.com/connector/oauth/example'],
            grantTypes: ['authorization_code'],
            responseTypes: ['code'],
            tokenEndpointAuthMethod: 'none',
            createdAt: 1,
          },
        },
        authorizationCodes: {},
        accessTokens: {},
      }),
      'utf8',
    );
    const store = new OAuthStore(stateFile, () => 1000);
    assert.equal(store.getClient('legacy_client').clientName, 'ChatGPT');
    assert.deepEqual(store.state.refreshTokens, {});
    store.save();
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')).refreshTokens, {});
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('concurrent initialize requests share one upstream session', async (t) => {
  const fixture = await createTestRuntime({ initializeDelayMs: 40 });
  t.after(async () => {
    await closeBmgServer(fixture.runtime);
    await fixture.fakeUpstream.close();
    fs.rmSync(fixture.rootDir, { recursive: true, force: true });
  });

  const headers = { 'Content-Type': 'application/json' };
  const payloads = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'a', version: '1' } },
    },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'b', version: '1' } },
    },
  ];
  const initialized = await Promise.all(
    payloads.map((payload) => fixture.runtime.upstreamSession.initializeFromRequest(headers, payload)),
  );
  assert.equal(initialized[0].sessionId, 'fake-upstream-session');
  assert.equal(initialized[1].sessionId, 'fake-upstream-session');
  assert.equal(
    fixture.fakeUpstream.calls.filter((call) => call.payload?.method === 'initialize').length,
    1,
  );
});

test('sidecar restart reuses the persisted upstream session', async (t) => {
  const fixture = await createTestRuntime();
  let restartedRuntime = null;
  t.after(async () => {
    if (restartedRuntime) {
      await closeBmgServer(restartedRuntime);
    }
    await closeBmgServer(fixture.runtime);
    await fixture.fakeUpstream.close();
    fs.rmSync(fixture.rootDir, { recursive: true, force: true });
  });

  const headers = {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
  };
  const payload = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'restart-test', version: '1' },
    },
  };
  const initialized = await fixture.runtime.upstreamSession.initializeFromRequest(headers, payload);
  assert.equal(initialized.sessionId, 'fake-upstream-session');
  assert.equal(fs.existsSync(fixture.runtime.config.upstreamSessionFile), true);

  await closeBmgServer(fixture.runtime);
  restartedRuntime = createBmgServer({
    config: fixture.runtime.config,
    upstreamUrl: fixture.fakeUpstream.url,
    logger: { error() {}, log() {} },
  });
  await listenBmgServer(restartedRuntime);

  const restored = await restartedRuntime.upstreamSession.ensureSession();
  assert.equal(restored.sessionId, initialized.sessionId);
  const toolsResponse = await restartedRuntime.upstreamSession.request(
    headers,
    new URL('/bmg/mcp', 'http://127.0.0.1'),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  );
  assert.equal(toolsResponse.statusCode, 200);
  assert.deepEqual(
    parseSse(toolsResponse.body.toString('utf8')).result.tools.map((tool) => tool.name),
    ['safe_ping'],
  );
  assert.equal(
    fixture.fakeUpstream.calls.filter((call) => call.payload?.method === 'initialize').length,
    1,
  );
  await closeBmgServer(restartedRuntime);
  assert.equal(fixture.fakeUpstream.calls.filter((call) => call.method === 'DELETE').length, 0);
});

test('Funnel ownership and lifecycle scripts stay narrowly scoped', () => {
  const configure = readTextFile('scripts/configure-funnel.ps1');
  const disable = readTextFile('scripts/disable-funnel.ps1');
  const stop = readTextFile('scripts/stop.ps1');
  const common = readTextFile('scripts/bmg-common.ps1');
  const installAutostart = readTextFile('scripts/install-autostart.ps1');
  const uninstallAutostart = readTextFile('scripts/uninstall-autostart.ps1');
  const paths = [
    '/bmg/mcp',
    '/bmg/authorize',
    '/bmg/token',
    '/bmg/register',
    '/bmg/revoke',
    '/bmg/oauth/consent',
    '/.well-known/oauth-authorization-server/bmg',
    '/.well-known/oauth-protected-resource/bmg/mcp',
    '/bmg/.well-known/oauth-authorization-server',
    '/bmg/mcp/.well-known/oauth-protected-resource',
  ];
  for (const route of paths) {
    assert.equal(configure.includes('"' + route + '"'), true);
    assert.equal(disable.includes('"' + route + '"'), true);
  }
  for (const script of [configure, disable]) {
    assert.doesNotMatch(script, /funnel\s+reset/iu);
    assert.doesNotMatch(script, /--https=443\s+off/iu);
    assert.doesNotMatch(script, /--set-path=\/[\s"']/u);
    assert.doesNotMatch(script, /\/cam|\/v1|8443/iu);
  }
  assert.match(configure, /if \(-not \$Apply\)/u);
  assert.match(disable, /if \(-not \$Apply\)/u);
  assert.match(stop, /Get-BmgLoopbackListenerPid/u);
  assert.match(stop, /Get-BmgHealth/u);
  assert.match(common, /curl\.exe/u);
  assert.doesNotMatch(common, /Invoke-WebRequest/u);
  assert.match(stop, /Stop-Process -Id \$listenerPid/u);
  assert.doesNotMatch(stop, /Stop-Process\s+-Name/iu);
  assert.doesNotMatch(stop, /taskkill/iu);
  assert.doesNotMatch(stop, /node\.exe|msedge\.exe/iu);
  assert.match(installAutostart, /New-ScheduledTaskTrigger\s+-AtLogOn/iu);
  assert.match(installAutostart, /Register-ScheduledTask/iu);
  assert.match(installAutostart, /RestartCount\s+3/iu);
  assert.match(installAutostart, /start\.ps1/iu);
  assert.doesNotMatch(installAutostart, /tailscale|funnel|RunAs|12306|msedge/iu);
  assert.match(uninstallAutostart, /Unregister-ScheduledTask/iu);
  assert.match(uninstallAutostart, /BMG Sidecar\.lnk/u);
  assert.doesNotMatch(uninstallAutostart, /tailscale|funnel|Stop-Process|taskkill/iu);
});

test('configuration rejects reserved ports and keeps the production upstream fixed', () => {
  const defaults = createConfig({ readEnvFile: false, issuer: ISSUER, resource: RESOURCE });
  assert.equal(defaults.port, 18007);
  assert.equal(defaults.workspaceIdleTimeoutSeconds, 28800);
  assert.equal(
    createConfig({
      readEnvFile: false,
      issuer: ISSUER,
      resource: RESOURCE,
      workspaceIdleTimeoutSeconds: 0,
    }).workspaceIdleTimeoutSeconds,
    0,
  );
  assert.throws(
    () =>
      createConfig({
        readEnvFile: false,
        issuer: ISSUER,
        resource: RESOURCE,
        port: 12306,
      }),
    /reserved/u,
  );
  assert.throws(
    () =>
      createConfig({
        readEnvFile: false,
        issuer: ISSUER,
        resource: RESOURCE,
        upstreamUrl: 'http://127.0.0.1:9999',
      }),
    /12306/u,
  );
  assert.equal(
    createPkceChallenge('a'.repeat(43)),
    createHash('sha256').update('a'.repeat(43), 'ascii').digest('base64url'),
  );
});


test('extension web-content patch is deterministic and wired into setup', () => {
  const backgroundFixture = `prefix
  class WebFetcherTool extends BaseBrowserToolExecutor {
const htmlResponse = yield this.sendMessageToTab(tab.id, {
              action: TOOL_MESSAGE_TYPES.WEB_FETCHER_GET_HTML_CONTENT,
              selector
            });
const textResponse = yield this.sendMessageToTab(tab.id, {
              action: TOOL_MESSAGE_TYPES.WEB_FETCHER_GET_TEXT_CONTENT,
              selector
            });
        const { textQuery, selector, includeCoordinates = true, types } = args;
          const tabs = yield chrome.tabs.query({ active: true, currentWindow: true });
          if (!tabs[0]) {
            return createErrorResponse("No active tab found");
          }
          const tab = tabs[0];
            const newWindow2 = yield chrome.windows.create({
              url,
              width: typeof width === "number" ? width : DEFAULT_WINDOW_WIDTH,
              height: typeof height === "number" ? height : DEFAULT_WINDOW_HEIGHT,
              focused: background2 === true ? false : true
            });
                const hostNoWww = u.host.replace(/^www\\./, "");
                const hostWithWww = hostNoWww.startsWith("www.") ? hostNoWww : \`www.\${hostNoWww}\`;
                patterns2.add(\`\${u.protocol}//\${u.host}\${pathWildcard}\`);
                patterns2.add(\`\${u.protocol}//\${hostNoWww}\${pathWildcard}\`);
                patterns2.add(\`\${u.protocol}//\${hostWithWww}\${pathWildcard}\`);
                const altProtocol = u.protocol === "https:" ? "http:" : "https:";
                patterns2.add(\`\${altProtocol}//\${u.host}\${pathWildcard}\`);
                patterns2.add(\`\${altProtocol}//\${hostNoWww}\${pathWildcard}\`);
                patterns2.add(\`\${altProtocol}//\${hostWithWww}\${pathWildcard}\`);
  class ComputerTool extends BaseBrowserToolExecutor {
    demo() {
      yield clickTool.execute({
        ref: one,
      });
      yield clickTool.execute({
        selector: two,
      });
            const coord = project(params.coordinates);
            const domResult = yield clickTool.execute({
              coordinates: coord,
              waitForNavigation: false,
              timeout: TIMEOUTS.DEFAULT_WAIT * 5,
              button: params.action === "right_click" ? "right" : "left",
              modifiers: params.modifiers
            });
            if (!domResult.isError) {
              return domResult;
            }
            try {
            }
      yield clickTool.execute({
        ref: four,
      });
      yield clickTool.execute({
        ref: five,
      });
      yield fillTool.execute({
        ref: six,
      });
      yield fillTool.execute({
        ref: seven,
      });
      yield keyboardTool.execute({
        keys: eight,
      });
      yield keyboardTool.execute({ keys: repeatedKeys });
    }
  }
  const computerTool = new ComputerTool();
suffix`;
  const first = patchWebContentBackgroundText(backgroundFixture);
  assert.equal(first.changed, true);
  assert.match(first.text, /BMG_WEB_CONTENT_FALLBACK_V1/u);
  assert.match(first.text, /BMG_INTERACTIVE_WORKSPACE_TARGET_V1/u);
  assert.match(first.text, /BMG_NATURAL_NEW_WINDOW_GEOMETRY_V1/u);
  assert.match(first.text, /BMG_COMPUTER_TARGET_TAB_V1/u);
  assert.match(first.text, /BMG_COMPUTER_COORDINATE_CDP_V1/u);
  assert.match(first.text, /chrome\.windows\.create\(createWindowOptions\)/u);
  assert.doesNotMatch(first.text, /width: typeof width === "number" \? width : DEFAULT_WINDOW_WIDTH/u);
  assert.match(first.text, /webContentMessageWithFallback/u);
  const second = patchWebContentBackgroundText(first.text);
  assert.equal(second.changed, false);
  assert.equal(second.text, first.text);

  const helper = "const pingActions = ['search_tabs_content_ping', 'chrome_web_fetcher_ping'];";
  const patchedHelper = patchWebContentHelperText(helper);
  assert.equal(patchedHelper.changed, true);
  assert.match(patchedHelper.text, /chrome_get_web_content_ping/u);
  assert.equal(patchWebContentHelperText(patchedHelper.text).changed, false);

  const setup = readTextFile('scripts/setup.ps1');
  assert.match(setup, /patch-extension-web-content\.mjs/u);
  assert.match(setup, /\$bridgeVersion = "1\.0\.31"/u);
  assert.match(setup, /patch-extension-upstream-tools\.mjs/u);
});

test('content CDP fallback patch is deterministic and wired into setup', () => {
  const background = readTextFile('extension/background.js');
  assert.match(background, /BMG_CDP_CONTENT_FALLBACK_V1/u);
  assert.match(background, /BMG_CDP_INTERACTION_FALLBACK_V1/u);
  assert.match(background, /bmgWebContentWithCdpFallback/u);
  assert.match(background, /bmgInteractiveWithCdpFallback/u);
  assert.match(background, /bmgCdpClickSelector/u);
  assert.match(background, /bmgCdpFillSelector/u);
  assert.match(background, /read page accessibility helper/u);
  assert.match(background, /Runtime\.evaluate/u);
  const second = patchContentCdpBackgroundText(background);
  assert.equal(second.changed, false);
  assert.equal(second.text, background);
  const setup = readTextFile('scripts/setup.ps1');
  assert.match(setup, /patch-extension-content-cdp\.mjs/u);
});

function workspaceToolMessage(data, isError = false) {
  return {
    jsonrpc: '2.0',
    id: 'workspace-test',
    result: {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      isError,
    },
  };
}

test('startup bootstrap window is claimed exactly once without creating a duplicate', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmg-workspace-startup-claim-test-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const stateFile = path.join(rootDir, 'workspace.json');
  const startupStateFile = path.join(rootDir, 'bmg-edge-bootstrap.json');
  fs.writeFileSync(
    startupStateFile,
    '\uFEFF' + JSON.stringify({
      version: 1,
      nonce: 'startup-owned',
      windowMarker: 9604,
      createdAtMs: 1000,
    }),
    'utf8',
  );
  const calls = [];
  const claims = [];
  const router = new BrowserWorkspaceRouter({
    enabled: true,
    stateFile,
    startupStateFile,
    bootstrapUrl: 'http://127.0.0.1:12307/workspace-bootstrap',
    clock: () => 1100,
    claimWindow: async (nonce, marker) => {
      claims.push({ nonce, marker });
      return {
        hwnd: 9603,
        marker,
        visible: false,
        processId: 9605,
        processStartTimeUtc: '2026-09-19T12:00:00.000Z',
      };
    },
    callTool: async (name) => {
      calls.push(name);
      assert.equal(name, 'get_windows_and_tabs');
      return workspaceToolMessage({
        windows: [
          { windowId: 9501, tabs: [{ tabId: 9502, url: 'https://user.example/' }] },
          {
            windowId: 9601,
            tabs: [{
              tabId: 9602,
              url: 'http://127.0.0.1:12307/workspace-bootstrap?nonce=startup-owned',
            }],
          },
        ],
      });
    },
  });
  const rewritten = await router.rewrite({
    method: 'tools/call',
    params: { name: 'chrome_get_web_content', arguments: { textContent: true } },
  });
  assert.deepEqual(calls, ['get_windows_and_tabs']);
  assert.deepEqual(claims, [{ nonce: 'startup-owned', marker: 9604 }]);
  assert.equal(rewritten.params.arguments.windowId, 9601);
  assert.equal(rewritten.params.arguments.tabId, 9602);
  assert.equal(fs.existsSync(startupStateFile), false);
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(saved.windowMarker, 9604);
  assert.equal(saved.processId, 9605);
});

test('expired startup claim grace preserves the orphan state for browser recovery', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmg-workspace-startup-orphan-test-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const stateFile = path.join(rootDir, 'workspace.json');
  const startupStateFile = path.join(rootDir, 'bmg-edge-bootstrap.json');
  fs.writeFileSync(
    startupStateFile,
    JSON.stringify({
      version: 1,
      nonce: 'startup-orphan',
      windowMarker: 9654,
      createdAtMs: 1000,
    }),
    'utf8',
  );
  const calls = [];
  const router = new BrowserWorkspaceRouter({
    enabled: true,
    stateFile,
    startupStateFile,
    bootstrapUrl: 'http://127.0.0.1:12307/workspace-bootstrap',
    clock: () => 32001,
    claimWindow: async () => assert.fail('stale bootstrap must not be replaced inside the router'),
    callTool: async (name) => {
      calls.push(name);
      if (name === 'get_windows_and_tabs') {
        return workspaceToolMessage({ windows: [] });
      }
      throw new Error('Unexpected internal tool call: ' + name);
    },
  });
  await assert.rejects(
    () => router.rewrite({
      method: 'tools/call',
      params: { name: 'chrome_get_web_content', arguments: { textContent: true } },
    }),
    /stale and must be retired before replacement/u,
  );
  assert.deepEqual(calls, ['get_windows_and_tabs']);
  assert.equal(fs.existsSync(startupStateFile), true);
  const pending = JSON.parse(fs.readFileSync(startupStateFile, 'utf8'));
  assert.equal(pending.nonce, 'startup-orphan');
  assert.equal(pending.windowMarker, 9654);
});

test('workspace request performs finite browser recovery and claims the recovered startup window', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmg-workspace-recovery-test-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const stateFile = path.join(rootDir, 'workspace.json');
  const startupStateFile = path.join(rootDir, 'bmg-edge-bootstrap.json');
  let recovered = false;
  let recoveryCalls = 0;
  const calls = [];
  const router = new BrowserWorkspaceRouter({
    enabled: true,
    stateFile,
    startupStateFile,
    bootstrapUrl: 'http://127.0.0.1:12307/workspace-bootstrap',
    clock: () => 5000,
    recoveryDelaysMs: [0],
    wait: async () => assert.fail('zero-delay recovery must not sleep'),
    recoverBrowser: async () => {
      recoveryCalls += 1;
      recovered = true;
      fs.writeFileSync(
        startupStateFile,
        JSON.stringify({
          version: 1,
          nonce: 'recovered-owned',
          windowMarker: 9704,
          createdAtMs: 5000,
        }),
        'utf8',
      );
    },
    claimWindow: async (nonce, marker) => {
      assert.equal(nonce, 'recovered-owned');
      assert.equal(marker, 9704);
      return { hwnd: 9703, marker, visible: false };
    },
    callTool: async (name) => {
      calls.push(name);
      if (!recovered) {
        assert.equal(name, 'chrome_navigate');
        throw new Error('synthetic extension offline');
      }
      assert.equal(name, 'get_windows_and_tabs');
      return workspaceToolMessage({
        windows: [{
          windowId: 9701,
          tabs: [{
            tabId: 9702,
            url: 'http://127.0.0.1:12307/workspace-bootstrap?nonce=recovered-owned',
          }],
        }],
      });
    },
  });
  const rewritten = await router.rewrite({
    method: 'tools/call',
    params: { name: 'chrome_screenshot', arguments: { fullPage: false } },
  });
  assert.equal(recoveryCalls, 1);
  assert.deepEqual(calls, ['chrome_navigate', 'get_windows_and_tabs']);
  assert.equal(rewritten.params.arguments.windowId, 9701);
  assert.equal(rewritten.params.arguments.tabId, 9702);
  assert.equal(rewritten.params.arguments.background, true);
  assert.equal(rewritten.params.arguments.savePng, false);
  assert.equal(rewritten.params.arguments.storeBase64, true);
});

test('workspace idle timeout keeps one hidden blank BMG tab', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmg-workspace-idle-test-'));
  let now = 0;
  let scheduledTimer = null;
  let workspaceSequence = 0;
  const closeCalls = [];
  const navigateCalls = [];
  const javascriptCalls = [];
  const hiddenHwnds = [];
  const setTimer = (fn, delay) => {
    const timer = { fn, delay, cancelled: false, unref() {} };
    scheduledTimer = timer;
    return timer;
  };
  const clearTimer = (timer) => {
    timer.cancelled = true;
    if (scheduledTimer === timer) scheduledTimer = null;
  };
  const router = new BrowserWorkspaceRouter({
    enabled: true,
    idleTimeoutMs: 1000,
    clock: () => now,
    setTimer,
    clearTimer,
    stateFile: path.join(rootDir, 'workspace.json'),
    bootstrapUrl: 'http://localhost:12307/workspace-bootstrap',
    logger: { error() {}, log() {} },
    claimWindow: async () => ({ hwnd: workspaceSequence === 1 ? 7003 : 7103 }),
    ensureWindowHidden: async (hwnd) => { hiddenHwnds.push(hwnd); return { hidden: true }; },
    callTool: async (name, args) => {
      if (name === 'chrome_navigate' && args.newWindow === true) {
        workspaceSequence += 1;
        const base = workspaceSequence === 1 ? 7000 : 7100;
        return workspaceToolMessage({ success: true, windowId: base + 1, tabs: [{ tabId: base + 2 }] });
      }
      if (name === 'chrome_navigate') {
        navigateCalls.push({ ...args });
        return workspaceToolMessage({ success: true, windowId: 7001, tabId: 7002 });
      }
      if (name === 'chrome_javascript') {
        javascriptCalls.push({ ...args });
        return workspaceToolMessage({ success: true, tabId: 7002, engine: 'cdp', result: 'scheduled' });
      }
      if (name === 'get_windows_and_tabs') {
        return workspaceToolMessage({
          windows: [
            { windowId: 7001, tabs: [{ tabId: 7002 }, { tabId: 7004 }, { tabId: 7005 }] },
            { windowId: 9901, tabs: [{ tabId: 9902 }, { tabId: 9903 }] },
          ],
        });
      }
      if (name === 'chrome_close_tabs') {
        closeCalls.push([...args.tabIds]);
        return workspaceToolMessage({ success: true, closedCount: args.tabIds.length });
      }
      throw new Error('Unexpected internal tool call: ' + name);
    },
  });
  t.after(async () => {
    await router.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  const first = await router.rewrite({
    method: 'tools/call',
    params: { name: 'chrome_get_web_content', arguments: { textContent: true } },
  });
  assert.equal(first.params.arguments.windowId, 7001);
  assert.equal(scheduledTimer.delay, 1000);
  const staleTimer = scheduledTimer;

  now = 900;
  await router.rewrite({ method: 'tools/call', params: { name: 'chrome_history', arguments: {} } });
  const refreshedTimer = scheduledTimer;
  assert.notEqual(refreshedTimer, staleTimer);
  assert.equal(refreshedTimer.delay, 1000);

  now = 1000;
  await staleTimer.fn();
  assert.deepEqual(closeCalls, []);

  now = 1900;
  await refreshedTimer.fn();
  assert.deepEqual(navigateCalls, []);
  assert.deepEqual(javascriptCalls, [{
    code: 'location.replace("about:blank"); return "scheduled";',
    tabId: 7002,
    timeoutMs: 5000,
  }]);
  assert.deepEqual(closeCalls, [[7004, 7005]]);
  assert.equal(closeCalls[0].includes(9902), false);
  assert.deepEqual(hiddenHwnds, [7003]);
  assert.equal(router.windowId, 7001);
  assert.equal(router.tabId, 7002);
  assert.equal(router.visible, false);
  assert.equal(scheduledTimer.delay, 1000);

  now = 1901;
  const fresh = await router.rewrite({
    method: 'tools/call',
    params: { name: 'chrome_get_web_content', arguments: { textContent: true } },
  });
  assert.equal(fresh.params.arguments.windowId, 7001);
  assert.equal(fresh.params.arguments.tabId, 7002);
});

test('workspace idle cleanup logs the failing stage and reschedules', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmg-workspace-idle-log-test-'));
  let now = 0;
  let scheduledTimer = null;
  const errors = [];
  const router = new BrowserWorkspaceRouter({
    enabled: true,
    idleTimeoutMs: 1000,
    clock: () => now,
    setTimer: (fn, delay) => {
      scheduledTimer = { fn, delay, unref() {} };
      return scheduledTimer;
    },
    clearTimer: () => {},
    stateFile: path.join(rootDir, 'workspace.json'),
    logger: { error(message) { errors.push(message); }, log() {} },
    callTool: async (name) => {
      if (name === 'get_windows_and_tabs') throw new Error('synthetic upstream outage');
      throw new Error('unexpected tool');
    },
  });
  t.after(async () => {
    await router.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
  router.windowId = 8001;
  router.tabId = 8002;
  router.lastActivityAt = 0;
  router.scheduleIdleCleanup();
  now = 1000;
  await scheduledTimer.fn();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /enumerate-windows: synthetic upstream outage/u);
  assert.match(errors[0], /retry after the timeout/u);
  assert.equal(scheduledTimer.delay, 1000);
});

test('workspace router creates one background window and pins page tools to it', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmg-workspace-test-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const calls = [];
  const router = new BrowserWorkspaceRouter({
    enabled: true,
    stateFile: path.join(rootDir, 'workspace.json'),
    bootstrapUrl: 'http://localhost:12307/workspace-bootstrap',
    logger: { error() {}, log() {} },
    claimWindow: async () => ({ hwnd: 7003 }),
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === 'chrome_navigate' && args.newWindow === true) {
        return workspaceToolMessage({
          success: true,
          windowId: 7001,
          tabs: [{ tabId: 7002, url: args.url }],
        });
      }
      if (name === 'get_windows_and_tabs') {
        return workspaceToolMessage({
          windows: [{ windowId: 7001, tabs: [{ tabId: 7002, active: true }] }],
        });
      }
      throw new Error('Unexpected internal tool call: ' + name);
    },
  });

  const rewrittenRead = await router.rewrite({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'chrome_get_web_content', arguments: { textContent: true } },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'chrome_navigate');
  assert.equal(calls[0].args.newWindow, true);
  assert.equal(calls[0].args.background, true);
  assert.equal('width' in calls[0].args, false);
  assert.equal('height' in calls[0].args, false);
  assert.equal(rewrittenRead.params.arguments.windowId, 7001);
  assert.equal(rewrittenRead.params.arguments.tabId, 7002);
  assert.equal(rewrittenRead.params.arguments.background, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(rootDir, 'workspace.json'), 'utf8')).hwnd, 7003);

  const defaultShot = await router.rewrite({
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: { name: 'chrome_screenshot', arguments: { fullPage: false } },
  });
  assert.equal(defaultShot.params.arguments.savePng, false);
  assert.equal(defaultShot.params.arguments.storeBase64, true);

  const explicitSave = await router.rewrite({
    jsonrpc: '2.0',
    id: 12,
    method: 'tools/call',
    params: { name: 'chrome_screenshot', arguments: { savePng: true, storeBase64: false } },
  });
  assert.equal(explicitSave.params.arguments.savePng, true);
  assert.equal(explicitSave.params.arguments.storeBase64, false);

  const rewrittenNavigate = await router.rewrite({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'chrome_navigate',
      arguments: { url: 'https://example.com/', newWindow: true, width: 1200, height: 800 },
    },
  });
  assert.equal(calls.length, 1, 'validated in-memory workspace should not add another upstream call');
  assert.equal(rewrittenNavigate.params.arguments.windowId, 7001);
  assert.equal(rewrittenNavigate.params.arguments.tabId, 7002);
  assert.equal(rewrittenNavigate.params.arguments.background, true);
  assert.equal(rewrittenNavigate.params.arguments.newWindow, false);
  assert.equal('width' in rewrittenNavigate.params.arguments, false);
  assert.equal('height' in rewrittenNavigate.params.arguments, false);

  const rewrittenUpload = await router.rewrite({ jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'chrome_upload_file', arguments: { selector: '#upload', filePath: 'C:\\temp\\test.txt' } } });
  assert.equal(rewrittenUpload.params.arguments.windowId, 7001);
  assert.equal(rewrittenUpload.params.arguments.tabId, 7002);
  assert.equal(rewrittenUpload.params.arguments.selector, '#upload');

  const rewrittenReadPage = await router.rewrite({
    jsonrpc: '2.0',
    id: 22,
    method: 'tools/call',
    params: { name: 'chrome_read_page', arguments: {} },
  });
  assert.equal(rewrittenReadPage.params.arguments.windowId, 7001);
  assert.equal(rewrittenReadPage.params.arguments.tabId, 7002);
  assert.equal(rewrittenReadPage.params.arguments.background, true);

  const rewrittenComputer = await router.rewrite({
    jsonrpc: '2.0',
    id: 23,
    method: 'tools/call',
    params: { name: 'chrome_computer', arguments: { action: 'left_click', ref: 'ref_9' } },
  });
  assert.equal(rewrittenComputer.params.arguments.windowId, 7001);
  assert.equal(rewrittenComputer.params.arguments.tabId, 7002);
  assert.equal(rewrittenComputer.params.arguments.background, true);

  for (const name of [
    'performance_start_trace',
    'performance_stop_trace',
    'performance_analyze_insight',
    'chrome_network_request',
    'chrome_network_capture',
    'chrome_javascript',
    'chrome_switch_tab',
    'chrome_handle_dialog',
    'chrome_gif_recorder',
    'chrome_bookmark_add',
  ]) {
    const rewritten = await router.rewrite({
      jsonrpc: '2.0',
      id: 'all-tools-' + name,
      method: 'tools/call',
      params: { name, arguments: name === 'chrome_switch_tab' ? { tabId: 9999 } : {} },
    });
    assert.equal(rewritten.params.arguments.windowId, 7001, name);
    assert.equal(rewritten.params.arguments.tabId, 7002, name);
  }

  const rewrittenFlow = await router.rewrite({
    jsonrpc: '2.0',
    id: 24,
    method: 'tools/call',
    params: { name: 'flow.login-check', arguments: { username: 'demo', tabTarget: 'new' } },
  });
  assert.equal(rewrittenFlow.params.arguments.username, 'demo');
  assert.equal(rewrittenFlow.params.arguments.tabTarget, 'new');
  assert.equal(rewrittenFlow.params.arguments.__bmg_workspace_window_id, 7001);
  assert.equal(rewrittenFlow.params.arguments.__bmg_workspace_tab_id, 7002);
});

test('workspace router refuses external close-tabs without touching any tab or workspace', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmg-workspace-close-test-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  let browserCalls = 0;
  const router = new BrowserWorkspaceRouter({
    enabled: true,
    stateFile: path.join(rootDir, 'workspace.json'),
    bootstrapUrl: 'http://localhost:12307/workspace-bootstrap',
    claimWindow: async () => ({ hwnd: 8103 }),
    callTool: async () => {
      browserCalls += 1;
      return workspaceToolMessage({ success: true, windowId: 8101, tabs: [{ tabId: 8102 }] });
    },
  });
  for (const args of [
    {}, { tabIds: [8102] }, { tabIds: [9999], url: 'https://user-window.example/' },
  ]) {
    await assert.rejects(() => router.rewrite({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'chrome_close_tabs', arguments: args },
    }), /workspace tab is protected from closing/u);
  }
  assert.equal(browserCalls, 0);
  assert.equal(router.windowId, null);
  assert.equal(router.tabId, null);
  const stateFile = path.join(rootDir, 'workspace.json');
  fs.writeFileSync(stateFile, JSON.stringify({
    version: 2, windowId: 8101, tabId: 8102,
    hwnd: 8103, windowMarker: 8104, visible: false,
  }));
  const persisted = new BrowserWorkspaceRouter({
    enabled: true, stateFile,
    callTool: async () => { browserCalls += 1; },
  });
  await assert.rejects(() => persisted.rewrite({
    method: 'tools/call',
    params: { name: 'chrome_close_tabs', arguments: { tabIds: [8102] } },
  }), /workspace tab is protected from closing/u);
  assert.equal(browserCalls, 0);
  assert.equal(persisted.windowId, 8101);
  assert.equal(persisted.tabId, 8102);
  assert.equal(fs.existsSync(stateFile), true);
});

test('automatic workspace recovery gives the Edge bootstrap and claim helpers 60 seconds', () => {
  assert.equal(WORKSPACE_RECOVERY_TIMEOUT_MS, 60_000);
  const server = readTextFile('sidecar/server.mjs');
  const start = readTextFile('scripts/ensure-workspace.mjs');
  const claim = server.split('async function claimWorkspaceWindow(')[1]
    .split('async function inspectWorkspaceWindow(')[0];
  const recover = server.split('async function ensureWorkspaceBrowser(')[1]
    .split('function sendWorkspaceBootstrap(')[0];
  assert.match(claim, /'-TimeoutMs', '30000'/u);
  assert.match(claim, /timeout: WORKSPACE_RECOVERY_TIMEOUT_MS/u);
  assert.match(recover, /timeout: WORKSPACE_RECOVERY_TIMEOUT_MS/u);
  assert.match(start, /timeout: WORKSPACE_RECOVERY_TIMEOUT_MS/u);
});


test('persisted v2 workspace verifies ownership before restoring hidden state', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmg-workspace-restore-test-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const stateFile = path.join(rootDir, 'workspace.json');
  const processStartTimeUtc = '2026-09-19T12:00:00.000Z';
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      version: 2,
      windowId: 9101,
      tabId: 9102,
      hwnd: 9103,
      windowMarker: 9104,
      processId: 9105,
      processStartTimeUtc,
      visible: false,
    }),
    'utf8',
  );
  let hiddenCalls = 0;
  const router = new BrowserWorkspaceRouter({
    enabled: true,
    stateFile,
    bootstrapUrl: 'http://localhost:12307/workspace-bootstrap',
    inspectWindow: async (hwnd, marker) => {
      assert.equal(hwnd, 9103);
      assert.equal(marker, 9104);
      return { hwnd, marker, visible: false, processId: 9105, processStartTimeUtc };
    },
    ensureWindowHidden: async (hwnd, marker) => {
      assert.equal(hwnd, 9103);
      assert.equal(marker, 9104);
      hiddenCalls += 1;
      return { hwnd, marker, visible: false, processId: 9105, processStartTimeUtc };
    },
    callTool: async (name) => {
      assert.equal(name, 'get_windows_and_tabs');
      return workspaceToolMessage({
        windows: [{ windowId: 9101, tabs: [{ tabId: 9102, active: true }] }],
      });
    },
  });
  const rewritten = await router.rewrite({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'chrome_get_web_content', arguments: { textContent: true } },
  });
  assert.equal(hiddenCalls, 1);
  assert.equal(rewritten.params.arguments.windowId, 9101);
  assert.equal(rewritten.params.arguments.tabId, 9102);

  await router.settleToolCall(
    { method: 'tools/call', params: { name: 'chrome_navigate' } },
    workspaceToolMessage({ success: true, windowId: 9101, tabId: 9102 }),
  );
  assert.equal(hiddenCalls, 2);
});


test('stale v2 HWND ownership is retired without closing the reported browser tab', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmg-workspace-stale-owner-test-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const stateFile = path.join(rootDir, 'workspace.json');
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      version: 2,
      windowId: 9801,
      tabId: 9802,
      hwnd: 9803,
      windowMarker: 9804,
      visible: false,
    }),
    'utf8',
  );
  const calls = [];
  const router = new BrowserWorkspaceRouter({
    enabled: true,
    stateFile,
    bootstrapUrl: 'http://127.0.0.1:12307/workspace-bootstrap',
    inspectWindow: async () => {
      throw new Error('synthetic ownership mismatch');
    },
    claimWindow: async (_nonce, marker) => ({ hwnd: 9903, marker, visible: false }),
    logger: { error() {}, log() {} },
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === 'get_windows_and_tabs') {
        return workspaceToolMessage({
          windows: [{ windowId: 9801, tabs: [{ tabId: 9802, active: true }] }],
        });
      }
      if (name === 'chrome_navigate') {
        return workspaceToolMessage({
          success: true,
          windowId: 9901,
          tabs: [{ tabId: 9902, url: args.url }],
        });
      }
      if (name === 'chrome_close_tabs') {
        assert.fail('stale ownership must never close a possibly user-owned tab');
      }
      throw new Error('Unexpected internal tool call: ' + name);
    },
  });
  const rewritten = await router.rewrite({
    method: 'tools/call',
    params: { name: 'chrome_get_web_content', arguments: { textContent: true } },
  });
  assert.deepEqual(calls.map((call) => call.name), ['get_windows_and_tabs', 'chrome_navigate']);
  assert.equal(rewritten.params.arguments.windowId, 9901);
  assert.equal(rewritten.params.arguments.tabId, 9902);
});

test('unsupported workspace state is retired without touching the stale browser window', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmg-workspace-unsupported-state-test-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const stateFile = path.join(rootDir, 'workspace.json');
  fs.writeFileSync(
    stateFile,
    JSON.stringify({ version: 999, windowId: 9201, tabId: 9202, hwnd: 9203 }),
    'utf8',
  );
  const calls = [];
  const router = new BrowserWorkspaceRouter({
    enabled: true,
    stateFile,
    bootstrapUrl: 'http://localhost:12307/workspace-bootstrap',
    claimWindow: async (_nonce, marker) => ({ hwnd: 9303, marker, visible: false }),
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === 'chrome_navigate') {
        return workspaceToolMessage({ success: true, windowId: 9301, tabs: [{ tabId: 9302, url: args.url }] });
      }
      throw new Error('Unexpected internal tool call: ' + name);
    },
  });
  const rewritten = await router.rewrite({
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'chrome_get_web_content', arguments: { textContent: true } },
  });
  assert.deepEqual(calls.map((call) => call.name), ['chrome_navigate']);
  assert.equal(rewritten.params.arguments.windowId, 9301);
  assert.equal(rewritten.params.arguments.tabId, 9302);
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(saved.version, 2);
  assert.equal(saved.hwnd, 9303);
  assert.ok(Number.isInteger(saved.windowMarker) && saved.windowMarker > 0);
});

test('post-navigation hide maintenance failure does not turn a browser success into an error', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmg-workspace-observe-test-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const router = new BrowserWorkspaceRouter({
    enabled: true,
    stateFile: path.join(rootDir, 'workspace.json'),
    bootstrapUrl: 'http://localhost:12307/workspace-bootstrap',
    claimWindow: async () => ({ hwnd: 9403 }),
    ensureWindowHidden: async () => { throw new Error('synthetic hide failure'); },
    logger: { error() {}, log() {} },
    callTool: async () => workspaceToolMessage({ success: true, windowId: 9401, tabs: [{ tabId: 9402 }] }),
  });
  await router.rewrite({
    jsonrpc: '2.0', id: 6, method: 'tools/call',
    params: { name: 'chrome_navigate', arguments: { url: 'https://example.com/' } },
  });
  await assert.doesNotReject(() => router.settleToolCall(
    { method: 'tools/call', params: { name: 'chrome_navigate' } },
    workspaceToolMessage({ success: true, windowId: 9401, tabId: 9402 }),
  ));
  assert.equal(router.validated, false);
});

test('foreground workspace is re-hidden after an upstream transport failure', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmg-workspace-transport-failure-test-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const transitions = [];
  const router = new BrowserWorkspaceRouter({
    enabled: true,
    stateFile: path.join(rootDir, 'workspace.json'),
    bootstrapUrl: 'http://localhost:12307/workspace-bootstrap',
    claimWindow: async (_nonce, marker) => ({ hwnd: 9453, marker, visible: false }),
    showWindow: async (hwnd) => {
      transitions.push(['show', hwnd]);
      return { hwnd, visible: true, foreground: true };
    },
    ensureWindowHidden: async (hwnd) => {
      transitions.push(['hide', hwnd]);
      return { hwnd, visible: false, hidden: true };
    },
    callTool: async (name, args) => {
      assert.equal(name, 'chrome_navigate');
      assert.equal(args.newWindow, true);
      return workspaceToolMessage({ success: true, windowId: 9451, tabs: [{ tabId: 9452, url: args.url }] });
    },
  });
  const rewritten = await router.rewrite({
    method: 'tools/call',
    params: {
      name: 'chrome_navigate',
      arguments: { url: 'https://example.com/', background: false },
    },
  });
  assert.deepEqual(transitions, [['show', 9453]]);
  assert.equal(router.visible, true);

  await router.settleToolCall(rewritten, null, new Error('connect ECONNREFUSED 127.0.0.1:12306'));
  assert.deepEqual(transitions, [['show', 9453], ['hide', 9453]]);
  assert.equal(router.visible, false);
  assert.equal(router.validated, false);
});

test('workspace Win32 helpers true-hide only ownership-verified HWNDs without moving geometry', () => {
  const script = readTextFile('scripts/hide-workspace-window.ps1');
  assert.match(script, /FlashWindowEx/u);
  assert.match(script, /FLASHW_STOP/u);
  assert.match(script, /Clear-BmgWindowAttention \$target/u);
  assert.doesNotMatch(script, /Clear-BmgProcessAttention/u);
  assert.match(script, /WS_EX_TOOLWINDOW/u);
  assert.match(script, /WS_EX_APPWINDOW/u);
  assert.match(script, /ParameterSetName = 'Hwnd'/u);
  assert.match(script, /BMG_BROWSER_MCP_WORKSPACE_V1/u);
  assert.match(script, /GetProp/u);
  assert.match(script, /SetProp/u);
  assert.match(script, /PostMessage/u);
  assert.match(script, /WM_CLOSE/u);
  assert.match(script, /\[switch\]\$Retire/u);
  assert.match(script, /ShowWindowAsync\(\$target, 0\).*SW_HIDE/u);
  assert.match(script, /SWP_NOMOVE/u);
  assert.match(script, /SWP_NOSIZE/u);
  assert.match(script, /Multiple Edge windows matched/u);
  assert.match(script, /ProcessName -ne 'msedge'/u);
  assert.match(script, /ownership marker mismatch/u);
  assert.match(script, /hide unexpectedly changed window geometry/u);
  assert.match(script, /NotePropertyName taskbarApi -NotePropertyValue 'DeleteTab'/u);
  assert.match(script, /NotePropertyName taskbarApiSucceeded -NotePropertyValue \$true/u);
  assert.doesNotMatch(script, /-32000/u);
  assert.doesNotMatch(script, /taskkill|Stop-Process|ProcessName -eq 'msedge'.*Stop/isu);

  const showScript = readTextFile('scripts/show-workspace-window.ps1');
  assert.match(showScript, /TargetHwnd/u);
  assert.match(showScript, /WindowMarker/u);
  assert.match(showScript, /GetProp/u);
  assert.match(showScript, /SetForegroundWindow/u);
  assert.match(showScript, /\[switch\]\$Activate/u);
  assert.match(showScript, /SWP_NOACTIVATE/u);
  assert.match(showScript, /if \(-not \$Activate\).*SWP_NOACTIVATE/u);
  assert.match(showScript, /ShowWindowAsync\(\$target, 8\).*SW_SHOWNA/u);
  assert.doesNotMatch(showScript, /ShowWindowAsync\(\$target, 4\)/u);
  assert.match(showScript, /if \(\$Activate\) \{ \$foreground = .*SetForegroundWindow/u);
  assert.match(showScript, /SWP_NOMOVE/u);
  assert.match(showScript, /SWP_NOSIZE/u);
  assert.match(showScript, /ProcessName -ne 'msedge'/u);
  assert.match(showScript, /show unexpectedly changed window geometry/u);
  assert.match(showScript, /taskbarApi = 'AddTab'/u);
  assert.match(showScript, /taskbarApiSucceeded = \$true/u);
  assert.doesNotMatch(showScript, /GetSystemMetrics|-32000/u);
  assert.doesNotMatch(showScript, /taskkill|Stop-Process/iu);

  const ensureEdge = readTextFile('scripts/ensure-edge.ps1');
  assert.match(ensureEdge, /windowMarker = Get-Random/u);
  assert.match(ensureEdge, /"-Retire"/u);
  assert.match(ensureEdge, /BMG bootstrap action=retire/u);
  assert.match(ensureEdge, /BMG bootstrap action=blocked/u);
  assert.doesNotMatch(ensureEdge, /taskkill|Stop-Process/iu);
  assert.match(ensureEdge, /hide-workspace-window\.ps1/u);
  assert.match(ensureEdge, /"-Nonce", \$nonce, "-WindowMarker"/u);
});

test('workspace transitions record command intent, Win32 results, taskbar API and failures', async () => {
  const events = [];
  const router = new BrowserWorkspaceRouter({
    clock: () => Date.parse('2026-10-28T08:00:00.000Z'),
    onWindowTransition: (event) => events.push(event),
    logger: { log() {}, error() {} },
  });
  const result = await router.transitionWindow('hide', 'explicit-hide', 12345, false, async () => ({
    visible: false, minimized: false, appWindow: false, toolWindow: true,
    taskbarApi: 'DeleteTab', taskbarApiSucceeded: true,
  }));
  assert.equal(result.visible, false);
  assert.deepEqual(events.map((event) => event.phase), ['request', 'result']);
  assert.equal(events[0].reason, 'explicit-hide');
  assert.equal(events[1].at, '2026-10-28T08:00:00.000Z');
  assert.equal(events[1].outcome, 'success');
  assert.equal(events[1].win32Visible, false);
  assert.equal(events[1].win32ToolWindow, true);
  assert.equal(events[1].taskbarApi, 'DeleteTab');
  assert.equal(events[1].taskbarApiSucceeded, true);
  assert.equal(events[1].taskbarUiStatus, 'not_verified');
  await assert.rejects(() => router.transitionWindow('show', 'page-foreground', 12345, true, async () => {
    throw new Error('synthetic window failure');
  }), /synthetic window failure/u);
  assert.deepEqual(events.slice(2).map((event) => event.phase), ['request', 'result']);
  assert.equal(events[3].outcome, 'error');
  assert.equal(events[3].activate, true);
  assert.equal(events[3].error, 'synthetic window failure');
  const errors = [];
  const logFailureRouter = new BrowserWorkspaceRouter({
    onWindowTransition: () => { throw new Error('disk unavailable'); },
    logger: { error: (message) => errors.push(message) },
  });
  await assert.doesNotReject(() => logFailureRouter.transitionWindow(
    'hide', 'test', 12345, false, async () => ({ visible: false }),
  ));
  assert.equal(errors.length, 2);
  assert.match(
    readTextFile('sidecar/server.mjs'),
    /showWindow: \(hwnd, marker, activate\) => showWorkspaceWindow\(config.rootDir, hwnd, marker, activate\)/u,
  );
});

test('工作区先确认隐藏再改样式，并仅对归属确认的窗口清理和恢复任务栏', () => {
  const hide = readTextFile('scripts/hide-workspace-window.ps1');
  const show = readTextFile('scripts/show-workspace-window.ps1');
  const helper = readTextFile('scripts/workspace-taskbar.ps1');
  const ownership = hide.indexOf('} elseif ($info.marker -ne $WindowMarker)');
  const inspect = hide.indexOf('if ($InspectOnly)');
  const hideCall = hide.indexOf('::ShowWindowAsync($target, 0)');
  const hiddenCheck = hide.indexOf('if ($hiddenInfo.visible)');
  const styleChange = hide.indexOf('::SetWindowLongPtr($target,');
  const identityCheck = hide.indexOf('if ($verified.marker -ne $WindowMarker');
  const deleteTab = hide.indexOf('::Update($target, $false)');
  assert.ok(ownership >= 0 && ownership < inspect && inspect < hideCall);
  assert.ok(hideCall < hiddenCheck && hiddenCheck < styleChange);
  assert.ok(styleChange < identityCheck && identityCheck < deleteTab);
  assert.match(hide, /if \(-not \$hiddenInfo.visible\) \{ break \}/u);
  assert.match(hide, /\$verified.processId -ne \$before.processId/u);
  assert.match(hide, /\$verified.processStartTimeUtc -ne \$before.processStartTimeUtc/u);
  // 重复隐藏也需要清理旧条目，不能只在样式发生变化时执行。
  assert.match(hide, /if \(\$newExStyle -ne \$oldExStyle\) \{[^}]+\}[^]*::Update\(\$target, \$false\)/u);
  const showCheck = show.indexOf('if ([int64][BmgWorkspaceShowWin32]::GetProp');
  const addTab = show.indexOf('::Update($target, $true)');
  assert.ok(showCheck >= 0 && showCheck < addTab);
  assert.match(helper, /taskbar.HrInit\(\)/u);
  assert.match(helper, /show \? taskbar.AddTab\(hwnd\) : taskbar.DeleteTab\(hwnd\)/u);
  assert.match(helper, /Marshal.ThrowExceptionForHR/u);
  assert.match(helper, /Marshal.FinalReleaseComObject/u);
});

test('workspace returns to hidden mode after normal browser work resumes', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmg-workspace-visible-test-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const stateFile = path.join(rootDir, 'workspace.json');
  const transitions = [];
  const visibilityEvents = [];
  const router = new BrowserWorkspaceRouter({
    enabled: true,
    stateFile,
    onWindowTransition: (event) => visibilityEvents.push(event),
    bootstrapUrl: 'http://localhost:12307/workspace-bootstrap',
    claimWindow: async () => ({ hwnd: 9503 }),
    ensureWindowHidden: async (hwnd) => { transitions.push(['hide', hwnd]); return { hidden: true }; },
    showWindow: async (hwnd, marker, activate) => {
      transitions.push(['show', hwnd, activate]);
      return { foreground: activate };
    },
    callTool: async (name, args) => {
      if (name === 'chrome_navigate') {
        return workspaceToolMessage({ success: true, windowId: 9501, tabs: [{ tabId: 9502, url: args.url }] });
      }
      if (name === 'get_windows_and_tabs') {
        return workspaceToolMessage({ windows: [{ windowId: 9501, tabs: [{ tabId: 9502, active: true }] }] });
      }
      throw new Error('Unexpected internal tool call: ' + name);
    },
  });
  const shown = await router.showWorkspace();
  assert.equal(shown.windowId, 9501);
  assert.equal(shown.tabId, 9502);
  assert.equal(shown.hwnd, 9503);
  assert.equal(shown.visible, true);
  assert.equal(shown.foreground, false);
  assert.deepEqual(transitions, [['show', 9503, false]]);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).visible, true);

  const focused = await router.showWorkspace({ activate: true });
  assert.equal(focused.visible, true);
  assert.equal(focused.foreground, true);
  assert.deepEqual(transitions, [['show', 9503, false], ['hide', 9503], ['show', 9503, true]]);
  await assert.rejects(router.showWorkspace({ activate: 'true' }), /activate must be a boolean/u);

  await router.settleToolCall(
    { method: 'tools/call', params: { name: 'chrome_navigate' } },
    workspaceToolMessage({ success: true, windowId: 9501, tabId: 9502 }),
  );
  assert.deepEqual(transitions, [['show', 9503, false], ['hide', 9503], ['show', 9503, true], ['hide', 9503]]);
  assert.equal(router.visible, false);

  const hidden = await router.hideWorkspace();
  assert.equal(hidden.visible, false);
  assert.ok(visibilityEvents.some((event) => event.phase === 'command' && event.reason === 'explicit-hide'));
  assert.ok(visibilityEvents.some((event) => event.phase === 'command-result' && event.action === 'hide' && event.outcome === 'success'));
  assert.ok(visibilityEvents.some((event) => event.phase === 'command' && event.reason === 'explicit-show' && event.activate === true));
  assert.ok(visibilityEvents.some((event) => event.phase === 'request' && event.reason === 'page-settle'));
  assert.ok(visibilityEvents.some((event) => event.phase === 'result' && event.reason === 'explicit-hide'));
  assert.deepEqual(transitions[0], ['show', 9503, false]);
  assert.ok(transitions.length >= 3);
  assert.ok(transitions.slice(3).every((transition) => transition[0] === 'hide' && transition[1] === 9503));
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.deepEqual(
    { windowId: saved.windowId, tabId: saved.tabId, hwnd: saved.hwnd, visible: saved.visible },
    { windowId: 9501, tabId: 9502, hwnd: 9503, visible: false },
  );
});

test('workspace local MCP tools expose only explicit show and hide controls', () => {
  assert.deepEqual(
    workspaceLocalToolsForTest.map((tool) => tool.name),
    ['bmg_show_workspace', 'bmg_hide_workspace'],
  );
  assert.deepEqual(workspaceLocalToolsForTest[0].inputSchema, {
    type: 'object',
    properties: {
      activate: {
        type: 'boolean',
        description: workspaceLocalToolsForTest[0].inputSchema.properties.activate.description,
        default: false,
      },
    },
    additionalProperties: false,
  });
  assert.match(workspaceLocalToolsForTest[0].description, /Showing a window is NOT the same as activating/u);
  assert.match(workspaceLocalToolsForTest[0].description, /activate=true/u);
  assert.match(workspaceLocalToolsForTest[0].inputSchema.properties.activate.description, /default/u);
  assert.deepEqual(workspaceLocalToolsForTest[1].inputSchema, {
    type: 'object', properties: {}, additionalProperties: false,
  });
});

test('workspace tool list adds login guidance only to chrome_read_page', () => {
  const sourceTools = [
    { name: 'chrome_read_page', description: 'Read visible page elements', inputSchema: { type: 'object', properties: {} } },
    { name: 'chrome_computer', description: 'Interact with page', inputSchema: { type: 'object', properties: {} } },
    { name: 'flow.sign-in', description: 'Recorded flow', inputSchema: { type: 'object', properties: {} } },
  ];
  const response = {
    statusCode: 200,
    headers: { 'content-length': 'old-length', 'content-type': 'text/event-stream' },
    body: Buffer.from('event: message\ndata: ' + JSON.stringify({
      jsonrpc: '2.0', id: 1, result: { tools: sourceTools },
    }) + '\n\n', 'utf8'),
  };
  const withoutWorkspace = parseSse(augmentWorkspaceToolsForTest(response, false).body.toString('utf8')).result.tools;
  assert.deepEqual(withoutWorkspace.map((tool) => tool.name).slice(0, 3), sourceTools.map((tool) => tool.name));
  assert.equal(withoutWorkspace.some((tool) => tool.name === 'bmg_show_workspace'), false);
  assert.ok(withoutWorkspace.some((tool) => tool.name === 'request_approval'));
  const augmented = augmentWorkspaceToolsForTest(response, true);
  const tools = parseSse(augmented.body.toString('utf8')).result.tools;
  assert.deepEqual(tools.map((tool) => tool.name), [
    'chrome_read_page', 'chrome_computer', 'flow.sign-in', 'bmg_show_workspace', 'bmg_hide_workspace',
    'bmg_claim_web_unlock', 'bmg_unlock', 'approval_status', 'get_approval_status',
    'request_approval', 'resolve_pending_action',
  ]);
  assert.ok(tools[0].description.startsWith(sourceTools[0].description + '\n'));
  assert.match(tools[0].description, /优先使用验证码登录/u);
  assert.match(tools[0].description, /CCM/u);
  assert.match(tools[0].description, /savePng=true/u);
  assert.match(tools[0].description, /填写并点击发送/u);
  assert.equal(tools[0].inputSchema.properties.approval_id.type, 'string');
  assert.equal(tools[1].inputSchema.properties.approval_id.type, 'string');
  assert.equal(tools[2].inputSchema.properties.approval_id.type, 'string');
  assert.match(tools[1].description, /request_approval/u);
  assert.match(tools[2].description, /bmg_unlock/u);
  assert.match(tools[1].description, /code is blocked, redacted.*request_approval/u);
  assert.match(tools.find((tool) => tool.name === 'bmg_unlock').description, /immediately call request_approval/u);
  assert.match(tools.find((tool) => tool.name === 'bmg_unlock').description, /totp-only mode, the card route is unavailable/u);
  assert.match(tools.find((tool) => tool.name === 'request_approval').description, /code is blocked or unavailable/u);
  assert.deepEqual(sourceTools[0].description, 'Read visible page elements');
  assert.equal(augmented.headers['content-length'], undefined);
  assert.equal(augmentWorkspaceToolsForTest({ ...response, statusCode: 502 }, true).statusCode, 502);
});

test('flow workspace patch scopes browser APIs and lifts dynamic run options', () => {
  const fixture = `prefix
  function ensureTab(options) {
    const tabs = chrome.tabs.query({ active: true, currentWindow: true });
    const created = chrome.tabs.create({ url: "about:blank", active: true });
    chrome.tabs.sendMessage(1, { action: "ping" });
    chrome.scripting.executeScript({ target: { tabId: 1 }, func: () => true });
    chrome.webNavigation.getAllFrames({ tabId: 1 });
    return chrome.tabs.get(1);
  }
  class FlowRunTool {
    execute(args) {
      return __async(this, null, function* () {
        const {
          flowId,
          args: vars,
          tabTarget,
          refresh,
          captureNetwork,
          returnLogs,
          timeoutMs,
          startUrl
        } = args || {};
        if (!flowId) return createErrorResponse("flowId is required");
        const flow = yield getFlow(flowId);
        if (!flow) return createErrorResponse(\`Flow not found: \${flowId}\`);
        const result2 = yield runFlow(flow, {
          tabTarget,
          refresh,
          captureNetwork,
          returnLogs,
          timeoutMs,
          startUrl,
          args: vars
        });
        return result2;
      });
    }
  }
  class ListPublishedTool {}
  const handleCallTool = (param) => __async(null, null, function* () {
    const tool = toolsMap.get(param.name);
    if (!tool) return createErrorResponse("missing");
    try {
      return yield tool.execute(param.args);
    } catch (error) {
      return createErrorResponse(String(error));
    }
  });
  const RR_V3_KEEPALIVE_PORT_NAME = "rr_v3_keepalive";
suffix`;
  const first = patchFlowWorkspace(fixture);
  assert.equal(first.changed, true);
  assert.match(first.text, /BMG_FLOW_WORKSPACE_V1/u);
  assert.match(first.text, /bmgFlowTabsQuery\(\{ active: true, currentWindow: true \}\)/u);
  assert.match(first.text, /bmgFlowTabsSendMessage\(1, \{ action: "ping" \}\)/u);
  assert.match(first.text, /bmgFlowScriptingExecuteScript\(\{ target: \{ tabId: 1 \}, func: \(\) => true \}\)/u);
  assert.match(first.text, /bmgFlowWebNavigationGetAllFrames\(\{ tabId: 1 \}\)/u);
  assert.match(first.text, /__bmg_workspace_tab_id/u);
  assert.match(first.text, /resolvedTabTarget/u);
  assert.match(first.text, /BMG_FLOW_TARGET_TOOLS/u);
  const second = patchFlowWorkspace(first.text);
  assert.equal(second.changed, false);
  assert.equal(second.text, first.text);
});

test('upstream public-tool patch is fully applied and deterministic on the pinned extension', () => {
  const background = readTextFile('extension/background.js');
  assert.match(background, /BMG_UPSTREAM_TOOL_TARGETS_V1/u);
  assert.match(background, /BMG_FLOW_WORKSPACE_V1/u);
  assert.match(background, /const targetTab = yield bmgResolveToolTab\(args\);/u);
  assert.match(background, /tabId: args\.tabId,\r?\n\s*windowId: args\.windowId/u);
  assert.match(background, /bmgFlowTabsSendMessage/u);
  assert.match(background, /bmgFlowScriptingExecuteScript/u);
  assert.match(background, /bmgFlowWebNavigationGetAllFrames/u);
  const performanceTargets = background.match(/const activeTab = yield bmgResolveToolTab\(args\);/gu) || [];
  assert.ok(performanceTargets.length >= 4, 'performance/dialog/current-tab tools should use explicit BMG target resolution');
  const second = patchUpstreamToolsBackgroundText(background);
  assert.equal(second.changed, false);
  assert.equal(second.text, background);
});


test('navigation target patch prioritizes explicit tabs and rejects non-http match patterns', () => {
  const fixture = `prefix
          console.log(\`Checking if URL is already open: \${url}\`);
          const buildUrlPatterns = (input) => {
            const patterns2 = /* @__PURE__ */ new Set();
            try {
              if (!input.includes("*")) {
                const u = new URL(input);
                const pathWildcard = "/*";
                const hostNoWww = u.host.replace(/^www\\./, "");
                const hostWithWww = hostNoWww.startsWith("www.") ? hostNoWww : \`www.\${hostNoWww}\`;
                patterns2.add(\`\${u.protocol}//\${u.host}\${pathWildcard}\`);
                patterns2.add(\`\${u.protocol}//\${hostNoWww}\${pathWildcard}\`);
                patterns2.add(\`\${u.protocol}//\${hostWithWww}\${pathWildcard}\`);
                const altProtocol = u.protocol === "https:" ? "http:" : "https:";
                patterns2.add(\`\${altProtocol}//\${u.host}\${pathWildcard}\`);
                patterns2.add(\`\${altProtocol}//\${hostNoWww}\${pathWildcard}\`);
                patterns2.add(\`\${altProtocol}//\${hostWithWww}\${pathWildcard}\`);
              } else {
                patterns2.add(input);
              }
            } catch (e) {
              patterns2.add(input.endsWith("/") ? \`\${input}*\` : \`\${input}/*\`);
            }
            return Array.from(patterns2);
          };
          const urlPatterns = buildUrlPatterns(url);
          const candidateTabs = yield chrome.tabs.query({ url: urlPatterns });
          console.log(\`Found \${candidateTabs.length} matching tabs with patterns:\`, urlPatterns);
          const explicitTab = yield this.tryGetTab(tabId);
          const existingTab = explicitTab || pickBestMatch(url, candidateTabs);
suffix`;
  const first = patchNavigationTargetSelection(fixture);
  assert.equal(first.changed, true);
  assert.match(first.text, /BMG_EXPLICIT_TARGET_NAVIGATION_V1/u);
  assert.match(first.text, /BMG_SAFE_NAVIGATION_URL_PATTERNS_V1/u);
  assert.match(first.text, /const explicitTab = yield this\.tryGetTab\(tabId\);[\s\S]*const urlPatterns = explicitTab \? \[\] : buildUrlPatterns\(url\);/u);
  assert.match(first.text, /u\.protocol !== "http:" && u\.protocol !== "https:"\) return \[\]/u);
  assert.match(first.text, /urlPatterns\.length > 0[\s\S]*chrome\.tabs\.query/u);
  assert.match(first.text, /hostnameNoWww !== "localhost" && !isIpLiteral/u);
  assert.match(first.text, /if \(hostWithWww\) patterns2\.add/u);
  assert.doesNotMatch(first.text, /patterns2\.add\(input\.endsWith/u);
  const second = patchNavigationTargetSelection(first.text);
  assert.equal(second.changed, false);
  assert.equal(second.text, first.text);
});

test('navigation patch keeps BMG browser work background-first and waits for settled URLs', () => {
  const background = readTextFile('extension/background.js');
  assert.match(background, /BMG_DEFAULT_BACKGROUND_V1/u);
  assert.match(background, /BMG_NAVIGATION_SETTLE_V2/u);
  assert.match(background, /BMG_EXPLICIT_TARGET_NAVIGATION_V1/u);
  assert.match(background, /BMG_SAFE_NAVIGATION_URL_PATTERNS_V1/u);
  assert.doesNotMatch(background, /BMG_SAFE_URL_PATTERN_HOSTS_V1/u);
  assert.match(background, /if \(!tab\) return false;\s*const current = tab\.url \|\| "";\s*if \(current === expectedUrl\) return true;\s*if \(tab\.status !== "complete"\) return false;/u);
  assert.match(background, /background: background2 = true/u);
  assert.match(background, /const background2 = args\.background !== false;/u);
  assert.match(background, /bmgWaitForNavigation\(\s*explicitTab\.id, url, previousUrl/u);
  assert.match(background, /bmgWaitForNavigation\(newTab\.id, url/u);
  assert.match(background, /focused: background2 === true \? false : true/u);
  assert.doesNotMatch(
    background,
    /const \{ url, type, jsScript, tabId, windowId, background: background2 \} = args;/u,
  );
  const second = patchNavigationBackgroundText(background);
  assert.equal(second.changed, false);
  assert.equal(second.text, background);

  const setup = readTextFile('scripts/setup.ps1');
  assert.match(setup, /patch-extension-navigation\.mjs/u);
});

test('web-content patch keeps chrome_computer delegated actions on the selected workspace tab', () => {
  const background = readTextFile('extension/background.js');
  assert.match(background, /BMG_COMPUTER_TARGET_TAB_V1/u);
  const start = background.indexOf('  class ComputerTool extends BaseBrowserToolExecutor {');
  const end = background.indexOf('  const computerTool = new ComputerTool();', start);
  assert.ok(start >= 0 && end > start);
  const block = background.slice(start, end);
  const delegates = [...block.matchAll(/yield (?:clickTool|fillTool|keyboardTool)\.execute\(\{/gu)];
  assert.equal(delegates.length, 8);
  const routedDelegates = [...block.matchAll(/yield (?:clickTool|fillTool|keyboardTool)\.execute\(\{\r?\n\s*tabId: tab\.id,\r?\n\s*windowId: tab\.windowId,/gu)];
  assert.equal(routedDelegates.length, 7);
  assert.match(block, /BMG_COMPUTER_COORDINATE_CDP_V1/u);
  assert.match(
    block,
    /keyboardTool\.execute\(\{ tabId: tab\.id, windowId: tab\.windowId, keys: repeatedKeys \}\)/u,
  );
  const second = patchWebContentBackgroundText(background);
  assert.equal(second.changed, false);
  assert.equal(second.text, background);
});

test('workspace defaults browser tools to background but preserves explicit foreground intent', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmg-workspace-background-default-test-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const transitions = [];
  const router = new BrowserWorkspaceRouter({
    enabled: true,
    stateFile: path.join(rootDir, 'workspace.json'),
    bootstrapUrl: 'http://localhost:12307/workspace-bootstrap',
    claimWindow: async () => ({ hwnd: 8803 }),
    showWindow: async (hwnd) => {
      transitions.push(['show', hwnd]);
      return { hwnd, visible: true, foreground: true };
    },
    ensureWindowHidden: async (hwnd) => {
      transitions.push(['hide', hwnd]);
      return { hwnd, visible: false, hidden: true };
    },
    callTool: async (name, args) => {
      if (name === 'chrome_navigate' && args.newWindow === true) {
        return workspaceToolMessage({
          success: true,
          windowId: 8801,
          tabs: [{ tabId: 8802, url: args.url }],
        });
      }
      if (name === 'get_windows_and_tabs') {
        return workspaceToolMessage({
          windows: [{ windowId: 8801, tabs: [{ tabId: 8802, active: true }] }],
        });
      }
      throw new Error('Unexpected internal tool call: ' + name);
    },
  });

  const foreground = await router.rewrite({
    method: 'tools/call',
    params: {
      name: 'chrome_navigate',
      arguments: { url: 'https://example.com/front', background: false },
    },
  });
  assert.equal(foreground.params.arguments.background, false);
  assert.deepEqual(transitions, [['show', 8803]]);
  assert.equal(router.visible, true);

  await router.settleToolCall(
    foreground,
    workspaceToolMessage({ success: true, windowId: 8801, tabId: 8802 }),
  );
  assert.deepEqual(transitions, [['show', 8803]]);
  assert.equal(router.visible, true);

  const background = await router.rewrite({
    method: 'tools/call',
    params: {
      name: 'chrome_get_web_content',
      arguments: { textContent: true },
    },
  });
  assert.equal(background.params.arguments.background, true);
  assert.deepEqual(transitions, [['show', 8803], ['hide', 8803]]);
  assert.equal(router.visible, false);

  await router.settleToolCall(
    background,
    workspaceToolMessage({ success: true, textContent: 'ok' }),
  );
  assert.deepEqual(transitions, [
    ['show', 8803],
    ['hide', 8803],
    ['hide', 8803],
  ]);
  assert.equal(router.visible, false);

  const flow = await router.rewrite({
    method: 'tools/call',
    params: { name: 'flow.tab-changing-flow', arguments: { tabTarget: 'new' } },
  });
  assert.equal(flow.params.arguments.__bmg_workspace_window_id, 8801);
  assert.equal(flow.params.arguments.__bmg_workspace_tab_id, 8802);
  await router.settleToolCall(flow, workspaceToolMessage({ success: true }));
  assert.equal(router.validated, false, 'flow may change the active workspace tab and must force revalidation');
});

test('element selection shows only the BMG workspace and hides it after completion', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmg-workspace-picker-test-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const transitions = [];
  const router = new BrowserWorkspaceRouter({
    enabled: true,
    stateFile: path.join(rootDir, 'workspace.json'),
    bootstrapUrl: 'http://localhost:12307/workspace-bootstrap',
    claimWindow: async () => ({ hwnd: 8903 }),
    showWindow: async (hwnd) => {
      transitions.push(['show', hwnd]);
      return { hwnd, visible: true, foreground: true };
    },
    ensureWindowHidden: async (hwnd) => {
      transitions.push(['hide', hwnd]);
      return { hwnd, visible: false, hidden: true };
    },
    callTool: async (name, args) => {
      if (name === 'chrome_navigate' && args.newWindow === true) {
        return workspaceToolMessage({
          success: true,
          windowId: 8901,
          tabs: [{ tabId: 8902, url: args.url }],
        });
      }
      if (name === 'get_windows_and_tabs') {
        return workspaceToolMessage({
          windows: [{ windowId: 8901, tabs: [{ tabId: 8902, active: true }] }],
        });
      }
      throw new Error('Unexpected internal tool call: ' + name);
    },
  });

  const rewritten = await router.rewrite({
    method: 'tools/call',
    params: {
      name: 'chrome_request_element_selection',
      arguments: { requests: [{ name: 'Target' }] },
    },
  });
  assert.equal(rewritten.params.arguments.windowId, 8901);
  assert.equal(rewritten.params.arguments.tabId, 8902);
  assert.deepEqual(transitions, [['show', 8903]]);
  assert.equal(router.visible, true);

  await router.settleToolCall(
    rewritten,
    workspaceToolMessage({ success: true, elements: [{ ref: 'ref_1' }] }),
  );
  assert.deepEqual(transitions, [['show', 8903], ['hide', 8903]]);
  assert.equal(router.visible, false);
});
