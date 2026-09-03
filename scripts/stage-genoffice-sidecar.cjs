const { cpSync, existsSync, mkdirSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const genofficeRoot = process.env.METIS_GENOFFICE_ROOT
  ? path.resolve(process.env.METIS_GENOFFICE_ROOT)
  : path.resolve(root, '..', 'tools', 'genoffice');
const executable = process.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar';
const candidates = [
  path.join(root, 'native', 'xlsx-engine', 'target', 'release', executable),
  path.join(genofficeRoot, 'apps', 'sheets', 'native', 'xlsx-engine', 'target', 'release', executable),
];
let source = candidates.find((candidate) => existsSync(candidate));
if (!source) {
  const sheetsRoot = path.join(genofficeRoot, 'apps', 'sheets');
  const build = spawnSync('cargo', [
    'build',
    '--release',
    '--manifest-path',
    path.join(sheetsRoot, 'native', 'xlsx-engine', 'Cargo.toml'),
    '--config',
    path.join(sheetsRoot, 'native', 'xlsx-engine', '.cargo', 'config.toml'),
  ], { cwd: sheetsRoot, stdio: 'inherit', windowsHide: true });
  if (build.error || build.status !== 0) {
    throw new Error(`Unable to build GenOffice Sheets sidecar: ${build.error?.message ?? `cargo exited with ${build.status}`}`);
  }
  source = candidates.find((candidate) => existsSync(candidate));
}
if (!source) {
  throw new Error(`GenOffice Sheets sidecar is missing after build: ${candidates[1]}`);
}
const destination = path.join(root, 'dist-electron', 'electron', 'native', 'xlsx-engine', 'target', 'release', executable);
mkdirSync(path.dirname(destination), { recursive: true });
cpSync(source, destination);
process.stdout.write(`[stage-genoffice-sidecar] ${source} -> ${destination}\n`);
