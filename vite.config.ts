import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import fs from 'fs'

const nodeEmptyShim = path.resolve(__dirname, './src/shims/node-empty.ts').replace(/\\/g, '/')
// 远程开发桥（dev-only，刘总 2026-09-15 工作流）：把 'electron' 模块替换为
// 浏览器垫片，electron/preload.ts 的完整 API 逻辑在 dev renderer 中原样运行，
// invoke/事件经本机回环 HTTP+SSE 到达 Electron 主进程。生产构建不含该链路
// （main.tsx 仅在 import.meta.env.DEV 下加载 preload）。
const remoteElectronShim = path.resolve(__dirname, './src/remoteBridge/electronShim.ts').replace(/\\/g, '/')

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      // 把主进程 RemoteDevBridge 写入的 .metis-remote-port 提供给同源页面垫片。
      name: 'metis-remote-bridge-port',
      configureServer(server) {
        server.middlewares.use('/metis-remote-bridge-port', (_req, res) => {
          try {
            const file = path.resolve(__dirname, '.metis-remote-port');
            const port = Number(fs.readFileSync(file, 'utf8').trim());
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ port: Number.isFinite(port) ? port : null }));
          } catch {
            res.statusCode = 503;
            res.end(JSON.stringify({ port: null }));
          }
        });
      },
    },
  ],
  base: './', // Electron loads from file://, use relative paths
  resolve: {
    alias: [
      { find: '@', replacement: path.resolve(__dirname, './src') },
      { find: '@engine', replacement: path.resolve(__dirname, './engine') },
      // Renderer bundles never run Node code — tool handlers execute in the
      // main process. Redirect Node builtins to empty shims so statically
      // imported engine modules evaluate safely in the browser context.
      { find: /^node:crypto$/, replacement: path.resolve(__dirname, './src/shims/node-crypto-shim.ts').replace(/\\/g, '/') },
      { find: /^node:.*$/, replacement: nodeEmptyShim },
      { find: /^bindings$/, replacement: nodeEmptyShim },
      { find: /^better-sqlite3$/, replacement: nodeEmptyShim },
      { find: /^electron$/, replacement: remoteElectronShim },
    ],
  },
  define: {
    // Node globals referenced at module top level by bundled engine code.
    'process.cwd': '(() => "/")',
    'process.platform': '"browser"',
    'process.arch': '"x64"',
    'process.versions': '({})',
  },
  build: {
    target: 'es2023',
    outDir: 'dist',
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/') || id.includes('node_modules/react-router-dom/')) {
            return 'vendor-react';
          }
          if (id.includes('node_modules/react-markdown/') || id.includes('node_modules/remark-gfm/')) {
            return 'vendor-markdown';
          }
          if (id.includes('node_modules/recharts/')) {
            return 'vendor-charts';
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
})
