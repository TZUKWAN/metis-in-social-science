// 打包应用冒烟（2026-09-15）：win-unpacked exe + 隔离 profile + CDP 就绪探针
// + 主进程日志存储初始化核验。
//
// 通过标准（全部满足才算 PASS）：
//   1. DevToolsActivePort 出现（应用完成启动）；
//   2. CDP /json/list 见真实渲染页 metis-app://renderer/index.html；
//   3. 进程 30 秒存活；
//   4. 隔离 profile 的主进程日志出现 "PersistenceStore initialized"——
//      防止 native ABI 不匹配导致存储静默失效仍被判通过（本机曾踩：
//      以 Node ABI 打包出 Electron 无法加载的 better-sqlite3）。
//
// 用法：METIS_PACKED_DIR=release8 node scripts/packaged-smoke.mjs
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const PACKED_DIR = process.env.METIS_PACKED_DIR || 'release7';
const unpackedDir = path.join(ROOT, PACKED_DIR, 'win-unpacked');
const exe = fs.readdirSync(unpackedDir).find((f) => f.endsWith('.exe'));
if (!exe) { console.error('NO_EXE'); process.exit(2); }
const exePath = path.join(unpackedDir, exe);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-packaged-smoke-'));
const evidence = { exe: exePath, profile, startedAt: new Date().toISOString(), pid: null, targets: null, alive30s: null, storeInitialized: null, error: null };

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

const fetchTargets = () => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path: '/json/list', timeout: 3000 }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
  });
  req.on('error', () => resolve(null));
  req.setTimeout(3000, () => { req.destroy(); resolve(null); });
});

// 主进程日志：<profile>/metis-data/logs/main-*.log，持久化层就绪会写
// "PersistenceStore initialized"。
const checkStoreLog = () => {
  try {
    const logDir = path.join(profile, 'metis-data', 'logs');
    const logs = fs.readdirSync(logDir).filter((f) => f.startsWith('main-'));
    for (const f of logs) {
      if (fs.readFileSync(path.join(logDir, f), 'utf8').includes('PersistenceStore initialized')) return true;
    }
  } catch { /* logs not written yet */ }
  return false;
};

let port = null;
for (let i = 0; i < 90 && !port; i += 1) { await sleep(1000); port = readPort(); }
if (!port) { evidence.error = 'DevToolsActivePort never appeared (app may have failed to boot)'; }

if (port) {
  for (let i = 0; i < 30; i += 1) {
    const targets = await fetchTargets();
    const page = targets?.find((t) => t.type === 'page');
    if (page) { evidence.targets = targets.map((t) => ({ type: t.type, title: t.title, url: t.url })); break; }
    await sleep(1000);
  }
  await sleep(30_000);
  evidence.alive30s = true;
  try { process.kill(child.pid, 0); evidence.alive30s = true; } catch { evidence.alive30s = false; }
  for (let i = 0; i < 10 && !evidence.storeInitialized; i += 1) {
    evidence.storeInitialized = checkStoreLog();
    if (!evidence.storeInitialized) await sleep(1500);
  }
}

killTree();
evidence.finishedAt = new Date().toISOString();
evidence.pass = Boolean(
  evidence.targets?.some((t) => t.type === 'page' && /metis-app:\/\/|index\.html/.test(t.url))
  && evidence.alive30s === true
  && evidence.storeInitialized === true,
);
fs.writeFileSync(path.join(ROOT, 'logs/packaged-smoke-20260915.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
process.exit(evidence.pass ? 0 : 1);
