/**
 * TaskBoardPage: kanban board with goal cards, column filtering, drag-and-drop
 * status transitions, priority management, and detail panel.
 *
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor, act } from '@testing-library/react';
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
      listProjects: vi.fn().mockResolvedValue({
        success: true,
        projects: [{ id: 'proj-a', title: 'RAG 调研', updatedAt: 1, archivedAt: null }],
      }),
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

  it('refreshes the board when a goal:changed event arrives from the chat side', async () => {
    const listGoals = vi.fn()
      .mockResolvedValueOnce({ success: true, goals: [makeGoal({ goalId: 'g1', label: '文献综述任务', status: 'ready' })] })
      .mockResolvedValueOnce({ success: true, goals: [makeGoal({ goalId: 'g1', label: '文献综述任务', status: 'completed' })] });
    const changedHandler = vi.fn();
    window.metis = {
      listGoals,
      onGoalChanged: vi.fn((callback: (data: unknown) => void) => {
        changedHandler.mockImplementation(callback);
        return () => {};
      }),
    } as unknown as typeof window.metis;

    const { default: TaskBoardPage } = await import('../../src/pages/TaskBoardPage');
    const { container } = render(<TaskBoardPage />);
    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid="kanban-card"]')).toHaveLength(1);
    });

    // Simulate the main-process broadcast after a chat-side plan/execute change.
    await act(async () => {
      changedHandler({ goalId: 'g1', label: '文献综述任务', status: 'completed', createdAt: 1000 });
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="kanban-column-done"]')?.textContent).toContain('文献综述任务');
    });
    expect(listGoals).toHaveBeenCalledTimes(2);
  });

  it('dispatches metis:open-goal when the detail panel asks to discuss in chat', async () => {
    const { default: TaskBoardPage } = await import('../../src/pages/TaskBoardPage');
    const { container } = render(<TaskBoardPage />);
    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid="kanban-card"]')).toHaveLength(3);
    });

    const openGoal = vi.fn();
    window.addEventListener('metis:open-goal', openGoal);
    try {
      fireEvent.click(container.querySelectorAll('[data-testid="kanban-card"]')[0]!);
      const discuss = container.querySelector('[data-testid="kanban-discuss-in-chat"]') as HTMLButtonElement;
      expect(discuss).toBeTruthy();
      fireEvent.click(discuss);
    } finally {
      window.removeEventListener('metis:open-goal', openGoal);
    }
    expect(openGoal).toHaveBeenCalledTimes(1);
    const detail = (openGoal.mock.calls[0]![0] as CustomEvent<{ goalId: string }>).detail;
    expect(detail.goalId).toBe('g1');
    // The detail panel closes before the handoff.
    expect(container.querySelector('[data-testid="kanban-detail"]')).toBeNull();
  });

  it('selects and scrolls to a card handed off from a chat goal card', async () => {
    const { default: TaskBoardPage } = await import('../../src/pages/TaskBoardPage');
    const scrollSpy = vi.fn();
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollSpy;

    window.sessionStorage.setItem('metis-pending-goal-focus', 'g2');
    const { container } = render(<TaskBoardPage />);
    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid="kanban-card"]')).toHaveLength(3);
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="kanban-detail"]')).toBeTruthy();
    });
    expect(container.querySelector('[data-testid="kanban-detail"]')?.getAttribute('aria-label')).toBe('数据分析任务');
    expect(window.sessionStorage.getItem('metis-pending-goal-focus')).toBeNull();
    await waitFor(() => {
      expect(scrollSpy).toHaveBeenCalled();
    });
    Element.prototype.scrollIntoView = originalScrollIntoView;
  });
});

describe('TaskBoardPage project filter', () => {
  beforeEach(() => {
    window.metis = {
      listGoals: vi.fn().mockResolvedValue({
        success: true,
        goals: [
          { goalId: 'g1', label: '项目任务', status: 'ready', createdAt: 1, projectId: 'proj-a' },
          { goalId: 'g2', label: '全局任务', status: 'ready', createdAt: 2 },
        ],
      }),
      updateGoalStatus: vi.fn().mockResolvedValue({ ok: true }),
      createGoal: vi.fn().mockResolvedValue({ success: true, goalId: 'g-new' }),
      listProjects: vi.fn().mockResolvedValue({
        success: true,
        projects: [{ id: 'proj-a', title: 'RAG 调研', updatedAt: 1, archivedAt: null }],
      }),
    } as unknown as typeof window.metis;
  });

  it('filters tasks by project', async () => {
    const { default: TaskBoardPage } = await import('../../src/pages/TaskBoardPage');
    const { container } = render(<TaskBoardPage />);
    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid="kanban-card"]')).toHaveLength(2);
    });

    const filter = screen.getByTestId('kanban-project-filter') as HTMLSelectElement;
    fireEvent.change(filter, { target: { value: 'proj-a' } });
    await waitFor(() => {
      const cards = container.querySelectorAll('[data-testid="kanban-card"]');
      expect(cards).toHaveLength(1);
      expect(cards[0]!.textContent).toContain('项目任务');
    });

    fireEvent.change(filter, { target: { value: 'unbound' } });
    await waitFor(() => {
      const cards = container.querySelectorAll('[data-testid="kanban-card"]');
      expect(cards).toHaveLength(1);
      expect(cards[0]!.textContent).toContain('全局任务');
    });
  });

  it('binds new tasks to the selected project', async () => {
    const { default: TaskBoardPage } = await import('../../src/pages/TaskBoardPage');
    render(<TaskBoardPage />);
    await waitFor(() => expect(screen.getByTestId('kanban-project-filter')).toBeDefined());

    const filter = screen.getByTestId('kanban-project-filter') as HTMLSelectElement;
    fireEvent.change(filter, { target: { value: 'proj-a' } });

    fireEvent.click(screen.getByTestId('kanban-add-todo'));
    const input = screen.getByTestId('kanban-new-task-input-todo');
    fireEvent.change(input, { target: { value: '绑定项目的任务' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect((window.metis as unknown as { createGoal: ReturnType<typeof vi.fn> }).createGoal)
        .toHaveBeenCalledWith('绑定项目的任务', undefined, 'proj-a');
    });
  });
});
