import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TimedGrantManager } from '../sidecar/approval/timed-grant-manager.mjs';
import { WebUnlockManager, WEB_UNLOCK_PATH } from '../sidecar/approval/web-unlock.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bmg-web-unlock-'));
let now = Date.now();
let revision = 10;
let mode = 'either';
let verifications = 0;
const grants = new TimedGrantManager({ now: () => now });
const manager = new WebUnlockManager({
  stateFile: path.join(root, 'browsers.json'),
  now: () => now,
  grants,
  verifyCode: (value) => { verifications++; return value === '123456' && verifications === 1; },
  policy: () => ({ revision, mode }),
});

async function page({ method = 'GET', cookie = '', body = null, url = '/web-unlock' } = {}) {
  const headers = {};
  let responseStatus = null;
  let responseText = '';
  const request = {
    url, method,
    headers: { cookie, ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
  };
  const response = {
    writeHead(status, value) { responseStatus = status; Object.assign(headers, value); },
    end(value = '') { responseText = value; },
  };
  await manager.handleHttp(request, response, async () => body);
  return { status: responseStatus, headers, text: responseText };
}

function cookiesOf(result) {
  return (result.headers['Set-Cookie'] || []).map((entry) => entry.split(';', 1)[0]).join('; ');
}

function hiddenCsrf(pageHtml) {
  return pageHtml.match(/name="csrf" value="([^"]+)"/)?.[1];
}

function form(csrf, action, fields = {}) {
  return new URLSearchParams({ csrf, action, ...fields }).toString();
}

try {
  assert.equal(WEB_UNLOCK_PATH, '/bmg/unlock');
  let initial = await page();
  assert.equal(initial.status, 200);
  assert.match(initial.text, /尚未配对/);
  assert.match(initial.headers['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.match(initial.headers['Cache-Control'], /no-store/);
  const csrf = hiddenCsrf(initial.text);
  let initialCookie = cookiesOf(initial);
  assert.ok(csrf && initialCookie.includes('bmg-web-csrf'));

  let denied = await page({ method: 'POST', cookie: '', body: form(csrf, 'pair', { code: '123456' }) });
  assert.equal(denied.status, 403, 'missing CSRF cookie is rejected');
  assert.equal(verifications, 0);

  const paired = await page({ method: 'POST', cookie: initialCookie, body: form(csrf, 'pair', { code: '123456' }) });
  assert.equal(paired.status, 303);
  assert.equal(paired.headers.Location, '/bmg/unlock?paired=1');
  assert.equal(verifications, 1);
  assert.ok(paired.headers['Set-Cookie'][0].includes('HttpOnly; Secure; SameSite=Lax'));
  const pairCookie = cookiesOf(paired);
  assert.ok(pairCookie.includes('bmg-web-pair'));
  assert.ok(!fs.readFileSync(path.join(root, 'browsers.json'), 'utf8').includes(pairCookie.split('=')[1]),
    'browser pairing token must be stored only as a hash');

  // Browser pairing survives manager recreation without retaining the TOTP code.
  const persisted = new WebUnlockManager({
    stateFile: path.join(root, 'browsers.json'),
    now: () => now, grants, policy: () => ({ revision, mode }), verifyCode: () => false,
  });
  assert.equal(persisted.isPaired(pairCookie.split('=')[1], revision), true);

  let ready = await page({ cookie: pairCookie, url: '/web-unlock?paired=1' });
  assert.equal(ready.status, 200);
  assert.match(ready.text, /临时解锁 BMG/);
  assert.doesNotMatch(ready.text, /name="code"/);
  const unlockCsrf = hiddenCsrf(ready.text);
  const unlockCookie = pairCookie + '; ' + cookiesOf(ready);
  let unlock = await page({ method: 'POST', cookie: unlockCookie,
    body: form(unlockCsrf, 'unlock', { duration_seconds: '300' }) });
  assert.equal(unlock.status, 303);
  assert.equal(unlock.headers.Location, '/bmg/unlock?issued=1');
  assert.equal(grants.snapshot().grant_count, 1);

  // A duplicate button click never creates multiple grants until claimed.
  unlock = await page({ method: 'POST', cookie: unlockCookie,
    body: form(unlockCsrf, 'unlock', { duration_seconds: '300' }) });
  assert.equal(unlock.headers.Location, '/bmg/unlock?pending=1');
  assert.equal(grants.snapshot().grant_count, 1);
  let claimed = manager.claim();
  assert.equal(claimed?.grant_state, 'active');
  assert.equal(claimed?.requested_duration_seconds, 300);
  assert.equal(manager.claim(), null, 'web grant must be claimed exactly once');
  assert.equal(grants.snapshot().grant_count, 1, 'claim must not revoke active grant');

  ready = await page({ cookie: pairCookie });
  let c = hiddenCsrf(ready.text);
  let ck = pairCookie + '; ' + cookiesOf(ready);
  await page({ method: 'POST', cookie: ck, body: form(c, 'unlock', { duration_seconds: '60' }) });
  assert.equal(grants.snapshot().grant_count, 2);
  now += 5 * 60 * 1000 + 1;
  assert.equal(manager.claim(), null, 'unclaimed grant must expire');
  assert.equal(grants.inspect(manager.pending?.approvalId)?.grant_state, undefined);
  assert.equal(grants.snapshot().grant_count, 0, 'unclaimed grant and previous elapsed grant expire');

  ready = await page({ cookie: pairCookie });
  c = hiddenCsrf(ready.text); ck = pairCookie + '; ' + cookiesOf(ready);
  await page({ method: 'POST', cookie: ck, body: form(c, 'unlock', { duration_seconds: '21600' }) });
  revision++;
  assert.equal(manager.claim(), null, 'policy change prevents claiming');
  assert.equal(grants.snapshot().grant_count, 0, 'pending grant revoked after policy change');
  assert.equal((await page({ cookie: pairCookie })).text.includes('尚未配对'), true,
    'policy revision forces re-pairing');
  mode = 'timed';
  assert.equal((await page()).status, 403, 'disabled mode disallows web unlock');
  console.log('BMG one-tap web unlock, pairing, CSRF, claim-once, expiry, mode and revision tests: PASS');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
