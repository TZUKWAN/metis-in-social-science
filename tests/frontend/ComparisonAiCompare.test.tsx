/**
 * ComparisonMatrixPage AI comparison: selected papers → main-process one-shot
 * comparison analysis → inline result → optionally save as a note.
 *
 * @vitest-environment jsdom
 */

import { fireEvent, render, waitFor, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMetisStore, type PaperItem } from '../../src/store';
import { ComparisonMatrixPage } from '../../src/pages/ComparisonMatrixPage';

function makePaper(overrides: Partial<PaperItem> & { id: string; title: string }): PaperItem {
  return {
    authors: [],
    year: 2024,
    venue: '',
    abstract: '',
    tags: [],
    notes: '',
    readStatus: 'unread',
    rating: 0,
    starred: false,
    archived: false,
    referenceIds: [],
    addedAt: 0,
    ...overrides,
  };
}

function resetStore() {
  useMetisStore.setState({
    papers: [],
    paperFilter: { query: '' },
    notes: [],
    selectedNote: null,
    experiments: [],
    collections: [],
    selectedCollection: null,
    workflowRuns: [],
    weeklyReadingGoal: 5,
    locale: 'zh',
    theme: 'light',
    isHydrated: true,
    selectedPaperId: null,
  });
}

describe('ComparisonMatrixPage AI comparison', () => {
  beforeEach(() => {
    resetStore();
    window.metis = {
      aiSynthesis: vi.fn().mockResolvedValue({
        ok: true,
        text: '## 对比分析\n| 维度 | Alpha | Beta |',
      }),
      saveNote: vi.fn().mockResolvedValue(undefined),
    } as unknown as typeof window.metis;
  });

  it('runs the comparison and shows the inline analysis', async () => {
    useMetisStore.setState({
      papers: [
        makePaper({ id: 'p1', title: 'Paper Alpha', abstract: 'About alpha.' }),
        makePaper({ id: 'p2', title: 'Paper Beta', abstract: 'About beta.' }),
      ],
    });
    const { container } = render(<ComparisonMatrixPage onClose={() => {}} />);

    const btn = await waitFor(() => {
      const found = container.querySelector('[data-testid="comparison-ai-compare"]') as HTMLButtonElement | null;
      expect(found).toBeTruthy();
      return found!;
    });
    await act(async () => { fireEvent.click(btn); });

    await waitFor(() => {
      expect(window.metis?.aiSynthesis).toHaveBeenCalledWith(expect.objectContaining({
        mode: 'compare',
        papers: expect.arrayContaining([
          expect.objectContaining({ title: 'Paper Alpha' }),
          expect.objectContaining({ title: 'Paper Beta' }),
        ]),
      }));
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="comparison-ai-result"]')).toBeTruthy();
    });
    expect(container.textContent).toContain('对比分析');
  });

  it('saves the comparison as a note linked to the compared papers', async () => {
    const addNote = vi.fn().mockResolvedValue(undefined);
    useMetisStore.setState({
      addNote,
      papers: [
        makePaper({ id: 'p1', title: 'Paper Alpha' }),
        makePaper({ id: 'p2', title: 'Paper Beta' }),
      ],
    } as never);
    const { container } = render(<ComparisonMatrixPage onClose={() => {}} />);

    const btn = await waitFor(() => container.querySelector('[data-testid="comparison-ai-compare"]') as HTMLButtonElement);
    await act(async () => { fireEvent.click(btn); });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="comparison-ai-result"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="comparison-ai-save-note"]')!);
    });
    await waitFor(() => {
      expect(addNote).toHaveBeenCalledWith(expect.objectContaining({
        linkedPaperIds: ['p1', 'p2'],
        content: expect.stringContaining('对比分析'),
      }));
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="comparison-ai-result"]')).toBeNull();
    });
  });
});
