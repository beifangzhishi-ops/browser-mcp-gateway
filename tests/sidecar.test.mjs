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
import { OAuthStore, createPkceChallenge } from '../sidecar/oauth.mjs';
import {
  patchWebContentBackgroundText,
  patchWebContentHelperText,
} from '../scripts/patch-extension-web-content.mjs';

const ISSUER = 'https://bmg.example.test/bmg';
const RESOURCE = 'https://bmg.example.test/bmg/mcp';
const PROTECTED_METADATA =
  'https://bmg.example.test/.well-known/oauth-protected-resource/bmg/mcp';
const APPROVAL_SECRET = 'unit-test-approval-secret';

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
  assert.match(common, /Invoke-WebRequest/u);
  assert.doesNotMatch(common, /curl\\.exe/iu);
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
  assert.equal(createConfig({ readEnvFile: false, issuer: ISSUER, resource: RESOURCE }).port, 18007);
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
suffix`;
  const first = patchWebContentBackgroundText(backgroundFixture);
  assert.equal(first.changed, true);
  assert.match(first.text, /BMG_WEB_CONTENT_FALLBACK_V1/u);
  assert.match(first.text, /BMG_INTERACTIVE_WORKSPACE_TARGET_V1/u);
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

test('workspace router creates one background window and pins page tools to it', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmg-workspace-test-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const calls = [];
  const router = new BrowserWorkspaceRouter({
    enabled: true,
    stateFile: path.join(rootDir, 'workspace.json'),
    bootstrapUrl: 'http://localhost:12307/workspace-bootstrap',
    logger: { error() {}, log() {} },
    placeWindowOffscreen: async () => ({ hwnd: 7003 }),
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
  assert.equal(rewrittenRead.params.arguments.windowId, 7001);
  assert.equal(rewrittenRead.params.arguments.tabId, 7002);
  assert.equal(rewrittenRead.params.arguments.background, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(rootDir, 'workspace.json'), 'utf8')).hwnd, 7003);

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
});

test('workspace router narrows close-tabs to the GPT tab', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmg-workspace-close-test-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const router = new BrowserWorkspaceRouter({
    enabled: true,
    stateFile: path.join(rootDir, 'workspace.json'),
    bootstrapUrl: 'http://localhost:12307/workspace-bootstrap',
    placeWindowOffscreen: async () => ({ hwnd: 8103 }),
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


test('persisted workspace re-applies hidden window style on restore and navigation', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmg-workspace-restore-test-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const stateFile = path.join(rootDir, 'workspace.json');
  fs.writeFileSync(
    stateFile,
    JSON.stringify({ version: 1, windowId: 9101, tabId: 9102, hwnd: 9103 }),
    'utf8',
  );
  let hiddenCalls = 0;
  const router = new BrowserWorkspaceRouter({
    enabled: true,
    stateFile,
    bootstrapUrl: 'http://localhost:12307/workspace-bootstrap',
    ensureWindowHidden: async (hwnd) => {
      assert.equal(hwnd, 9103);
      hiddenCalls += 1;
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


test('legacy workspace state without HWND is retired and recreated exactly', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmg-workspace-legacy-test-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const stateFile = path.join(rootDir, 'workspace.json');
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, windowId: 9201, tabId: 9202 }), 'utf8');
  const calls = [];
  const router = new BrowserWorkspaceRouter({
    enabled: true,
    stateFile,
    bootstrapUrl: 'http://localhost:12307/workspace-bootstrap',
    placeWindowOffscreen: async () => ({ hwnd: 9303 }),
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === 'get_windows_and_tabs') {
        return workspaceToolMessage({ windows: [{ windowId: 9201, tabs: [{ tabId: 9202, active: true }] }] });
      }
      if (name === 'chrome_close_tabs') return workspaceToolMessage({ success: true, closedCount: 1 });
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
  assert.deepEqual(calls.map((call) => call.name), ['get_windows_and_tabs', 'chrome_close_tabs', 'chrome_navigate']);
  assert.equal(rewritten.params.arguments.windowId, 9301);
  assert.equal(rewritten.params.arguments.tabId, 9302);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).hwnd, 9303);
});

test('post-navigation hide maintenance failure does not turn a browser success into an error', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmg-workspace-observe-test-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const router = new BrowserWorkspaceRouter({
    enabled: true,
    stateFile: path.join(rootDir, 'workspace.json'),
    bootstrapUrl: 'http://localhost:12307/workspace-bootstrap',
    placeWindowOffscreen: async () => ({ hwnd: 9403 }),
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

test('workspace window script keeps Win32 hiding narrowly scoped', () => {
  const script = readTextFile('scripts/place-workspace-window-offscreen.ps1');
  assert.match(script, /WS_EX_TOOLWINDOW/u);
  assert.match(script, /WS_EX_APPWINDOW/u);
  assert.match(script, /ParameterSetName = 'Hwnd'/u);
  assert.match(script, /\[int64\]\$hWnd -ne \$TargetHwnd/u);
  assert.match(script, /Multiple Edge windows matched/u);
  assert.doesNotMatch(script, /ExistingOffscreen/u);
  assert.match(script, /SWP_NOACTIVATE/u);
  assert.match(script, /ProcessName -ne 'msedge'/u);
  assert.doesNotMatch(script, /taskkill|Stop-Process|ProcessName -eq 'msedge'.*Stop/isu);
  const showScript = readTextFile('scripts/show-workspace-window.ps1');
  assert.match(showScript, /TargetHwnd/u);
  assert.match(showScript, /SetForegroundWindow/u);
  assert.match(showScript, /WS_EX_TOOLWINDOW/u);
  assert.match(showScript, /WS_EX_APPWINDOW/u);
  assert.match(showScript, /ProcessName -ne 'msedge'/u);
  assert.doesNotMatch(showScript, /taskkill|Stop-Process/iu);
});

test('workspace show and hide preserve one exact window and explicit visibility state', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmg-workspace-visible-test-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const stateFile = path.join(rootDir, 'workspace.json');
  const transitions = [];
  const router = new BrowserWorkspaceRouter({
    enabled: true,
    stateFile,
    bootstrapUrl: 'http://localhost:12307/workspace-bootstrap',
    placeWindowOffscreen: async () => ({ hwnd: 9503 }),
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
  assert.deepEqual(transitions, [['show', 9503]], 'visible workspace must not auto-hide after navigation');

  const hidden = await router.hideWorkspace();
  assert.equal(hidden.visible, false);
  assert.deepEqual(transitions, [['show', 9503], ['hide', 9503]]);
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
