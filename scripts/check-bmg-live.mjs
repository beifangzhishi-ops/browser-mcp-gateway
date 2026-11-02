import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bmgctl = path.join(rootDir, 'scripts', 'bmgctl.mjs');
const netstatExe = 'C:\\Windows\\System32\\netstat.exe';

export function inspectBrowserToolResponse(response, { requireAccessibilityTree = false } = {}) {
  if (!response || response.success !== true || response.result?.isError !== false) {
    return { passed: false, reason: 'browser_tool_error' };
  }
  const item = response.result?.content?.find((entry) => entry?.type === 'text' && typeof entry.text === 'string');
  if (!item) return { passed: false, reason: 'missing_tool_content' };
  let payload;
  try {
    payload = JSON.parse(item.text);
  } catch {
    return { passed: false, reason: 'invalid_tool_payload' };
  }
  if (payload?.success !== true) return { passed: false, reason: 'tool_payload_error' };
  if (requireAccessibilityTree && payload.fallbackUsed === true) {
    // sparse_tree 只在主树读取成功后产生；此分支保留主树正文，交互元素作为补充。
    const stats = payload.stats;
    const primaryTreeSupplemented = payload.reason === 'sparse_tree'
      && payload.sparse === true
      && payload.fallbackSource === 'get_interactive_elements'
      && typeof payload.pageContent === 'string' && payload.pageContent.trim().length > 0
      && Number.isInteger(stats?.processed) && stats.processed > 0
      && Number.isInteger(stats?.included) && stats.included > 0
      && stats.included <= stats.processed;
    return primaryTreeSupplemented
      ? { passed: true, reason: 'primary_tree_with_interactive_supplement' }
      : { passed: false, reason: 'accessibility_tree_fallback_only' };
  }
  if (requireAccessibilityTree && typeof payload.pageContent !== 'string') {
    return { passed: false, reason: 'missing_accessibility_content' };
  }
  return { passed: true, reason: 'ok' };
}

function run(executable, args, maxBuffer = 8 * 1024 * 1024) {
  const response = spawnSync(executable, args, {
    cwd: rootDir,
    encoding: 'utf8',
    timeout: 45_000,
    maxBuffer,
    windowsHide: true,
  });
  return {
    ok: !response.error && response.status === 0,
    output: response.stdout || '',
  };
}

function callBmgctl(args) {
  const response = run(process.execPath, [bmgctl, ...args]);
  let parsed;
  try {
    parsed = JSON.parse(response.output);
  } catch {
    return { ok: false, reason: 'invalid_bmgctl_json' };
  }
  return { ok: response.ok, payload: parsed, reason: response.ok ? 'ok' : 'command_failed' };
}

function listeningPids() {
  const response = run(netstatExe, ['-ano', '-p', 'TCP'], 2 * 1024 * 1024);
  if (!response.ok) return { pids: null, reason: 'listener_probe_unavailable' };
  const pids = new Map();
  for (const line of response.output.split(/\r?\n/u)) {
    const match = /^\s*TCP\s+127\.0\.0\.1:(12306|18007)\s+\S+\s+LISTENING\s+(\d+)\s*$/u.exec(line);
    if (match && Number(match[2]) > 0) pids.set(Number(match[1]), Number(match[2]));
  }
  return { pids, reason: 'ok' };
}

