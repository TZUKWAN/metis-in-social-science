const { rmSync } = require('node:fs');
const { resolve, relative } = require('node:path');

const projectRoot = resolve(__dirname, '..');
const generatedDirectories = ['dist', 'dist-electron'];

for (const directory of generatedDirectories) {
  const target = resolve(projectRoot, directory);
  const relativeTarget = relative(projectRoot, target);
  if (relativeTarget !== directory) {
    throw new Error(`Refusing to remove unexpected path: ${target}`);
  }
  rmSync(target, { recursive: true, force: true });
}
