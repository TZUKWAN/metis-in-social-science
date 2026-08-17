/**
 * AutonomousWorkspaceService — 工作区真实数据组装（重构 R1）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutonomousWorkspaceService } from '../../electron/AutonomousWorkspaceService.js';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import { ResearchRepository } from '../../engine/persistence/ResearchRepository.js';

let tmpDir: string;
let store: PersistenceStore;
let repository: ResearchRepository;
let service: AutonomousWorkspaceService;

function makeProject(id: string, title: string, overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id, title,
    originalIntent: '', researchQuestion: '初始研究问题', lifecycle: 'draft' as const,
    methodology: '', discipline: '', metadata: {},
    createdAt: now, updatedAt: now, archivedAt: null,
    version: 1, source: 'user' as const, deletedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-aws-'));
  store = new PersistenceStore(path.join(tmpDir, 'test.db'));
  repository = new ResearchRepository(store.raw);
  service = new AutonomousWorkspaceService(repository, store);
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('AutonomousWorkspaceService.buildDetail', () => {
  it('空项目：默认问题占位、无判断/发现/成果', () => {
    repository.createProject(makeProject('p-ws-1', '空项目'));
    const detail = service.buildDetail('p-ws-1')!;
    expect(detail).not.toBeNull();
    expect(detail.question.text).toBe('初始研究问题');
    expect(detail.question.version).toBe(1);
    expect(detail.coreJudgments).toHaveLength(0);
    expect(detail.artifacts).toHaveLength(0);
    expect(detail.timeline).toHaveLength(0);
  });

  it('研究问题版本随决策递增，历史可回溯', () => {
    const project = repository.createProject(makeProject('p-ws-2', '版本项目'))!;
    repository.updateProject('p-ws-2', { researchQuestion: '第二次研究问题' });
    // 模拟研究问题决策记录。
    store.raw.prepare(
      'INSERT INTO research_decisions (id, project_id, run_id, target_kind, target_id, decision, origin, before_value, after_value, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('d-1', 'p-ws-2', null, 'project', 'p-ws-2', 'revise_question', 'autonomous',
      JSON.stringify({ researchQuestion: project.researchQuestion }),
      JSON.stringify({ researchQuestion: '第二次研究问题' }),
      '新证据显示原问题过窄', Date.now());
    const detail = service.buildDetail('p-ws-2')!;
    expect(detail.question.version).toBe(2);
    expect(detail.question.text).toBe('第二次研究问题');
    expect(detail.question.history).toHaveLength(1);
    expect(detail.question.history[0]!.note).toContain('过窄');
  });

  it('claims 按置信度组成核心判断；低置信进不确定性', () => {
    repository.createProject(makeProject('p-ws-3', '判断项目'));
    repository.saveClaim({ id: 'c-hi', projectId: 'p-ws-3', statement: '组织控制调节 AI 使用强度的效应', claimType: 'finding', confidence: 0.85, status: 'supported', metadata: {}, createdAt: Date.now(), updatedAt: Date.now(), deletedAt: null } as never);
    repository.saveClaim({ id: 'c-lo', projectId: 'p-ws-3', statement: '技能增强假设成立', claimType: 'hypothesis', confidence: 0.3, status: 'unsupported', metadata: {}, createdAt: Date.now(), updatedAt: Date.now(), deletedAt: null } as never);
    const detail = service.buildDetail('p-ws-3')!;
    expect(detail.coreJudgments[0]!.id).toBe('c-hi');
    expect(detail.uncertainties.some((u) => u.text.includes('技能增强'))).toBe(true);
  });

  it('成果直展携带最新版本内容与 AI 编辑标记', () => {
    repository.createProject(makeProject('p-ws-4', '成果项目'));
    repository.saveArtifact({ id: 'a-1', projectId: 'p-ws-4', title: '理论框架', artifactType: 'network', reviewStatus: 'draft', contentRef: null, inputHash: null, provenance: {}, metadata: {}, version: 1, createdAt: Date.now(), updatedAt: Date.now(), deletedAt: null } as never);
    repository.saveArtifactVersion(
      { id: 'a-1', projectId: 'p-ws-4', title: '理论框架', artifactType: 'network', reviewStatus: 'draft', generatedBy: { capabilityId: 'autonomous', method: 'synthesis' }, renderer: { kind: 'text' }, createdAt: Date.now() - 60_000, updatedAt: Date.now() - 60_000 },
      '框架 v2：决策权迁移 → 组织控制（调节）→ 劳动自主性',
      { createdBy: 'ai', branchFromVersion: 1, thumbnailRef: null },
    );
    const detail = service.buildDetail('p-ws-4')!;
    expect(detail.artifacts).toHaveLength(1);
    const artifact = detail.artifacts[0]!;
    expect(artifact.contentPreview).toContain('决策权迁移');
    expect(artifact.aiEditing).toBe(true); // 1 分钟内 AI 更新
  });

  it('时间线合并决策/证据/文献/论断并按时间倒序', () => {
    repository.createProject(makeProject('p-ws-5', '动态项目'));
    repository.saveSource({ id: 's-1', projectId: 'p-ws-5', kind: 'paper', title: '关键文献', authors: [], year: 2024, venue: '', identifier: '', identifierType: 'doi', filePath: null, externalUrl: null, tags: [], sourceVersionHash: null, createdAt: Date.now() - 1000, updatedAt: Date.now() - 1000, deletedAt: null } as never);
    repository.saveClaim({ id: 'c-1', projectId: 'p-ws-5', statement: '新论断', claimType: 'finding', confidence: 0.7, status: 'supported', metadata: {}, createdAt: Date.now(), updatedAt: Date.now(), deletedAt: null } as never);
    const detail = service.buildDetail('p-ws-5')!;
    const kinds = new Set(detail.timeline.map((item) => item.kind));
    expect(kinds.has('source')).toBe(true);
    expect(kinds.has('claim')).toBe(true);
    expect(detail.timeline[0]!.at).toBeGreaterThanOrEqual(detail.timeline[detail.timeline.length - 1]!.at);
  });
});

describe('AutonomousWorkspaceService.buildOverview', () => {
  it('只列自主来源项目（或运行中），指标真实统计', () => {
    repository.createProject(makeProject('p-auto', '自主项目A', { source: 'autonomous' }));
    repository.createProject(makeProject('p-cons', '控制台运行项目', { source: 'autonomous_research' }));
    repository.createProject(makeProject('p-user', '手工项目')); // 非自主：不出现
    repository.saveClaim({ id: 'c-m', projectId: 'p-auto', statement: '指标论断', claimType: 'finding', confidence: 0.6, status: 'supported', metadata: {}, createdAt: Date.now(), updatedAt: Date.now(), deletedAt: null } as never);
    const overview = service.buildOverview(new Set(['p-auto']));
    expect(overview.projects.map((p) => p.id).sort()).toEqual(['p-auto', 'p-cons']);
    // listProjects 按 updated_at 倒序，运行中项目不保证排第一：按 id 定位断言状态。
    const autoProject = overview.projects.find((p) => p.id === 'p-auto')!;
    expect(autoProject.status).toBe('running');
    expect(overview.metrics.running).toBe(1);
    expect(overview.metrics.newFindings7d).toBe(1);
  });
});
