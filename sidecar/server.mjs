import fs from 'node:fs';
import { execFile } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadConfig } from './config.mjs';
import { BrowserWorkspaceRouter } from './workspace.mjs';
import {
  OAuthError,
  OAuthStore,
  OAUTH_SCOPE,
  constantTimeEqual,
  createPkceChallenge,
} from './oauth.mjs';

const execFileAsync = promisify(execFile);
const MAX_BODY_BYTES = 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 120000;
const MAX_UPSTREAM_RESPONSE_BYTES = 8 * 1024 * 1024;
const REGISTRATION_RATE_LIMIT = 20;
const REGISTRATION_RATE_WINDOW_MS = 60 * 1000;
const MCP_SESSION_HEADER = 'mcp-session-id';
const WORKSPACE_BOOTSTRAP_PATH = '/workspace-bootstrap';
const REQUEST_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'authorization',
]);
const RESPONSE_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const AUTHORIZATION_PATH = '/bmg/authorize';
const TOKEN_PATH = '/bmg/token';
const REGISTER_PATH = '/bmg/register';
const REVOKE_PATH = '/bmg/revoke';
const CONSENT_PATH = '/bmg/oauth/consent';
const MCP_PATH = '/bmg/mcp';
const AUTHORIZATION_DISCOVERY_PATHS = new Set([
  '/.well-known/oauth-authorization-server/bmg',
  '/bmg/.well-known/oauth-authorization-server',
]);
const RESOURCE_DISCOVERY_PATHS = new Set([
  '/.well-known/oauth-protected-resource/bmg/mcp',
  '/bmg/mcp/.well-known/oauth-protected-resource',
]);

const WORKSPACE_LOCAL_TOOLS = [
  {
    name: 'bmg_show_workspace',
    description:
      'Bring the dedicated BMG Edge workspace to the foreground for manual login, QR scan, CAPTCHA, or verification. Only the tracked GPT workspace window is affected.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'bmg_hide_workspace',
    description:
      'Return the dedicated BMG Edge workspace to hidden off-screen background mode after manual interaction. Only the tracked GPT workspace window is affected.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];
const WORKSPACE_SUPPLEMENTAL_UPSTREAM_TOOLS = [
  {
    name: 'chrome_upload_file',
    description:
      'Upload a local, URL, or base64-backed file directly into an input[type=file] in the dedicated BMG workspace via CDP, bypassing the Windows file picker.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector for input[type=file]' },
        filePath: { type: 'string', description: 'Absolute local file path on the BMG Windows machine' },
        fileUrl: { type: 'string', description: 'URL to download to a temporary local file before upload' },
        base64Data: { type: 'string', description: 'Base64-encoded file data to upload' },
        fileName: { type: 'string', description: 'Filename for URL/base64 uploads' },
        multiple: { type: 'boolean', description: 'Whether the input accepts multiple files' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'chrome_handle_download',
    description:
      'Wait for a browser-managed download and return its local filename, URL, state, and size.',
    inputSchema: {
      type: 'object',
      properties: {
        filenameContains: { type: 'string', description: 'Filter by filename or URL substring' },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds (default 60000, max 300000)' },
        waitForComplete: { type: 'boolean', description: 'Wait until the download completes (default true)' },
      },
      required: [],
    },
  },
];
const WORKSPACE_ADDITIONAL_TOOLS = [
  ...WORKSPACE_LOCAL_TOOLS,
  ...WORKSPACE_SUPPLEMENTAL_UPSTREAM_TOOLS,
];
const WORKSPACE_LOCAL_TOOL_NAMES = new Set(WORKSPACE_LOCAL_TOOLS.map((tool) => tool.name));

function logMessage(logger, method, message) {
  if (logger && typeof logger[method] === 'function') {
    logger[method](message);
  }
}

function setNoStore(response) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Pragma', 'no-cache');
}

function setCors(response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Session-Id');
}

function createRegistrationLimiter({ limit = REGISTRATION_RATE_LIMIT, windowMs = REGISTRATION_RATE_WINDOW_MS } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(windowMs) || windowMs < 1000) {
    throw new Error('Registration rate limit configuration is invalid.');
  }
  const timestamps = [];
  return {
    consume(now = Date.now()) {
      const cutoff = now - windowMs;
      while (timestamps.length > 0 && timestamps[0] <= cutoff) timestamps.shift();
      if (timestamps.length >= limit) {
        const retryAfterSeconds = Math.max(1, Math.ceil((timestamps[0] + windowMs - now) / 1000));
        return { allowed: false, retryAfterSeconds };
      }
      timestamps.push(now);
      return { allowed: true, retryAfterSeconds: 0 };
    },
  };
}

function sendJson(response, status, payload, options = {}) {
  const body = JSON.stringify(payload);
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (options.noStore) {
    setNoStore(response);
  }
  if (options.cors) {
    setCors(response);
  }
  response.end(body);
}

function sendHtml(response, status, body) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  setNoStore(response);
  response.end(body);
}

