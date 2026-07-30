import { describe, expect, it } from 'vitest';
import {
  SCENARIO_OUTPUT_BUNDLE_LIMITS,
  decodeScenarioOutputBundle,
  type ScenarioOutputBundle,
} from '../../engine/runtime/ScenarioOutputBundleContract.js';

const outputPlan = {
  primaryDeliverable: 'Complete article',
  supportingArtifacts: ['Evidence table', 'Source ledger'],
  qualityCriteria: ['Every claim is traceable', 'Methods are reproducible'],
};

function validBundle(): ScenarioOutputBundle {
  return {
    primary: {
      name: 'Complete article',
      content: '# Complete article\n\nEvidence-grounded manuscript.',
    },
    supporting: [
      { name: 'Evidence table', content: '| Claim | Evidence |\n| --- | --- |' },
      { name: 'Source ledger', content: '1. Source A, locator 12.' },
    ],
    quality: [
      { criterion: 'Every claim is traceable', status: 'met', evidence: 'All pivotal claims map to the evidence table.' },
      { criterion: 'Methods are reproducible', status: 'partially_met', evidence: 'Code and parameters are present; environment lockfile is pending.' },
    ],
  };
}

function decode(value: unknown, plan: unknown = outputPlan) {
  return decodeScenarioOutputBundle(
    typeof value === 'string' ? value : JSON.stringify(value),
    plan,
  );
}

