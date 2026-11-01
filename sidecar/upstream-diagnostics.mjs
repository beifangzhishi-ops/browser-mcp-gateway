import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const DEFAULT_PROBE_INTERVAL_MS = 30_000;
const MAX_LOG_BYTES = 10 * 1024 * 1024;

function safeCode(error) {
  const code = error?.code;
  return typeof code === 'string' && /^[A-Z_0-9]{1,40}$/u.test(code)
    ? code : 'UNKNOWN';
}

export function probeTcpPort({ host, port, timeoutMs = 2000 }) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (state, code = null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ state, code });
    };
    socket.setTimeout(timeoutMs, () => finish('down', 'ETIMEDOUT'));
    socket.once('connect', () => finish('up'));
    socket.once('error', (error) => finish('down', safeCode(error)));
  });
}

// Evidence only: these are machine-wide process counts and PIDs, not proof that
// a particular Edge/Node process belongs to the BMG workspace or native host.
export async function snapshotWindowsProcesses() {
  if (process.platform !== 'win32') return null;
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = '$items = @(Get-Process -Name msedge,node -ErrorAction SilentlyContinue | ' +
    'Select-Object ProcessName,Id); ' +
    '$items | ConvertTo-Json -Compress';
  const { stdout } = await execFileAsync(powershell,
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 5000, maxBuffer: 128 * 1024 });
  const items = stdout.trim() ? JSON.parse(stdout) : [];
  const processes = Array.isArray(items) ? items : [items];
  const selected = (name) => processes
    .filter((p) => String(p.ProcessName).toLowerCase() === name && Number.isInteger(p.Id))
    .map((p) => p.Id).sort((a, b) => a - b);
  const edge = selected('msedge');
  const node = selected('node');
  return { edge_count: edge.length, edge_pids: edge.slice(0, 64),
    node_count: node.length, node_pids: node.slice(0, 64) };
}

export class UpstreamDiagnostics {
  constructor({ logDir, upstreamUrl, intervalMs = DEFAULT_PROBE_INTERVAL_MS,
    probe = probeTcpPort, snapshot = snapshotWindowsProcesses,
    now = () => Date.now(), logger = null } = {}) {
    const url = new URL(upstreamUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      throw new Error('Upstream diagnostics require a local HTTP upstream.');
    }
    this.target = { host: url.hostname, port: Number(url.port || 80) };
    this.file = path.join(logDir, 'bmg-upstream-diagnostics.jsonl');
    this.intervalMs = intervalMs;
    this.probe = probe;
    this.snapshot = snapshot;
    this.now = now;
    this.logger = logger;
    this.state = null;
    this.stateSince = null;
    this.timer = null;
    this.running = null;
  }

  record(event, fields = {}) {
    // Only fixed, non-sensitive event names and allowlisted metadata are passed in.
    try {
      const line = JSON.stringify({ at: new Date(this.now()).toISOString(),
        event, ...fields }) + '\n';
      if (fs.existsSync(this.file) && fs.statSync(this.file).size + Buffer.byteLength(line) > MAX_LOG_BYTES) {
        const previous = this.file + '.1';
        fs.rmSync(previous, { force: true });
        fs.renameSync(this.file, previous);
      }
      fs.appendFileSync(this.file, line, { encoding: 'utf8', mode: 0o600 });
    } catch {
      this.logger?.error?.('BMG upstream diagnostic log write failed.');
    }
  }

  requestFailure(stage, error, status = null) {
    this.record('upstream_request_failed', {
      stage, code: safeCode(error),
      ...(Number.isInteger(status) ? { http_status: status } : {}),
    });
  }

  async pollOnce() {
    if (this.running) return this.running;
    const task = this.sample();
    this.running = task;
    try { await task; } finally { if (this.running === task) this.running = null; }
  }

  async sample() {
    let observation;
    try { observation = await this.probe(this.target); }
    catch (error) { observation = { state: 'down', code: safeCode(error) }; }
    const state = observation?.state === 'up' ? 'up' : 'down';
    if (state === this.state) return;
    const at = this.now();
    const previous = this.state;
    const elapsed = this.stateSince === null ? null : Math.max(0, at - this.stateSince);
    this.state = state;
    this.stateSince = at;
    let processes = null;
    let processError = null;
    try { processes = await this.snapshot(); }
    catch (error) { processError = safeCode(error); }
    this.record('upstream_state_changed', {
      state, previous_state: previous, previous_duration_ms: elapsed,
      ...(state === 'down' ? { tcp_error: observation?.code || 'UNKNOWN' } : {}),
      ...(processes ? { processes } : {}),
      ...(processError ? { process_snapshot_error: processError } : {}),
    });
  }

  start() {
    if (this.timer) return;
    this.record('monitor_started', { interval_ms: this.intervalMs, upstream_port: this.target.port,
      sidecar_pid: process.pid });
    void this.pollOnce();
    this.timer = setInterval(() => { void this.pollOnce(); }, this.intervalMs);
    this.timer.unref?.();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.running) await this.running;
    this.record('monitor_stopped', { sidecar_pid: process.pid });
  }
}
