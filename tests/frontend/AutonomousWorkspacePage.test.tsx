/**
 * AutonomousWorkspacePage — 顶部启动条控件与连续模式行为测试（重构 R3 补充）。
 *
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { researchWorkspaceStore } from '../../src/research/researchWorkspaceStore';

function makeMetis(overrides: Record<string, unknown> = {}) {
  const handlers: Record<string, (data: unknown) => void> = {};
  const metis = {
    getAutoWorkspaceOverview: vi.fn().mockResolvedValue({ projects: [], metrics: { running: 0, decisions24h: 0, evidenceToday: 0, newFindings7d: 0 } }),
    getAutoWorkspaceDetail: vi.fn().mockResolvedValue(null),
    generateAutonomousBatch: vi.fn().mockResolvedValue({ ok: true, added: 1, topics: [] }),
    onAutonomousStep: vi.fn().mockReturnValue(() => {}),
    onAutonomousReflection: vi.fn().mockReturnValue(() => {}),
    onAutonomousProgress: vi.fn().mockReturnValue(() => {}),
    onAutonomousCompleted: vi.fn((cb: (d: unknown) => void) => { handlers.completed = cb; return () => {}; }),
    onAutonomousFailed: vi.fn().mockReturnValue(() => {}),
    getAgendaState: vi.fn().mockResolvedValue({ queue: [{ key: 'k1', title: 't1', autonomous: true, goalPrompt: '目标A', projectId: null }] }),
    decideAgendaNext: vi.fn().mockResolvedValue({ action: 'run_next', projectId: null, waitMs: 0, note: 'advance' }),
    autonomousStart: vi.fn().mockResolvedValue({ ok: true, sessionId: 'auto-2', projectId: 'p-2' }),
    ...overrides,
  };
  return { metis: metis as unknown as typeof window.metis, handlers };
}

describe('AutonomousWorkspacePage top launcher', () => {
  beforeEach(() => {
    researchWorkspaceStore.setState({ activeProjectId: null });
  });

  it('方法/输出/数量随批量启动一并提交', async () => {
    const { metis } = makeMetis();
    window.metis = metis;
    const { default: AutonomousWorkspacePage } = await import('../../src/components/autonomous/AutonomousWorkspacePage');
    render(<AutonomousWorkspacePage onOpenConsole={() => {}} />);

    const input = screen.getByTestId('aw-start-input');
    fireEvent.change(input, { target: { value: '组织控制与 AI 采纳' } });
    fireEvent.change(screen.getByTestId('aw-start-method'), { target: { value: 'qualitative' } });
    fireEvent.change(screen.getByTestId('aw-start-output'), { target: { value: 'report' } });
    fireEvent.change(screen.getByTestId('aw-start-count'), { target: { value: '2' } });
    fireEvent.click(screen.getByTestId('aw-start-button'));

    await waitFor(() => expect(metis.generateAutonomousBatch).toHaveBeenCalledTimes(1));
    expect(metis.generateAutonomousBatch).toHaveBeenCalledWith({
      prompt: '组织控制与 AI 采纳',
      count: 2,
      method: 'qualitative',
      output: 'report',
    });
  });

  it('连续模式：完成后自动推进议程下一个自主选题', async () => {
    const { metis, handlers } = makeMetis();
    window.metis = metis;
    const { default: AutonomousWorkspacePage } = await import('../../src/components/autonomous/AutonomousWorkspacePage');
    render(<AutonomousWorkspacePage onOpenConsole={() => {}} />);

    fireEvent.change(screen.getByTestId('aw-start-mode'), { target: { value: 'continuous' } });
    const input = screen.getByTestId('aw-start-input');
    fireEvent.change(input, { target: { value: '跑完全批' } });
    fireEvent.click(screen.getByTestId('aw-start-button'));
    await waitFor(() => expect(metis.generateAutonomousBatch).toHaveBeenCalledTimes(1));

    // 引擎完成 → 工作区自动拉取议程头并启动下一个选题。
    handlers.completed?.({ version: 1, sessionId: 'auto-1', sequence: 51, type: 'engine-completed', summary: 'done', artifactIds: [] });
    await waitFor(() => expect(metis.getAgendaState).toHaveBeenCalled());
    await waitFor(() => expect(metis.autonomousStart).toHaveBeenCalledWith({ goal: '目标A', projectId: undefined }));
  });

  it('单次模式：完成后不自动推进', async () => {
    const { metis, handlers } = makeMetis();
    window.metis = metis;
    const { default: AutonomousWorkspacePage } = await import('../../src/components/autonomous/AutonomousWorkspacePage');
    render(<AutonomousWorkspacePage onOpenConsole={() => {}} />);

    handlers.completed?.({ version: 1, sessionId: 'auto-1', sequence: 51, type: 'engine-completed', summary: 'done', artifactIds: [] });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(metis.getAgendaState).not.toHaveBeenCalled();
    expect(metis.autonomousStart).not.toHaveBeenCalled();
  });
});
