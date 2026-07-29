import { describe, expect, it } from 'vitest';
import { evaluateAuthenticode, validateArtifactSet } from '../../scripts/verify-release-policy.mjs';

const metadata = { version: '1.2.3', productName: 'Metis Research Workbench', appId: 'com.metis.workbench' };
const windowsPolicy = { requiredArtifacts: ['nsis', 'msi'], requireAuthenticode: true, requireTimestamp: true };
const hash = 'a'.repeat(64);
const artifacts = [
  { path: 'release/Metis-Setup-1.2.3-x64.exe', size: 10, sha256: hash },
  { path: 'release/Metis-1.2.3-x64.msi', size: 20, sha256: hash },
];

describe('release policy verification', () => {
  it('accepts an exact versioned x64 NSIS/MSI set with matching checksums', () => {
    const issues = validateArtifactSet(artifacts, windowsPolicy, metadata, (path: string) => ({
      exists: true,
      isFile: true,
      size: path.endsWith('.msi') ? 20 : 10,
      sha256: hash,
    }));
    expect(issues).toEqual([]);
  });

  it('rejects missing artifacts and checksum mismatches', () => {
    const issues = validateArtifactSet(artifacts.slice(0, 1), windowsPolicy, metadata, () => ({
      exists: true,
      isFile: true,
      size: 10,
      sha256: 'b'.repeat(64),
    }));
    expect(issues.map((issue: { code: string }) => issue.code)).toEqual(expect.arrayContaining([
      'artifact_checksum_mismatch',
      'required_artifact_missing',
      'unexpected_artifact_count',
    ]));
  });

  it('requires both a valid Authenticode signature and timestamp certificate', () => {
    const issues = evaluateAuthenticode([
      { path: artifacts[0].path, status: 'NotSigned', timestampSubject: null },
    ], windowsPolicy);
    expect(issues.map((issue: { code: string }) => issue.code)).toEqual(['authenticode_invalid', 'timestamp_missing']);
    expect(evaluateAuthenticode([
      { path: artifacts[0].path, status: 'Valid', timestampSubject: 'CN=Timestamp Authority' },
    ], windowsPolicy)).toEqual([]);
  });
});
