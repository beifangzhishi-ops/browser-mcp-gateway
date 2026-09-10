import fs from 'node:fs';
import { loadConfig } from '../sidecar/config.mjs';
import { createPkceChallenge } from '../sidecar/oauth.mjs';

const config = loadConfig(process.cwd());
const baseUrl = 'http://' + config.host + ':' + config.port;
const redirectUri = 'http://127.0.0.1:19001/bmg-e2e-callback';
let stage = 'startup';

function parseSse(text) {
  const line = String(text)
    .split(/\r?\n/u)
    .find((value) => value.startsWith('data:'));
  if (!line) {
    throw new Error('SSE data was missing.');
  }
  return JSON.parse(line.slice('data:'.length).trim());
}

async function request(requestPath, options = {}) {
  const response = await fetch(baseUrl + requestPath, {
    redirect: 'manual',
    ...options,
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { response, text, json };
}

function requireStatus(result, status) {
  if (result.response.status !== status) {
    throw new Error(
      'Unexpected HTTP status at ' +
        stage +
        ': ' +
        result.response.status +
        ' (' +
        (result.response.headers.get('content-type') || 'no content type') +
        ', error=' +
        (result.json && result.json.error ? result.json.error : 'none') +
        ').',
    );
  }
}

async function runRound(round, approvalSecret) {
  const stagePrefix = 'round ' + round + ': ';
  stage = stagePrefix + 'registration';
  const registration = await request('/bmg/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'BMG local E2E',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  requireStatus(registration, 201);
  const clientId = registration.json.client_id;

  stage = stagePrefix + 'authorization';
  const verifier = Buffer.from(cryptoRandomBytes(32)).toString('base64url');
  const challenge = createPkceChallenge(verifier);
  const authorizationQuery = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: config.resource,
    scope: 'mcp',
    state: 'bmg-e2e-state-' + round,
  });
  const authorization = await request('/bmg/authorize?' + authorizationQuery.toString());
  requireStatus(authorization, 302);
  const consentLocation = new URL(authorization.response.headers.get('location'));
  if (consentLocation.pathname !== '/bmg/oauth/consent') {
    throw new Error('Authorization did not redirect to consent.');
  }

  stage = stagePrefix + 'consent';
  const consentForm = new URLSearchParams(consentLocation.search);
  consentForm.set('approval_secret', approvalSecret);
  const consent = await request('/bmg/oauth/consent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: consentForm.toString(),
  });
  requireStatus(consent, 302);
  const callbackLocation = new URL(consent.response.headers.get('location'));
  const authorizationCode = callbackLocation.searchParams.get('code');
  if (!authorizationCode) {
    throw new Error('Authorization code was missing.');
  }

  stage = stagePrefix + 'token';
  const tokenForm = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    code: authorizationCode,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    resource: config.resource,
  });
  const token = await request('/bmg/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenForm.toString(),
  });
  requireStatus(token, 200);
  const initialAccessToken = token.json.access_token;
  const initialRefreshToken = token.json.refresh_token;
  if (!initialAccessToken || !initialRefreshToken) {
    throw new Error('Access or refresh token was missing.');
  }

  stage = stagePrefix + 'refresh token rotation';
  const refresh = await request('/bmg/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: initialRefreshToken,
      resource: config.resource,
    }).toString(),
  });
  requireStatus(refresh, 200);
  const accessToken = refresh.json.access_token;
  const refreshToken = refresh.json.refresh_token;
  if (!accessToken || !refreshToken || refreshToken === initialRefreshToken) {
    throw new Error('Refresh token rotation did not return a new token pair.');
  }

  const mcpHeaders = {
    Authorization: 'Bearer ' + accessToken,
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
  };
  stage = stagePrefix + 'initialize through upstream';
  const initialize = await request('/bmg/mcp', {
    method: 'POST',
    headers: mcpHeaders,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: round * 10 + 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'bmg-local-e2e', version: '1.0' },
      },
    }),
  });
  requireStatus(initialize, 200);
  const initializeResult = parseSse(initialize.text);
  const sessionId = initialize.response.headers.get('mcp-session-id');
  if (!initializeResult.result || !sessionId) {
    throw new Error('Upstream initialize response was incomplete.');
  }

  stage = stagePrefix + 'tools/list through upstream';
  const tools = await request('/bmg/mcp', {
    method: 'POST',
    headers: { ...mcpHeaders, 'Mcp-Session-Id': sessionId },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });
  requireStatus(tools, 200);
  const toolList = parseSse(tools.text).result.tools;
  const expectedToolCount = config.workspaceMode ? 27 : 23;
  if (toolList.length !== expectedToolCount) {
    throw new Error('Expected ' + expectedToolCount + ' BMG tools, received ' + toolList.length + '.');
  }
  if (config.workspaceMode) {
    for (const name of ['bmg_show_workspace', 'bmg_hide_workspace', 'chrome_upload_file', 'chrome_handle_download']) {
      if (!toolList.some((tool) => tool.name === name)) {
        throw new Error('Workspace control tool was not listed: ' + name);
      }
    }
  }
  const screenshotTool = toolList.find((tool) => tool.name === 'chrome_screenshot');
  if (!screenshotTool) {
    throw new Error('Upstream screenshot tool was not listed.');
  }
  const safeToolName = 'get_windows_and_tabs';
  if (!toolList.some((tool) => tool.name === safeToolName)) {
    throw new Error('The expected read-only tool was not listed.');
  }

  stage = stagePrefix + 'read-only tool through upstream';
  const safeTool = await request('/bmg/mcp', {
    method: 'POST',
    headers: { ...mcpHeaders, 'Mcp-Session-Id': sessionId },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: round * 10 + 3,
      method: 'tools/call',
      params: { name: safeToolName, arguments: {} },
    }),
  });
  requireStatus(safeTool, 200);
  const safeToolResult = parseSse(safeTool.text).result;
  if (!safeToolResult || safeToolResult.isError === true) {
    throw new Error('Read-only tool returned an error.');
  }

  stage = stagePrefix + 'MCP session cleanup';
  const closeSession = await request('/bmg/mcp', {
    method: 'DELETE',
    headers: { ...mcpHeaders, 'Mcp-Session-Id': sessionId },
  });
  if (![200, 204].includes(closeSession.response.status)) {
    throw new Error('Upstream MCP session could not be closed.');
  }

  stage = stagePrefix + 'revocation';
  const revoke = await request('/bmg/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: refreshToken }).toString(),
  });
  requireStatus(revoke, 200);
  const revoked = await request('/bmg/mcp', {
    method: 'POST',
    headers: mcpHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id: round * 10 + 4, method: 'tools/list', params: {} }),
  });
  requireStatus(revoked, 401);

  const stateText = fs.readFileSync(config.stateFile, 'utf8');
  const secrets = [initialAccessToken, initialRefreshToken, accessToken, refreshToken, approvalSecret];
  if (secrets.some((secret) => stateText.includes(secret))) {
    throw new Error('OAuth state contains plaintext secret material.');
  }

  return {
    sessionId,
    toolCount: toolList.length,
    screenshotTool: screenshotTool.name,
    safeToolName,
  };
}

