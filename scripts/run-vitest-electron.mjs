/**
 * Run Vitest under Electron's Node runtime so native modules compiled for
 * Electron can be exercised without rebuilding them for the host Node ABI.
 *
 * Electron injects flags such as --no-webstorage into process.execArgv. Node
 * worker and child-process runtimes reject those flags, so remove
 * Electron-only switches before Vitest creates its worker pool. Electron 41
 * also propagates its private --no-webstorage switch when process.fork
 * launches electron.exe, so worker threads are the reliable default: they
 * remain inside Electron's Node runtime and exercise its native-module ABI.
 */
process.execArgv = process.execArgv.filter((arg) => arg !== '--no-webstorage');
const sanitizedNodeOptions = (process.env.NODE_OPTIONS ?? '')
  .replace(/(?:^|\s)--no-webstorage(?=\s|$)/gu, ' ')
  .trim();
if (sanitizedNodeOptions) process.env.NODE_OPTIONS = sanitizedNodeOptions;
else delete process.env.NODE_OPTIONS;

const filters = process.argv.slice(2);
if (filters.length === 0) {
  console.error('Usage: electron scripts/run-vitest-electron.mjs <test-file> [...]');
  process.exit(2);
}

const { startVitest } = await import('vitest/node');
const reporter = process.env.METIS_VITEST_REPORTER ?? 'dot';
const outputFile = process.env.METIS_VITEST_OUTPUT_FILE;
const context = await startVitest('test', filters, {
  run: true,
  watch: false,
  pool: process.env.METIS_VITEST_POOL ?? 'threads',
  execArgv: [],
  // Vitest snapshots the parent environment per worker. Electron can
  // re-inject --no-webstorage after module startup, so override the worker
  // environment explicitly instead of relying only on deleting the parent
  // variable above.
  env: {
    NODE_OPTIONS: '',
    ELECTRON_RUN_AS_NODE: '1',
  },
  reporters: [reporter],
  ...(outputFile ? { outputFile } : {}),
});

if (!context) {
  process.exitCode = 1;
} else {
  const files = context.state.getFiles();
  const failed = files.some((file) => file.result?.state === 'fail');
  const unhandled = context.state.getUnhandledErrors().length > 0;
  if (files.length === 0 || failed || unhandled) process.exitCode = 1;
  await context.close();
}
