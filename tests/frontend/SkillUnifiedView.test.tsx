/** @vitest-environment jsdom */
/**
 * 技能页「全部技能」统一视图 + 常驻对话窗测试（刘总 2026-09 重构）。
 * 覆盖：已安装与目录条目合并呈现、目录「安装」走 capabilityVaultInstall、
 * 搜索框过滤、常驻对话窗默认展开/收起、「对话优化」把技能送入上下文。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { buildBuiltinPersonalizationDefinitions } from '../fixtures/personalization/legacyBuiltinDefinitions.js';
import type { PersonalizationDefinition } from '../../engine/runtime/PersonalizationRuntimeContract.js';
import { useMetisStore } from '../../src/store.js';
import { researchWorkspaceStore } from '../../src/research/researchWorkspaceStore.js';
import PersonalizationCenter from '../../src/personalization/PersonalizationCenter.js';

let definitions: PersonalizationDefinition[];
let vaultList: ReturnType<typeof vi.fn>;
let vaultInstall: ReturnType<typeof vi.fn>;
let saveDefinition: ReturnType<typeof vi.fn>;

const CATALOG_ENTRY = {
  id: 'vault-entry-1',
  kind: 'skill',
  name: 'Catalog outline skill',
  description: 'A preset catalog skill for outlines.',
  sourceId: 'preset-repo',
  sourceRepo: 'metis/preset-skills',
  originalPath: 'skills/outline/SKILL.md',
  license: null,
  licenseStatus: 'verified',
  domains: ['writing'],
  researchStages: [],
  tags: ['outline'],
  contentDigest: 'a'.repeat(64),
  included: true,
  exclusionReason: null,
  installedDefinitionId: null,
  importedAt: Date.now(),
  updatedAt: Date.now(),
};

beforeEach(() => {
  useMetisStore.setState({ locale: 'zh' });
  researchWorkspaceStore.setState({ activeProjectId: null });
  definitions = structuredClone(buildBuiltinPersonalizationDefinitions());
  vaultList = vi.fn().mockResolvedValue({ ok: true, entries: [CATALOG_ENTRY] });
  vaultInstall = vi.fn().mockResolvedValue({ ok: true, definitionId: 'user:skills/catalog-outline-skill' });
  saveDefinition = vi.fn().mockImplementation((request: { definition: PersonalizationDefinition }) => {
    definitions = [...definitions, request.definition];
    return Promise.resolve({ ok: true, code: 'saved', definition: request.definition });
  });
  Object.defineProperty(window, 'metis', {
    configurable: true,
    writable: true,
    value: {
      listPersonalization: vi.fn().mockImplementation(() => Promise.resolve({ ok: true, definitions })),
      savePersonalization: saveDefinition,
      archivePersonalization: vi.fn(),
      forkPersonalization: vi.fn(),
      listPersonalizationSecrets: vi.fn().mockResolvedValue({ ok: true, contractVersion: 1, operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', revision: 0, secrets: [] }),
      capabilityVaultSources: vi.fn().mockResolvedValue({ ok: true, sources: [] }),
      capabilityVaultStats: vi.fn().mockResolvedValue({ ok: true, stats: { total: 1, skills: 1, mcps: 0, installed: 0, sources: 1 } }),
      capabilityVaultList: vaultList,
      capabilityVaultGetDetail: vi.fn().mockResolvedValue({ ok: false }),
      capabilityVaultInstall: vaultInstall,
      capabilityVaultUninstall: vi.fn().mockResolvedValue({ ok: false }),
    },
  });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'metis', { configurable: true, writable: true, value: undefined });
});

async function openSkillPage(): Promise<void> {
  render(<PersonalizationCenter />);
  fireEvent.click(await screen.findByRole('button', { name: /技能/ }));
  await screen.findByTestId('skill-unified-panel');
}

describe('技能页统一视图与常驻对话窗（刘总 2026-09）', () => {
  it('已安装技能与能力库目录条目在同一视图中呈现，目录条目只读可查看详情', async () => {
    await openSkillPage();
    // 已安装（内置）技能卡片仍在。
    const installed = definitions.find((item) => item.kind === 'skill')!;
    await waitFor(() => expect(document.querySelector(`[data-definition-id="${installed.id}"]`)).not.toBeNull());
    // 目录条目进入同一面板，带「目录」标记；「添加」按钮已移除（场景步骤选用时自动安装）。
    const catalogEntry = await screen.findByText('Catalog outline skill');
    const card = catalogEntry.closest('article') as HTMLElement;
    expect(card.textContent).toContain('目录');
    expect(card.textContent).toContain('查看详情');
    expect(card.textContent).not.toContain('添加');
  });

  it('搜索框同时收窄已安装卡片与目录条目查询', async () => {
    await openSkillPage();
    await waitFor(() => expect(vaultList).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId('personalization-skill-search'), { target: { value: 'outline' } });
    await waitFor(() => expect(vaultList).toHaveBeenCalledWith(expect.objectContaining({ kind: 'skill', keyword: 'outline' })));
  });

  it('技能页不再展示空的「选择或新建配置」区块', async () => {
    await openSkillPage();
    expect(screen.queryByText('选择或新建配置')).toBeNull();
  });

  it('常驻对话窗默认展开、可收起，「对话优化」把技能送入上下文', async () => {
    await openSkillPage();
    // 默认展开：步骤引导可见（skill-creator 范式）。
    expect(await screen.findByTestId('skill-studio-steps')).toBeDefined();
    const installed = definitions.find((item) => item.kind === 'skill')!;
    fireEvent.click(await screen.findByTestId('personalization-studio-optimize-0'));
    expect(await screen.findByText(`技能工坊：优化「${installed.name}」`)).toBeDefined();
    // 收起后对话体隐藏，仅剩展开条。
    fireEvent.click(screen.getByTestId('skill-studio-dock-toggle'));
    expect(screen.queryByTestId('skill-studio-steps')).toBeNull();
    expect(screen.getByTestId('skill-studio-dock')).toBeDefined();
    // 重新展开恢复对话体。
    fireEvent.click(screen.getByTestId('skill-studio-dock-toggle'));
    expect(await screen.findByTestId('skill-studio-steps')).toBeDefined();
  });
});
