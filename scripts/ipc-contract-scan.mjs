// IPC contract scan — extracts the renderer-facing IPC surface as a sorted,
// deterministic channel list so CI can fail loudly on unreviewed drift.
//
// Unlike scripts/scan-ipc-inventory.mjs (a line-number diagnostic that stays
// untouched), this module is contract-oriented:
//   invoke      — ipcMain.handle('<channel>' …) across electron/*.ts and electron/ipc/**
//   renderer    — ipcRenderer.invoke('<channel>') in electron/preload.ts
//   send        — webContents.send('<channel>' …) main→renderer events
//   contractVersions — *_CONTRACT_VERSION constants exposed by electron code
//
// Usage:
//   node scripts/ipc-contract-scan.mjs            → prints summary JSON to stdout
//   node scripts/ipc-contract-scan.mjs --write    → refreshes the golden snapshot
//                                                   (tests/fixtures/ipc/ipc-inventory.snapshot.json)
//                                                   and writes raw detail to logs/ipc-contract-raw.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT_PATH = path.join(ROOT, 'tests/fixtures/ipc/ipc-inventory.snapshot.json');
const RAW_LOG_PATH = path.join(ROOT, 'logs/ipc-contract-raw.json');
const QUOTE = "['\"`]";

function listElectronSources() {
  const sources = [];
  const electronDir = path.join(ROOT, 'electron');
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__pycache__' || entry.name === 'node_modules') continue;
        walk(full);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        sources.push(full);
      }
    }
  };
  walk(electronDir);
  return sources;
}

function extractQuotedCall(text, callPattern, onChannel) {
  const found = new Set();
  const record = (ch) => {
    if (!ch) return;
    found.add(ch);
    if (onChannel) onChannel(ch);
  };
  const re = new RegExp(`${callPattern}\\(\\s*(${QUOTE})([^'"\`]+)\\1`, 'g');
  let m;
  while ((m = re.exec(text))) record(m[2]);
  // multi-line registration form: handle(\n  'channel',
  const openRe = new RegExp(`${callPattern}\\(\\s*$`, 'gm');
  while ((m = openRe.exec(text))) {
    const rest = text.slice(m.index + m[0].length, m.index + m[0].length + 200);
    const simple = rest.match(new RegExp(`^\\s*(${QUOTE})([^'"\`]+)\\1`));
    if (simple) record(simple[2]);
  }
  return found;
}

