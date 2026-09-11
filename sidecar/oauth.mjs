import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const OAUTH_SCOPE = 'mcp';
const STATE_VERSION = 1;
const CODE_TTL_SECONDS = 600;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_REGISTERED_CLIENTS = 256;
const STALE_CLIENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_REDIRECT_URIS_PER_CLIENT = 16;

export class OAuthError extends Error {
  constructor(code, description, status = 400) {
    super(description);
    this.name = 'OAuthError';
    this.code = code;
    this.description = description;
    this.status = status;
  }
}

export function base64UrlEncode(value) {
  return Buffer.from(value)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

export function createPkceChallenge(verifier) {
  return base64UrlEncode(createHash('sha256').update(verifier, 'ascii').digest());
}

export function createOpaqueValue(prefix = '') {
  return prefix + base64UrlEncode(randomBytes(32));
}

function hashOpaqueValue(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left), 'utf8');
  const rightBuffer = Buffer.from(String(right), 'utf8');
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateRedirectUris(redirectUris) {
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    throw new OAuthError(
      'invalid_client_metadata',
      'redirect_uris must contain at least one URI.',
    );
  }
  if (redirectUris.length > MAX_REDIRECT_URIS_PER_CLIENT) {
    throw new OAuthError(
      'invalid_client_metadata',
      `redirect_uris cannot contain more than ${MAX_REDIRECT_URIS_PER_CLIENT} URIs.`,
    );
  }
  const uniqueUris = [];
  for (const redirectUri of redirectUris) {
    if (typeof redirectUri !== 'string' || redirectUri.length > 2048) {
      throw new OAuthError('invalid_redirect_uri', 'redirect_uris contains an invalid URI.');
    }
    let parsed;
    try {
      parsed = new URL(redirectUri);
    } catch {
      throw new OAuthError('invalid_redirect_uri', 'redirect_uris contains an invalid URI.');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.hash) {
      throw new OAuthError('invalid_redirect_uri', 'redirect_uris contains an invalid URI.');
    }
    if (!uniqueUris.includes(redirectUri)) {
      uniqueUris.push(redirectUri);
    }
  }
  return uniqueUris;
}

function createEmptyState() {
  return {
    version: STATE_VERSION,
    clients: {},
    authorizationCodes: {},
    accessTokens: {},
    refreshTokens: {},
  };
}

export class OAuthStore {
  constructor(stateFile, clock = () => Date.now(), options = {}) {
    this.stateFile = stateFile;
    this.clock = clock;
    this.maxClients = options.maxClients ?? MAX_REGISTERED_CLIENTS;
    this.staleClientRetentionMs = options.staleClientRetentionMs ?? STALE_CLIENT_RETENTION_MS;
    if (!Number.isInteger(this.maxClients) || this.maxClients < 1) {
      throw new Error('OAuth max client count must be a positive integer.');
    }
    if (!Number.isInteger(this.staleClientRetentionMs) || this.staleClientRetentionMs < 0) {
      throw new Error('OAuth stale client retention must be a non-negative integer.');
    }
    this.state = this.load();
  }

  load() {
    if (!fs.existsSync(this.stateFile)) {
      return createEmptyState();
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    } catch {
      throw new Error('BMG OAuth state file is invalid.');
    }
    const refreshTokens = parsed?.refreshTokens ?? {};
    if (
      !parsed ||
      parsed.version !== STATE_VERSION ||
      typeof parsed.clients !== 'object' ||
      typeof parsed.authorizationCodes !== 'object' ||
      typeof parsed.accessTokens !== 'object' ||
      typeof refreshTokens !== 'object' ||
      Array.isArray(refreshTokens)
    ) {
      throw new Error('BMG OAuth state file has an unsupported format.');
    }
    parsed.refreshTokens = refreshTokens;
    return parsed;
  }

