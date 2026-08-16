#!/usr/bin/env node
/**
 * dev-publish — 一条命令完成「源仓库 → 运行目录」发布（T31，收编双目录）。
 *
 * 用法：
 *   node scripts/dev-publish.mjs            # 同步源→运行 + 构建 + 重启 App
 *   node scripts/dev-publish.mjs --no-build # 仅同步（不构建）
 *   node scripts/dev-publish.mjs --no-restart # 同步+构建，不重启
 *
 * 方向约定（消除手工 robocopy 事故）：
 *   SOURCE  = D:\LATEXTEST\metis-alpha2-release   （git 交付仓库，唯一真源）
 *   RUNTIME = D:\LATESTEXT\metis-alpha2-release   （App 运行目录，用户从这里启动）
 *   常规开发流：在 SOURCE 改代码 → node scripts/dev-publish.mjs → 用户立即看到。
 *   本脚本同时在两个目录各存一份，两边都可运行；始终以 SOURCE 为准覆盖 RUNTIME。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = new Set(process.argv.slice(2));
const NO_BUILD = args.has('--no-build');
const NO_RESTART = args.has('--no-restart');

const SOURCE = 'D:\\LATEXTEST\\metis-alpha2-release';
const RUNTIME = 'D:\\LATESTEXT\\metis-alpha2-release';

const SYNC_DIRS = ['src', 'electron', 'engine', 'tests', 'scripts', 'docs'];

function log(step, msg) {
  console.log(`[dev-publish ${step}] ${msg}`);
}

function copyDir(from, to) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(to, { recursive: true });
  let copied = 0;
  const walk = (srcDir, dstDir) => {
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.cache' || entry.name === '.git') continue;
      const srcPath = path.join(srcDir, entry.name);
      const dstPath = path.join(dstDir, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(dstPath, { recursive: true });
        walk(srcPath, dstPath);
      } else {
        const srcStat = fs.statSync(srcPath);
        let stale = true;
        try {
          const dstStat = fs.statSync(dstPath);
          stale = srcStat.mtimeMs !== dstStat.mtimeMs || srcStat.size !== dstStat.size;
        } catch { /* destination missing */ }
        if (stale) {
          fs.copyFileSync(srcPath, dstPath);
          fs.utimesSync(dstPath, srcStat.atime, srcStat.mtime);
          copied += 1;
        }
      }
    }
  };
  walk(from, to);
  return copied;
}

function run(cmd, cwd, extraEnv = {}) {
  const result = spawnSync(cmd, {
    cwd,
    shell: true,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  });
  if (result.status !== 0) {
    console.error(`[dev-publish] 命令失败 (${cmd})，退出码 ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

function main() {
  if (!fs.existsSync(SOURCE) || !fs.existsSync(RUNTIME)) {
    console.error(`[dev-publish] 目录不存在：${SOURCE} / ${RUNTIME}`);
    process.exit(1);
  }
  let total = 0;
  for (const dir of SYNC_DIRS) {
    total += copyDir(path.join(SOURCE, dir), path.join(RUNTIME, dir));
  }
  // 顶层的 package.json / 配置文件也以 SOURCE 为准。
  for (const file of ['package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts', 'eslint.config.js']) {
    const src = path.join(SOURCE, file);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(RUNTIME, file));
  }
  log('sync', `SOURCE → RUNTIME 完成，更新 ${total} 个文件`);

  if (!NO_BUILD) {
    log('build', 'npm run build:electron（typecheck + vite + electron ABI）…');
    run('npm run build:electron', RUNTIME);
  }

  if (!NO_RESTART) {
    log('restart', '重启 App…');
    spawnSync('powershell -NoProfile -Command "Get-Process | Where-Object { $_.Name -match \'electron\' } | Stop-Process -Force"', { shell: true, stdio: 'ignore' });
    const cmdLine = `cd /d ${RUNTIME} && npm run start > ${RUNTIME}\\app-run.log 2>&1`;
    spawnSync(`powershell -NoProfile -Command "Start-Process -FilePath cmd.exe -ArgumentList @('/c', '${cmdLine}') -WindowStyle Hidden"`, { shell: true, stdio: 'ignore' });
    log('restart', '已后台启动，日志见 RUNTIME\\app-run.log');
  }
  log('done', '发布完成。');
}

main();
