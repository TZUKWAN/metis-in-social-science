// Node >=25 exposes an experimental Web Storage global whose localStorage
// shadows jsdom's (missing clear/removeItem). Setting NODE_OPTIONS here makes
// every forked worker start with it disabled — the CLI flag alone does not
// propagate into worker execArgv.
process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, '--no-webstorage'].filter(Boolean).join(' ');

import { defineConfig } from 'vitest/config'
import path from 'path'

/**
 * Vitest projects (vitest 4 integrates workspaces via test.projects):
 *  - node: engine/electron/e2e/security/integration tests — isolated forks,
 *    parallel file execution (no DOM, no cross-file pollution).
 *  - jsdom: frontend tests — serial forks + explicit setup cleanup, keeping
 *    the METIS-004/1001 stability guarantees that fixed the "multiple
 *    elements found" flakiness.
 */
export default defineConfig({
  root: __dirname,
  test: {
    globals: true,
    projects: [
      {
        root: __dirname,
        test: {
          name: 'node',
          globals: true,
          environment: 'node',
          include: [
            'engine/**/*.test.ts',
            'tests/{engine,electron,e2e,security,integration,scripts,utils,evals}/**/*.test.{ts,tsx}',
            'electron/ScenarioLoopRunTracker.test.ts',
            'electron/RuntimeShutdownCoordinator.test.ts',
          ],
          pool: 'forks',
          isolate: true,
          fileParallelism: true,
          maxWorkers: 4,
          minWorkers: 1,
          // Native-process integration suites can create several real child
          // runtimes while the rest of the fork pool is active. Keep the
          // default timeout honest without mistaking host scheduling pressure
          // for a product timeout.
          testTimeout: 30_000,
          hookTimeout: 30_000,
          coverage: {
            provider: 'v8',
            include: ['engine/**/*.ts', 'src/**/*.{ts,tsx}', 'electron/**/*.ts'],
            exclude: [
              'engine/**/*.test.ts',
              'engine/**/types.ts',
              'src/**/*.test.{ts,tsx}',
              'src/main.tsx',
              'electron/preload.ts',
            ],
          },
        },
        resolve: {
          alias: {
            '@engine': path.resolve(__dirname, './engine'),
          },
        },
      },
      {
        root: __dirname,
        test: {
          name: 'jsdom',
          globals: true,
          environment: 'jsdom',
          include: ['tests/{frontend,lib}/**/*.test.{ts,tsx}'],
          setupFiles: [path.resolve(__dirname, 'tests/frontend/setup.ts')],
          // METIS-004/1001: jsdom files stay serial — each file runs in its
          // own process with a fresh global/document, eliminating cross-file
          // jsdom state pollution. Stability is required over raw speed here.
          pool: 'forks',
          isolate: true,
          fileParallelism: false,
          coverage: {
            provider: 'v8',
            include: ['engine/**/*.ts', 'src/**/*.{ts,tsx}', 'electron/**/*.ts'],
            exclude: [
              'engine/**/*.test.ts',
              'engine/**/types.ts',
              'src/**/*.test.{ts,tsx}',
              'src/main.tsx',
              'electron/preload.ts',
            ],
          },
        },
        resolve: {
          alias: {
            '@engine': path.resolve(__dirname, './engine'),
          },
        },
      },
    ],
  },
  resolve: {
    alias: {
      '@engine': path.resolve(__dirname, './engine'),
    },
  },
})