export function scanIpcContract() {
  const invoke = new Set();
  const send = new Set();
  const contractVersions = {};
  // invoke 通道 → 注册点列表（"相对路径"重复出现即该文件注册多次）。
  // Electron 的 ipcMain.handle 对同通道二次注册会直接抛错（主进程启动即崩），
  // 2026-09-15 曾因 registrar 已迁入而 main.ts 残留旧 handler 踩过坑，这里守门。
  const invokeSites = new Map();
  for (const file of listElectronSources()) {
    const rel = path.relative(ROOT, file).split('\\').join('/');
    const text = fs.readFileSync(file, 'utf8');
    if (!rel.endsWith('preload.ts')) {
      const onInvoke = (ch) => {
        const sites = invokeSites.get(ch) ?? [];
        sites.push(rel);
        invokeSites.set(ch, sites);
      };
      for (const ch of extractQuotedCall(text, 'ipcMain\\.handle', onInvoke)) invoke.add(ch);
      for (const ch of extractQuotedCall(text, 'webContents\\.send')) send.add(ch);
      // Domain registrars (electron/ipc/**) route through IpcRegistry:
      // `registry.handle('channel', …)` / `topic.handle('channel', …)`.
      if (rel.startsWith('electron/ipc/')) {
        for (const ch of extractQuotedCall(text, '[A-Za-z_$][\\w$]*\\.handle', onInvoke)) invoke.add(ch);
      }
    }
    for (const m of text.matchAll(/([A-Z0-9_]+_CONTRACT_VERSION)\s*=\s*(\d+)/g)) {
      contractVersions[m[1]] = Number(m[2]);
    }
  }
  const duplicateInvoke = [...invokeSites.entries()]
    .filter(([, sites]) => sites.length > 1)
    .map(([channel, sites]) => ({ channel, sites }))
    .sort((a, b) => a.channel.localeCompare(b.channel));

  // Contract version constants live next to the zod contracts in engine/runtime.
  const runtimeDir = path.join(ROOT, 'engine/runtime');
  if (fs.existsSync(runtimeDir)) {
    for (const entry of fs.readdirSync(runtimeDir)) {
      if (!entry.endsWith('.ts')) continue;
      const text = fs.readFileSync(path.join(runtimeDir, entry), 'utf8');
      for (const m of text.matchAll(/export const ([A-Z0-9_]+_CONTRACT_VERSION)\s*=\s*(\d+)/g)) {
        contractVersions[m[1]] = Number(m[2]);
      }
    }
  }

  // 任务3：preload 拆分为 electron/preload.ts + electron/preload/*Bridge.ts，
  // renderer 可达面 = 全部 bridge 文件的并集，逐个拼接扫描（channel 集合不变）。
  const preloadFiles = [
    path.join(ROOT, 'electron/preload.ts'),
    ...fs.readdirSync(path.join(ROOT, 'electron/preload'))
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => path.join(ROOT, 'electron/preload', f)),
  ];
  const preloadText = preloadFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

  const renderer = extractQuotedCall(preloadText, 'ipcRenderer\\.invoke');

  return {
    schemaVersion: 1,
    counts: { invoke: invoke.size, rendererInvoke: renderer.size, send: send.size },
    invoke: [...invoke].sort(),
    rendererInvoke: [...renderer].sort(),
    send: [...send].sort(),
    contractVersions: Object.fromEntries(Object.entries(contractVersions).sort(([a], [b]) => a.localeCompare(b))),
    duplicateInvoke,
  };
}

function diffChannels(golden, current) {
  const added = [];
  const removed = [];
  for (const key of ['invoke', 'rendererInvoke', 'send']) {
    const g = new Set(golden[key] ?? []);
    const c = new Set(current[key] ?? []);
    for (const ch of c) if (!g.has(ch)) added.push(`${key}:${ch}`);
    for (const ch of g) if (!c.has(ch)) removed.push(`${key}:${ch}`);
  }
  return { added, removed };
}

export function main(argv) {
  const scan = scanIpcContract();
  const write = argv.includes('--write');
  if (write) {
    fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
    fs.mkdirSync(path.dirname(RAW_LOG_PATH), { recursive: true });
    fs.writeFileSync(SNAPSHOT_PATH, `${JSON.stringify({ schemaVersion: 1, counts: scan.counts, invoke: scan.invoke, rendererInvoke: scan.rendererInvoke, send: scan.send, contractVersions: scan.contractVersions }, null, 2)}\n`);
    fs.writeFileSync(RAW_LOG_PATH, `${JSON.stringify({ generatedAt: new Date().toISOString(), scan }, null, 2)}\n`);
    console.log(`wrote ${path.relative(ROOT, SNAPSHOT_PATH)} (invoke=${scan.counts.invoke} renderer=${scan.counts.rendererInvoke} send=${scan.counts.send})`);
    return 0;
  }
  const golden = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
  const { added, removed } = diffChannels(golden, scan);
  const duplicatesOk = scan.duplicateInvoke.length === 0;
  console.log(JSON.stringify({ counts: scan.counts, goldenCounts: golden.counts, added, removed, duplicateInvoke: scan.duplicateInvoke }, null, 2));
  if (!duplicatesOk) {
    console.error('duplicate invoke registration detected — ipcMain.handle throws on the second handler for a channel (main process crashes at startup)');
  }
  return added.length === 0 && removed.length === 0 && duplicatesOk ? 0 : 1;
}

if (process.argv[1] && process.argv[1].endsWith('ipc-contract-scan.mjs')) {
  process.exit(main(process.argv.slice(2)));
}