function readBody(request, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    const fail = (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    request.on('data', (chunk) => {
      if (settled) {
        return;
      }
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        request.resume();
        fail(new OAuthError('invalid_request', 'Request body is too large.', 413));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
    request.on('aborted', () => {
      fail(new OAuthError('invalid_request', 'Request was aborted.'));
    });
    request.on('error', () => {
      fail(new OAuthError('invalid_request', 'Request body could not be read.'));
    });
  });
}

function getContentType(request) {
  return String(request.headers['content-type'] || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
}

async function readJson(request) {
  const body = await readBody(request);
  try {
    return JSON.parse(body);
  } catch {
    throw new OAuthError('invalid_request', 'Request body must be valid JSON.');
  }
}

async function readForm(request) {
  const body = await readBody(request);
  return new URLSearchParams(body);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderConsentPage(request) {
  const fields = [
    ['client_id', request.clientId],
    ['redirect_uri', request.redirectUri],
    ['response_type', 'code'],
    ['code_challenge', request.codeChallenge],
    ['code_challenge_method', request.codeChallengeMethod],
    ['resource', request.resource],
    ['scope', request.scope],
  ];
  if (request.state) {
    fields.push(['state', request.state]);
  }
  const hiddenFields = fields
    .map(
      ([name, value]) =>
        '<input type="hidden" name="' +
        escapeHtml(name) +
        '" value="' +
        escapeHtml(value) +
        '">',
    )
    .join('');
  const clientLabel = request.clientName
    ? '<p>请求方：' + escapeHtml(request.clientName) + '</p>'
    : '';
  return (
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>BMG 授权</title></head><body>' +
    '<main><h1>BMG 浏览器网关授权</h1>' +
    clientLabel +
    '<p>确认允许该客户端访问浏览器 MCP 工具后，输入本机 approval secret。</p>' +
    '<form method="post" action="' +
    CONSENT_PATH +
    '">' +
    hiddenFields +
    '<label>Approval secret <input name="approval_secret" type="password" ' +
    'autocomplete="off" required></label>' +
    '<button type="submit">批准并继续</button></form></main></body></html>'
  );
}

function parseBearerToken(request) {
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string') {
    return null;
  }
  const match = authorization.match(/^Bearer ([A-Za-z0-9._~-]+)$/u);
  return match ? match[1] : null;
}

function sendUnauthorized(response, config) {
  response.setHeader(
    'WWW-Authenticate',
    'Bearer resource_metadata="' + config.protectedResourceMetadataUrl + '"',
  );
  sendJson(response, 401, { error: 'invalid_token' }, { noStore: true });
}

function buildAuthorizationServerMetadata(config) {
  return {
    issuer: config.issuer,
    authorization_endpoint: config.issuer + AUTHORIZATION_PATH.slice('/bmg'.length),
    token_endpoint: config.issuer + TOKEN_PATH.slice('/bmg'.length),
    registration_endpoint: config.issuer + REGISTER_PATH.slice('/bmg'.length),
    revocation_endpoint: config.issuer + REVOKE_PATH.slice('/bmg'.length),
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: [OAUTH_SCOPE],
    resource_indicators_supported: true,
  };
}

function buildProtectedResourceMetadata(config) {
  return {
    resource: config.resource,
    authorization_servers: [config.issuer],
    bearer_methods_supported: ['header'],
    scopes_supported: [OAUTH_SCOPE],
  };
}

function validateScope(scopeValue) {
  const scope = scopeValue || OAUTH_SCOPE;
  const scopes = scope.split(/\s+/u).filter(Boolean);
  if (scopes.length !== 1 || scopes[0] !== OAUTH_SCOPE) {
    throw new OAuthError('invalid_scope', 'Only the mcp scope is supported.');
  }
  return OAUTH_SCOPE;
}

function validateAuthorizationRequest(parameters, runtime) {
  const clientId = parameters.get('client_id');
  const client = runtime.store.getClient(clientId);
  if (!client) {
    throw new OAuthError('invalid_client', 'OAuth client is not registered.');
  }
  const redirectUri = parameters.get('redirect_uri');
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
    throw new OAuthError('invalid_request', 'redirect_uri is not registered.');
  }
  if (parameters.get('response_type') !== 'code') {
    throw new OAuthError('unsupported_response_type', 'Only response_type=code is supported.');
  }
  const codeChallenge = parameters.get('code_challenge');
  const codeChallengeMethod = parameters.get('code_challenge_method');
  if (
    !codeChallenge ||
    !/^[A-Za-z0-9_-]{43,128}$/u.test(codeChallenge) ||
    codeChallengeMethod !== 'S256'
  ) {
    throw new OAuthError('invalid_request', 'PKCE S256 is required.');
  }
  const resource = parameters.get('resource') || runtime.config.resource;
  if (resource !== runtime.config.resource) {
    throw new OAuthError('invalid_target', 'The requested resource is not supported.');
  }
  const state = parameters.get('state') || '';
  if (state.length > 2048) {
    throw new OAuthError('invalid_request', 'state is too long.');
  }
  return {
    clientId,
    clientName: client.clientName,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    resource,
    scope: validateScope(parameters.get('scope')),
    state,
  };
}

function sendOAuthError(response, error) {
  const oauthError =
    error instanceof OAuthError
      ? error
      : new OAuthError('server_error', 'OAuth request could not be completed.', 500);
  sendJson(
    response,
    oauthError.status,
    { error: oauthError.code, error_description: oauthError.description },
    { noStore: true, cors: true },
  );
}

function sendAuthorizationRedirectError(response, redirectUri, state, error) {
  const oauthError =
    error instanceof OAuthError
      ? error
      : new OAuthError('server_error', 'OAuth request could not be completed.', 500);
  const location = new URL(redirectUri);
  location.searchParams.set('error', oauthError.code);
  if (state) {
    location.searchParams.set('state', state);
  }
  response.statusCode = 302;
  response.setHeader('Location', location.toString());
  setNoStore(response);
  response.end();
}

async function handleAuthorization(request, response, runtime, url) {
  const parameters = url.searchParams;
  const client = runtime.store.getClient(parameters.get('client_id'));
  const redirectUri = parameters.get('redirect_uri');
  const safeRedirect =
    client && redirectUri && client.redirectUris.includes(redirectUri) ? redirectUri : null;
  try {
    const authorizationRequest = validateAuthorizationRequest(parameters, runtime);
    const consentUrl = new URL(runtime.config.issuer + '/oauth/consent');
    const consentFields = [
      'client_id',
      'redirect_uri',
      'response_type',
      'code_challenge',
      'code_challenge_method',
      'resource',
      'scope',
      'state',
    ];
    for (const field of consentFields) {
      const value = parameters.get(field);
      if (value !== null) {
        consentUrl.searchParams.set(field, value);
      }
    }
    response.statusCode = 302;
    response.setHeader('Location', consentUrl.toString());
    setNoStore(response);
    response.end();
    return authorizationRequest;
  } catch (error) {
    if (safeRedirect) {
      sendAuthorizationRedirectError(response, safeRedirect, parameters.get('state') || '', error);
    } else {
      sendOAuthError(response, error);
    }
    return null;
  }
}

async function handleConsent(request, response, runtime, url) {
  let parameters = url.searchParams;
  let approvalSecret = '';
  if (request.method === 'POST') {
    const form = await readForm(request);
    parameters = form;
    approvalSecret = form.get('approval_secret') || '';
  }
  let authorizationRequest;
  try {
    authorizationRequest = validateAuthorizationRequest(parameters, runtime);
  } catch (error) {
    sendOAuthError(response, error);
    return;
  }
  if (request.method === 'GET') {
    sendHtml(response, 200, renderConsentPage(authorizationRequest));
    return;
  }
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'GET, POST');
    sendJson(response, 405, { error: 'method_not_allowed' }, { noStore: true });
    return;
  }
  if (
    !runtime.approvalSecret ||
    !constantTimeEqual(approvalSecret, runtime.approvalSecret)
  ) {
    sendHtml(response, 403, '<!doctype html><meta charset="utf-8"><p>批准密钥不正确。</p>');
    return;
  }
  const code = runtime.store.createAuthorizationCode(authorizationRequest);
  const location = new URL(authorizationRequest.redirectUri);
  location.searchParams.set('code', code);
  if (authorizationRequest.state) {
    location.searchParams.set('state', authorizationRequest.state);
  }
  response.statusCode = 302;
  response.setHeader('Location', location.toString());
  setNoStore(response);
  response.end();
}