export async function checkLiveService() {
  let failed = false;
  function report(name, passed, reason = '') {
    if (!passed) failed = true;
    console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${reason ? `: ${reason}` : ''}`);
  }

  const firstProbe = listeningPids();
  const baseline = firstProbe.pids;
  const portsPass = baseline?.has(12306) && baseline?.has(18007)
    && baseline.get(12306) !== baseline.get(18007);
  report('independent 12306 and 18007 listeners', !!portsPass,
    portsPass ? 'ok' : firstProbe.reason === 'ok' ? 'listener_missing' : firstProbe.reason);
  if (!portsPass) {
    console.log('NOT DELIVERED: unsafe to proceed with browser probes while a listener is missing.');
    return false;
  }

  const health = callBmgctl(['health']);
  report('Sidecar health', health.ok && health.payload?.status === 'ok'
    && health.payload?.upstream === 'http://127.0.0.1:12306');
  if (!health.ok || health.payload?.status !== 'ok') {
    console.log('NOT DELIVERED: Sidecar health failed; no workspace recovery attempted.');
    return false;
  }

  // Never create a new workspace just to satisfy a post-maintenance health probe.
  // The existing state is only a preflight guard; the workspace response still
  // needs its normal ownership verification before the browser is considered live.
  const existingWorkspaceFile = path.join(rootDir, '.state', 'bmg-workspace.json');
  let existingWorkspace = null;
  try {
    existingWorkspace = JSON.parse(fs.readFileSync(existingWorkspaceFile, 'utf8'));
  } catch {}
  const workspaceRecorded = Number.isInteger(existingWorkspace?.tabId)
    && Number.isInteger(existingWorkspace?.windowId);
  report('existing workspace state preflight', workspaceRecorded,
    workspaceRecorded ? 'ok' : 'state_missing_or_invalid');
  if (!workspaceRecorded) {
    console.log('NOT DELIVERED: refusing a workspace probe that could trigger new Edge recovery.');
    return false;
  }

  const resource = health.payload?.resource;
  if (typeof resource === 'string' && resource.startsWith('https://')) {
    try {
      const uri = new URL(resource);
      const metadata = await fetch(`${uri.origin}/.well-known/oauth-protected-resource${uri.pathname}`, {
        signal: AbortSignal.timeout(9_000),
      });
      report('public OAuth metadata', metadata.status === 200, `HTTP ${metadata.status}`);
    } catch {
      report('public OAuth metadata', false, 'request_failed');
    }
  } else {
    report('public OAuth metadata', false, 'invalid_resource_uri');
  }

  const workspace = callBmgctl(['workspace']);
  report('owned BMG workspace', workspace.ok && workspace.payload?.success === true
    && Number.isInteger(workspace.payload?.workspace?.tabId)
    && Number.isInteger(workspace.payload?.workspace?.windowId));
  if (!workspace.ok || workspace.payload?.success !== true) {
    console.log('NOT DELIVERED: workspace check failed.');
    return false;
  }

  const cases = [
    { name: 'chrome_get_web_content textContent=true', tool: 'chrome_get_web_content', args: { textContent: true }, tree: false },
    { name: 'chrome_read_page defaults (primary accessibility tree)', tool: 'chrome_read_page', args: {}, tree: true },
    { name: 'chrome_read_page depth=0 (primary accessibility tree)', tool: 'chrome_read_page', args: { depth: 0 }, tree: true },
  ];
  for (const item of cases) {
    const encoded = Buffer.from(JSON.stringify(item.args)).toString('base64');
    const result = callBmgctl(['call', item.tool, '--args-base64', encoded]);
    const inspected = inspectBrowserToolResponse(result.payload, { requireAccessibilityTree: item.tree });
    report(item.name, inspected.passed && result.ok, inspected.reason);
  }

  const finalProbe = listeningPids();
  const final = finalProbe.pids;
  report('upstream and Sidecar PIDs unchanged during acceptance', !!final
    && final.get(12306) === baseline.get(12306)
    && final.get(18007) === baseline.get(18007),
    final ? '' : finalProbe.reason);
  console.log(failed ? 'NOT DELIVERED: mandatory live checks failed.' : 'LIVE ACCEPTANCE PASSED.');
  return !failed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkLiveService().then((passed) => {
    if (!passed) process.exitCode = 1;
  }).catch(() => {
    console.error('NOT DELIVERED: live acceptance encountered an unexpected error.');
    process.exitCode = 1;
  });
}
