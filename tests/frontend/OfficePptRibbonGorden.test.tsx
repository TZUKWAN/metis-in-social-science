/**
 * OfficePptRibbon × Gorden 模板库（任务：GordenPPTSkill 集成到 METIS Office PPT）。
 *
 * UI 契约：
 * - 「设计」组提供「Gorden 模板库」入口；
 * - 对话框加载模板清单（window.metis.gordenPptListTemplates）；
 * - 选模板 + 填标题后可生成（gordenPptBuildFromBrief），产物 document 经
 *   onChange 载入 Office 画布。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { OfficePptRibbon } from '../../src/components/OfficePptRibbon';
import type { PptDocument } from '../../engine/runtime/OutcomeRuntimeContract.js';

function makeDocument(): PptDocument {
  return {
    type: 'ppt',
    ratio: '16:9',
    theme: {},
    templateId: null,
    generationSkillId: null,
    pages: [
      { id: 'slide-1', title: '封面', pageType: 'cover', humanModified: false, status: 'complete', elements: [] },
    ],
  } as unknown as PptDocument;
}

function makeRibbonProps(onChange: (document: PptDocument) => void) {
  const document = makeDocument();
  return {
    document,
    pageIndex: 0,
    onChange,
    onSave: vi.fn(),
    onSelectPage: vi.fn(),
    onSelectElement: vi.fn(),
    onNotice: vi.fn(),
  };
}

const TEMPLATES = {
  ok: true,
  templates: [
    { slug: 'minimal-business-summary', name: '极简商务汇报', slideCount: 16, roles: ['cover', 'agenda', 'content'], previewPath: null },
    { slug: 'thesis-novice', name: '论文答辩入门', slideCount: 32, roles: ['cover', 'content'], previewPath: null },
  ],
};

describe('OfficePptRibbon —— Gorden 模板库集成', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('「设计」组提供 Gorden 模板库入口，点击打开对话框并列出模板', async () => {
    const listTemplates = vi.fn().mockResolvedValue(TEMPLATES);
    (window as unknown as { metis: unknown }).metis = { gordenPptListTemplates: listTemplates };
    const props = makeRibbonProps(vi.fn());
    render(<OfficePptRibbon {...props} />);
    fireEvent.click(screen.getByRole('tab', { name: '设计' }));
    const trigger = screen.getByTestId('office-gorden-template');
    expect(trigger).toBeTruthy();
    fireEvent.click(trigger);
    expect(await screen.findByRole('dialog', { name: /Gorden 模板库/ })).toBeTruthy();
    await waitFor(() => expect(listTemplates).toHaveBeenCalled());
    expect(await screen.findByText('极简商务汇报')).toBeTruthy();
    expect(screen.getByText('论文答辩入门')).toBeTruthy();
  });

  it('选模板、填标题、生成成功后把产物 document 经 onChange 载入画布', async () => {
    const builtDocument = makeDocument();
    builtDocument.pages = [
      { id: 'slide-1', title: '生成页', pageType: 'cover', humanModified: false, status: 'complete', elements: [] },
      { id: 'slide-2', title: '第二页', pageType: 'content', humanModified: false, status: 'complete', elements: [] },
    ];
    const buildFromBrief = vi.fn().mockResolvedValue({
      ok: true, message: '构建完成。', fileName: 'metis-deck.pptx', document: builtDocument, warnings: [],
    });
    (window as unknown as { metis: unknown }).metis = {
      gordenPptListTemplates: vi.fn().mockResolvedValue(TEMPLATES),
      gordenPptBuildFromBrief: buildFromBrief,
    };
    const onChange = vi.fn();
    const props = makeRibbonProps(onChange);
    render(<OfficePptRibbon {...props} />);
    fireEvent.click(screen.getByRole('tab', { name: '设计' }));
    fireEvent.click(screen.getByTestId('office-gorden-template'));
    fireEvent.click(await screen.findByText('极简商务汇报'));
    fireEvent.change(screen.getByPlaceholderText('例如：METIS 科研工作台介绍'), { target: { value: 'METIS 介绍' } });
    fireEvent.click(screen.getByRole('button', { name: /生成并载入 Office/ }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const applied = onChange.mock.calls[0][0] as PptDocument;
    expect(applied.pages.length).toBe(2);
    expect(buildFromBrief).toHaveBeenCalledWith(expect.objectContaining({ slug: 'minimal-business-summary', title: 'METIS 介绍' }));
  });

  it('构建失败时把错误呈现在对话框内，不改动画布', async () => {
    (window as unknown as { metis: unknown }).metis = {
      gordenPptListTemplates: vi.fn().mockResolvedValue(TEMPLATES),
      gordenPptBuildFromBrief: vi.fn().mockResolvedValue({ ok: false, code: 'build_failed', message: '构建没有产出文件：python-pptx 缺失。' }),
    };
    const onChange = vi.fn();
    const props = makeRibbonProps(onChange);
    render(<OfficePptRibbon {...props} />);
    fireEvent.click(screen.getByRole('tab', { name: '设计' }));
    fireEvent.click(screen.getByTestId('office-gorden-template'));
    fireEvent.click(await screen.findByText('极简商务汇报'));
    fireEvent.change(screen.getByPlaceholderText('例如：METIS 科研工作台介绍'), { target: { value: 'T' } });
    fireEvent.click(screen.getByRole('button', { name: /生成并载入 Office/ }));
    expect(await screen.findByText(/构建没有产出文件/)).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });
});
