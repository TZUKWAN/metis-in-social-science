/**
 * GordenPptService 测试（任务：GordenPPTSkill 集成到 METIS Office PPT 并确保可用）。
 *
 * - composeEditsFromBrief 纯函数：可编辑 slot 全填充、装饰位不动、要点轮替。
 * - listTemplates / buildFromBrief：对真实技能包执行（含真实 python build_pptx.py
 *   构建 + OutcomePptxService 转 Grid 文档）。技能包位置由 env
 *   METIS_GORDEN_SKILL_DIR 指定；不存在时如实 SKIP（NOT RUN），不伪造通过。
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  composeEditsFromBrief,
  GordenPptService,
} from '../../electron/GordenPptService.js';

const SKILL_DIR = process.env.METIS_GORDEN_SKILL_DIR
  ?? ['D:/LATEXTEST/ppt-skill-qa/gorden-ppt-skill', path.join(os.homedir(), 'ppt-skill-qa/gorden-ppt-skill')]
    .find((candidate) => existsSync(path.join(candidate, 'SKILL.md')));
const SKILL_AVAILABLE = Boolean(SKILL_DIR);

const DETAIL: Parameters<typeof composeEditsFromBrief>[0] = {
  name: '演示模板',
  slide_count: 3,
  pages: [
    {
      slide_number: 1,
      text_slots: [
        { slot_id: 'cover_title_en' },
        { slot_id: 'cover_title_cn' },
        { slot_id: 'cover_num', editable: false },
      ],
    },
    {
      slide_number: 2,
      text_slots: [
        { slot_id: 'p2_title' },
        { slot_id: 'p2_body1' },
        { slot_id: 'p2_body2' },
      ],
    },
    { slide_number: 3, text_slots: [] },
  ],
};

describe('composeEditsFromBrief —— 编辑组装纯函数', () => {
  it('可编辑 slot 全部填充（无占位残留），装饰位保持不动', () => {
    const { selectedSlides, edits } = composeEditsFromBrief(DETAIL, '测试标题', ['要点一', '要点二'], 3);
    expect(selectedSlides).toEqual([1, 2]); // 第 3 页无可编辑 slot，不选
    const byId = new Map(edits.map((edit) => [edit.slot_id, edit.new_text]));
    expect(byId.get('cover_title_cn')).toBe('测试标题');
    expect(byId.get('cover_num')).toBeUndefined(); // editable:false 不动
    expect(byId.get('p2_body1')).toBe('要点一');
    expect(byId.get('p2_body2')).toBe('要点二');
    // 每个可编辑 slot 都有非空填充
    for (const edit of edits) expect(edit.new_text.length).toBeGreaterThan(0);
  });

  it('要点不足时轮替复用（不伪造新事实），要点为空时用标题兜底', () => {
    const { edits } = composeEditsFromBrief(DETAIL, '标题T', ['唯一要点'], 3);
    const bodies = edits.filter((edit) => edit.slot_id.startsWith('p2_body')).map((edit) => edit.new_text);
    expect(bodies).toEqual(['唯一要点', '唯一要点']);
    const empty = composeEditsFromBrief(DETAIL, '标题T', [], 3);
    expect(empty.edits.every((edit) => edit.new_text === '标题T' || /标题T/.test(edit.new_text))).toBe(true);
  });
});

describe('GordenPptService —— 对真实技能包的构建（确保 Office 集成可用）', () => {
  it.skipIf(!SKILL_AVAILABLE)('listTemplates 枚举 21 套模板元数据', async () => {
    const service = new GordenPptService(path.dirname(SKILL_DIR!));
    const templates = await service.listTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(20);
    const minimal = templates.find((template) => template.slug === 'minimal-business-summary');
    expect(minimal?.slideCount).toBeGreaterThan(0);
    expect(minimal?.roles.length ?? 0).toBeGreaterThan(0);
    expect(minimal?.previewPath).toBeTruthy();
  });

  it.skipIf(!SKILL_AVAILABLE)('buildFromBrief：真实 python 构建 + 转换为 METIS PPT Grid 文档', async () => {
    const service = new GordenPptService(path.dirname(SKILL_DIR!));
    const result = await service.buildFromBrief({
      slug: 'minimal-business-summary',
      title: 'METIS Office 集成测试',
      points: ['可执行场景：工作流即代码', '真实文献检索：DOI 逐条核验', '成果与投稿：Office 编辑 + 参谋选刊'],
      maxSlides: 3,
    });
    expect(result.ok).toBe(true);
    expect(result.document).toBeTruthy();
    const document = result.document as { type: string; pages: Array<{ title: string; elements: unknown[] }> };
    expect(document.type).toBe('ppt');
    expect(document.pages.length).toBe(3);
    const allText = JSON.stringify(document);
    expect(allText).toContain('METIS Office 集成测试');
    // 用户要点至少一处落盘
    expect(allText).toContain('真实文献检索');
    // 模板占位词不得残留（SKILL.md 编辑铁律 2）——含 detail.json 里的真实占位词
    expect(allText).not.toMatch(/Vivamus|Lorem ipsum|Question \d|Rice Husk|Work completion|Follow up objectives|Work schedule|Contents/iu);
  }, 120_000);

  it.skipIf(!SKILL_AVAILABLE)('不存在的模板如实报错', async () => {
    const service = new GordenPptService(path.dirname(SKILL_DIR!));
    const result = await service.buildFromBrief({ slug: 'no-such-deck', title: 'T', points: [] });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('template_not_found');
  });
});