async function handleRegistration(request, response, runtime) {
  const registration = runtime.registrationLimiter.consume();
  if (!registration.allowed) {
    response.setHeader('Retry-After', String(registration.retryAfterSeconds));
    sendOAuthError(
      response,
      new OAuthError('temporarily_unavailable', 'Too many client registration requests.', 429),
    );
    return;
  }
  if (getContentType(request) !== 'application/json') {
    sendOAuthError(response, new OAuthError('invalid_request', 'JSON registration is required.'));
    return;
  }
  try {
    const metadata = await readJson(request);
    const client = runtime.store.registerClient(metadata);
    sendJson(
      response,
      201,
      {
        client_id: client.clientId,
        client_id_issued_at: Math.floor(client.createdAt / 1000),
        redirect_uris: client.redirectUris,
        grant_types: client.grantTypes,
        response_types: client.responseTypes,
        token_endpoint_auth_method: client.tokenEndpointAuthMethod,
        client_name: client.clientName || undefined,
      },
      { noStore: true, cors: true },
    );
  } catch (error) {
    sendOAuthError(response, error);
  }
}

async function handleToken(request, response, runtime) {
  if (getContentType(request) !== 'application/x-www-form-urlencoded') {
    sendOAuthError(
      response,
      new OAuthError('invalid_request', 'Form encoded token requests are required.'),
    );
    return;
  }
  try {
    const form = await readForm(request);
    const grantType = form.get('grant_type');
    const clientId = form.get('client_id');
    if (!runtime.store.getClient(clientId)) {
      throw new OAuthError('invalid_client', 'OAuth client is not registered.');
    }
    const resource = form.get('resource') || runtime.config.resource;
    if (resource !== runtime.config.resource) {
      throw new OAuthError('invalid_target', 'The requested resource is not supported.');
    }
    let result;
    if (grantType === 'authorization_code') {
      const codeVerifier = form.get('code_verifier') || '';
      if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(codeVerifier)) {
        throw new OAuthError('invalid_grant', 'Authorization code or verifier is invalid.');
      }
      result = runtime.store.exchangeAuthorizationCode({
        code: form.get('code'),
        clientId,
        redirectUri: form.get('redirect_uri'),
        codeVerifier,
        resource,
        tokenTtlSeconds: runtime.config.tokenTtlSeconds,
      });
    } else if (grantType === 'refresh_token') {
      const scope = form.has('scope') ? validateScope(form.get('scope')) : null;
      result = runtime.store.exchangeRefreshToken({
        refreshToken: form.get('refresh_token'),
        clientId,
        resource,
        scope,
        tokenTtlSeconds: runtime.config.tokenTtlSeconds,
      });
    } else {
      throw new OAuthError(
        'unsupported_grant_type',
        'Only authorization_code and refresh_token are supported.',
      );
    }
    sendJson(
      response,
      200,
      {
        access_token: result.accessToken,
        token_type: 'Bearer',
        expires_in: result.expiresIn,
        refresh_token: result.refreshToken,
        scope: result.scope,
        resource: result.resource,
      },
      { noStore: true, cors: true },
    );
  } catch (error) {
    sendOAuthError(response, error);
  }
}

