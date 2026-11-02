// Read-only production smoke test: never submits a real authenticator code,
// pairs a browser, claims a grant, or accesses browser tools.
import assert from 'node:assert/strict';
import { loadConfig } from '../sidecar/config.mjs';

const config = loadConfig();
const url = config.issuer + '/unlock';
const page = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(12000) });
assert.equal(page.status, 200, 'BMG mobile unlock page must be reachable over HTTPS');
assert.match(page.headers.get('content-type') || '', /text\/html/);
assert.match(page.headers.get('cache-control') || '', /no-store/);
assert.match(page.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
const html = await page.text();
assert.match(html, /BMG 临时解锁/);
const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
assert.ok(csrf, 'page must render an unpredictable CSRF form token');

const denial = await fetch(url, {
  method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(12000),
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    Origin: 'null', 'Sec-Fetch-Site': 'cross-site',
  },
  // Valid form token but no CSRF cookie or paired browser identity.
  body: new URLSearchParams({ csrf, action: 'unlock', duration_seconds: '60' }).toString(),
});
assert.equal(denial.status, 403, 'no-cookie request must fail closed');
console.log('Public BMG HTTPS unlock page and no-cookie denial: PASS');
