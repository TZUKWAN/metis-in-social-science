/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getPaperRecommendationsMock = vi.fn();

vi.mock('@engine/research/SemanticScholarClient.js', () => ({
  getPaperRecommendations: getPaperRecommendationsMock,
  recommendationToPlain: (edge: unknown) => {
    const e = edge as { citedPaper?: { externalIds?: { DOI?: string; ArXiv?: string } } };
    const ext = e?.citedPaper?.externalIds ?? {};
    return { doi: ext.DOI, arxivId: ext.ArXiv };
  },
}));

// reactflow relies on DOM measurement APIs that jsdom does not implement.
vi.mock('reactflow', () => ({
  ReactFlow: ({ nodes, edges }: { nodes: unknown[]; edges: unknown[] }) => (
    <div data-testid="reactflow" data-nodes={nodes.length} data-edges={edges.length} />
  ),
  Background: () => null,
  Controls: () => null,
  MiniMap: () => null,
  useNodesState: (initial: unknown[]) => [initial, () => {}, () => {}],
  useEdgesState: (initial: unknown[]) => [initial, () => {}, () => {}],
}));

import { createElement } from 'react';

describe('KnowledgeGraphPage real citation loading', () => {
  beforeEach(() => {
    getPaperRecommendationsMock.mockReset();
    localStorage.clear();
  });

  it('renders the load-citations toolbar button', async () => {
    const { useMetisStore } = await import('../../src/store');
    useMetisStore.setState({
      papers: [{ id: 'p1', title: 'Paper One', authors: [], year: 2024, venue: '', abstract: '', tags: [], notes: '', readStatus: 'unread', rating: 0, referenceIds: [], addedAt: 1, doi: '10.1/p1' }],
    } as never);

    const { default: KnowledgeGraphPage } = await import('../../src/pages/KnowledgeGraphPage');
    const { getByText } = render(createElement(KnowledgeGraphPage));
    // The button label is localized; match the English default.
    expect(getByText(/Load real citations|加载真实引用/)).toBeTruthy();
  });

  it('persists discovered in-library references through addPaperReference', async () => {
    const addPaperReferenceSpy = vi.fn(async () => {});
    const { useMetisStore } = await import('../../src/store');
    useMetisStore.setState({
      papers: [
        { id: 'p1', title: 'Paper One', authors: [], year: 2024, venue: '', abstract: '', tags: [], notes: '', readStatus: 'unread', rating: 0, referenceIds: [], addedAt: 1, doi: '10.1/p1' },
        { id: 'p2', title: 'Paper Two', authors: [], year: 2023, venue: '', abstract: '', tags: [], notes: '', readStatus: 'unread', rating: 0, referenceIds: [], addedAt: 1, doi: '10.1/p2' },
      ],
      addPaperReference: addPaperReferenceSpy,
    } as never);

    // Semantic Scholar reports that p1 cites p2 (matched by DOI).
    getPaperRecommendationsMock.mockResolvedValue({
      offset: 0,
      data: [{ citedPaper: { externalIds: { DOI: '10.1/p2' } } }],
    });

    const { default: KnowledgeGraphPage } = await import('../../src/pages/KnowledgeGraphPage');
    const { getByText } = render(createElement(KnowledgeGraphPage));
    const btn = getByText(/Load real citations|加载真实引用/);
    await fireEvent.click(btn);

    await waitFor(() => expect(addPaperReferenceSpy).toHaveBeenCalledTimes(1));
    // addPaperReference(source, target) = source cites target.
    expect(addPaperReferenceSpy).toHaveBeenCalledWith('p1', 'p2');
  });

  it('skips papers without a DOI or arXiv id', async () => {
    const addPaperReferenceSpy = vi.fn(async () => {});
    const { useMetisStore } = await import('../../src/store');
    useMetisStore.setState({
      papers: [{ id: 'p1', title: 'No identifiers', authors: [], year: 2024, venue: '', abstract: '', tags: [], notes: '', readStatus: 'unread', rating: 0, referenceIds: [], addedAt: 1 }],
      addPaperReference: addPaperReferenceSpy,
    } as never);

    const { default: KnowledgeGraphPage } = await import('../../src/pages/KnowledgeGraphPage');
    const { getByText } = render(createElement(KnowledgeGraphPage));
    await fireEvent.click(getByText(/Load real citations|加载真实引用/));
    await waitFor(() => expect(getPaperRecommendationsMock).not.toHaveBeenCalled());
    expect(addPaperReferenceSpy).not.toHaveBeenCalled();
  });
});
