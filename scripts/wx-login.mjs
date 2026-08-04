import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { app, safeStorage } from 'electron';

const logFile = path.resolve('wx-login.log');
const say = (...args) => {
  const line = `[wx-login] ${args.join(' ')}`;
  try { fs.appendFileSync(logFile, `${line}\n`); } catch { /* ignore */ }
};

process.on('uncaughtException', (err) => { say('uncaughtException:', err && err.message, err && err.stack); process.exit(1); });
process.on('unhandledRejection', (err) => { say('unhandledRejection:', err && err.message, err && err.stack); process.exit(1); });

fs.writeFileSync(logFile, '');
say('boot');

const appDataBase = path.join(os.homedir(), 'AppData', 'Roaming');
const candidates = [
  path.join(appDataBase, 'metis-workbench'),
  path.join(appDataBase, 'Metis Research Workbench'),
];
const userData = candidates.find((dir) => fs.existsSync(dir)) ?? candidates[0];
const DATA_DIR = path.join(userData, 'metis-data');
say('数据目录:', DATA_DIR);

// IMPORTANT: the whole flow runs inside the ready callback. Top-level await
// on readiness would deadlock — Electron fires ready only after the module
// finishes evaluating.
async function main() {
  const qrcode = (await import('qrcode')).default;
  const { initSecureStorage, getSecureStorage } = await import('../dist-electron/engine/core/SecureStorage.js');
  initSecureStorage(safeStorage);
  const { WeChatBotService } = await import('../dist-electron/electron/WeChatBotService.js');
  const { IlinkClient } = await import('../dist-electron/engine/im/IlinkClient.js');
  say('services imported');

  const service = new WeChatBotService({
    client: new IlinkClient({}),
    store: getSecureStorage(),
    statePath: path.join(DATA_DIR, 'bot-state.json'),
    mediaDir: path.join(DATA_DIR, 'wechat-media'),
    runTurn: async () => ({ ok: false, error: 'offline-login' }),
    listProjects: () => [],
    getModelName: () => 'offline-login',
  });

  const login = await service.beginLogin();
  if (!login.ok || !login.qrContent) {
    say('二维码获取失败:', login.error ?? 'unknown');
    process.exit(1);
  }

  const qrPath = path.resolve('wx-login-qr.png');
  await qrcode.toFile(qrPath, login.qrContent, { width: 480, margin: 2 });
  say('二维码已生成:', qrPath);
  say('QR 内容:', login.qrContent);
  say('请用微信扫码，手机端确认后自动完成绑定（最长等待 5 分钟）。');

  for (let attempt = 0; attempt < 150; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    let poll;
    try {
      poll = await service.pollLogin();
    } catch (err) {
      say('轮询出错:', (err && err.message) || err);
      continue;
    }
    if (poll.phase !== 'login_pending') {
      say('状态:', poll.phase, poll.ok ? 'bound' : '', poll.error ?? '');
    }
    if (poll.phase === 'need_verifycode') {
      say('需要短信验证码，请在 Metis 设置页微信 Bot 面板完成验证。');
      process.exit(2);
    }
    if (poll.phase === 'error') {
      say('登录失败（二维码可能过期），请重新运行脚本。');
      process.exit(1);
    }
    if (poll.phase === 'bound') {
      say('绑定成功！重启 Metis 后微信 Bot 自动上线。');
      process.exit(0);
    }
  }

  say('等待超时（5 分钟），请重新运行脚本。');
  process.exit(1);
}

app.on('ready', () => { void main(); });
