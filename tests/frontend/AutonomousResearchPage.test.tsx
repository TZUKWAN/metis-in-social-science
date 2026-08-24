/**
 * AutonomousResearchPage — real pause/resume UI state machine: running shows
 * Pause + Interrupt, engine-paused flips to a Paused badge + Resume button,
 * engine-resumed flips back to running controls.
 *
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { researchWorkspaceStore } from '../../src/research/researchWorkspaceStore';

function makeMetis(overrides: Record<string, unknown> = {}) {
  const handlers: Record<string, (data: unknown) => void> = {};
  const metis = {
    autonomousStart: vi.fn().mockResolvedValue({ ok: true, sessionId: 'auto-1' }),
    autonomousControl: vi.fn().mockResolvedValue({ ok: true, code: 'applied' }),
    autonomousListSessions: vi.fn().mockResolvedValue({ sessions: [] }),
    autonomousResumeSession: vi.fn().mockResolvedValue({ ok: true, goal: '恢复目标' }),
    onAutonomousEngineStarted: vi.fn((cb: (d: unknown) => void) => { handlers.started = cb; return () => {}; }),
    onAutonomousPhaseStarted: vi.fn().mockReturnValue(() => {}),
    onAutonomousStep: vi.fn().mockReturnValue(() => {}),
    onAutonomousReflection: vi.fn().mockReturnValue(() => {}),
    onAutonomousProgress: vi.fn().mockReturnValue(() => {}),
    onAutonomousCompleted: vi.fn((cb: (d: unknown) => void) => { handlers.completed = cb; return () => {}; }),
    onAutonomousFailed: vi.fn((cb: (d: unknown) => void) => { handlers.failed = cb; return () => {}; }),
    onAutonomousInterrupted: vi.fn().mockReturnValue(() => {}),
    onAutonomousPaused: vi.fn((cb: (d: unknown) => void) => { handlers.paused = cb; return () => {}; }),
    onAutonomousResumed: vi.fn((cb: (d: unknown) => void) => { handlers.resumed = cb; return () => {}; }),
    ...overrides,
  };
  return { metis: metis as unknown as typeof window.metis, handlers };
}

describe('AutonomousResearchPage pause/resume', () => {
  beforeEach(() => {
    researchWorkspaceStore.setState({ activeProjectId: null });
    window.sessionStorage.clear();
  });

  it('shows Pause + Interrupt while running, then Paused + Resume after engine-paused', async () => {
    const { metis, handlers } = makeMetis();
    window.metis = metis;

    const { default: AutonomousResearchPage } = await import('../../src/pages/AutonomousResearchPage');
    render(<AutonomousResearchPage />);

    const input = screen.getByPlaceholderText(/描述研究目标/u);
    fireEvent.change(input, { target: { value: '调研 transformer 方向' } });
    fireEvent.click(screen.getByTestId('autonomous-start'));
    await waitFor(() => expect(metis.autonomousStart).toHaveBeenCalledTimes(1));

    expect(screen.getByTestId('autonomous-pause')).toBeTruthy();
    expect(screen.getByTestId('autonomous-interrupt')).toBeTruthy();
    expect(screen.queryByTestId('autonomous-resume')).toBeNull();

    // The engine broadcasts engine-paused after stopping at a phase boundary.
    await waitFor(() => {
      handlers.paused?.({ version: 1, sessionId: 'auto-1', sequence: 7, type: 'engine-paused', reason: 'user_pause' });
    });
    expect(await screen.findByTestId('autonomous-paused-badge')).toBeTruthy();
    expect(screen.getByTestId('autonomous-resume')).toBeTruthy();
    expect(screen.queryByTestId('autonomous-pause')).toBeNull();
  });

  it('sends pause and resume control requests with the active session id', async () => {
    const { metis, handlers } = makeMetis();
    window.metis = metis;

    const { default: AutonomousResearchPage } = await import('../../src/pages/AutonomousResearchPage');
    render(<AutonomousResearchPage />);

    const input = screen.getByPlaceholderText(/描述研究目标/u);
    fireEvent.change(input, { target: { value: '调研方向' } });
    fireEvent.click(screen.getByTestId('autonomous-start'));
    await waitFor(() => expect(metis.autonomousStart).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId('autonomous-pause'));
    await waitFor(() => expect(metis.autonomousControl).toHaveBeenCalledWith({
      sessionId: 'auto-1',
      action: 'pause',
      reason: 'user_pause',
    }));

    await waitFor(() => {
      handlers.paused?.({ version: 1, sessionId: 'auto-1', sequence: 8, type: 'engine-paused', reason: 'user_pause' });
    });
    fireEvent.click(await screen.findByTestId('autonomous-resume'));
    await waitFor(() => expect(metis.autonomousControl).toHaveBeenCalledWith({
      sessionId: 'auto-1',
      action: 'resume',
      reason: 'user_resume',
    }));

    // engine-resumed flips the controls back to running.
    await waitFor(() => {
      handlers.resumed?.({ version: 1, sessionId: 'auto-1', sequence: 9, type: 'engine-resumed', completedPhases: 2 });
    });
    expect(await screen.findByTestId('autonomous-pause')).toBeTruthy();
    expect(screen.queryByTestId('autonomous-resume')).toBeNull();
  });

  it('surfaces a resume failure with the engine code', async () => {
    const { metis, handlers } = makeMetis({
      autonomousControl: vi.fn().mockResolvedValue({ ok: false, code: 'not_found' }),
    });
    window.metis = metis;

    const { default: AutonomousResearchPage } = await import('../../src/pages/AutonomousResearchPage');
    render(<AutonomousResearchPage />);

    const input = screen.getByPlaceholderText(/描述研究目标/u);
    fireEvent.change(input, { target: { value: '方向' } });
    fireEvent.click(screen.getByTestId('autonomous-start'));
    await waitFor(() => expect(metis.autonomousStart).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      handlers.paused?.({ version: 1, sessionId: 'auto-1', sequence: 1, type: 'engine-paused', reason: 'user_pause' });
    });

    fireEvent.click(await screen.findByTestId('autonomous-resume'));
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('defaults to automatic method selection and renders the dynamic method plan', async () => {
    const { metis, handlers } = makeMetis({
      strategyList: vi.fn().mockResolvedValue({
        ok: true,
        strategies: [{
          id: 'manual-1',
          name: '人工策略',
          phases: [{ action: 'analysis', name: '分析' }],
          createdAt: 1,
          updatedAt: 1,
          isDefault: true,
        }],
      }),
      structureList: vi.fn().mockResolvedValue({ ok: true, templates: [] }),
    });
    window.metis = metis;

    const { default: AutonomousResearchPage } = await import('../../src/pages/AutonomousResearchPage');
    render(<AutonomousResearchPage />);

    expect(await screen.findByText('自动选择研究方法（推荐）')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(/描述研究目标/u), {
      target: { value: '利用地方档案研究制度演变' },
    });
    fireEvent.click(screen.getByTestId('autonomous-start'));
    await waitFor(() => expect(metis.autonomousStart).toHaveBeenCalledWith(expect.objectContaining({
      goal: '利用地方档案研究制度演变',
      strategyId: undefined,
    })));

    await waitFor(() => {
      handlers.started?.({
        version: 1,
        sessionId: 'auto-1',
        sequence: 0,
        type: 'engine-started',
        goal: '利用地方档案研究制度演变',
        plan: [
          { phase: 'source_discovery', name: '资料发现' },
          { phase: 'source_criticism', name: '史料批判' },
          { phase: 'writing', name: '写作' },
        ],
        method: {
          family: 'historical',
          name: '历史研究',
          rationale: '问题关注历时变化且依赖档案材料。',
          confidence: 0.9,
          selectedBy: 'automatic_heuristic',
        },
      });
    });

    expect((await screen.findByTestId('autonomous-method')).textContent).toContain('历史研究');
    // 阶段名同时出现在工作流总览与阶段卡片中。
    expect(screen.getAllByText('史料批判').length).toBeGreaterThanOrEqual(1);
  });

  it('surfaces an engine failure and offers checkpoint recovery instead of staying falsely running', async () => {
    const { metis, handlers } = makeMetis();
    window.metis = metis;
    const { default: AutonomousResearchPage } = await import('../../src/pages/AutonomousResearchPage');
    render(<AutonomousResearchPage />);

    fireEvent.change(screen.getByPlaceholderText(/描述研究目标/u), { target: { value: '研究目标' } });
    fireEvent.click(screen.getByTestId('autonomous-start'));
    await waitFor(() => expect(metis.autonomousStart).toHaveBeenCalledTimes(1));
    await waitFor(() => handlers.failed?.({
      version: 1,
      sessionId: 'auto-1',
      sequence: 4,
      type: 'engine-failed',
      reason: '达到自主执行上限，已保留检查点。',
      completedPhases: 2,
      recoverable: true,
    }));

    expect((await screen.findByRole('alert')).textContent).toContain('达到自主执行上限');
    expect(screen.queryByTestId('autonomous-pause')).toBeNull();
    expect(screen.getByTestId('autonomous-resume')).toBeTruthy();
  });

  it('shows durable deliverables and opens the project artifact workspace after completion', async () => {
    researchWorkspaceStore.setState({ activeProjectId: 'project-existing' });
    const { metis, handlers } = makeMetis();
    window.metis = metis;
    const { default: AutonomousResearchPage } = await import('../../src/pages/AutonomousResearchPage');
    const openProject = vi.fn();
    window.addEventListener('metis:open-project', openProject);
    render(<AutonomousResearchPage />);

    fireEvent.change(screen.getByPlaceholderText(/描述研究目标/u), { target: { value: '研究目标' } });
    fireEvent.click(screen.getByTestId('autonomous-start'));
    await waitFor(() => expect(metis.autonomousStart).toHaveBeenCalledTimes(1));
    await waitFor(() => handlers.completed?.({
      version: 1,
      sessionId: 'auto-1',
      sequence: 9,
      type: 'engine-completed',
      summary: '研究已经完成。',
      artifactIds: ['artifact-1', 'artifact-2'],
    }));

    expect((await screen.findByTestId('autonomous-deliverables')).textContent).toContain('2');
    fireEvent.click(screen.getByTestId('autonomous-open-artifacts'));
    expect(openProject).toHaveBeenCalledTimes(1);
    expect((openProject.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      projectId: 'project-existing',
      section: 'artifacts',
    });
    window.removeEventListener('metis:open-project', openProject);
  });

  it('surfaces crash-recovery checkpoints and resumes without restarting completed phases', async () => {
    const { metis } = makeMetis({
      autonomousListSessions: vi.fn().mockResolvedValue({
        sessions: [{
          sessionId: 'recover-1',
          goal: '恢复中的历史研究',
          projectId: 'project-recover',
          executions: 4,
          completedPhases: 3,
          savedAt: 100,
          state: 'paused',
          failureReason: '资料服务暂时不可用',
        }],
      }),
      autonomousResumeSession: vi.fn().mockResolvedValue({ ok: true, goal: '恢复中的历史研究' }),
    });
    window.metis = metis;
    const { default: AutonomousResearchPage } = await import('../../src/pages/AutonomousResearchPage');
    render(<AutonomousResearchPage />);

    expect((await screen.findByTestId('autonomous-recovery')).textContent).toContain('恢复中的历史研究');
    expect(screen.getByTestId('autonomous-recovery').textContent).toContain('3');
    fireEvent.click(screen.getByText('从检查点继续'));

    await waitFor(() => expect(metis.autonomousResumeSession).toHaveBeenCalledWith('recover-1'));
    expect(screen.getByDisplayValue('恢复中的历史研究')).toBeTruthy();
    expect(screen.getByTestId('autonomous-pause')).toBeTruthy();
  });
});

// ─── 过程可视化：选题依据 + 工作流总览 ──────────────────────────

describe('AutonomousResearchPage — 过程可视化', () => {
  beforeEach(() => {
    researchWorkspaceStore.setState({ activeProjectId: 'proj-1' });
    window.sessionStorage.clear();
  });

  function makeVizMetis() {
    const handlers: Record<string, (data: unknown) => void> = {};
    const metis = {
      autonomousStart: vi.fn().mockResolvedValue({ ok: true, sessionId: 'viz-1', projectId: 'proj-1' }),
      autonomousControl: vi.fn().mockResolvedValue({ ok: true, code: 'applied' }),
      autonomousListSessions: vi.fn().mockResolvedValue({ sessions: [] }),
      autonomousResumeSession: vi.fn().mockResolvedValue({ ok: true, goal: '' }),
      strategyList: vi.fn().mockResolvedValue({ ok: true, strategies: [] }),
      structureList: vi.fn().mockResolvedValue({ ok: true, templates: [] }),
      onAutonomousEngineStarted: vi.fn((cb: (d: unknown) => void) => { handlers.started = cb; return () => {}; }),
      onAutonomousPhaseStarted: vi.fn((cb: (d: unknown) => void) => { handlers.phaseStarted = cb; return () => {}; }),
      onAutonomousStep: vi.fn((cb: (d: unknown) => void) => { handlers.step = cb; return () => {}; }),
      onAutonomousReflection: vi.fn().mockReturnValue(() => {}),
      onAutonomousProgress: vi.fn().mockReturnValue(() => {}),
      onAutonomousCompleted: vi.fn((cb: (d: unknown) => void) => { handlers.completed = cb; return () => {}; }),
      onAutonomousFailed: vi.fn((cb: (d: unknown) => void) => { handlers.failed = cb; return () => {}; }),
      onAutonomousInterrupted: vi.fn((cb: (d: unknown) => void) => { handlers.interrupted = cb; return () => {}; }),
      onAutonomousPaused: vi.fn().mockReturnValue(() => {}),
      onAutonomousResumed: vi.fn().mockReturnValue(() => {}),
    };
    window.metis = metis as unknown as typeof window.metis;
    return handlers;
  }

  it('shows the topic rationale and workflow overview while the run streams', async () => {
    const handlers = makeVizMetis();
    const { default: AutonomousResearchPage } = await import('../../src/pages/AutonomousResearchPage');
    render(<AutonomousResearchPage />);

    const input = screen.getByPlaceholderText(/描述研究目标/u) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '利用地方档案研究民国救济制度演变' } });
    fireEvent.click(screen.getByTestId('autonomous-start'));
    await waitFor(() => expect(handlers.started).toBeDefined());

    handlers.started?.({
      version: 1, sessionId: 'viz-1', sequence: 1, type: 'engine-started',
      goal: '利用地方档案研究民国救济制度演变',
      plan: [
        { phase: 'idea', name: '选题与假设' },
        { phase: 'source_discovery', name: '资料发现' },
        { phase: 'writing', name: '论文写作' },
      ],
      method: { family: 'historical', name: '历史档案分析法', rationale: '研究对象以地方档案为核心史料', confidence: 0.85, selectedBy: 'automatic_heuristic' },
    });
    handlers.phaseStarted?.({ version: 1, sessionId: 'viz-1', sequence: 2, type: 'phase-started', phase: 'idea', phaseIteration: 1, phaseName: '选题与假设' });
    handlers.step?.({
      version: 1, sessionId: 'viz-1', sequence: 3, type: 'step-complete',
      phase: 'idea', stepId: 'gap_analysis', stepName: '研究空白分析',
      output: '现有研究多聚焦制度文本，缺乏对基层执行档案的系统梳理。',
    });

    // 选题依据：目标 + 方法选择（为什么）+ 选题分析。
    const topic = await screen.findByTestId('autonomous-topic');
    expect(topic.textContent).toContain('利用地方档案研究民国救济制度演变');
    expect(topic.textContent).toContain('历史档案分析法');
    expect(topic.textContent).toContain('研究对象以地方档案为核心史料');
    expect(topic.textContent).toContain('现有研究多聚焦制度文本');

    // 工作流总览：完整计划可见，idea 阶段已完成、其余待执行。
    const workflow = screen.getByTestId('autonomous-workflow');
    const nodes = workflow.querySelectorAll('.autonomous-pipeline-node');
    expect(nodes.length).toBe(3);
    expect(workflow.textContent).toContain('论文写作');
    // idea 阶段已开始（phase-started），其余阶段待执行。
    expect(nodes[0]?.getAttribute('data-status')).toBe('running');
    expect(nodes[1]?.getAttribute('data-status')).toBe('pending');
  });

  it('keeps the topic panel after the run completes with the final summary', async () => {
    const handlers = makeVizMetis();
    const { default: AutonomousResearchPage } = await import('../../src/pages/AutonomousResearchPage');
    render(<AutonomousResearchPage />);

    fireEvent.change(screen.getByPlaceholderText(/描述研究目标/u), { target: { value: '探讨地方救济组织的运作机制' } });
    fireEvent.click(screen.getByTestId('autonomous-start'));
    await waitFor(() => expect(handlers.started).toBeDefined());

    handlers.started?.({
      version: 1, sessionId: 'viz-1', sequence: 1, type: 'engine-started',
      goal: '探讨地方救济组织的运作机制',
      plan: [{ phase: 'idea', name: '选题与假设' }],
      method: { family: 'qualitative', name: '质性案例研究', rationale: '适合小样本深度机制分析', confidence: 0.7, selectedBy: 'automatic_heuristic' },
    });
    handlers.completed?.({
      version: 1, sessionId: 'viz-1', sequence: 9, type: 'engine-completed',
      summary: '研究完成。', artifactIds: ['artifact-1'],
    });

    expect(await screen.findByTestId('autonomous-topic')).toBeTruthy();
    expect(screen.getByTestId('autonomous-summary')).toBeTruthy();
    expect(screen.getByTestId('autonomous-deliverables')).toBeTruthy();
  });

  it('shows the launchpad preview while idle and hides it once a run starts', async () => {
    const handlers = makeVizMetis();
    const { default: AutonomousResearchPage } = await import('../../src/pages/AutonomousResearchPage');
    render(<AutonomousResearchPage />);

    // 空闲态：流程预告可见（回答「它会做什么」），五步齐全，运行选项可设置。
    const preview = await screen.findByTestId('autonomous-preview');
    expect(preview).toBeTruthy();
    expect(preview.querySelectorAll('.autonomous-preview-steps li').length).toBe(5);
    expect(screen.getByLabelText('工作流策略')).toBeTruthy();
    expect(screen.getByTestId('autonomous-project-select')).toBeTruthy();
    // 空闲态不展示反思日志（避免死区）。
    expect(screen.queryByTestId('autonomous-reflection-log')).toBeNull();

    // 开始后：预告消失，进入运行态。
    fireEvent.change(screen.getByPlaceholderText(/描述研究目标/u), { target: { value: '梳理地方档案的制度变迁' } });
    fireEvent.click(screen.getByTestId('autonomous-start'));
    await waitFor(() => expect(handlers.started).toBeDefined());
    handlers.started?.({
      version: 1, sessionId: 'viz-1', sequence: 1, type: 'engine-started',
      goal: '梳理地方档案的制度变迁',
      plan: [{ phase: 'idea', name: '选题与假设' }],
    });
    await waitFor(() => expect(screen.queryByTestId('autonomous-preview')).toBeNull());
    expect(await screen.findByTestId('autonomous-workflow')).toBeTruthy();
  });

  it('queues goals and auto-starts the next one when continuous mode is on', async () => {
    const handlers = makeVizMetis();
    const { default: AutonomousResearchPage } = await import('../../src/pages/AutonomousResearchPage');
    const metis = window.metis as unknown as { autonomousStart: ReturnType<typeof vi.fn> };
    render(<AutonomousResearchPage />);

    // 目标 1 开始运行；目标 2 加入队列。
    fireEvent.change(screen.getByPlaceholderText(/描述研究目标/u), { target: { value: '目标一：制度演变' } });
    fireEvent.click(screen.getByTestId('autonomous-start'));
    await waitFor(() => expect(metis.autonomousStart).toHaveBeenCalledTimes(1));
    expect(metis.autonomousStart.mock.calls[0][0].goal).toBe('目标一：制度演变');

    fireEvent.change(screen.getByPlaceholderText(/描述研究目标/u), { target: { value: '目标二：档案补证' } });
    fireEvent.click(screen.getByTestId('autonomous-enqueue'));
    expect(await screen.findByTestId('autonomous-queue-count')).toBeTruthy();
    expect(screen.getByTestId('autonomous-queue-count').textContent).toBe('1');

    // 连续运行默认开启；目标一完成 → 自动开始目标二。
    handlers.completed?.({
      version: 1, sessionId: 'viz-1', sequence: 9, type: 'engine-completed',
      summary: '目标一完成。', artifactIds: ['a1'],
    });
    expect(await screen.findByTestId('autonomous-next-goal')).toBeTruthy();

    await waitFor(() => expect(metis.autonomousStart).toHaveBeenCalledTimes(2), { timeout: 4000 });
    expect(metis.autonomousStart.mock.calls[1][0].goal).toBe('目标二：档案补证');
    // 队列已消费。
    await waitFor(() => expect(screen.getByTestId('autonomous-queue-count').textContent).toBe('0'));
  });

  it('does not continue the chain when the run is interrupted', async () => {
    const handlers = makeVizMetis();
    const { default: AutonomousResearchPage } = await import('../../src/pages/AutonomousResearchPage');
    const metis = window.metis as unknown as { autonomousStart: ReturnType<typeof vi.fn> };
    render(<AutonomousResearchPage />);

    fireEvent.change(screen.getByPlaceholderText(/描述研究目标/u), { target: { value: '目标一' } });
    fireEvent.click(screen.getByTestId('autonomous-start'));
    await waitFor(() => expect(metis.autonomousStart).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByPlaceholderText(/描述研究目标/u), { target: { value: '目标二' } });
    fireEvent.click(screen.getByTestId('autonomous-enqueue'));

    handlers.completed?.({
      version: 1, sessionId: 'viz-1', sequence: 9, type: 'engine-completed',
      summary: '完成。', artifactIds: [],
    });
    // 在自动开始下一个之前，用户中断链式续跑。
    await screen.findByTestId('autonomous-next-goal');
    // 手动模拟用户点了中断（中断当前已无运行会话 —— 直接发中断事件等价语义）。
    handlers.failed?.({
      version: 1, sessionId: 'viz-2', sequence: 1, type: 'engine-failed',
      reason: '用户中断', completedPhases: 0, recoverable: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 2200));
    expect(metis.autonomousStart).toHaveBeenCalledTimes(1);
  });
});
