/**
 * Gorden PPT Skill 集成测试（2026-09-11 刘总要求：作为 METIS 本体做 PPT 的
 * 默认挂载和使用的技能）。
 *
 * 契约：
 * - 技能定义可注册进 SkillRegistry 且形状合法；
 * - systemPrompt 内嵌可执行协议（自举/构建命令/edits.json/编辑铁律/输出目录）；
 * - PPT 意图自动挂载判定：未选技能 + 命中意图 → 挂载；显式技能选择绝不覆盖。
 * - 能力库源清单包含 gorden-ppt-skill（入库不注入，随全量导入）。
 */

import { describe, it, expect } from 'vitest';
import { SkillRegistry, registerDefaultSkills } from '../../engine/skills/SkillRegistry.js';
import {
  createGordenPptSkill,
  shouldAutoMountPptSkill,
  PPT_INTENT_PATTERN,
  GORDEN_PPT_SKILL_ID,
  GORDEN_PPT_SKILL_REPO,
} from '../../engine/skills/PptDeckSkill.js';
import { CAPABILITY_SOURCES } from '../../engine/capabilities/CapabilityImporter.js';

describe('createGordenPptSkill —— 技能定义', () => {
  const skill = createGordenPptSkill({ skillRoot: 'D:/data/metis-data/ppt-skill' });

  it('id/分类/版本固定，description 说明能力', () => {
    expect(skill.id).toBe('gorden-ppt-skill');
    expect(skill.category).toBe('writing');
    expect(skill.version).toBe('1.0.20');
    expect(skill.description.length).toBeGreaterThan(10);
  });

  it('allowedTools 仅含真实注册的工具（execute_command + file-tools 白名单）', () => {
    expect(skill.allowedTools).toContain('execute_command');
    for (const tool of skill.allowedTools ?? []) {
      expect(['execute_command', 'read_file', 'write_file', 'list_directory', 'create_directory']).toContain(tool);
    }
  });

  it('systemPrompt 是可执行协议：自举克隆 + 依赖安装 + 构建命令模板', () => {
    expect(skill.systemPrompt).toContain(`git clone --depth 1 ${GORDEN_PPT_SKILL_REPO}`);
    expect(skill.systemPrompt).toContain('python -m pip install python-pptx');
    expect(skill.systemPrompt).toContain('build_pptx.py');
    expect(skill.systemPrompt).toContain('templates/INDEX.md');
  });

  it('systemPrompt 注入真实数据目录（技能目录与输出目录）', () => {
    expect(skill.systemPrompt).toContain('D:/data/metis-data/ppt-skill/gorden-ppt-skill');
    expect(skill.systemPrompt).toContain('D:/data/metis-data/ppt-skill/output');
  });

  it('systemPrompt 包含编辑铁律与非商业许可声明', () => {
    expect(skill.systemPrompt).toContain('严禁用省略号截断');
    expect(skill.systemPrompt).toContain('非商业');
    expect(skill.systemPrompt).toContain('如实告知用户失败原因并停止');
  });

  it('可注册进 SkillRegistry（重复注册先卸载再注册，不抛错）', () => {
    const registry = new SkillRegistry();
    registry.register(skill);
    expect(registry.get(GORDEN_PPT_SKILL_ID)?.name).toBe(skill.name);
    // main.ts 的注册方式：has → unregister → register
    expect(() => {
      if (registry.has(skill.id)) registry.unregister(skill.id);
      registry.register(skill);
    }).not.toThrow();
  });

  it('不与既有 DEFAULT_SKILLS 的 id 冲突', () => {
    const registry = registerDefaultSkills(new SkillRegistry());
    expect(registry.has(GORDEN_PPT_SKILL_ID)).toBe(false);
  });
});

describe('shouldAutoMountPptSkill —— 默认挂载判定', () => {
  it('未选技能 + 中文 PPT 意图 → 挂载', () => {
    expect(shouldAutoMountPptSkill(null, '帮我做一个开题答辩 PPT')).toBe(true);
    expect(shouldAutoMountPptSkill(undefined, '把这份报告做成演示文稿')).toBe(true);
    expect(shouldAutoMountPptSkill(null, 'make a ppt about my research')).toBe(true);
    expect(shouldAutoMountPptSkill(null, '生成一份产品路演 slides')).toBe(true);
  });

  it('用户显式选择了任何技能 → 绝不覆盖', () => {
    expect(shouldAutoMountPptSkill('literature-review', '帮我做一个 PPT')).toBe(false);
  });

  it('非 PPT 意图 → 不挂载', () => {
    expect(shouldAutoMountPptSkill(null, '帮我总结这篇论文的方法论')).toBe(false);
    expect(shouldAutoMountPptSkill(null, '')).toBe(false);
    expect(shouldAutoMountPptSkill(null, null)).toBe(false);
    expect(shouldAutoMountPptSkill(null, undefined)).toBe(false);
  });

  it('意图正则覆盖主要中英文表述且不误伤常见学术词', () => {
    expect(PPT_INTENT_PATTERN.test('做一份 PPT')).toBe(true);
    expect(PPT_INTENT_PATTERN.test('制作幻灯片')).toBe(true);
    expect(PPT_INTENT_PATTERN.test('开题报告')).toBe(true);
    expect(PPT_INTENT_PATTERN.test('prepare a presentation')).toBe(true);
    // "汇报" 单字匹配较宽，但作为默认挂载宁可多挂（用户可一键切换技能）。
    expect(PPT_INTENT_PATTERN.test('写一段摘要')).toBe(false);
  });
});

describe('CAPABILITY_SOURCES —— 能力库登记', () => {
  it('gorden-ppt-skill 已登记且 spec 合法（入库不注入）', () => {
    const source = CAPABILITY_SOURCES.find((item) => item.id === 'gorden-ppt-skill');
    expect(source).toBeDefined();
    expect(source?.repo).toBe('GordenSun/GordenPPTSkill');
    expect(source?.expansion).toBe('single');
    expect(source?.licenseStatus).toBe('unverified');
    expect(source?.notes).toContain('非商业');
  });

  it('源 id 全局唯一', () => {
    const ids = CAPABILITY_SOURCES.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
