/**
 * PapersPage AI literature synthesis: multi-select papers → generate review
 * draft (main-process one-shot call) → save as a literature note.
 *
 * @vitest-environment jsdom
 */

import { fireEvent, render, waitFor, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMetisStore, type PaperItem } from '../../src/store';

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

describe('PapersPage AI literature synthesis', () => {
  beforeEach(() => {
    resetStore();
    window.metis = {
      aiSynthesis: vi.fn().mockResolvedValue({
        ok: true,
        text: '## 综述\n近年来两篇工作分别研究了 A 与 B…',
      }),
      saveNote: vi.fn().mockResolvedValue(undefined),
    } as unknown as typeof window.metis;
  });

  it('shows the button only when at least two papers are selected', async () => {
    useMetisStore.setState({
      papers: [
        makePaper({ id: 'p1', title: 'Paper Alpha' }),
        makePaper({ id: 'p2', title: 'Paper Beta' }),
      ],
    });
    const { default: PapersPage } = await import('../../src/pages/PapersPage');
    const { container } = render(<PapersPage />);

    // Nothing selected yet.
    expect(container.querySelector('[data-testid="paper-generate-synthesis"]')).toBeNull();

    // Select one — still hidden.
    const checkboxes = container.querySelectorAll('[data-testid="paper-checkbox"]');
    await act(async () => { fireEvent.click(checkboxes[0]!); });
    expect(container.querySelector('[data-testid="paper-generate-synthesis"]')).toBeNull();

    // Select two — button appears.
    await act(async () => { fireEvent.click(checkboxes[1]!); });
    expect(container.querySelector('[data-testid="paper-generate-synthesis"]')).toBeTruthy();
  });

  it('calls the main process with the selected papers and shows the review', async () => {
    useMetisStore.setState({
      papers: [
        makePaper({ id: 'p1', title: 'Paper Alpha', abstract: 'About alpha.' }),
        makePaper({ id: 'p2', title: 'Paper Beta', abstract: 'About beta.' }),
      ],
    });
    const { default: PapersPage } = await import('../../src/pages/PapersPage');
    const { container } = render(<PapersPage />);

    const checkboxes = container.querySelectorAll('[data-testid="paper-checkbox"]');
    await act(async () => { fireEvent.click(checkboxes[0]!); fireEvent.click(checkboxes[1]!); });
    const genBtn = container.querySelector('[data-testid="paper-generate-synthesis"]') as HTMLButtonElement;
    await act(async () => { fireEvent.click(genBtn); });

    await waitFor(() => {
      expect(window.metis?.aiSynthesis).toHaveBeenCalledWith(expect.objectContaining({
        mode: 'synthesis',
        papers: expect.arrayContaining([
          expect.objectContaining({ title: 'Paper Alpha', abstract: 'About alpha.' }),
          expect.objectContaining({ title: 'Paper Beta', abstract: 'About beta.' }),
        ]),
      }));
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="synthesis-modal"]')).toBeTruthy();
    });
    expect(container.querySelector('.modal')?.textContent).toContain('文献综述');
  });

  it('saves the review as a literature note linked to both papers', async () => {
    const addNote = vi.fn().mockResolvedValue(undefined);
    useMetisStore.setState({
      addNote,
      papers: [
        makePaper({ id: 'p1', title: 'Paper Alpha' }),
        makePaper({ id: 'p2', title: 'Paper Beta' }),
      ],
    } as never);
    const { default: PapersPage } = await import('../../src/pages/PapersPage');
    const { container } = render(<PapersPage />);

    const checkboxes = container.querySelectorAll('[data-testid="paper-checkbox"]');
    await act(async () => { fireEvent.click(checkboxes[0]!); fireEvent.click(checkboxes[1]!); });
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="paper-generate-synthesis"]')!);
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="synthesis-modal"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="synthesis-save-note"]')!);
    });
    await waitFor(() => {
      expect(addNote).toHaveBeenCalledWith(expect.objectContaining({
        linkedPaperIds: ['p1', 'p2'],
        content: expect.stringContaining('综述'),
      }));
    });
    // Modal closes after saving.
    await waitFor(() => {
      expect(container.querySelector('[data-testid="synthesis-modal"]')).toBeNull();
    });
  });
});