async function handleRevocation(request, response, runtime) {
  try {
    const body =
      getContentType(request) === 'application/json'
        ? await readJson(request)
        : Object.fromEntries((await readForm(request)).entries());
    runtime.store.revokeToken(body.token);
    response.statusCode = 200;
    setNoStore(response);
    response.end();
  } catch (error) {
    sendOAuthError(response, error);
  }
}

async function placeWorkspaceWindowOffscreen(rootDir, nonce) {
  const script = path.join(rootDir, 'scripts', 'place-workspace-window-offscreen.ps1');
  const result = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Nonce', nonce],
    { cwd: rootDir, windowsHide: true, timeout: 10000 },
  );
  const lines = String(result.stdout || '').trim().split(/\r?\n/u).filter(Boolean);
  const placement = JSON.parse(lines.at(-1) || '{}');
  if (!Number.isInteger(placement.hwnd) || placement.hwnd <= 0) {
    throw new Error('BMG workspace HWND was not returned by the window helper.');
  }
  return placement;
}

function parseWindowHelperResult(stdout) {
  const lines = String(stdout || '').trim().split(/\r?\n/u).filter(Boolean);
  const result = JSON.parse(lines.at(-1) || '{}');
  if (!Number.isInteger(result.hwnd) || result.hwnd <= 0) {
    throw new Error('BMG workspace HWND helper returned an invalid result.');
  }
  return result;
}

async function ensureWorkspaceWindowHidden(rootDir, hwnd) {
  if (!Number.isInteger(hwnd) || hwnd <= 0) {
    throw new Error('BMG workspace HWND is invalid.');
  }
  const script = path.join(rootDir, 'scripts', 'place-workspace-window-offscreen.ps1');
  const result = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-TargetHwnd', String(hwnd)],
    { cwd: rootDir, windowsHide: true, timeout: 10000 },
  );
  return { ...parseWindowHelperResult(result.stdout), hidden: true };
}

async function showWorkspaceWindow(rootDir, hwnd) {
  if (!Number.isInteger(hwnd) || hwnd <= 0) {
    throw new Error('BMG workspace HWND is invalid.');
  }
  const script = path.join(rootDir, 'scripts', 'show-workspace-window.ps1');
  const result = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-TargetHwnd', String(hwnd)],
    { cwd: rootDir, windowsHide: true, timeout: 10000 },
  );
  return parseWindowHelperResult(result.stdout);
}

function sendWorkspaceBootstrap(response, nonce) {
  if (!/^[A-Za-z0-9._-]{1,100}$/u.test(nonce)) {
    sendJson(response, 400, { error: 'invalid_workspace_nonce' }, { noStore: true });
    return;
  }
  const title = 'BMG GPT Workspace ' + nonce;
  response.statusCode = 200;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  response.end(
    '<!doctype html><meta charset="utf-8"><title>' +
      title +
      '</title><style>body{font-family:system-ui;margin:2rem}</style><p>BMG GPT workspace</p>',
  );
}

function getUpstreamRequestPath(runtime, url) {
  const upstreamUrl = new URL(runtime.upstreamUrl);
  const basePath = upstreamUrl.pathname.replace(/\/+$/u, '');
  return basePath + '/mcp' + url.search;
}

function buildUpstreamHeaders(sourceHeaders, body, sessionId = null) {
  const headers = {};
  for (const [name, value] of Object.entries(sourceHeaders)) {
    if (
      REQUEST_HOP_HEADERS.has(name) ||
      name === MCP_SESSION_HEADER ||
      name === 'content-length'
    ) {
      continue;
    }
    headers[name] = value;
  }
  if (body !== null && body !== undefined) {
    headers['content-length'] = Buffer.byteLength(body);
  }
  if (sessionId) {
    headers[MCP_SESSION_HEADER] = sessionId;
  }
  return headers;
}

