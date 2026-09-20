#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../sidecar/config.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function print(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

function fail(message, details = null, code = 1) {
  const payload = { success: false, error: String(message) };
  if (details !== null) payload.details = details;
  process.stderr.write(JSON.stringify(payload) + '\n');
  process.exit(code);
}

function localSecret(config) {
  try {
    return fs.readFileSync(config.approvalSecretFile, 'utf8').trim();
  } catch {
    fail('BMG local approval secret is unavailable. Start/configure BMG first.', null, 2);
  }
}
async function requestJson(baseUrl, requestPath, options = {}) {
  const response = await fetch(baseUrl + requestPath, {
    redirect: 'manual',
    ...options,
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    fail(
      'BMG request failed with HTTP ' + response.status + '.',
      payload,
      response.status === 403 ? 3 : 2,
    );
  }
  return payload;
}

function parseToolArguments(rest) {
  const index = rest.findIndex((value) => value === '--args' || value === '--args-base64');
  if (index < 0) return {};
  const mode = rest[index];
  const raw = rest[index + 1];
  if (!raw) fail(mode + ' requires a value.', null, 2);
  try {
    const text = mode === '--args-base64'
      ? Buffer.from(raw, 'base64').toString('utf8')
      : raw;
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('arguments must be a JSON object');
    }
    return value;
  } catch (error) {
    fail('Invalid tool arguments: ' + error.message, null, 2);
  }
}

let config;
try {
  config = loadConfig(rootDir);
} catch (error) {
  fail('BMG is not configured: ' + error.message, null, 2);
}
const baseUrl = `http://${config.host}:${config.port}`;
const [command = 'health', ...rest] = process.argv.slice(2);

if (command === 'health') {
  print(await requestJson(baseUrl, '/health'));
  process.exit(0);
}

const secret = localSecret(config);
const headers = {
  'Content-Type': 'application/json',
  'X-BMG-Local-Secret': secret,
};

if (command === 'workspace') {
  print(await requestJson(baseUrl, '/internal/ensure-workspace', {
    method: 'POST',
    headers,
    body: '{}',
  }));
  process.exit(0);
}

let toolName = command === 'show'
  ? 'bmg_show_workspace'
  : command === 'hide'
    ? 'bmg_hide_workspace'
    : null;
let toolArgs = {};
if (command === 'call') {
  toolName = rest[0];
  if (!toolName) fail('Usage: bmgctl call <tool> [--args JSON|--args-base64 BASE64]', null, 2);
  toolArgs = parseToolArguments(rest.slice(1));
} else if (!toolName) {
  fail('Unknown command. Use health, workspace, show, hide, or call.', null, 2);
}

const result = await requestJson(baseUrl, '/internal/tool-call', {
  method: 'POST',
  headers,
  body: JSON.stringify({ name: toolName, arguments: toolArgs }),
});
print(result);
if (result?.result?.isError === true) process.exitCode = 1;
