import { existsSync, lstatSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  artifactKind,
  evidenceRoot,
  fail,
  packageMetadata,
  projectRoot,
  provenanceRoot,
  readJson,
  releaseRoot,
  run,
  sha256File,
  utcNow,
  writeJson,
} from './release-lib.mjs';

const policyPath = resolve(projectRoot, 'build', 'release-policy.json');
const packageManifestPath = resolve(provenanceRoot, 'package-manifest.json');
const scanPath = resolve(evidenceRoot, 'package-scan.json');
const licenseInventoryPath = resolve(evidenceRoot, 'compliance', 'license-inventory.json');
const sbomPath = resolve(evidenceRoot, 'compliance', 'sbom.cdx.json');
const verificationPath = resolve(evidenceRoot, 'release-verification.json');

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

export function evaluateAuthenticode(records, windowsPolicy) {
  const issues = [];
  for (const record of records) {
    if (windowsPolicy.requireAuthenticode && record.status !== 'Valid') {
      issues.push({ code: 'authenticode_invalid', artifact: record.path, status: record.status });
    }
    if (windowsPolicy.requireTimestamp && !record.timestampSubject) {
      issues.push({ code: 'timestamp_missing', artifact: record.path });
    }
  }
  return issues;
}

export function validateArtifactSet(artifacts, windowsPolicy, metadata, inspectFile) {
  const issues = [];
  const requiredKinds = new Set(windowsPolicy.requiredArtifacts || []);
  const seenKinds = new Set();
  for (const artifact of artifacts) {
    const kind = artifactKind(artifact.path);
    if (kind) seenKinds.add(kind);
    if (!artifact.path.includes(metadata.version)) {
      issues.push({ code: 'artifact_version_mismatch', artifact: artifact.path });
    }
    if (!artifact.path.toLowerCase().includes('-x64.')) {
      issues.push({ code: 'artifact_architecture_mismatch', artifact: artifact.path });
    }
    if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0 || !isSha256(artifact.sha256)) {
      issues.push({ code: 'artifact_manifest_invalid', artifact: artifact.path });
      continue;
    }
    const actual = inspectFile(artifact.path);
    if (!actual.exists || !actual.isFile) {
      issues.push({ code: 'artifact_missing', artifact: artifact.path });
    } else if (actual.size !== artifact.size || actual.sha256 !== artifact.sha256) {
      issues.push({ code: 'artifact_checksum_mismatch', artifact: artifact.path });
    }
  }
  for (const kind of requiredKinds) {
    if (!seenKinds.has(kind)) issues.push({ code: 'required_artifact_missing', kind });
  }
  if (artifacts.length !== requiredKinds.size) {
    issues.push({ code: 'unexpected_artifact_count', expected: requiredKinds.size, actual: artifacts.length });
  }
  return issues;
}

export function readAuthenticode(artifacts) {
  const quotedPaths = artifacts.map((artifact) => {
    const absolute = resolve(projectRoot, artifact.path);
    return `'${absolute.replaceAll("'", "''")}'`;
  }).join(',');
  const script = [
    `$paths=@(${quotedPaths})`,
    '$rows=@(foreach($path in $paths){',
    '  $signature=Get-AuthenticodeSignature -LiteralPath $path',
    '  $signerSubject=if($signature.SignerCertificate){[string]$signature.SignerCertificate.Subject}else{$null}',
    '  $signerThumbprint=if($signature.SignerCertificate){[string]$signature.SignerCertificate.Thumbprint}else{$null}',
    '  $timestampSubject=if($signature.TimeStamperCertificate){[string]$signature.TimeStamperCertificate.Subject}else{$null}',
    '  [pscustomobject]@{',
    '    path=$path',
    '    status=[string]$signature.Status',
    '    statusMessage=[string]$signature.StatusMessage',
    '    signerSubject=$signerSubject',
    '    signerThumbprint=$signerThumbprint',
    '    timestampSubject=$timestampSubject',
    '  }',
    '})',
    '$rows | ConvertTo-Json -Compress -Depth 4',
  ].join('\n');
  const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
  const parsed = JSON.parse(result.stdout || '[]');
  return (Array.isArray(parsed) ? parsed : [parsed]).map((record, index) => ({
    ...record,
    path: artifacts[index]?.path || record.path,
  }));
}

