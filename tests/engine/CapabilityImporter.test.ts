import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_SOURCES,
  contentDigest,
  expandSourceSkills,
  type RepoSkillFile,
} from '../../engine/capabilities/CapabilityImporter.js';

describe('Capability 展开导入器(2026-09-05 任务7 7B)', () => {
  it('registers the 10 required GitHub sources with expansion strategy', () => {
    expect(CAPABILITY_SOURCES).toHaveLength(10);
    const byId = new Set(CAPABILITY_SOURCES.map((source) => source.id));
    for (const required of ['auto-empirical-research', 'research-plugins', 'cnki-skills', 'paper-search-mcp']) {
      expect(byId.has(required)).toBe(true);
    }
    const perSkill = CAPABILITY_SOURCES.filter((source) => source.expansion === 'per_skill').map((source) => source.id);
    expect(perSkill).toContain('auto-empirical-research');
    expect(perSkill).toContain('research-plugins');
  });

  it('expands multiple SKILL.md files into per-skill manifests with provenance', () => {
    const source = CAPABILITY_SOURCES[0]!;
    const files: RepoSkillFile[] = [
      { path: 'skills/did-identification/SKILL.md', content: '---\nname: did-identification\ndescription: 双重差分识别策略与平行趋势检验方法。\nlicense: MIT\n---\n\n# DID\n\n当处理面板政策冲击时,使用双重差分识别策略估计政策效应。必须先检验平行趋势假设:比较处理组与对照组在政策实施前的结果变量走势。若平行趋势不成立,应考虑合成控制法或断点回归设计作为替代识别策略,并如实报告检验结果与敏感性分析。' },
      { path: 'skills/event-study/SKILL.md', content: '# event-study\n\n事件研究设计:以政策时点为基准,动态估计各期效应并绘制置信区间。需要预先定义事件窗口与基准期,报告各期系数及95%置信区间,并对聚类稳健标准误做出说明。' },
    ];
    const manifests = expandSourceSkills(source, files);
    expect(manifests).toHaveLength(2);
    expect(manifests.every((manifest) => manifest.included)).toBe(true);
    expect(manifests[0]!.sourceRepo).toBe(source.repo);
    expect(manifests[0]!.originalPath).toBe('skills/did-identification/SKILL.md');
    expect(manifests[0]!.license).toBe('MIT');
    expect(manifests[0]!.contentDigest).not.toBe(manifests[1]!.contentDigest);
  });

  it('excludes empty-content skills with an honest reason', () => {
    const source = CAPABILITY_SOURCES[1]!;
    const manifests = expandSourceSkills(source, [
      { path: 'SKILL.md', content: '---\nname: thin\n---\ntoo short' },
    ]);
    expect(manifests).toHaveLength(1);
    expect(manifests[0]!.included).toBe(false);
    expect(manifests[0]!.exclusionReason).toContain('无实质内容');
  });

  it('contentDigest is deterministic and input-sensitive', () => {
    expect(contentDigest('abc')).toBe(contentDigest('abc'));
    expect(contentDigest('abc')).not.toBe(contentDigest('abd'));
  });
});

describe('GitHub 真实拉取管线(任务7 7B)', () => {
  it('fetchAndExpandSource walks the repo tree and expands per skill', async () => {
    const { fetchAndExpandSource } = await import('../../engine/capabilities/CapabilityImporter.js');
    const calls: string[] = [];
    const fetcher = async (url: string): Promise<string> => {
      calls.push(url);
      if (url.includes('/git/trees/')) {
        return JSON.stringify({ tree: [
          { path: 'skills/a/SKILL.md', type: 'blob' },
          { path: 'README.md', type: 'blob' },
        ] });
      }
      if (url.startsWith('https://raw.githubusercontent.com/')) {
        return '---\nname: skill-a\ndescription: 测试技能 A 的描述,长度足够通过内容门槛。\n---\n\n# skill-a\n\n这是一段足够长的真实技能正文内容,用于通过最小内容长度检查,包含具体的方法步骤与判断规则说明,并要求在证据不足时如实报告而不是编造结论,完成后需要自查引用与数据的可追溯性。';
      }
      return '{}';
    };
    const manifests = await fetchAndExpandSource(CAPABILITY_SOURCES[0]!, fetcher);
    expect(calls.some((call) => call.includes('/git/trees/'))).toBe(true);
    expect(manifests).toHaveLength(1);
    expect(manifests[0]!.included).toBe(true);
    expect(manifests[0]!.sourceRepo).toBe(CAPABILITY_SOURCES[0]!.repo);
  });
});
