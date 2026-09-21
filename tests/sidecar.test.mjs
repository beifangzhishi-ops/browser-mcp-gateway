import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { createBmgServer, closeBmgServer, listenBmgServer, workspaceLocalToolsForTest, workspaceSupplementalToolsForTest } from '../sidecar/server.mjs';
import { createConfig } from '../sidecar/config.mjs';
import { BrowserWorkspaceRouter } from '../sidecar/workspace.mjs';
import { prepareWorkspace } from '../scripts/ensure-workspace.mjs';
import { execFileSync } from 'node:child_process';
import { OAuthStore, createPkceChallenge } from '../sidecar/oauth.mjs';
import {
  patchWebContentBackgroundText,
  patchWebContentHelperText,
} from '../scripts/patch-extension-web-content.mjs';
import {
  patchNavigationBackgroundText,
} from '../scripts/patch-extension-navigation.mjs';
import {
  patchContentCdpBackgroundText,
} from '../scripts/patch-extension-content-cdp.mjs';
import { toolCallFailed } from '../scripts/bmgctl-result.mjs';

const ISSUER = 'https://bmg.example.test/bmg';
const RESOURCE = 'https://bmg.example.test/bmg/mcp';
const PROTECTED_METADATA =
  'https://bmg.example.test/.well-known/oauth-protected-resource/bmg/mcp';
const APPROVAL_SECRET = 'unit-test-approval-secret';

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

