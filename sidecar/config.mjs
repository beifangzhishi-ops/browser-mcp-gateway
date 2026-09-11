import fs from 'node:fs';
import path from 'node:path';

export const SIDECAR_HOST = '127.0.0.1';
export const SIDECAR_PORT = 18007;
export const UPSTREAM_URL = 'http://127.0.0.1:12306';
export const FORBIDDEN_PORTS = new Set([8317, 8765, 8766, 8767, 12306]);

function unquoteEnvValue(value) {
  if (value.length < 2) {
    return value;
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

export function parseEnvFile(content) {
  const values = {};
  for (const rawLine of String(content).split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u);
    if (!match) {
      continue;
    }
    values[match[1]] = unquoteEnvValue(match[2].trim());
  }
  return values;
}

function resolveFromRoot(rootDir, value) {
  return path.isAbsolute(value) ? value : path.resolve(rootDir, value);
}

function requireInteger(name, value, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(name + ' must be an integer between ' + minimum + ' and ' + maximum + '.');
  }
  return parsed;
}

function requireBoolean(name, value) {
  if (typeof value === 'boolean') return value;
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', ''].includes(normalized)) return false;
  throw new Error(name + ' must be a boolean value.');
}

function normalizeUpstreamUrl(value) {
  let upstream;
  try {
    upstream = new URL(value);
  } catch {
    throw new Error('BMG_UPSTREAM_URL must be a valid URL.');
  }
  if (
    upstream.protocol !== 'http:' ||
    upstream.hostname !== '127.0.0.1' ||
    upstream.port !== '12306' ||
    (upstream.pathname !== '/' && upstream.pathname !== '')
  ) {
    throw new Error('BMG_UPSTREAM_URL must remain http://127.0.0.1:12306.');
  }
  return UPSTREAM_URL;
}

function requireHttpsIdentity(name, value, expectedPath) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(name + ' is required.');
  let url;
  try { url = new URL(text); }
  catch { throw new Error(name + ' must be a valid HTTPS URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(name + ' must be a clean HTTPS URL without credentials, query, or fragment.');
  }
  const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/u, '');
  if (pathname !== expectedPath) throw new Error(name + ' path must be ' + expectedPath + '.');
  return url.origin + expectedPath;
}

function wellKnownUrl(identity, kind) {
  const url = new URL(identity);
  const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/u, '');
  return `${url.origin}/.well-known/${kind}${pathname}`;
}

export function createConfig(options = {}) {
  const {
    rootDir = process.cwd(),
    envPath = path.join(rootDir, 'config', '.env'),
    envValues = {},
    readEnvFile = true,
    host,
    port,
    upstreamUrl,
    issuer,
    resource,
    stateFile,
    upstreamSessionFile,
    workspaceMode,
    workspaceStateFile,
    workspaceIdleTimeoutSeconds,
    approvalSecretFile,
    logDir,
    tokenTtlSeconds,
    approvalSecret,
    allowEphemeral = false,
  } = options;

  let fileValues = {};
  if (readEnvFile) {
    if (!fs.existsSync(envPath)) {
      throw new Error('BMG config file was not found: ' + envPath);
    }
    fileValues = parseEnvFile(fs.readFileSync(envPath, 'utf8'));
  }
  const values = { ...fileValues, ...envValues };
  const selectedHost = host ?? values.BMG_SIDECAR_HOST ?? SIDECAR_HOST;
  if (selectedHost !== SIDECAR_HOST) {
    throw new Error('BMG_SIDECAR_HOST must be ' + SIDECAR_HOST + '.');
  }

  const selectedPort = requireInteger(
    'BMG_SIDECAR_PORT',
    port ?? values.BMG_SIDECAR_PORT ?? SIDECAR_PORT,
    allowEphemeral ? 0 : 1,
    65535,
  );
  if (selectedPort !== 0 && FORBIDDEN_PORTS.has(selectedPort)) {
    throw new Error('BMG_SIDECAR_PORT cannot use a reserved port: ' + selectedPort + '.');
  }

  const selectedIssuer = requireHttpsIdentity(
    'BMG_ISSUER',
    issuer ?? values.BMG_ISSUER,
    '/bmg',
  );
  const selectedResource = requireHttpsIdentity(
    'BMG_RESOURCE',
    resource ?? values.BMG_RESOURCE,
    '/bmg/mcp',
  );
  if (new URL(selectedIssuer).origin !== new URL(selectedResource).origin) {
    throw new Error('BMG_ISSUER and BMG_RESOURCE must use the same HTTPS origin.');
  }
  const selectedUpstreamUrl = normalizeUpstreamUrl(
    upstreamUrl ?? values.BMG_UPSTREAM_URL ?? UPSTREAM_URL,
  );
  const selectedTtl = requireInteger(
    'BMG_TOKEN_TTL_SECONDS',
    tokenTtlSeconds ?? values.BMG_TOKEN_TTL_SECONDS ?? 3600,
    60,
    86400,
  );

  const selectedWorkspaceMode = requireBoolean(
    'BMG_WORKSPACE_MODE',
    workspaceMode ?? values.BMG_WORKSPACE_MODE ?? false,
  );
  const selectedWorkspaceIdleTimeoutSeconds = requireInteger(
    'BMG_WORKSPACE_IDLE_TIMEOUT_SECONDS',
    workspaceIdleTimeoutSeconds ?? values.BMG_WORKSPACE_IDLE_TIMEOUT_SECONDS ?? 1800,
    0,
    604800,
  );

  const selectedStateFile = resolveFromRoot(
    rootDir,
    stateFile ?? values.BMG_STATE_FILE ?? '.state/bmg-oauth-state.json',
  );
  const selectedUpstreamSessionFile = resolveFromRoot(
    rootDir,
    upstreamSessionFile ??
      values.BMG_UPSTREAM_SESSION_FILE ??
      '.state/bmg-upstream-session.json',
  );
  const selectedWorkspaceStateFile = resolveFromRoot(
    rootDir,
    workspaceStateFile ?? values.BMG_WORKSPACE_STATE_FILE ?? '.state/bmg-workspace.json',
  );
  const selectedApprovalSecretFile = resolveFromRoot(
    rootDir,
    approvalSecretFile ??
      values.BMG_APPROVAL_SECRET_FILE ??
      '.state/bmg-approval-secret.txt',
  );
  const selectedLogDir = resolveFromRoot(rootDir, logDir ?? values.BMG_LOG_DIR ?? 'logs');

  return Object.freeze({
    rootDir,
    host: selectedHost,
    port: selectedPort,
    upstreamUrl: selectedUpstreamUrl,
    issuer: selectedIssuer,
    resource: selectedResource,
    protectedResourceMetadataUrl: wellKnownUrl(selectedResource, 'oauth-protected-resource'),
    authorizationServerMetadataUrl: wellKnownUrl(selectedIssuer, 'oauth-authorization-server'),
    stateFile: selectedStateFile,
    upstreamSessionFile: selectedUpstreamSessionFile,
    workspaceMode: selectedWorkspaceMode,
    workspaceStateFile: selectedWorkspaceStateFile,
    workspaceIdleTimeoutSeconds: selectedWorkspaceIdleTimeoutSeconds,
    approvalSecretFile: selectedApprovalSecretFile,
    logDir: selectedLogDir,
    tokenTtlSeconds: selectedTtl,
    approvalSecret,
  });
}

export function loadConfig(rootDir = process.cwd()) {
  return createConfig({ rootDir });
}
