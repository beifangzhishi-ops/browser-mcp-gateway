import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { validateApprovalDurationSeconds } from './approval-policy.mjs';

export const WEB_UNLOCK_PATH = '/bmg/unlock';
const PAIR_COOKIE = '__Secure-bmg-web-pair';
const CSRF_COOKIE = '__Secure-bmg-web-csrf';
const PAIR_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const CLAIM_TTL_MS = 5 * 60 * 1000;
const MAX_PAIRED_BROWSERS = 8;
const DURATIONS = [60, 300, 1800, 3600, 21600, 86400, 604800];
const DURATIONS_LABELS = ['1 分钟', '5 分钟', '30 分钟', '1 小时', '6 小时', '1 天', '7 天'];

const hash = (value) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const safeEqual = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function readCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const equal = part.indexOf('=');
    if (equal > 0) cookies[part.slice(0, equal).trim()] = part.slice(equal + 1).trim();
  }
  return cookies;
}

function responseHtml(response, status, html, cookies = []) {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    'Pragma': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    ...(cookies.length ? { 'Set-Cookie': cookies } : {}),
  });
  response.end(html);
}

function sessionCookie(value, maxAge) {
  // Lax allows an owner to open the bookmarked page from ChatGPT.
  // POST relies on matching unpredictable CSRF and paired-browser cookies,
  // not mobile-proxy Origin / Referer / Fetch-Metadata headers.
  return `${PAIR_COOKIE}=${value}; Path=${WEB_UNLOCK_PATH}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function csrfCookie(value) {
  return `${CSRF_COOKIE}=${value}; Path=${WEB_UNLOCK_PATH}; Max-Age=3600; HttpOnly; Secure; SameSite=Lax`;
}

function redirect(response, destination, cookies = []) {
  response.writeHead(303, {
    Location: WEB_UNLOCK_PATH + destination,
    'Cache-Control': 'no-store',
    ...(cookies.length ? { 'Set-Cookie': cookies } : {}),
  });
  response.end();
}

function htmlEscape(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function renderPage({ paired, csrf, message = '', error = false }) {
  const form = paired
    ? `<form method="post" action="${WEB_UNLOCK_PATH}">
        <input type="hidden" name="csrf" value="${htmlEscape(csrf)}">
        <input type="hidden" name="action" value="unlock">
        <label for="duration">授权时长</label>
        <select id="duration" name="duration_seconds">${DURATIONS.map((seconds, i) =>
          `<option value="${seconds}"${seconds === 21600 ? ' selected' : ''}>${DURATIONS_LABELS[i]}</option>`).join('')}</select>
        <button type="submit">临时解锁 BMG</button>
      </form><p class="muted">授权成功后回到 ChatGPT，说「已解锁，继续」。网页恢复待解锁状态，不影响已签发授权。</p>`
    : `<p class="muted">仅首次使用本浏览器需要配对手机验证器。此后直接点击即可解锁。</p>
      <form method="post" action="${WEB_UNLOCK_PATH}">
        <input type="hidden" name="csrf" value="${htmlEscape(csrf)}">
        <input type="hidden" name="action" value="pair">
        <label for="code">手机验证码（仅本次配对）</label>
        <input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required>
        <button type="submit">配对此浏览器</button>
      </form>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>BMG 临时解锁</title><style>
    :root{color-scheme:light dark;font-family:system-ui,-apple-system,'Segoe UI',sans-serif}
    body{max-width:430px;margin:10vh auto;padding:0 22px;line-height:1.6}
    h1{font-size:1.6rem;margin:0 0 12px} .muted{opacity:.7;font-size:.9rem}
    .panel{padding:26px 20px;border:1px solid #8886;border-radius:16px}
    form{display:grid;gap:12px;margin-top:24px}label{font-weight:600}
    input,select,button{box-sizing:border-box;padding:13px;font:inherit;border-radius:9px;width:100%}
    button{border:0;background:#2764d7;color:white;font-weight:650;cursor:pointer;margin-top:8px}
    .notice{padding:10px 12px;border-radius:8px;background:#568a7a22}
    .error{background:#d65b5b26}
    </style></head><body><main class="panel"><h1>BMG 临时解锁</h1>
    <p class="muted">${paired ? '当前：等待你主动解锁' : '当前：尚未配对此浏览器'}</p>
    ${message ? `<p class="notice${error ? ' error' : ''}" role="status">${htmlEscape(message)}</p>` : ''}
    ${form}</main></body></html>`;
}

export class WebUnlockManager {
  constructor({ stateFile, verifyCode, grants, policy, now = () => Date.now() } = {}) {
    this.stateFile = stateFile || path.resolve(process.cwd(), '.state', 'bmg-web-browsers.json');
    this.verifyCode = verifyCode;
    this.grants = grants;
    this.policy = policy;
    this.now = now;
    this.pending = null;
  }

  loadPairs() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (!Array.isArray(parsed) || parsed.length > 100) throw new Error('Invalid browser pairing state.');
      return parsed.filter((entry) => /^[a-f0-9]{64}$/.test(entry.hash) &&
        Number.isSafeInteger(entry.expires) && Number.isInteger(entry.policyRevision));
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }

  savePairs(pairs) {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const temp = this.stateFile + '.' + process.pid + '.tmp';
    try {
      fs.writeFileSync(temp, JSON.stringify(pairs), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temp, this.stateFile);
    } finally {
      try { fs.unlinkSync(temp); } catch {}
    }
  }

  isPaired(cookieValue, revision) {
    if (typeof cookieValue !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(cookieValue)) return false;
    const browserHash = hash(cookieValue);
    return this.loadPairs().some((pair) => pair.hash === browserHash &&
      pair.expires > this.now() && pair.policyRevision === revision);
  }

  pair(code, revision) {
    if (!this.verifyCode(code)) return null;
    const browserToken = token();
    const pairs = this.loadPairs().filter((pair) =>
      pair.expires > this.now() && pair.policyRevision === revision);
    pairs.push({ hash: hash(browserToken), expires: this.now() + PAIR_TTL_MS, policyRevision: revision });
    this.savePairs(pairs.slice(-MAX_PAIRED_BROWSERS));
    return browserToken;
  }

  invalidatePending() {
    if (this.pending) this.grants.clear(this.pending.approvalId, 'web_claim_unavailable');
    this.pending = null;
  }

  unlock(durationSeconds, revision) {
    this.expirePending();
    if (this.pending) return false;
    const duration = validateApprovalDurationSeconds(durationSeconds);
    if (!DURATIONS.includes(duration)) throw new Error('Unsupported web unlock duration.');
    const approvalId = randomUUID();
    this.grants.grant({
      approvalId, requestedDurationSeconds: duration,
      operationId: 'web-unlock-' + randomUUID(), policyRevision: revision,
    });
    this.pending = { approvalId, claimExpires: this.now() + CLAIM_TTL_MS, policyRevision: revision };
    return true;
  }

  expirePending() {
    if (this.pending && (this.pending.claimExpires <= this.now() ||
      !this.grants.active(this.pending.approvalId))) this.invalidatePending();
  }

  claim() {
    const policy = this.policy();
    this.expirePending();
    if (policy.mode !== 'either' || !this.pending || this.pending.policyRevision !== policy.revision) {
      if (this.pending) this.invalidatePending();
      return null;
    }
    const record = this.grants.active(this.pending.approvalId);
    this.pending = null;
    return record;
  }

  async handleHttp(request, response, readBody) {
    const policy = this.policy();
    const cookies = readCookies(request.headers.cookie);
    if (policy.mode !== 'either') {
      responseHtml(response, 403, renderPage({ paired: false, csrf: '',
        message: 'BMG 当前未启用双通道授权。', error: true }));
      return;
    }
    const paired = this.isPaired(cookies[PAIR_COOKIE], policy.revision);
    if (request.method === 'GET') {
      const csrf = token();
      const url = new URL(request.url, 'http://localhost');
      let message = '';
      if (paired && url.searchParams.get('issued') === '1') message = '已临时解锁！回到 ChatGPT 说「已解锁，继续」。';
      if (paired && url.searchParams.get('paired') === '1') message = '浏览器配对成功，下次直接点「临时解锁」。';
      responseHtml(response, 200, renderPage({ paired, csrf, message }), [csrfCookie(csrf)]);
      return;
    }
    if (request.method !== 'POST') {
      responseHtml(response, 405, 'Method Not Allowed');
      return;
    }
    if (request.headers['content-type']?.split(';')[0]?.trim()?.toLowerCase() !== 'application/x-www-form-urlencoded') {
      responseHtml(response, 415, 'Unsupported Media Type');
      return;
    }
    const body = new URLSearchParams(await readBody(request, 4096));
    if (!safeEqual(cookies[CSRF_COOKIE], body.get('csrf')) || !cookies[CSRF_COOKIE]) {
      responseHtml(response, 403, renderPage({ paired, csrf: '', message: '表单已过期，请刷新重试。', error: true }));
      return;
    }
    if (body.get('action') === 'pair' && !paired) {
      const pairToken = this.pair(body.get('code'), policy.revision);
      if (!pairToken) {
        responseHtml(response, 403, renderPage({ paired: false, csrf: '', message: '验证码无效或已使用，请刷新后重试。', error: true }));
        return;
      }
      redirect(response, '?paired=1', [sessionCookie(pairToken, PAIR_TTL_MS / 1000)]);
      return;
    }
    if (body.get('action') === 'unlock' && paired) {
      try {
        const issued = this.unlock(Number(body.get('duration_seconds')), policy.revision);
        redirect(response, issued ? '?issued=1' : '?pending=1');
      } catch {
        responseHtml(response, 400, renderPage({ paired, csrf: '', message: '无效的授权时长，请刷新重试。', error: true }));
      }
      return;
    }
    responseHtml(response, 403, renderPage({ paired: false, csrf: '', message: '请先配对浏览器。', error: true }));
  }
}
