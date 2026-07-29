import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { extname, relative, resolve, sep } from 'node:path';
import asar from '@electron/asar';
import { evidenceRoot, fail, projectRoot, releaseRoot, utcNow, writeJson } from './release-lib.mjs';

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const forbiddenPaths = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)(test|tests|__tests__|fixtures|examples?|coverage|\.github)(\/|$)/i,
  /\.(?:pfx|p12|pem|key|cer|crt|map|tsbuildinfo)$/i,
  /(^|\/)(?:docs\/.*(?:audit|handoff)|\.codex|artifacts\/acceptance)(\/|$)/i,
  /(^|\/)package-lock\.json$/i,
  /\.(?:ts|tsx)$/i,
];
const secretPatterns = [
  { id: 'openai-style-key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { id: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { id: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
];
const textExtensions = new Set(['.js', '.cjs', '.mjs', '.json', '.html', '.css', '.md', '.txt', '.xml', '.yml', '.yaml', '.ini', '.cfg']);

const unpackedRoots = readdirSync(releaseRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.endsWith('-unpacked'))
  .map((entry) => resolve(releaseRoot, entry.name));
if (unpackedRoots.length !== 1) fail(`Expected exactly one unpacked Windows application directory; found ${unpackedRoots.length}.`);

const findings = [];
let scannedFiles = 0;
function inspect(relativePath, bufferProvider, size) {
  const normalized = relativePath.split(sep).join('/').replace(/^\/+/, '');
  scannedFiles += 1;
  for (const pattern of forbiddenPaths) {
    if (pattern.test(normalized)) findings.push({ severity: 'block', kind: 'development-or-secret-path', path: normalized, rule: String(pattern) });
  }
  if (size > MAX_TEXT_BYTES || !textExtensions.has(extname(normalized).toLowerCase())) return;
  const text = bufferProvider().toString('utf8');
  for (const { id, pattern } of secretPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) findings.push({ severity: 'block', kind: 'secret-content', path: normalized, rule: id });
  }
}

function walk(root, current = root) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = resolve(current, entry.name);
    const rel = relative(root, absolute);
    if (entry.isSymbolicLink()) {
      findings.push({ severity: 'block', kind: 'symbolic-link', path: rel });
    } else if (entry.isDirectory()) {
      walk(root, absolute);
    } else if (entry.isFile()) {
      const stat = lstatSync(absolute);
      inspect(rel, () => readFileSync(absolute), stat.size);
    }
  }
}

const unpacked = unpackedRoots[0];
walk(unpacked);
const archive = resolve(unpacked, 'resources', 'app.asar');
if (!existsSync(archive)) fail(`Packaged app archive is missing: ${archive}`);
for (const entry of asar.listPackage(archive, { isPack: false })) {
  const normalized = entry.replace(/^\\/, '').replaceAll('\\', '/');
  let stat;
  try { stat = asar.statFile(archive, normalized, false); } catch { continue; }
  if ('files' in stat) continue;
  inspect(`app.asar/${normalized}`, () => asar.extractFile(archive, normalized, false), Number(stat.size || 0));
}

const report = { schemaVersion: 1, generatedAt: utcNow(), unpackedRoot: relative(projectRoot, unpacked), scannedFiles, findings };
writeJson(resolve(evidenceRoot, 'package-scan.json'), report);
if (findings.length > 0) fail(`Release package scan rejected ${findings.length} finding(s). See release/evidence/package-scan.json.`);
console.log(`Release package scan passed for ${scannedFiles} entries.`);