describe('ScenarioOutputBundleContract', () => {
  it('decodes a strict raw JSON bundle', () => {
    expect(decode(validBundle())).toEqual({ ok: true, bundle: validBundle() });
  });

  it('decodes exactly one lowercase json fenced block with surrounding whitespace and CRLF', () => {
    const fenced = ` \r\n\`\`\`json\r\n${JSON.stringify(validBundle(), null, 2)}\r\n\`\`\`\r\n `;
    expect(decodeScenarioOutputBundle(fenced, outputPlan)).toEqual({ ok: true, bundle: validBundle() });
  });

  it.each([
    ['prose before raw JSON', `Here is the result:\n${JSON.stringify(validBundle())}`],
    ['prose after raw JSON', `${JSON.stringify(validBundle())}\nDone.`],
    ['untyped fence', `\`\`\`\n${JSON.stringify(validBundle())}\n\`\`\``],
    ['uppercase fence', `\`\`\`JSON\n${JSON.stringify(validBundle())}\n\`\`\``],
    ['two fenced blocks', `\`\`\`json\n${JSON.stringify(validBundle())}\n\`\`\`\n\`\`\`json\n{}\n\`\`\``],
    ['trailing fenced prose', `\`\`\`json\n${JSON.stringify(validBundle())}\n\`\`\`\nDone.`],
  ])('rejects %s', (_label, text) => {
    expect(decodeScenarioOutputBundle(text, outputPlan)).toMatchObject({ ok: false, code: 'invalid_json' });
  });

  it.each([
    '',
    '{',
    'null',
    '[]',
    '"string"',
  ])('returns a decode failure instead of throwing for malformed or non-object JSON: %j', (text) => {
    expect(() => decodeScenarioOutputBundle(text, outputPlan)).not.toThrow();
    expect(decodeScenarioOutputBundle(text, outputPlan).ok).toBe(false);
  });

  it.each([
    ['root', { ...validBundle(), unexpected: true }],
    ['primary', { ...validBundle(), primary: { ...validBundle().primary, unexpected: true } }],
    ['supporting item', { ...validBundle(), supporting: [{ ...validBundle().supporting[0]!, unexpected: true }, validBundle().supporting[1]!] }],
    ['quality item', { ...validBundle(), quality: [{ ...validBundle().quality[0]!, unexpected: true }, validBundle().quality[1]!] }],
  ])('rejects extra keys at %s', (_label, bundle) => {
    expect(decode(bundle)).toMatchObject({ ok: false, code: 'invalid_shape' });
  });

  it.each([
    ['primary', { supporting: validBundle().supporting, quality: validBundle().quality }],
    ['supporting', { primary: validBundle().primary, quality: validBundle().quality }],
    ['quality', { primary: validBundle().primary, supporting: validBundle().supporting }],
    ['primary content', { ...validBundle(), primary: { name: validBundle().primary.name } }],
    ['supporting content', { ...validBundle(), supporting: [{ name: 'Evidence table' }, validBundle().supporting[1]!] }],
    ['quality evidence', { ...validBundle(), quality: [{ criterion: 'Every claim is traceable', status: 'met' }, validBundle().quality[1]!] }],
  ])('rejects missing %s', (_label, bundle) => {
    expect(decode(bundle)).toMatchObject({ ok: false, code: 'invalid_shape' });
  });

  it('rejects duplicate JSON object keys before JSON.parse can overwrite them', () => {
    const primary = JSON.stringify(validBundle().primary);
    const text = `{"primary":${primary},"primary":${primary},"supporting":${JSON.stringify(validBundle().supporting)},"quality":${JSON.stringify(validBundle().quality)}}`;
    expect(decodeScenarioOutputBundle(text, outputPlan)).toEqual({ ok: false, code: 'invalid_json' });
  });

  it('rejects duplicate nested JSON object keys', () => {
    const text = `{"primary":{"name":"Complete article","content":"one","content":"two"},"supporting":${JSON.stringify(validBundle().supporting)},"quality":${JSON.stringify(validBundle().quality)}}`;
    expect(decodeScenarioOutputBundle(text, outputPlan)).toEqual({ ok: false, code: 'invalid_json' });
  });

  it('requires primary.name to equal primaryDeliverable exactly', () => {
    expect(decode({ ...validBundle(), primary: { ...validBundle().primary, name: ' complete article' } }))
      .toMatchObject({ ok: false, code: 'plan_mismatch' });
  });

  it.each([
    ['missing supporting item', validBundle().supporting.slice(0, 1)],
    ['extra supporting item', [...validBundle().supporting, { name: 'Appendix', content: 'x' }]],
    ['reordered supporting items', [...validBundle().supporting].reverse()],
    ['renamed supporting item', [{ name: 'Evidence matrix', content: 'x' }, validBundle().supporting[1]!]],
    ['duplicate supporting name', [validBundle().supporting[0]!, { ...validBundle().supporting[1]!, name: 'Evidence table' }]],
  ])('rejects %s', (_label, supporting) => {
    expect(decode({ ...validBundle(), supporting })).toMatchObject({ ok: false });
  });

  it.each([
    ['missing quality item', validBundle().quality.slice(0, 1)],
    ['extra quality item', [...validBundle().quality, { criterion: 'No fabricated claims', status: 'met', evidence: 'Audited.' }]],
    ['reordered quality items', [...validBundle().quality].reverse()],
    ['renamed quality criterion', [{ ...validBundle().quality[0]!, criterion: 'Claims have sources' }, validBundle().quality[1]!]],
    ['duplicate quality criterion', [validBundle().quality[0]!, { ...validBundle().quality[1]!, criterion: 'Every claim is traceable' }]],
  ])('rejects %s', (_label, quality) => {
    expect(decode({ ...validBundle(), quality })).toMatchObject({ ok: false });
  });

  it.each([
    ['unknown quality status', { ...validBundle(), quality: [{ ...validBundle().quality[0]!, status: 'passed' }, validBundle().quality[1]!] }],
    ['empty primary content', { ...validBundle(), primary: { ...validBundle().primary, content: ' \n\t ' } }],
    ['empty supporting content', { ...validBundle(), supporting: [{ ...validBundle().supporting[0]!, content: '' }, validBundle().supporting[1]!] }],
    ['empty quality evidence', { ...validBundle(), quality: [{ ...validBundle().quality[0]!, evidence: '\n' }, validBundle().quality[1]!] }],
  ])('rejects %s', (_label, bundle) => {
    expect(decode(bundle)).toMatchObject({ ok: false, code: 'invalid_shape' });
  });

  it.each([
    ['primary template placeholder', {
      ...validBundle(),
      primary: { ...validBundle().primary, content: '<complete primary deliverable>' },
    }],
    ['supporting template placeholder', {
      ...validBundle(),
      supporting: [
        { ...validBundle().supporting[0]!, content: '<complete supporting artifact>' },
        validBundle().supporting[1]!,
      ],
    }],
    ['quality template placeholder', {
      ...validBundle(),
      quality: [
        { ...validBundle().quality[0]!, evidence: '<specific evidence from the generated deliverables>' },
        validBundle().quality[1]!,
      ],
    }],
  ])('rejects %s instead of persisting the prompt template', (_label, bundle) => {
    expect(decode(bundle)).toEqual({ ok: false, code: 'invalid_shape' });
  });

  it.each([
    ['primary name', { ...validBundle(), primary: { ...validBundle().primary, name: 'Complete\u0000 article' } }],
    ['primary content', { ...validBundle(), primary: { ...validBundle().primary, content: 'Unsafe\u0000content' } }],
    ['supporting name', { ...validBundle(), supporting: [{ ...validBundle().supporting[0]!, name: 'Evidence\u0085table' }, validBundle().supporting[1]!] }],
    ['supporting content', { ...validBundle(), supporting: [{ ...validBundle().supporting[0]!, content: 'Unsafe\u001fcontent' }, validBundle().supporting[1]!] }],
    ['quality criterion', { ...validBundle(), quality: [{ ...validBundle().quality[0]!, criterion: 'Every\u007fclaim is traceable' }, validBundle().quality[1]!] }],
    ['quality evidence', { ...validBundle(), quality: [{ ...validBundle().quality[0]!, evidence: 'Unsafe\u009fevidence' }, validBundle().quality[1]!] }],
  ])('rejects control characters in %s', (_label, bundle) => {
    expect(decode(bundle)).toMatchObject({ ok: false, code: 'invalid_shape' });
  });

  it('rejects an invalid OutputPlan before comparing bundle names', () => {
    expect(decode(validBundle(), { ...outputPlan, supportingArtifacts: ['Evidence table', 'Evidence table'] }))
      .toEqual({ ok: false, code: 'invalid_shape' });
    expect(decode(validBundle(), { ...outputPlan, extra: true }))
      .toEqual({ ok: false, code: 'invalid_shape' });
  });

  it('rejects raw agent text beyond the raw input limit', () => {
    const text = ' '.repeat(SCENARIO_OUTPUT_BUNDLE_LIMITS.rawTextChars + 1);
    expect(decodeScenarioOutputBundle(text, outputPlan)).toEqual({ ok: false, code: 'invalid_shape' });
  });

  it.each([
    ['primary content', { ...validBundle(), primary: { ...validBundle().primary, content: 'x'.repeat(SCENARIO_OUTPUT_BUNDLE_LIMITS.itemContentChars + 1) } }],
    ['supporting content', { ...validBundle(), supporting: [{ ...validBundle().supporting[0]!, content: 'x'.repeat(SCENARIO_OUTPUT_BUNDLE_LIMITS.itemContentChars + 1) }, validBundle().supporting[1]!] }],
    ['quality evidence', { ...validBundle(), quality: [{ ...validBundle().quality[0]!, evidence: 'x'.repeat(SCENARIO_OUTPUT_BUNDLE_LIMITS.evidenceChars + 1) }, validBundle().quality[1]!] }],
  ])('rejects oversized %s', (_label, bundle) => {
    expect(decode(bundle)).toMatchObject({ ok: false, code: 'invalid_shape' });
  });

  it('rejects a bundle whose aggregate body exceeds the total body limit while every item is within its own limit', () => {
    const plan = {
      primaryDeliverable: 'Primary',
      supportingArtifacts: ['Support A', 'Support B'],
      qualityCriteria: [],
    };
    const bundle = {
      primary: { name: 'Primary', content: 'p'.repeat(SCENARIO_OUTPUT_BUNDLE_LIMITS.itemContentChars) },
      supporting: [
        { name: 'Support A', content: 'a'.repeat(300_000) },
        { name: 'Support B', content: 'b'.repeat(300_000) },
      ],
      quality: [],
    };
    expect(decode(bundle, plan)).toEqual({ ok: false, code: 'invalid_shape' });
  });

  it('never throws for non-string input or hostile OutputPlan accessors', () => {
    expect(() => decodeScenarioOutputBundle({} as unknown as string, outputPlan)).not.toThrow();
    expect(decodeScenarioOutputBundle({} as unknown as string, outputPlan))
      .toEqual({ ok: false, code: 'invalid_json' });
    const hostile = Object.defineProperty({}, 'primaryDeliverable', {
      enumerable: true,
      get: () => { throw new Error('getter must not escape'); },
    });
    expect(() => decodeScenarioOutputBundle(JSON.stringify(validBundle()), hostile)).not.toThrow();
    expect(decodeScenarioOutputBundle(JSON.stringify(validBundle()), hostile))
      .toEqual({ ok: false, code: 'invalid_shape' });
  });
});
