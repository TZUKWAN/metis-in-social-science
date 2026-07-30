import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..', '..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('open-source release metadata', () => {
  it('ships the declared Apache-2.0 license in source and packaged application inputs', () => {
    const pkg = JSON.parse(read('package.json')) as {
      private?: boolean;
      license?: string;
      build?: { files?: string[] };
    };
    const license = read('LICENSE');
    expect(pkg.private).toBe(true);
    expect(pkg.license).toBe('Apache-2.0');
    expect(pkg.build?.files).toContain('LICENSE');
    expect(license).toContain('Apache License\n                           Version 2.0, January 2004');
    expect(license).toContain('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION');
    expect(license).toContain('END OF TERMS AND CONDITIONS');
  });

  it('keeps every local README link resolvable and contains no emoji', () => {
    const readme = read('README.md');
    const localTargets = [...readme.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu)]
      .map((match) => match[1]?.trim() ?? '')
      .filter((target) => target !== '' && !/^(?:https?:|mailto:|#)/iu.test(target))
      .map((target) => decodeURIComponent(target.split('#')[0] ?? ''));
    expect(localTargets.length).toBeGreaterThan(0);
    expect(localTargets.filter((target) => !fs.existsSync(path.resolve(root, target)))).toEqual([]);
    expect(readme).not.toMatch(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}]/u);
  });

  it('runs integration, security, and documentation matrices in the public CI workflow', () => {
    const workflow = read('.github/workflows/ci.yml');
    expect(workflow).toContain('tests/integration');
    expect(workflow).toContain('tests/security');
    expect(workflow).toContain('tests/docs');
    expect(workflow).toContain('npm audit --omit=dev');
    expect(workflow).toContain('npm run typecheck');
    expect(workflow).toContain('npm run lint');
  });
});
