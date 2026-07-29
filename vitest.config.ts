import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  root: __dirname,
  test: {
    globals: true,
    environment: 'node',
    include: ['engine/**/*.test.ts', 'tests/**/*.test.{ts,tsx}'],
    // Node 25 exposes an experimental Web Storage global unless it is explicitly
    // disabled. Its incomplete localStorage shadows jsdom's implementation in
    // forked workers and does not provide clear/removeItem, so browser tests must
    // start without the Node-level storage global and let jsdom install its own.
    execArgv: ['--no-webstorage'],
    // METIS-004/1001: forks pool + isolate + fileParallelism=false ensures each test FILE
    // runs in its own process with a fresh global/document, eliminating cross-file jsdom
    // state pollution (the root cause of intermittent "multiple elements found" failures
    // under full-suite concurrency). Stability is required: "three consecutive identical
    // results" — prioritized over raw speed.
    pool: 'forks',
    isolate: true,
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['engine/**/*.ts'],
      exclude: ['engine/**/*.test.ts', 'engine/**/types.ts'],
    },
  },
  resolve: {
    alias: {
      '@engine': path.resolve(__dirname, './engine'),
    },
  },
})
