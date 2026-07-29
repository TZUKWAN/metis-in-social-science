import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  artifactKind,
  git,
  inventoryDigest,
  inventoryExplicitFiles,
  inventoryFiles,
  manifestDigest,
  packageMetadata,
  projectRoot,
  provenanceRoot,
  readJson,
  releaseRoot,
  sha256File,
  utcNow,
  writeJson,
  fail,
} from './release-lib.mjs';

const stage = process.argv[2];
const sourcePath = resolve(provenanceRoot, 'source-manifest.json');
const distPath = resolve(provenanceRoot, 'dist-manifest.json');
const packagePath = resolve(provenanceRoot, 'package-manifest.json');

function currentGitState() {
  const head = git(['rev-parse', 'HEAD']);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const porcelain = git(['status', '--porcelain=v1', '--untracked-files=all']);
  return { head, branch, clean: porcelain.length === 0, statusSha256: manifestDigest(porcelain) };
}

function sourceInventory() {
  const files = inventoryExplicitFiles(git(['ls-files', '-co', '--exclude-standard', '-z']).split('\0').filter(Boolean));
  return { files, treeSha256: inventoryDigest(files) };
}

function requireCleanSource() {
  const state = currentGitState();
  if (!state.clean) fail('Release provenance is fail-closed: commit or otherwise clear all tracked and untracked source changes before producing a candidate.');
  return state;
}

function verifySource(source) {
  const metadata = packageMetadata();
  const gitState = requireCleanSource();
  const current = sourceInventory();
  if (source.product.version !== metadata.version) fail('Package version changed after source manifest generation.');
  if (source.git.head !== gitState.head) fail('Git HEAD changed after source manifest generation.');
  if (source.source.treeSha256 !== current.treeSha256) fail('Current source bytes do not match the source provenance manifest.');
  return current;
}

function distInventory() {
  const files = inventoryFiles(['dist', 'dist-electron'], {
    exclude: (rel) => rel.endsWith('.map') || rel.includes('/.cache/'),
  });
  if (files.length === 0) fail('No dist files were found.');
  return { files, treeSha256: inventoryDigest(files) };
}

function packageInventory(version) {
  const files = inventoryFiles(['release'], {
    exclude: (rel, stat) => stat.isDirectory() && rel === 'release/evidence',
  }).filter((file) => artifactKind(file.path));
  const artifacts = files.filter((file) => file.path.includes(version));
  const kinds = new Set(artifacts.map((file) => artifactKind(file.path)));
  if (artifacts.length !== 2 || !kinds.has('nsis') || !kinds.has('msi')) {
    fail(`Expected exactly one versioned NSIS EXE and one MSI for ${version}; found ${artifacts.map((item) => item.path).join(', ') || 'none'}.`);
  }
  return { files: artifacts, treeSha256: inventoryDigest(artifacts) };
}

if (stage === 'source') {
  const metadata = packageMetadata();
  const gitState = requireCleanSource();
  const source = sourceInventory();
  const manifest = {
    schemaVersion: 1,
    stage: 'current-source',
    generatedAt: utcNow(),
    product: metadata,
    git: gitState,
    source,
  };
  writeJson(sourcePath, { ...manifest, manifestSha256: manifestDigest(manifest) });
  console.log(`Source manifest written: ${sourcePath}`);
} else if (stage === 'dist') {
  if (!existsSync(sourcePath)) fail('Source manifest is required before dist provenance.');
  const source = readJson(sourcePath);
  verifySource(source);
  const dist = distInventory();
  const manifest = {
    schemaVersion: 1,
    stage: 'dist',
    generatedAt: utcNow(),
    product: source.product,
    sourceManifestSha256: sha256File(sourcePath),
    sourceTreeSha256: source.source.treeSha256,
    dist,
  };
  writeJson(distPath, { ...manifest, manifestSha256: manifestDigest(manifest) });
  console.log(`Dist manifest written: ${distPath}`);
} else if (stage === 'package') {
  if (!existsSync(sourcePath) || !existsSync(distPath)) fail('Source and dist manifests are required before package provenance.');
  const source = readJson(sourcePath);
  const dist = readJson(distPath);
  verifySource(source);
  const currentDist = distInventory();
  if (currentDist.treeSha256 !== dist.dist.treeSha256) fail('Dist bytes changed after the dist manifest was generated.');
  if (dist.sourceManifestSha256 !== sha256File(sourcePath)) fail('Dist manifest is not bound to the current source manifest file.');
  const packages = packageInventory(source.product.version);
  const manifest = {
    schemaVersion: 1,
    stage: 'package',
    generatedAt: utcNow(),
    product: source.product,
    sourceManifestSha256: sha256File(sourcePath),
    sourceTreeSha256: source.source.treeSha256,
    distManifestSha256: sha256File(distPath),
    distTreeSha256: dist.dist.treeSha256,
    packages,
  };
  writeJson(packagePath, { ...manifest, manifestSha256: manifestDigest(manifest) });
  console.log(`Package manifest written: ${packagePath}`);
} else if (stage === 'verify') {
  for (const required of [sourcePath, distPath, packagePath]) if (!existsSync(required)) fail(`Missing provenance manifest: ${required}`);
  const source = readJson(sourcePath);
  const dist = readJson(distPath);
  const packaged = readJson(packagePath);
  verifySource(source);
  if (dist.sourceManifestSha256 !== sha256File(sourcePath)) fail('Dist provenance source link is invalid.');
  if (packaged.sourceManifestSha256 !== sha256File(sourcePath)) fail('Package provenance source link is invalid.');
  if (packaged.distManifestSha256 !== sha256File(distPath)) fail('Package provenance dist link is invalid.');
  const currentDist = distInventory();
  if (currentDist.treeSha256 !== packaged.distTreeSha256) fail('Current dist bytes do not match package provenance.');
  const currentPackages = packageInventory(source.product.version);
  if (currentPackages.treeSha256 !== packaged.packages.treeSha256) fail('Current installer bytes do not match package provenance.');
  console.log('Source, dist, and package provenance links are intact.');
} else {
  fail('Usage: node scripts/release-provenance.mjs <source|dist|package|verify>');
}
