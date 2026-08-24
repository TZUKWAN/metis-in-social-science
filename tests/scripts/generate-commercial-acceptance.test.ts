import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- executable ESM script intentionally exports testable report helpers.
import { buildReport } from '../../scripts/generate-commercial-acceptance.mjs';

const temporaryRoots: string[] = [];

function copyEvidence(root: string, relativePath: string, sourcePath: string): void {
  const destination = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(sourcePath, destination);
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('commercial acceptance report generator', () => {
  it('maps real workspace evidence to explicit domain statuses and boundaries', () => {
    const report = buildReport(path.resolve(process.cwd()));

    expect(report.report).toBe('alpha2-commercial-acceptance');
    expect(report.overallStatus).toBe('blocked');
    expect(report.domains.P0.status).toBe('passed');
    expect(report.domains.Agent.status).toBe('blocked');
    expect(report.domains.Goal.status).toBe('passed');
    expect(report.domains.Scenario.status).toBe('passed');
    expect(report.domains.Outcomes.status).toBe('pending');
    expect(report.domains.Word.status).toBe('pending');
    expect(report.domains.PPT.status).toBe('pending');
    expect(report.domains.Desktop.status).toBe('passed');
    expect(report.domains.Word.subgates.nativeOfficeVisual.status).toBe('cancelled_gate');
    expect(report.domains.PPT.subgates.nativeOfficeVisual.status).toBe('cancelled_gate');
    expect(report.domains.Goal.providerBoundary).toContain('not external');
    expect(report.domains.Agent.evidencePath.length).toBeGreaterThan(0);
    expect(report.domains.P0.checks.failedTests).toBe(0);
  });

  it('does not infer passes when evidence is absent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'commercial-acceptance-empty-'));
    temporaryRoots.push(root);
    const report = buildReport(root, new Date('2026-08-21T00:00:00.000Z'));

    for (const domain of Object.values(report.domains)) {
      expect(['pending', 'blocked']).toContain(domain.status);
      expect(domain.evidencePath).toEqual([]);
    }
    expect(report.domains.Word.subgates.nativeOfficeVisual.status).toBe('pending');
    expect(report.domains.PPT.subgates.nativeOfficeVisual.status).toBe('pending');
  });

  it('requires zero-failure ABI summary and preserves evidence metadata', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'commercial-acceptance-abi-'));
    temporaryRoots.push(root);
    copyEvidence(root, 'test-results/personalization-final-merged-vitest-node-abi.json', path.resolve('test-results/personalization-final-merged-vitest-node-abi.json'));
    const report = buildReport(root);
    expect(report.domains.P0.status).toBe('passed');
    expect(report.domains.P0.evidence[0].sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.domains.P0.evidence[0].bytes).toBeGreaterThan(0);

    const broken = JSON.parse(fs.readFileSync(path.join(root, 'test-results/personalization-final-merged-vitest-node-abi.json'), 'utf8')) as Record<string, unknown>;
    broken.numFailedTests = 1;
    fs.writeFileSync(path.join(root, 'test-results/personalization-final-merged-vitest-node-abi.json'), JSON.stringify(broken));
    expect(buildReport(root).domains.P0.status).toBe('pending');
  });
});
