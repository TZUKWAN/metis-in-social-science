#!/usr/bin/env node
/**
 * start-remote-bridge — 以远程开发桥模式启动 METIS 主进程（dev-only）。
 *
 * 用法：npm run start:remote
 * 等价于 METIS_REMOTE_BRIDGE=1 electron .：主进程额外开启回环 HTTP/SSE
 * 服务，供 Vite dev server 里的浏览器界面调用真实 IPC。
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

const child = spawn(process.execPath, ['node_modules/electron/cli.js', '.'], {
  stdio: 'inherit',
  env: { ...process.env, METIS_REMOTE_BRIDGE: '1' },
  windowsHide: true,
});
child.on('exit', (code) => process.exitCode = code ?? 0);
