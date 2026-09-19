import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig } from '../sidecar/config.mjs';

const execFileAsync = promisify(execFile);

export async function prepareWorkspace({ request, ensureEdge, wait = sleep, log = () => {} }) {
  let checkedEdge = false;
  for (const delay of [0, 10000, 20000, 40000]) {
    if (delay) await wait(delay);
    const result = await request();
    if (result.ok) {
      log('BMG 工作区已就绪。');
      return;
    }
    if ([403, 404, 409].includes(result.status)) {
      throw new Error('本机检查入口不可用，请确认服务已更新、认证有效且工作区模式已开启。');
    }
    if (!checkedEdge) {
      await ensureEdge();
      checkedEdge = true;
    }
    log('工作区尚未就绪，等待 Edge 扩展和本地桥接连接。');
  }
  throw new Error('BMG 工作区启动失败，请检查 Edge 扩展是否已启用自动连接。');
}

async function main() {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const config = loadConfig(rootDir);
  fs.mkdirSync(config.logDir, { recursive: true });
  const log = (message) => {
    fs.appendFileSync(path.join(config.logDir, 'bmg-workspace-startup.log'),
      `${new Date().toISOString()} ${message}\n`, 'utf8');
  };
  try {
    if (!config.workspaceMode) throw new Error('请先启用 BMG_WORKSPACE_MODE=1。');
    const secret = config.approvalSecret ?? fs.readFileSync(config.approvalSecretFile, 'utf8').trim();
    await prepareWorkspace({
      log,
      request: async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${config.port}/internal/ensure-workspace`, {
            method: 'POST', headers: { 'x-bmg-local-secret': secret },
            signal: AbortSignal.timeout(130000), redirect: 'error',
          });
          const body = await response.json();
          return { ok: response.ok && body.success === true, status: response.status };
        } catch {
          return { ok: false, status: 0 };
        }
      },
      ensureEdge: async () => {
        const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        await execFileAsync(powershell, [
          '-NoProfile', '-ExecutionPolicy', 'Bypass',
          '-File', path.join(rootDir, 'scripts', 'ensure-edge.ps1'),
          '-Port', String(config.port),
          '-BootstrapStateFile', path.join(path.dirname(config.workspaceStateFile), 'bmg-edge-bootstrap.json'),
        ], { windowsHide: true, timeout: 15000 });
      },
    });
  } catch (error) {
    log(error.message);
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write('BMG 工作区启动失败，请检查本机配置。\n');
    process.exitCode = 1;
  });
}
