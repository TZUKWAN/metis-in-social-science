/**
 * TaskBoardPage: kanban board with goal cards, column filtering, drag-and-drop
 * status transitions, priority management, and detail panel.
 *
 * @vitest-environment jsdom
 */

import { fireEvent, render, waitFor, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

function makeGoal(overrides: Record<string, unknown> & { goalId: string; label: string }) {
  return {
    status: 'ready',
    createdAt: 1000,
    ...overrides,
  };
}

describe('TaskBoardPage', () => {
  beforeEach(() => {
    window.metis = {
      listGoals: vi.fn().mockResolvedValue({
        success: true,
        goals: [
          makeGoal({ goalId: 'g1', label: '文献综述任务', status: 'ready' }),
          makeGoal({ goalId: 'g2', label: '数据分析任务', status: 'running' }),
          makeGoal({ goalId: 'g3', label: '已完成任务', status: 'completed' }),
        ],
      }),
      updateGoalStatus: vi.fn().mockResolvedValue({ ok: true }),
      updateGoalPriority: vi.fn().mockResolvedValue({ ok: true }),
      deleteGoal: vi.fn().mockResolvedValue({ ok: true }),
      createGoal: vi.fn().mockResolvedValue({ success: true, goalId: 'g-new' }),
    } as unknown as typeof window.metis;
  });

  it('renders goals in the correct kanban columns', async () => {
    const { default: TaskBoardPage } = await import('../../src/pages/TaskBoardPage');
    const { container } = render(<TaskBoardPage />);

    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid="kanban-card"]')).toHaveLength(3);
    });
    // ready → todo column, running → inprogress, completed → done
    expect(container.querySelector('[data-testid="kanban-column-todo"]')?.textContent).toContain('文献综述任务');
    expect(container.querySelector('[data-testid="kanban-column-inprogress"]')?.textContent).toContain('数据分析任务');
    expect(container.querySelector('[data-testid="kanban-column-done"]')?.textContent).toContain('已完成任务');
  });

  it('moves a goal to a new column on drop (status transition)', async () => {
    const { default: TaskBoardPage } = await import('../../src/pages/TaskBoardPage');
    const { container } = render(<TaskBoardPage />);

    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid="kanban-card"]')).toHaveLength(3);
    });

    // Simulate drag from todo to inprogress.
    const card = container.querySelectorAll('[data-testid="kanban-card"]')[0]!;
    fireEvent.dragStart(card, { dataTransfer: { effectAllowed: 'move' } });
    const inprogressCol = container.querySelector('[data-testid="kanban-column-inprogress"]')!;
    fireEvent.dragOver(inprogressCol, { preventDefault: () => {}, dataTransfer: { dropEffect: 'move' } });
    await act(async () => {
      fireEvent.drop(inprogressCol, { preventDefault: () => {}, dataTransfer: { dropEffect: 'move' } });
    });

    expect(window.metis?.updateGoalStatus).toHaveBeenCalledWith({ goalId: 'g1', status: 'running' });
  });

  it('shows the detail panel on card click', async () => {
    const { default: TaskBoardPage } = await import('../../src/pages/TaskBoardPage');
    const { container } = render(<TaskBoardPage />);

    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid="kanban-card"]')).toHaveLength(3);
    });
    fireEvent.click(container.querySelectorAll('[data-testid="kanban-card"]')[0]!);
    expect(container.querySelector('[data-testid="kanban-detail"]')).toBeTruthy();
    expect(container.textContent).toContain('文献综述任务');
  });

  it('filters goals by search text', async () => {
    const { default: TaskBoardPage } = await import('../../src/pages/TaskBoardPage');
    const { container } = render(<TaskBoardPage />);

    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid="kanban-card"]')).toHaveLength(3);
    });
    const search = container.querySelector('input[placeholder*="搜索任务"]') as HTMLInputElement;
    fireEvent.change(search, { target: { value: '数据分析' } });
    expect(container.querySelectorAll('[data-testid="kanban-card"]')).toHaveLength(1);
    expect(container.textContent).toContain('数据分析任务');
  });
});