function requestUpstreamBuffer(runtime, method, url, headers, body = null) {
  const upstreamUrl = new URL(runtime.upstreamUrl);
  return new Promise((resolve, reject) => {
    let settled = false;
    const upstreamRequest = http.request(
      {
        hostname: upstreamUrl.hostname,
        port: Number(upstreamUrl.port || 80),
        method,
        path: getUpstreamRequestPath(runtime, url),
        headers,
        timeout: UPSTREAM_TIMEOUT_MS,
      },
      (upstreamResponse) => {
        const chunks = [];
        let totalBytes = 0;
        upstreamResponse.on('data', (chunk) => {
          totalBytes += chunk.length;
          if (totalBytes > MAX_UPSTREAM_RESPONSE_BYTES) {
            upstreamResponse.destroy(new Error('upstream response is too large'));
            return;
          }
          chunks.push(chunk);
        });
        upstreamResponse.on('end', () => {
          if (settled) {
            return;
          }
          settled = true;
          resolve({
            statusCode: upstreamResponse.statusCode || 502,
            headers: upstreamResponse.headers,
            body: Buffer.concat(chunks),
          });
        });
        upstreamResponse.on('error', (error) => {
          if (!settled) {
            settled = true;
            reject(error);
          }
        });
      },
    );
    upstreamRequest.on('timeout', () => {
      upstreamRequest.destroy(new Error('upstream timeout'));
    });
    upstreamRequest.on('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    if (body === null || body === undefined) {
      upstreamRequest.end();
    } else {
      upstreamRequest.end(body);
    }
  });
}

function sendUpstreamResponse(response, upstreamResponse) {
  response.statusCode = upstreamResponse.statusCode || 502;
  for (const [name, value] of Object.entries(upstreamResponse.headers || {})) {
    if (
      !RESPONSE_HOP_HEADERS.has(name) &&
      name.toLowerCase() !== 'content-length' &&
      value !== undefined
    ) {
      response.setHeader(name, value);
    }
  }
  const body = upstreamResponse.body || Buffer.alloc(0);
  response.setHeader('Content-Length', String(Buffer.byteLength(body)));
  response.end(body);
}

function parseUpstreamMessage(body) {
  const text = body.toString('utf8');
  const dataLine = text
    .split(/\r?\n/u)
    .find((line) => line.startsWith('data:'));
  const jsonText = dataLine ? dataLine.slice('data:'.length).trim() : text.trim();
  if (!jsonText) {
    return null;
  }
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

function augmentWorkspaceTools(upstreamResponse, enabled) {
  if (!enabled || upstreamResponse.statusCode !== 200) return upstreamResponse;
  const message = parseUpstreamMessage(upstreamResponse.body);
  if (!Array.isArray(message?.result?.tools)) return upstreamResponse;
  const existing = new Set(message.result.tools.map((tool) => tool?.name));
  message.result.tools = [
    ...message.result.tools,
    ...WORKSPACE_ADDITIONAL_TOOLS.filter((tool) => !existing.has(tool.name)),
  ];
  const headers = { ...(upstreamResponse.headers || {}) };
  delete headers['content-length'];
  return {
    ...upstreamResponse,
    headers,
    body: Buffer.from('event: message\ndata: ' + JSON.stringify(message) + '\n\n', 'utf8'),
  };
}

function sendLocalToolResult(response, payload, data, isError, sessionId) {
  const message = {
    jsonrpc: '2.0',
    id: payload.id,
    result: {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      isError: isError === true,
    },
  };
  response.statusCode = 200;
  response.setHeader('Content-Type', 'text/event-stream');
  response.setHeader('Cache-Control', 'no-cache');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (sessionId) response.setHeader('Mcp-Session-Id', sessionId);
  response.end('event: message\ndata: ' + JSON.stringify(message) + '\n\n');
}

async function handleWorkspaceLocalTool(response, payload, runtime) {
  const name = payload?.params?.name;
  if (!WORKSPACE_LOCAL_TOOL_NAMES.has(name)) return false;
  try {
    const result =
      name === 'bmg_show_workspace'
        ? await runtime.workspace.showWorkspace()
        : await runtime.workspace.hideWorkspace();
    sendLocalToolResult(response, payload, { success: true, ...result }, false, runtime.upstreamSession.sessionId);
  } catch (error) {
    sendLocalToolResult(
      response,
      payload,
      { success: false, error: String(error?.message || 'workspace control failed') },
      true,
      runtime.upstreamSession.sessionId,
    );
  }
  return true;
}

function sendCachedInitialize(response, requestPayload, session) {
  const message = {
    ...session.initializeMessage,
    id: requestPayload.id,
  };
  response.statusCode = 200;
  response.setHeader('Content-Type', 'text/event-stream');
  response.setHeader('Cache-Control', 'no-cache');
  response.setHeader('Mcp-Session-Id', session.sessionId);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end('event: message\ndata: ' + JSON.stringify(message) + '\n\n');
}

const UPSTREAM_SESSION_STATE_VERSION = 1;

function loadUpstreamSession(file, upstreamUrl) {
  if (!file || !fs.existsSync(file)) {
    return null;
  }
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (
      !state ||
      state.version !== UPSTREAM_SESSION_STATE_VERSION ||
      state.upstreamUrl !== upstreamUrl ||
      typeof state.sessionId !== 'string' ||
      !state.sessionId ||
      !state.initializeMessage ||
      typeof state.initializeMessage !== 'object' ||
      !state.initializeMessage.result
    ) {
      return null;
    }
    return {
      sessionId: state.sessionId,
      initializeMessage: state.initializeMessage,
    };
  } catch {
    return null;
  }
}