function validatePolicy(policy, metadata) {
  if (policy?.schemaVersion !== 1 || policy?.product !== metadata.productName) fail('Release policy product/schema does not match package metadata.');
  if (policy?.appId !== metadata.appId) fail('Release policy appId does not match package metadata.');
  if (!Array.isArray(policy?.windows?.requiredArtifacts) || policy.windows.requiredArtifacts.length === 0) fail('Release policy has no required Windows artifacts.');
  if (policy.release?.allowDirtySource !== false) fail('Release policy must reject dirty source.');
}

export function main() {
  for (const required of [policyPath, packageManifestPath, scanPath, licenseInventoryPath, sbomPath]) {
    if (!existsSync(required)) fail(`Missing release verification input: ${required}`);
  }
  const metadata = packageMetadata();
  const policy = readJson(policyPath);
  validatePolicy(policy, metadata);

  run(process.execPath, [resolve(projectRoot, 'scripts', 'release-provenance.mjs'), 'verify']);
  const packaged = readJson(packageManifestPath);
  const scan = readJson(scanPath);
  const licenses = readJson(licenseInventoryPath);
  const sbom = readJson(sbomPath);
  const issues = [];

  if (!Array.isArray(scan.findings) || scan.findings.length > 0) issues.push({ code: 'package_scan_failed', findingCount: scan.findings?.length ?? null });
  if (!Array.isArray(licenses.packages) || licenses.packages.length === 0) issues.push({ code: 'license_inventory_empty' });
  if (policy.release?.allowMissingLicenses === false) {
    for (const item of licenses.packages || []) {
      if (typeof item.license !== 'string' || item.license.trim() === '' || /^(unknown|unlicensed|none)$/i.test(item.license.trim())) {
        issues.push({ code: 'license_missing', package: `${item.name}@${item.version}` });
      }
    }
  }
  if (sbom.bomFormat !== 'CycloneDX' || !Array.isArray(sbom.components) || sbom.components.length === 0) issues.push({ code: 'sbom_invalid' });

  const artifacts = packaged?.packages?.files || [];
  issues.push(...validateArtifactSet(artifacts, policy.windows, metadata, (relativePath) => {
    const absolute = resolve(projectRoot, relativePath);
    if (!existsSync(absolute)) return { exists: false, isFile: false, size: 0, sha256: null };
    const stat = lstatSync(absolute);
    return { exists: true, isFile: stat.isFile() && !stat.isSymbolicLink(), size: stat.size, sha256: stat.isFile() ? sha256File(absolute) : null };
  }));

  const signatures = readAuthenticode(artifacts);
  issues.push(...evaluateAuthenticode(signatures, policy.windows));
  const report = {
    schemaVersion: 1,
    generatedAt: utcNow(),
    product: metadata,
    policy: {
      requireAuthenticode: policy.windows.requireAuthenticode,
      requireTimestamp: policy.windows.requireTimestamp,
      requireSha256Checksums: policy.windows.requireSha256Checksums,
    },
    artifacts: artifacts.map((artifact) => ({
      kind: artifactKind(artifact.path),
      fileName: basename(artifact.path),
      size: artifact.size,
      sha256: artifact.sha256,
    })),
    signatures,
    packageScan: { scannedFiles: scan.scannedFiles, findings: scan.findings.length },
    compliance: { packages: licenses.packages.length, sbomComponents: sbom.components.length },
    issues,
    passed: issues.length === 0,
  };
  writeJson(verificationPath, report);
  if (issues.length > 0) fail(`Release verification rejected ${issues.length} issue(s). See ${verificationPath}.`);
  console.log(`Release policy verification passed for ${artifacts.length} Windows installers.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
