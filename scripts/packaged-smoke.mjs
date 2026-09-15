// 打包应用冒烟（2026-09-15）：release7/win-unpacked exe + 隔离 profile + CDP 就绪探针。
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const exe = fs.readdirSync(path.join(ROOT, 'release7/win-unpacked')).find((f) => f.endsWith('.exe'));
if (!exe) { console.error('NO_EXE'); process.exit(2); }
const exePath = path.join(ROOT, 'release7/win-unpacked', exe);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-packaged-smoke-'));
const evidence = { exe: exePath, profile, startedAt: new Date().toISOString(), pid: null, targets: null, alive30s: null, error: null };

const child = spawn(exePath, ['--remote-debugging-port=0'], {
  env: { ...process.env, METIS_USER_DATA_DIR: profile },
  stdio: 'ignore',
});
evidence.pid = child.pid;
const killTree = () => { try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch {} };
process.on('exit', killTree);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readPort = () => {
  try {
    const file = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8');
    return Number(file.split('\n')[0].trim());
  } catch { return null; }
};

let port = null;
for (let i = 0; i < 90 && !port; i += 1) { await sleep(1000); port = readPort(); }
if (!port) { evidence.error = 'DevToolsActivePort never appeared (app may have failed to boot)'; }

const fetchTargets = () => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path: '/json/list', timeout: 3000 }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
  });
  req.on('error', () => resolve(null));
  req.setTimeout(3000, () => { req.destroy(); resolve(null); });
});

if (port) {
  for (let i = 0; i < 30; i += 1) {
    const targets = await fetchTargets();
    const page = targets?.find((t) => t.type === 'page');
    if (page) { evidence.targets = targets.map((t) => ({ type: t.type, title: t.title, url: t.url })); break; }
    await sleep(1000);
  }
  await sleep(30_000);
  evidence.alive30s = !child.pid || true;
  try { process.kill(child.pid, 0); evidence.alive30s = true; } catch { evidence.alive30s = false; }
}

killTree();
evidence.finishedAt = new Date().toISOString();
evidence.pass = Boolean(evidence.targets?.some((t) => t.type === 'page' && /metis-app:\/\/|index\.html/.test(t.url)) && evidence.alive30s === true);
fs.writeFileSync(path.join(ROOT, 'logs/packaged-smoke-20260915.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
process.exit(evidence.pass ? 0 : 1);
