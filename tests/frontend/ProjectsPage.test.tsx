/**
 * ProjectsPage + ArtifactsCenter tests.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import ProjectsPage, { type ProjectViewMode } from '../../src/pages/ProjectsPage';
import ArtifactsCenter from '../../src/pages/ArtifactsCenter';
import { researchWorkspaceStore } from '../../src/research/researchWorkspaceStore';
import type { MetisAPI } from '../../electron/preload';

/** 受控模式的测试外壳：页签切换由真实 state 驱动。 */
function ProjectsPageHarness() {
  const [mode, setMode] = useState<ProjectViewMode>('chat');
  return (
    <ProjectsPage
      mode={mode}
      onModeChange={setMode}
      chatContent={<div data-testid="projects-chat-content">聊天内容</div>}
      chatRightPanel={null}
    />
  );
}

function projectDto(id: string, title: string, updatedAt: number) {
  return {
    id,
    title,
    originalIntent: '',
    researchQuestion: '',
    lifecycle: 'draft',
    methodology: '',
    discipline: '',
    createdAt: updatedAt - 1000,
    updatedAt,
    archivedAt: null,
    version: 1,
    deletedAt: null,
  };
}

function artifactDto(id: string, title: string, artifactType: string, updatedAt: number, reviewStatus = 'draft') {
  return {
    id,
    projectId: 'proj-1',
    title,
    artifactType,
    reviewStatus,
    contentRef: null,
    inputHash: null,
    version: 2,
    createdAt: updatedAt - 1000,
    updatedAt,
    deletedAt: null,
  };
}

function emptySnapshot(projectId: string, capturedAt = Date.now()) {
  return {
    success: true,
    snapshot: {
      project: projectDto(projectId, '测试项目', capturedAt),
      sources: [],
      evidence: [],
      noteCodes: [],
      claims: [],
      claimEvidenceLinks: [],
      artifacts: [],
      artifactVersions: [],
      runs: [],
      checkpoints: [],
      decisions: [],
      capturedAt,
    },
  };
}

function setMockMetis(overrides?: Partial<MetisAPI>) {
  (window as Window).metis = overrides as MetisAPI;
}

function resetWorkspace() {
  researchWorkspaceStore.setState({
    projects: [],
    activeProjectId: null,
    snapshot: null,
    loading: { projects: false, snapshot: false, mutation: false },
    error: null,
  });
}

