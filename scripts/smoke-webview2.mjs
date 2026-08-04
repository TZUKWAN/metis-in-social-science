import path from 'node:path';
import fs from 'node:fs';
import { app, BrowserWindow, WebviewTag } from 'electron';
app.setName('metis-smoke');
await import('../dist-electron/electron/main.js');

app.on('ready', () => {
  void (async () => {
    let win = BrowserWindow.getAllWindows()[0];
    for (let i = 0; i < 50 && !win; i += 1) {
      await new Promise((r) => setTimeout(r, 300));
      win = BrowserWindow.getAllWindows()[0];
    }
    if (win.webContents.isLoading()) {
      await new Promise((r) => win.webContents.once('did-finish-load', r));
    }
    fs.writeFileSync('wv-probe.log', '');

    // Create doc + add content + start watch
    const setup = await win.webContents.executeJavaScript(`(async () => {
      const m = window.metis;
      const created = await m.officeCliNewDocument('docx', 'probe');
      await m.officeCliAdd({ filePath: created.filePath, parent: '/', type: 'paragraph', props: { text: 'webview content test' } });
      const watch = await m.officeCliStartWatch(created.filePath);
      return { filePath: created.filePath, url: watch.url };
    })()`);
    fs.appendFileSync('wv-probe.log', `setup: ${JSON.stringify(setup)}\n`);

    if (setup?.url) {
      // Inject a webview into the page and check if it loads.
      const probe = await win.webContents.executeJavaScript(`new Promise((resolve) => {
        const wv = document.createElement('webview');
        wv.src = '${setup.url}';
        wv.style.cssText = 'position:fixed;top:0;left:0;width:100px;height:100px;border:2px solid red;z-index:9999;';
        wv.addEventListener('did-finish-load', () => {
          resolve({ loaded: true, url: wv.getURL?.() ?? 'unknown' });
        });
        wv.addEventListener('did-fail-load', (e) => {
          resolve({ loaded: false, error: e.errorCode + ' ' + e.errorDescription });
        });
        setTimeout(() => resolve({ loaded: false, timeout: true }), 8000);
        document.body.appendChild(wv);
      })`);
      fs.appendFileSync('wv-probe.log', `webview: ${JSON.stringify(probe)}\n`);
      // cleanup
      await win.webContents.executeJavaScript(`window.metis.officeCliClose('${setup.filePath}')`);
    }
    app.exit(0);
  })().catch((err) => { fs.appendFileSync('wv-probe.log', `ERROR: ${err}\n`); app.exit(1); });
});