  save() {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const temporaryFile = this.stateFile + '.' + process.pid + '.tmp';
    fs.writeFileSync(temporaryFile, JSON.stringify(this.state), {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.renameSync(temporaryFile, this.stateFile);
  }

  pruneExpiredRecords(now = this.clock()) {
    let changed = false;
    for (const collectionName of ['authorizationCodes', 'accessTokens', 'refreshTokens']) {
      for (const [key, record] of Object.entries(this.state[collectionName])) {
        if (Number.isFinite(record?.expiresAt) && record.expiresAt <= now) {
          delete this.state[collectionName][key];
          changed = true;
        }
      }
    }
    return changed;
  }

  ensureRegistrationCapacity() {
    const now = this.clock();
    let changed = this.pruneExpiredRecords(now);
    let clientCount = Object.keys(this.state.clients).length;
    if (clientCount >= this.maxClients) {
      const activeClientIds = new Set();
      for (const collectionName of ['authorizationCodes', 'accessTokens', 'refreshTokens']) {
        for (const record of Object.values(this.state[collectionName])) {
          if (typeof record?.clientId === 'string') activeClientIds.add(record.clientId);
        }
      }
      const cutoff = now - this.staleClientRetentionMs;
      const staleClientIds = Object.entries(this.state.clients)
        .filter(([clientId, client]) =>
          !activeClientIds.has(clientId) && Number.isFinite(client?.createdAt) && client.createdAt <= cutoff)
        .sort((left, right) => left[1].createdAt - right[1].createdAt)
        .map(([clientId]) => clientId);
      for (const clientId of staleClientIds) {
        if (clientCount < this.maxClients) break;
        delete this.state.clients[clientId];
        clientCount -= 1;
        changed = true;
      }
    }
    if (changed) this.save();
    if (clientCount >= this.maxClients) {
      throw new OAuthError(
        'temporarily_unavailable',
        'OAuth client registration capacity has been reached.',
        503,
      );
    }
  }

  registerClient(metadata) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new OAuthError('invalid_client_metadata', 'Client metadata must be a JSON object.');
    }
    const redirectUris = validateRedirectUris(metadata.redirect_uris);
    const grantTypes = Array.isArray(metadata.grant_types)
      ? metadata.grant_types
      : ['authorization_code'];
    const responseTypes = Array.isArray(metadata.response_types)
      ? metadata.response_types
      : ['code'];
    const supportedGrantTypes = new Set(['authorization_code', 'refresh_token']);
    if (
      !grantTypes.includes('authorization_code') ||
      grantTypes.some((grantType) => !supportedGrantTypes.has(grantType)) ||
      !responseTypes.includes('code') ||
      responseTypes.some((responseType) => responseType !== 'code')
    ) {
      throw new OAuthError(
        'invalid_client_metadata',
        'Only authorization_code/refresh_token with response type code is supported.',
      );
    }
    if (
      metadata.token_endpoint_auth_method &&
      metadata.token_endpoint_auth_method !== 'none'
    ) {
      throw new OAuthError(
        'invalid_client_metadata',
        'Only public clients with token endpoint auth method none are supported.',
      );
    }
    this.ensureRegistrationCapacity();
    const clientId = createOpaqueValue('bmg_client_');
    const clientName =
      typeof metadata.client_name === 'string' && metadata.client_name.length <= 200
        ? metadata.client_name
        : '';
    const client = {
      clientId,
      clientName,
      redirectUris,
      grantTypes: [...new Set(grantTypes)],
      responseTypes: ['code'],
      tokenEndpointAuthMethod: 'none',
      createdAt: this.clock(),
    };
    this.state.clients[clientId] = client;
    this.save();
    return clone(client);
  }

  getClient(clientId) {
    const client = this.state.clients[clientId];
    return client ? clone(client) : null;
  }

  createAuthorizationCode({
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    resource,
    scope,
  }) {
    const code = createOpaqueValue('bmg_code_');
    const now = this.clock();
    this.state.authorizationCodes[hashOpaqueValue(code)] = {
      clientId,
      redirectUri,
      codeChallenge,
      codeChallengeMethod,
      resource,
      scope,
      createdAt: now,
      expiresAt: now + CODE_TTL_SECONDS * 1000,
    };
    this.save();
    return code;
  }

  mintTokenPair({ clientId, resource, scope, tokenTtlSeconds, familyId = null }) {
    const accessToken = createOpaqueValue('bmg_at_');
    const refreshToken = createOpaqueValue('bmg_rt_');
    const tokenFamilyId = familyId || createOpaqueValue('bmg_family_');
    const now = this.clock();
    this.state.accessTokens[hashOpaqueValue(accessToken)] = {
      clientId,
      resource,
      scope,
      familyId: tokenFamilyId,
      createdAt: now,
      expiresAt: now + tokenTtlSeconds * 1000,
    };
    this.state.refreshTokens[hashOpaqueValue(refreshToken)] = {
      clientId,
      resource,
      scope,
      familyId: tokenFamilyId,
      createdAt: now,
      expiresAt: now + REFRESH_TOKEN_TTL_SECONDS * 1000,
    };
    this.save();
    return {
      accessToken,
      refreshToken,
      expiresIn: tokenTtlSeconds,
      scope,
      resource,
    };
  }