function saveUpstreamSession(file, upstreamUrl, sessionId, initializeMessage) {
  if (!file) {
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporaryFile = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(
    temporaryFile,
    JSON.stringify({
      version: UPSTREAM_SESSION_STATE_VERSION,
      upstreamUrl,
      sessionId,
      initializeMessage,
    }),
    { encoding: 'utf8', mode: 0o600 },
  );
  fs.renameSync(temporaryFile, file);
}

function removeUpstreamSession(file) {
  if (!file) {
    return;
  }
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      throw error;
    }
  }
}

function isInvalidUpstreamSession(response) {
  if (response.statusCode === 404) {
    return true;
  }
  if (response.statusCode !== 400) {
    return false;
  }
  const text = response.body.toString('utf8').toLowerCase();
  return (
    text.includes('session') &&
    (text.includes('invalid') || text.includes('not found') || text.includes('no transport'))
  );
}

class UpstreamHttpError extends Error {
  constructor(message, response) {
    super(message);
    this.name = 'UpstreamHttpError';
    this.response = response;
  }
}

class UpstreamSessionManager {
  constructor(runtime) {
    this.runtime = runtime;
    const persisted = loadUpstreamSession(
      runtime.config.upstreamSessionFile,
      runtime.upstreamUrl,
    );
    this.sessionId = persisted?.sessionId || null;
    this.initializeMessage = persisted?.initializeMessage || null;
    this.initializeRequest = null;
    this.initializing = null;
  }

  async initializeFromRequest(requestHeaders, payload) {
    if (!this.initializeRequest) {
      this.initializeRequest = {
        headers: buildUpstreamHeaders(requestHeaders, null),
        payload,
      };
    }
    return this.ensureSession();
  }

  async ensureSession() {
    if (this.sessionId && this.initializeMessage) {
      return {
        sessionId: this.sessionId,
        initializeMessage: this.initializeMessage,
      };
    }
    if (this.initializing) {
      return this.initializing;
    }
    if (!this.initializeRequest) {
      throw new Error('MCP initialize is required before other requests.');
    }
    const initialization = this.createSession();
    this.initializing = initialization;
    try {
      return await initialization;
    } finally {
      if (this.initializing === initialization) {
        this.initializing = null;
      }
    }
  }

  async createSession() {
    const body = JSON.stringify(this.initializeRequest.payload);
    const response = await requestUpstreamBuffer(
      this.runtime,
      'POST',
      new URL(MCP_PATH, 'http://127.0.0.1'),
      buildUpstreamHeaders(this.initializeRequest.headers, body),
      body,
    );
    if (response.statusCode !== 200) {
      throw new UpstreamHttpError('Upstream initialize failed.', response);
    }
    const message = parseUpstreamMessage(response.body);
    const sessionId = response.headers[MCP_SESSION_HEADER];
    if (!message || !message.result || typeof sessionId !== 'string' || !sessionId) {
      throw new Error('Upstream initialize response was incomplete.');
    }
    this.sessionId = sessionId;
    this.initializeMessage = message;
    saveUpstreamSession(
      this.runtime.config.upstreamSessionFile,
      this.runtime.upstreamUrl,
      sessionId,
      message,
    );
    return { sessionId, initializeMessage: message };
  }

  invalidate(sessionId) {
    if (sessionId && this.sessionId !== sessionId) {
      return;
    }
    this.sessionId = null;
    this.initializeMessage = null;
    removeUpstreamSession(this.runtime.config.upstreamSessionFile);
  }

  async request(requestHeaders, url, body) {
    const session = await this.ensureSession();
    let response = await requestUpstreamBuffer(
      this.runtime,
      'POST',
      url,
      buildUpstreamHeaders(requestHeaders, body, session.sessionId),
      body,
    );
    if (isInvalidUpstreamSession(response)) {
      this.invalidate(session.sessionId);
      const refreshedSession = await this.ensureSession();
      response = await requestUpstreamBuffer(
        this.runtime,
        'POST',
        url,
        buildUpstreamHeaders(requestHeaders, body, refreshedSession.sessionId),
        body,
      );
    }
    return response;
  }

