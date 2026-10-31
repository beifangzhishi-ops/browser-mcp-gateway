import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const STEP_MS = 30_000;
// Let a phone code be entered through a remote terminal or chat for roughly five minutes.
// The authenticator still follows standard 30-second TOTP periods.
const MAX_PAST_STEPS = 10;
const MAX_FUTURE_STEPS = 1;
const MAX_FAILURES = 5;
const LOCK_MS = 5 * 60_000;

export function totpForCounter(secret, counter) {
  if (!Buffer.isBuffer(secret) || secret.length < 20) throw new Error('Invalid TOTP secret.');
  if (!Number.isSafeInteger(counter) || counter < 0) throw new Error('Invalid TOTP counter.');
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(message).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

function secretStatePath(fileName) {
  return path.join(process.env.LOCALAPPDATA || os.homedir(), 'BMG', 'secrets', fileName);
}

export function readProtectedTotpSecret({ root = process.cwd() } = {}) {
  if (process.platform !== 'win32') throw new Error('BMG TOTP DPAPI requires Windows.');
  const script = path.join(root, 'scripts', 'manage-bmg-totp.ps1');
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', script, '-Action', 'ReadForRouter',
  ], { encoding: 'utf8', windowsHide: true, timeout: 7000, maxBuffer: 4096 });
  if (result.error || result.status !== 0) throw new Error('TOTP credential is not configured or cannot be decrypted.');
  const encoded = String(result.stdout || '').trim();
  if (!/^[A-Za-z0-9+/]{27,}={0,2}$/.test(encoded)) throw new Error('Invalid TOTP credential encoding.');
  const secret = Buffer.from(encoded, 'base64');
  if (secret.length !== 20) throw new Error('Invalid TOTP credential length.');
  return secret;
}

export class BmgTotpManager {
  constructor({
    root = process.cwd(),
    stateFile = secretStatePath('totp-unlock-state.json'),
    secretProvider = () => readProtectedTotpSecret({ root }),
    now = () => Date.now(),
  } = {}) {
    this.stateFile = stateFile;
    this.secretProvider = secretProvider;
    this.now = now;
  }

  loadState(fingerprint) {
    let state = null;
    try {
      state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error('TOTP replay state unavailable.');
    }
    if (!state || state.fingerprint !== fingerprint) {
      return { fingerprint, lastCounter: -1, failedAt: [], lockUntil: 0 };
    }
    if (!Number.isSafeInteger(state.lastCounter) || !Array.isArray(state.failedAt) ||
        !Number.isFinite(state.lockUntil)) throw new Error('Invalid TOTP replay state.');
    return state;
  }

  saveState(state) {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const tmp = this.stateFile + '.' + process.pid + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, this.stateFile);
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }

  verify(code) {
    const now = this.now();
    const secret = this.secretProvider();
    const fingerprint = createHash('sha256').update(secret).digest('hex');
    const state = this.loadState(fingerprint);
    state.failedAt = state.failedAt.filter((t) => Number.isFinite(t) && t > now - LOCK_MS && t <= now);
    if (state.lockUntil > now) return false;
    const current = Math.floor(now / STEP_MS);
    let matchingCounter = -1;
    if (typeof code === 'string' && /^\d{6}$/.test(code)) {
      for (let counter = current - MAX_PAST_STEPS;
        counter <= current + MAX_FUTURE_STEPS; counter++) {
        if (counter <= state.lastCounter || counter < 0) continue;
        const expected = totpForCounter(secret, counter);
        if (timingSafeEqual(Buffer.from(code), Buffer.from(expected))) {
          matchingCounter = counter;
          break;
        }
      }
    }
    if (matchingCounter >= 0) {
      state.lastCounter = matchingCounter;
      state.failedAt = [];
      state.lockUntil = 0;
      this.saveState(state);
      return true;
    }
    state.failedAt.push(now);
    if (state.failedAt.length >= MAX_FAILURES) state.lockUntil = now + LOCK_MS;
    this.saveState(state);
    return false;
  }
}
