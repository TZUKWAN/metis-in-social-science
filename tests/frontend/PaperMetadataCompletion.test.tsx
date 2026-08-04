/**
 * PapersPage metadata completion: an existing paper with a DOI/arXiv ID can
 * fetch missing fields (never overwriting manual edits) from the resolver.
 *
 * @vitest-environment jsdom
 */

import { fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMetisStore, type PaperItem } from '../../src/store';

const resolveDoiMock = vi.fn();
const resolveArxivMock = vi.fn();

vi.mock('@engine/research/DoiResolver.js', () => ({
  resolveDoi: (...args: unknown[]) => resolveDoiMock(...args),
}));
vi.mock('@engine/research/ArxivResolver.js', () => ({
  resolveArxiv: (...args: unknown[]) => resolveArxivMock(...args),
}));

function makePaper(overrides?: Partial<PaperItem>): PaperItem {
  return {
    id: 'paper-1',
    title: 'Untitled local paper',
    authors: [],
    year: 0,
    venue: '',
    abstract: '',
    doi: '10.1234/fixture',
    arxivId: undefined,
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

describe('PapersPage metadata completion', () => {
  beforeEach(() => {
    resetStore();
    resolveDoiMock.mockReset();
    resolveArxivMock.mockReset();
  });

  it('fills only the empty fields and refreshes the citation count', async () => {
    const paper = makePaper({ citationCount: 5 });
    useMetisStore.setState({ papers: [paper], selectedPaperId: paper.id });
    resolveDoiMock.mockResolvedValue({
      doi: '10.1234/fixture',
      title: 'Resolved Online Title',
      authors: ['Alice Author', 'Bob Writer'],
      year: 2023,
      venue: 'JMLR',
      abstract: 'Resolved abstract text.',
      pdfUrl: 'https://example.org/paper.pdf',
      citationCount: 42,
    });

    const { default: PapersPage } = await import('../../src/pages/PapersPage');
    const { container } = render(<PapersPage />);

    const button = await waitFor(() => {
      const btn = container.querySelector('[data-testid="paper-complete-metadata"]') as HTMLButtonElement | null;
      expect(btn).toBeTruthy();
      return btn!;
    });
    fireEvent.click(button);

    await waitFor(() => {
      const updated = useMetisStore.getState().papers.find((p) => p.id === paper.id);
      expect(updated?.authors).toEqual(['Alice Author', 'Bob Writer']);
    });
    const updated = useMetisStore.getState().papers.find((p) => p.id === paper.id)!;
    // Empty fields get filled.
    expect(updated.year).toBe(2023);
    expect(updated.venue).toBe('JMLR');
    expect(updated.abstract).toBe('Resolved abstract text.');
    expect(updated.pdfUrl).toBe('https://example.org/paper.pdf');
    // Citation count refreshes even though it was already set.
    expect(updated.citationCount).toBe(42);
    // The manually edited title is NOT overwritten.
    expect(updated.title).toBe('Untitled local paper');
    // Success notice is shown.
    expect(container.textContent).toContain('已通过 DOI/arXiv 补全元数据');
  });

  it('hides the button when the paper has no DOI or arXiv ID', async () => {
    const paper = makePaper({ doi: undefined, arxivId: undefined });
    useMetisStore.setState({ papers: [paper], selectedPaperId: paper.id });

    const { default: PapersPage } = await import('../../src/pages/PapersPage');
    const { container } = render(<PapersPage />);

    await waitFor(() => {
      expect(container.querySelector('[data-testid="pin-detail-star-button"]')).toBeTruthy();
    });
    expect(container.querySelector('[data-testid="paper-complete-metadata"]')).toBeNull();
  });

  it('shows an error when the resolver finds nothing', async () => {
    const paper = makePaper();
    useMetisStore.setState({ papers: [paper], selectedPaperId: paper.id });
    resolveDoiMock.mockResolvedValue(null);

    const { default: PapersPage } = await import('../../src/pages/PapersPage');
    const { container } = render(<PapersPage />);
    const button = container.querySelector('[data-testid="paper-complete-metadata"]') as HTMLButtonElement;
    fireEvent.click(button);

    await waitFor(() => {
      expect(container.textContent).toContain('未找到该 DOI/arXiv 对应的元数据');
    });
    // Nothing changed.
    const unchanged = useMetisStore.getState().papers.find((p) => p.id === paper.id)!;
    expect(unchanged.title).toBe('Untitled local paper');
    expect(unchanged.citationCount).toBeUndefined();
  });
});