  async callTool(name, args = {}) {
    const payload = {
      jsonrpc: '2.0',
      id: `bmg-workspace-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      method: 'tools/call',
      params: { name, arguments: args },
    };
    const body = JSON.stringify(payload);
    const response = await this.request(
      {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      new URL(MCP_PATH, 'http://127.0.0.1'),
      body,
    );
    if (response.statusCode !== 200) {
      throw new UpstreamHttpError('Upstream internal tool call failed.', response);
    }
    const message = parseUpstreamMessage(response.body);
    if (!message || message.error) {
      throw new Error('Upstream internal tool call returned an invalid response.');
    }
    return message;
  }

  async close() {
    if (this.initializing) {
      try {
        await this.initializing;
      } catch {}
    }
  }
}

async function handleProtectedMcp(request, response, runtime, url) {
  const accessToken = parseBearerToken(request);
  if (!accessToken || !runtime.store.validateAccessToken(accessToken, runtime.config.resource)) {
    sendUnauthorized(response, runtime.config);
    return;
  }
  if (!['GET', 'POST', 'DELETE'].includes(request.method)) {
    response.setHeader('Allow', 'GET, POST, DELETE');
    sendJson(response, 405, { error: 'method_not_allowed' }, { noStore: true });
    return;
  }
  try {
    if (request.method === 'DELETE') {
      response.statusCode = 204;
      setNoStore(response);
      response.end();
      return;
    }
    if (request.method === 'GET') {
      const session = await runtime.upstreamSession.ensureSession();
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/event-stream');
      response.setHeader('Cache-Control', 'no-cache');
      response.setHeader('Connection', 'keep-alive');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Mcp-Session-Id', session.sessionId);
      response.flushHeaders();
      response.write(': connected\n\n');
      const keepAlive = setInterval(() => {
        if (!response.writableEnded) {
          response.write(': keepalive\n\n');
        }
      }, 15000);
      keepAlive.unref?.();
      const cleanup = () => clearInterval(keepAlive);
      request.on('aborted', cleanup);
      response.on('close', cleanup);
      return;
    }
    const body = await readBody(request);
    let payload = null;
    try {
      payload = JSON.parse(body);
    } catch {}
    if (payload && payload.method === 'initialize') {
      const initialized = await runtime.upstreamSession.initializeFromRequest(
        request.headers,
        payload,
      );
      sendCachedInitialize(response, payload, initialized);
      return;
    }
    if (
      payload?.method === 'tools/call' &&
      runtime.workspace?.enabled &&
      WORKSPACE_LOCAL_TOOL_NAMES.has(payload.params?.name)
    ) {
      await handleWorkspaceLocalTool(response, payload, runtime);
      return;
    }
    let forwardedPayload = payload;
    let forwardedBody = body;
    if (payload && payload.method === 'tools/call' && runtime.workspace) {
      forwardedPayload = await runtime.workspace.rewrite(payload);
      forwardedBody = JSON.stringify(forwardedPayload);
    }
    const upstreamResponse = await runtime.upstreamSession.request(
      request.headers,
      url,
      forwardedBody,
    );
    if (runtime.workspace && forwardedPayload?.method === 'tools/call') {
      await runtime.workspace.observe(
        forwardedPayload,
        parseUpstreamMessage(upstreamResponse.body),
      );
    }
    const responseToSend =
      payload?.method === 'tools/list'
        ? augmentWorkspaceTools(upstreamResponse, runtime.workspace?.enabled === true)
        : upstreamResponse;
    sendUpstreamResponse(response, responseToSend);
  } catch (error) {
    if (error instanceof UpstreamHttpError) {
      sendUpstreamResponse(response, error.response);
      return;
    }
    if (error instanceof OAuthError) {
      sendOAuthError(response, error);
      return;
    }
    if (error instanceof Error && error.message.includes('MCP initialize is required')) {
      sendJson(response, 409, { error: 'mcp_initialize_required' }, { noStore: true });
      return;
    }
    sendJson(response, 502, { error: 'upstream_unavailable' }, { noStore: true });
  }
}

async function handleRequest(request, response, runtime) {
  const url = new URL(request.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/internal/ensure-workspace') {
    const address = runtime.server.address();
    const localHost = `127.0.0.1:${address.port}`;
    if (
      request.method !== 'POST' ||
      request.socket.remoteAddress !== '127.0.0.1' ||
      request.headers.host !== localHost ||
      request.headers.origin !== undefined ||
      !constantTimeEqual(request.headers['x-bmg-local-secret'] || '', runtime.approvalSecret)
    ) {
      sendJson(response, 403, { error: 'forbidden' }, { noStore: true });
      return;
    }
    if (!runtime.workspace.enabled) {
      sendJson(response, 409, { error: 'workspace_disabled' }, { noStore: true });
      return;
    }
    try {
      if (!runtime.preparingWorkspace) {
        runtime.preparingWorkspace = (async () => {
          await runtime.upstreamSession.initializeFromRequest({}, {
            jsonrpc: '2.0', id: 'bmg-startup', method: 'initialize',
            params: {
              protocolVersion: '2025-03-26', capabilities: {},
              clientInfo: { name: 'bmg-startup', version: '1.0.0' },
            },
          });
          runtime.workspace.markActivity();
          return runtime.workspace.ensureWorkspace({ revalidate: true });
        })().finally(() => { runtime.preparingWorkspace = null; });
      }
      const workspace = await runtime.preparingWorkspace;
      sendJson(response, 200, { success: true, workspace }, { noStore: true });
    } catch {
      sendJson(response, 503, { error: 'workspace_unavailable' }, { noStore: true });
    }
    return;
  }
  if (request.method === 'OPTIONS') {
    setCors(response);
    response.statusCode = 204;
    response.end();
    return;
  }
  if (url.pathname === WORKSPACE_BOOTSTRAP_PATH && request.method === 'GET') {
    sendWorkspaceBootstrap(response, url.searchParams.get('nonce') || '');
    return;
  }
  if (url.pathname === '/health' && request.method === 'GET') {
    const address = runtime.server.address();
    const actualPort = address && typeof address === 'object' ? address.port : runtime.config.port;
    sendJson(response, 200, {
      status: 'ok',
      service: 'bmg-sidecar',
      host: runtime.config.host,
      port: actualPort,
      issuer: runtime.config.issuer,
      resource: runtime.config.resource,
      upstream: runtime.config.upstreamUrl,
    });
    return;
  }
  if (AUTHORIZATION_DISCOVERY_PATHS.has(url.pathname) && request.method === 'GET') {
    sendJson(response, 200, buildAuthorizationServerMetadata(runtime.config), {
      noStore: true,
      cors: true,
    });
    return;
  }
  if (RESOURCE_DISCOVERY_PATHS.has(url.pathname) && request.method === 'GET') {
    sendJson(response, 200, buildProtectedResourceMetadata(runtime.config), {
      noStore: true,
      cors: true,
    });
    return;
  }
  if (url.pathname === AUTHORIZATION_PATH && request.method === 'GET') {
    await handleAuthorization(request, response, runtime, url);
    return;
  }
  if (url.pathname === CONSENT_PATH) {
    await handleConsent(request, response, runtime, url);
    return;
  }
  if (url.pathname === REGISTER_PATH && request.method === 'POST') {
    await handleRegistration(request, response, runtime);
    return;
  }
  if (url.pathname === TOKEN_PATH && request.method === 'POST') {
    await handleToken(request, response, runtime);
    return;
  }
  if (url.pathname === REVOKE_PATH && request.method === 'POST') {
    await handleRevocation(request, response, runtime);
    return;
  }
  if (url.pathname === MCP_PATH) {
    await handleProtectedMcp(request, response, runtime, url);
    return;
  }
  sendJson(response, 404, { error: 'not_found' });
}

function loadApprovalSecret(config) {
  const directSecret = config.approvalSecret;
  const secret = directSecret ?? fs.readFileSync(config.approvalSecretFile, 'utf8').trim();
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new Error('BMG approval secret is missing or too short.');
  }
  return secret;
}

export function createBmgServer(options = {}) {
  const config = options.config ?? loadConfig(options.rootDir ?? process.cwd());
  const store = options.oauthStore ?? new OAuthStore(config.stateFile);
  const logger = options.logger ?? console;
  const upstreamUrl = options.upstreamUrl ?? config.upstreamUrl;
  const approvalSecret = loadApprovalSecret(config);
  fs.mkdirSync(path.dirname(config.stateFile), { recursive: true });
  fs.mkdirSync(config.logDir, { recursive: true });
  const runtime = {
    config,
    store,
    logger,
    upstreamUrl,
    approvalSecret,
    registrationLimiter: createRegistrationLimiter({
      limit: options.registrationRateLimit ?? REGISTRATION_RATE_LIMIT,
      windowMs: options.registrationRateWindowMs ?? REGISTRATION_RATE_WINDOW_MS,
    }),
    upstreamSession: null,
    workspace: null,
    server: null,
  };
  runtime.upstreamSession = new UpstreamSessionManager(runtime);
  runtime.workspace = new BrowserWorkspaceRouter({
    enabled: config.workspaceMode,
    stateFile: config.workspaceStateFile,
    idleTimeoutMs: config.workspaceIdleTimeoutSeconds * 1000,
    logger,
    bootstrapUrl: `http://localhost:${config.port}${WORKSPACE_BOOTSTRAP_PATH}`,
    placeWindowOffscreen: (nonce) => placeWorkspaceWindowOffscreen(config.rootDir, nonce),
    ensureWindowHidden: (hwnd) => ensureWorkspaceWindowHidden(config.rootDir, hwnd),
    showWindow: (hwnd) => showWorkspaceWindow(config.rootDir, hwnd),
    callTool: (name, args) => runtime.upstreamSession.callTool(name, args),
  });
  const server = http.createServer((request, response) => {
    handleRequest(request, response, runtime).catch(() => {
      if (!response.headersSent) {
        sendJson(response, 500, { error: 'internal_server_error' }, { noStore: true });
      } else if (!response.writableEnded) {
        response.destroy();
      }
      logMessage(logger, 'error', 'BMG sidecar request failed.');
    });
  });
  server.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  runtime.server = server;
  return runtime;
}