test('Windows 启动脚本仅在当前会话缺少 Edge 时启动浏览器', {
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
  return fetch(baseUrl + requestPath, {
    redirect: 'manual',
    ...options,
  }).then(async (response) => {
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    return { response, text, json };
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

async function createFakeUpstream({ initializeDelayMs = 0 } = {}) {
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
        ],
      };
    } else if (method === 'tools/call' && payload.params?.name === 'safe_ping') {
      result = {
        content: [{ type: 'text', text: 'pong from 12306' }],
        isError: false,
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
  assert.deepEqual(parseSse(tools.text).result.tools.map((tool) => tool.name), ['safe_ping']);

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
  assert.equal(defaults.workspaceIdleTimeoutSeconds, 1800);
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
  assert.match(first.text, /BMG_SAFE_URL_PATTERN_HOSTS_V1/u);
  assert.match(first.text, /BMG_COMPUTER_TARGET_TAB_V1/u);
  assert.match(first.text, /BMG_COMPUTER_COORDINATE_CDP_V1/u);
  assert.match(first.text, /hostnameNoWww !== "localhost" && !isIpLiteral/u);
  assert.match(first.text, /if \(hostWithWww\) patterns2\.add/u);
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

test('expired startup claim grace retires an orphan nonce before creating a new workspace', async (t) => {
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
  const claims = [];
  const router = new BrowserWorkspaceRouter({
    enabled: true,
    stateFile,
    startupStateFile,
    bootstrapUrl: 'http://127.0.0.1:12307/workspace-bootstrap',
    clock: () => 32001,
    claimWindow: async (nonce, marker) => {
      claims.push({ nonce, marker });
      assert.notEqual(nonce, 'startup-orphan');
      return { hwnd: 9663, marker, visible: false };
    },
    callTool: async (name, args) => {
      calls.push(name);
      if (name === 'get_windows_and_tabs') {
        return workspaceToolMessage({ windows: [] });
      }
      if (name === 'chrome_navigate') {
        return workspaceToolMessage({
          success: true,
          windowId: 9661,
          tabs: [{ tabId: 9662, url: args.url }],
        });
      }
      throw new Error('Unexpected internal tool call: ' + name);
    },
  });
  const rewritten = await router.rewrite({
    method: 'tools/call',
    params: { name: 'chrome_get_web_content', arguments: { textContent: true } },
  });
  assert.deepEqual(calls, ['get_windows_and_tabs', 'chrome_navigate']);
  assert.equal(claims.length, 1);
  assert.equal(fs.existsSync(startupStateFile), false);
  assert.equal(rewritten.params.arguments.windowId, 9661);
  assert.equal(rewritten.params.arguments.tabId, 9662);
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
  assert.deepEqual(navigateCalls, [{
    url: 'about:blank',
    tabId: 7002,
    windowId: 7001,
    newWindow: false,
    background: true,
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
  assert.equal('background' in rewrittenReadPage.params.arguments, false);

  const rewrittenComputer = await router.rewrite({
    jsonrpc: '2.0',
    id: 23,
    method: 'tools/call',
    params: { name: 'chrome_computer', arguments: { action: 'left_click', ref: 'ref_9' } },
  });
  assert.equal(rewrittenComputer.params.arguments.windowId, 7001);
  assert.equal(rewrittenComputer.params.arguments.tabId, 7002);
  assert.equal(rewrittenComputer.params.arguments.background, true);
});

test('workspace router narrows close-tabs to the GPT tab', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmg-workspace-close-test-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const router = new BrowserWorkspaceRouter({
    enabled: true,
    stateFile: path.join(rootDir, 'workspace.json'),
    bootstrapUrl: 'http://localhost:12307/workspace-bootstrap',
    claimWindow: async () => ({ hwnd: 8103 }),
    callTool: async () =>
      workspaceToolMessage({ success: true, windowId: 8101, tabs: [{ tabId: 8102 }] }),
  });
  const rewritten = await router.rewrite({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'chrome_close_tabs',
      arguments: { tabIds: [9999], url: 'https://user-window.example/' },
    },
  });
  assert.deepEqual(rewritten.params.arguments.tabIds, [8102]);
  assert.equal('url' in rewritten.params.arguments, false);
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

  await router.observe(
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

test('legacy v1 workspace state is retired without touching the stale browser window', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmg-workspace-legacy-test-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const stateFile = path.join(rootDir, 'workspace.json');
  fs.writeFileSync(
    stateFile,
    JSON.stringify({ version: 1, windowId: 9201, tabId: 9202, hwnd: 9203 }),
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
  await assert.doesNotReject(() => router.observe(
    { method: 'tools/call', params: { name: 'chrome_navigate' } },
    workspaceToolMessage({ success: true, windowId: 9401, tabId: 9402 }),
  ));
  assert.equal(router.validated, false);
});

test('workspace Win32 helpers true-hide only ownership-verified HWNDs without moving geometry', () => {
  const script = readTextFile('scripts/hide-workspace-window.ps1');
  assert.match(script, /FlashWindowEx/u);
  assert.match(script, /FLASHW_STOP/u);
  assert.match(script, /Clear-BmgProcessAttention \(\[uint32\]\$before\.processId\)/u);
  assert.match(script, /GetWindowThreadProcessId\(\$hWnd, \[ref\]\$windowProcessId\)/u);
  assert.match(script, /WS_EX_TOOLWINDOW/u);
  assert.match(script, /WS_EX_APPWINDOW/u);
  assert.match(script, /ParameterSetName = 'Hwnd'/u);
  assert.match(script, /BMG_BROWSER_MCP_WORKSPACE_V1/u);
  assert.match(script, /GetProp/u);
  assert.match(script, /SetProp/u);
  assert.match(script, /ShowWindowAsync\(\$target, 0\).*SW_HIDE/u);
  assert.match(script, /SWP_NOMOVE/u);
  assert.match(script, /SWP_NOSIZE/u);
  assert.match(script, /Multiple Edge windows matched/u);
  assert.match(script, /ProcessName -ne 'msedge'/u);
  assert.match(script, /ownership marker mismatch/u);
  assert.match(script, /hide unexpectedly changed window geometry/u);
  assert.doesNotMatch(script, /-32000/u);
  assert.doesNotMatch(script, /taskkill|Stop-Process|ProcessName -eq 'msedge'.*Stop/isu);

  const showScript = readTextFile('scripts/show-workspace-window.ps1');
  assert.match(showScript, /TargetHwnd/u);
  assert.match(showScript, /WindowMarker/u);
  assert.match(showScript, /GetProp/u);
  assert.match(showScript, /SetForegroundWindow/u);
  assert.match(showScript, /SWP_NOMOVE/u);
  assert.match(showScript, /SWP_NOSIZE/u);
  assert.match(showScript, /ProcessName -ne 'msedge'/u);
  assert.match(showScript, /show unexpectedly changed window geometry/u);
  assert.doesNotMatch(showScript, /GetSystemMetrics|-32000/u);
  assert.doesNotMatch(showScript, /taskkill|Stop-Process/iu);

  const ensureEdge = readTextFile('scripts/ensure-edge.ps1');
  assert.match(ensureEdge, /windowMarker = Get-Random/u);
  assert.match(ensureEdge, /hide-workspace-window\.ps1/u);
  assert.match(ensureEdge, /"-Nonce", \$nonce, "-WindowMarker"/u);
});

test('workspace returns to hidden mode after normal browser work resumes', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmg-workspace-visible-test-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const stateFile = path.join(rootDir, 'workspace.json');
  const transitions = [];
  const router = new BrowserWorkspaceRouter({
    enabled: true,
    stateFile,
    bootstrapUrl: 'http://localhost:12307/workspace-bootstrap',
    claimWindow: async () => ({ hwnd: 9503 }),
    ensureWindowHidden: async (hwnd) => { transitions.push(['hide', hwnd]); return { hidden: true }; },
    showWindow: async (hwnd) => { transitions.push(['show', hwnd]); return { foreground: true }; },
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
  assert.equal(shown.foreground, true);
  assert.deepEqual(transitions, [['show', 9503]]);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).visible, true);

  await router.observe(
    { method: 'tools/call', params: { name: 'chrome_navigate' } },
    workspaceToolMessage({ success: true, windowId: 9501, tabId: 9502 }),
  );
  assert.deepEqual(transitions, [['show', 9503], ['hide', 9503]]);
  assert.equal(router.visible, false);

  const hidden = await router.hideWorkspace();
  assert.equal(hidden.visible, false);
  assert.deepEqual(transitions[0], ['show', 9503]);
  assert.ok(transitions.length >= 3);
  assert.ok(transitions.slice(1).every((transition) => transition[0] === 'hide' && transition[1] === 9503));
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.deepEqual(
    { windowId: saved.windowId, tabId: saved.tabId, hwnd: saved.hwnd, visible: saved.visible },
    { windowId: 9501, tabId: 9502, hwnd: 9503, visible: false },
  );
});

test('workspace supplements hidden upstream file transfer tools', () => {
  assert.deepEqual(workspaceSupplementalToolsForTest.map((tool) => tool.name), ['chrome_upload_file', 'chrome_handle_download']);
  const upload = workspaceSupplementalToolsForTest.find((tool) => tool.name === 'chrome_upload_file');
  assert.deepEqual(upload.inputSchema.required, ['selector']);
  assert.equal('tabId' in upload.inputSchema.properties, false);
  assert.equal('windowId' in upload.inputSchema.properties, false);
  const download = workspaceSupplementalToolsForTest.find((tool) => tool.name === 'chrome_handle_download');
  assert.deepEqual(download.inputSchema.required, []);
});

test('workspace local MCP tools expose only explicit show and hide controls', () => {
  assert.deepEqual(
    workspaceLocalToolsForTest.map((tool) => tool.name),
    ['bmg_show_workspace', 'bmg_hide_workspace'],
  );
  for (const tool of workspaceLocalToolsForTest) {
    assert.deepEqual(tool.inputSchema, { type: 'object', properties: {}, additionalProperties: false });
  }
});


test('navigation patch keeps BMG browser work background-first and waits for settled URLs', () => {
  const background = readTextFile('extension/background.js');
  assert.match(background, /BMG_DEFAULT_BACKGROUND_V1/u);
  assert.match(background, /BMG_NAVIGATION_SETTLE_V2/u);
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

  await router.observe(
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

  await router.observe(
    background,
    workspaceToolMessage({ success: true, textContent: 'ok' }),
  );
  assert.deepEqual(transitions, [
    ['show', 8803],
    ['hide', 8803],
    ['hide', 8803],
  ]);
  assert.equal(router.visible, false);
});
