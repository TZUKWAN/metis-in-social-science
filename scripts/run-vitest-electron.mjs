/**
 * Run Vitest under Electron's Node runtime so native modules compiled for
 * Electron can be exercised without rebuilding them for the host Node ABI.
 *
 * Electron injects flags such as --no-webstorage into process.execArgv. Node
 * worker_threads rejects those flags, so remove Electron-only switches before
 * Vitest creates its worker pool.
 */
process.execArgv = process.execArgv.filter((arg) => arg !== '--no-webstorage');

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
  pool: 'threads',
  execArgv: [],
  reporters: [reporter],
  ...(outputFile ? { outputFile } : {}),
});

if (!context) {
  process.exitCode = 1;
} else if (!context.shouldKeepServer()) {
  await context.exit();
}