describe('ProjectsPage — 科研项目工作台', () => {
  beforeEach(() => {
    resetWorkspace();
  });

  afterEach(() => {
    cleanup();
    (window as Window).metis = undefined;
  });

  it('renders the project list and activates a project on click', async () => {
    const projects = [
      projectDto('p1', '地方救济制度研究', Date.now() - 86_400_000),
      projectDto('p2', '档案馆文献整理', Date.now()),
    ];
    setMockMetis({
      researchListProjects: vi.fn().mockResolvedValue({
        success: true,
        items: projects.map((value) => ({ entityKind: 'project', value })),
      }),
    });

    render(<ProjectsPage mode="chat" onModeChange={() => {}} chatContent={null} chatRightPanel={null} />);

    await waitFor(() => {
      expect(screen.getByText('地方救济制度研究')).toBeTruthy();
      expect(screen.getByText('档案馆文献整理')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('地方救济制度研究'));
    await waitFor(() => {
      expect(researchWorkspaceStore.getState().activeProjectId).toBe('p1');
    });
  });

  it('creates a project from the inline form', async () => {
    const listProjects = vi.fn().mockResolvedValue({ success: true, items: [] });
    const createCrud = vi.fn().mockResolvedValue({
      success: true,
      code: 'created',
      projectId: 'project-new-1',
      resourceKind: 'project',
      resourceId: 'project-new-1',
      version: 1,
    });
    setMockMetis({
      researchListProjects: listProjects,
      researchCrud: createCrud,
    });

    render(<ProjectsPage mode="chat" onModeChange={() => {}} chatContent={null} chatRightPanel={null} />);
    await waitFor(() => expect(listProjects).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId('projects-new-project'));
    const input = screen.getByTestId('projects-new-project-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '新科研项目' } });
    fireEvent.click(screen.getByTestId('projects-create-submit'));

    await waitFor(() => {
      expect(createCrud).toHaveBeenCalled();
    });
    const request = createCrud.mock.calls[0][0] as { operation: string; entityKind: string; value: { title: string } };
    expect(request.operation).toBe('create');
    expect(request.entityKind).toBe('project');
    expect(request.value.title).toBe('新科研项目');
  });

  it('switches between chat, task board and outputs modes', async () => {
    setMockMetis({
      researchListProjects: vi.fn().mockResolvedValue({ success: true, items: [] }),
      listGoals: vi.fn().mockResolvedValue({ success: true, goals: [] }),
      onGoalChanged: vi.fn().mockReturnValue(() => {}),
      researchSnapshot: vi.fn().mockResolvedValue(emptySnapshot('proj-1')),
    });

    render(<ProjectsPageHarness />);

    expect(screen.getByTestId('projects-chat-content')).toBeTruthy();

    fireEvent.click(screen.getByTestId('projects-mode-kanban'));
    await waitFor(() => expect(screen.getByTestId('kanban-board')).toBeTruthy());

    fireEvent.click(screen.getByTestId('projects-mode-artifacts'));
    await waitFor(() => expect(screen.getByTestId('artifacts-center')).toBeTruthy());
  });

  it('project list width is user-resizable via the split handle', async () => {
    setMockMetis({
      researchListProjects: vi.fn().mockResolvedValue({ success: true, items: [] }),
      listGoals: vi.fn().mockResolvedValue({ success: true, goals: [] }),
      onGoalChanged: vi.fn().mockReturnValue(() => {}),
    });

    render(<ProjectsPage mode="chat" onModeChange={() => {}} chatContent={null} chatRightPanel={null} />);
    const handle = await screen.findByTestId('projects-split-sidebar');
    const sidebar = document.querySelector('.projects-page__sidebar') as HTMLElement;
    expect(sidebar.style.width).toBe('248px');

    fireEvent.pointerDown(handle, { clientX: 200 });
    fireEvent.pointerMove(window, { clientX: 500 });
    fireEvent.pointerUp(window);

    // jsdom 无布局宽度，clientX 直接成为宽度（夹取到 180–420）。
    expect(sidebar.style.width).toBe('420px');
    expect(window.localStorage.getItem('metis-projects-sidebar-width')).toBe('420');
  });
});

describe('ArtifactsCenter — 研究成果', () => {
  beforeEach(() => {
    resetWorkspace();
  });

  afterEach(() => {
    cleanup();
    (window as Window).metis = undefined;
  });

  function snapshotWithArtifacts(artifacts: ReturnType<typeof artifactDto>[]) {
    const snapshot = emptySnapshot('proj-1');
    snapshot.snapshot.artifacts = artifacts as never;
    return snapshot;
  }

  it('lists artifacts newest-first with category chips and version counts', async () => {
    const older = artifactDto('a1', '阶段报告', 'report', Date.now() - 60_000);
    const newer = artifactDto('a2', '证据数据表', 'table', Date.now());
    setMockMetis({
      researchSnapshot: vi.fn().mockResolvedValue(snapshotWithArtifacts([older, newer])),
      researchVersion: vi.fn().mockImplementation((request: { artifactId: string }) => {
        if (request.artifactId !== 'a2') return Promise.resolve({ success: true, items: [] });
        return Promise.resolve({
          success: true,
          items: [{ artifactId: 'a2', version: 2, contentHash: 'hash-a2', createdAt: Date.now(), createdBy: 'ai', branchFromVersion: 1 }],
        });
      }),
    });

    render(<ArtifactsCenter projectId="proj-1" />);

    await waitFor(() => expect(screen.getByText('阶段报告')).toBeTruthy());
    const items = screen.getAllByTestId('artifacts-center-item');
    // 最新在前：a2（证据数据表）排在 a1 之前。
    expect(items[0]?.getAttribute('data-artifact-id')).toBe('a2');
    expect(items[1]?.getAttribute('data-artifact-id')).toBe('a1');
    // 类别直接展示：report → 论文，table → 元数据（筛选按钮与条目徽章都会出现）。
    expect(screen.getAllByText('论文').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('元数据').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('1 个版本')).toBeTruthy();
  });

  it('right-click marks an artifact as 最终版 via researchReview', async () => {
    const artifact = artifactDto('a1', '终稿论文', 'manuscript', Date.now(), 'draft');
    const researchReview = vi.fn().mockResolvedValue({
      success: true,
      code: 'reviewed',
      projectId: 'proj-1',
      resourceKind: 'artifact',
      resourceId: 'a1',
      version: 3,
    });
    setMockMetis({
      researchSnapshot: vi.fn().mockResolvedValue(snapshotWithArtifacts([artifact])),
      researchVersion: vi.fn().mockResolvedValue({ success: true, items: [] }),
      researchReview,
    });

    render(<ArtifactsCenter projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('终稿论文')).toBeTruthy());

    fireEvent.contextMenu(screen.getByTestId('artifacts-center-item'));
    const menu = await screen.findByTestId('artifacts-center-menu');
    expect(menu).toBeTruthy();

    fireEvent.click(screen.getByText('最终版'));

    await waitFor(() => {
      expect(researchReview).toHaveBeenCalled();
    });
    const request = researchReview.mock.calls[0][0] as {
      operation: string;
      reviewKind: string;
      entityId: string;
      expectedVersion: number;
      toStatus: string;
    };
    expect(request.operation).toBe('review');
    expect(request.reviewKind).toBe('artifact');
    expect(request.entityId).toBe('a1');
    expect(request.expectedVersion).toBe(2);
    expect(request.toStatus).toBe('verified');
  });

  it('shows the empty state when the project has no artifacts', async () => {
    setMockMetis({
      researchSnapshot: vi.fn().mockResolvedValue(emptySnapshot('proj-1')),
    });
    render(<ArtifactsCenter projectId="proj-1" />);
    await waitFor(() => expect(screen.getByText('暂无研究成果')).toBeTruthy());
  });
});