async function main() {
  const approvalSecret = fs.readFileSync(config.approvalSecretFile, 'utf8').trim();
  if (approvalSecret.length < 16) {
    throw new Error('Approval secret is not configured.');
  }

  const roundOne = await runRound(1, approvalSecret);
  const roundTwo = await runRound(2, approvalSecret);
  if (roundOne.sessionId !== roundTwo.sessionId) {
    throw new Error('The upstream MCP session was not reused between rounds.');
  }

  console.log('BMG local OAuth E2E: PASS');
  console.log('round_1=PASS');
  console.log('round_2=PASS');
  console.log('upstream_session_reused=true');
  console.log('registration_status=201');
  console.log('pkce_token_status=200');
  console.log('refresh_rotation_status=200');
  console.log('bearer_initialize_status=200');
  console.log('tools_count=' + roundTwo.toolCount);
  console.log('screenshot_tool=' + roundTwo.screenshotTool);
  console.log('safe_tool=' + roundTwo.safeToolName + ' status=200');
  console.log('revoke_status=200');
  console.log('revoked_bearer_status=401');
}

function cryptoRandomBytes(size) {
  const bytes = new Uint8Array(size);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

main().catch((error) => {
  console.error(
    'BMG local OAuth E2E: FAIL at ' +
      stage +
      '. ' +
      String(error && error.message ? error.message : 'unknown error'),
  );
  process.exitCode = 1;
});