export function listenBmgServer(runtime, port = runtime.config.port, host = runtime.config.host) {
  return new Promise((resolve, reject) => {
    const handleError = (error) => {
      runtime.server.off('listening', handleListening);
      reject(error);
    };
    const handleListening = () => {
      runtime.server.off('error', handleError);
      resolve(runtime);
    };
    runtime.server.once('error', handleError);
    runtime.server.once('listening', handleListening);
    runtime.server.listen(port, host);
  });
}

export async function closeBmgServer(runtime) {
  await runtime.workspace?.close?.();
  await runtime.upstreamSession.close();
  if (!runtime.server.listening) {
    return;
  }
  await new Promise((resolve, reject) => {
    runtime.server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function main() {
  const config = loadConfig(process.cwd());
  const runtime = createBmgServer({ config });
  await listenBmgServer(runtime);
  logMessage(
    console,
    'log',
    'BMG sidecar listening on ' + config.host + ':' + config.port + '.',
  );
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await closeBmgServer(runtime);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const currentFile = path.resolve(fileURLToPath(import.meta.url));
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (currentFile === invokedFile) {
  main().catch(() => {
    process.stderr.write('BMG sidecar failed to start. Check the BMG log.\n');
    process.exitCode = 1;
  });
}

export const workspaceLocalToolsForTest = WORKSPACE_LOCAL_TOOLS;
export const workspaceSupplementalToolsForTest = WORKSPACE_SUPPLEMENTAL_UPSTREAM_TOOLS;