  exchangeAuthorizationCode({
    code,
    clientId,
    redirectUri,
    codeVerifier,
    resource,
    tokenTtlSeconds,
  }) {
    if (typeof code !== 'string' || typeof codeVerifier !== 'string') {
      throw new OAuthError('invalid_grant', 'Authorization code or verifier is invalid.');
    }
    const codeKey = hashOpaqueValue(code);
    const record = this.state.authorizationCodes[codeKey];
    if (!record || record.expiresAt <= this.clock()) {
      if (record) {
        delete this.state.authorizationCodes[codeKey];
        this.save();
      }
      throw new OAuthError('invalid_grant', 'Authorization code is invalid or expired.');
    }
    if (
      record.clientId !== clientId ||
      record.redirectUri !== redirectUri ||
      record.resource !== resource ||
      record.codeChallengeMethod !== 'S256' ||
      !constantTimeEqual(createPkceChallenge(codeVerifier), record.codeChallenge)
    ) {
      throw new OAuthError('invalid_grant', 'Authorization code is invalid or expired.');
    }

    delete this.state.authorizationCodes[codeKey];
    return this.mintTokenPair({
      clientId,
      resource: record.resource,
      scope: record.scope,
      tokenTtlSeconds,
    });
  }

  exchangeRefreshToken({ refreshToken, clientId, resource, scope, tokenTtlSeconds }) {
    if (typeof refreshToken !== 'string' || !refreshToken) {
      throw new OAuthError('invalid_grant', 'Refresh token is invalid or expired.');
    }
    const tokenKey = hashOpaqueValue(refreshToken);
    const record = this.state.refreshTokens[tokenKey];
    if (!record || record.expiresAt <= this.clock()) {
      if (record) {
        delete this.state.refreshTokens[tokenKey];
        this.save();
      }
      throw new OAuthError('invalid_grant', 'Refresh token is invalid or expired.');
    }
    if (record.clientId !== clientId) {
      throw new OAuthError('invalid_grant', 'Refresh token is invalid or expired.');
    }
    if (record.resource !== resource) {
      throw new OAuthError('invalid_target', 'The requested resource is not supported.');
    }
    const requestedScope = scope || record.scope;
    const originalScopes = new Set(String(record.scope || '').split(/\s+/u).filter(Boolean));
    const requestedScopes = String(requestedScope || '').split(/\s+/u).filter(Boolean);
    if (requestedScopes.some((item) => !originalScopes.has(item))) {
      throw new OAuthError('invalid_scope', 'Requested scope exceeds the original grant.');
    }
    delete this.state.refreshTokens[tokenKey];
    return this.mintTokenPair({
      clientId: record.clientId,
      resource: record.resource,
      scope: requestedScope,
      tokenTtlSeconds,
      familyId: record.familyId,
    });
  }

  validateAccessToken(accessToken, resource) {
    if (typeof accessToken !== 'string' || !accessToken) {
      return null;
    }
    const tokenKey = hashOpaqueValue(accessToken);
    const record = this.state.accessTokens[tokenKey];
    if (!record) {
      return null;
    }
    if (record.expiresAt <= this.clock()) {
      delete this.state.accessTokens[tokenKey];
      this.save();
      return null;
    }
    if (record.resource !== resource) {
      return null;
    }
    return clone(record);
  }

  revokeToken(token) {
    if (typeof token !== 'string' || !token) {
      return false;
    }
    const tokenKey = hashOpaqueValue(token);
    const record = this.state.accessTokens[tokenKey] || this.state.refreshTokens[tokenKey];
    if (!record) {
      return false;
    }
    if (record.familyId) {
      for (const [key, candidate] of Object.entries(this.state.accessTokens)) {
        if (candidate.familyId === record.familyId) delete this.state.accessTokens[key];
      }
      for (const [key, candidate] of Object.entries(this.state.refreshTokens)) {
        if (candidate.familyId === record.familyId) delete this.state.refreshTokens[key];
      }
    } else {
      delete this.state.accessTokens[tokenKey];
      delete this.state.refreshTokens[tokenKey];
    }
    this.save();
    return true;
  }

  revokeAccessToken(accessToken) {
    return this.revokeToken(accessToken);
  }
}
