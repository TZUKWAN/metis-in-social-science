/**
 * @vitest-environment jsdom
 */

import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

describe('ComparisonMatrixPage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  async function seedPapers() {
    const { useMetisStore } = await import('../../src/store');
    useMetisStore.setState({
      papers: [
        { id: 'p1', title: 'BERT pretraining', authors: [], year: 2019, venue: 'NAACL', abstract: 'We fine-tune bert on squad and achieve f1 93.2 on the imagenet subset.', tags: [], notes: '', readStatus: 'unread', rating: 0, referenceIds: [], addedAt: 1 },
        { id: 'p2', title: 'GPT generation', authors: [], year: 2020, venue: 'NeurIPS', abstract: 'A transformer llm reaching accuracy 88.1 on mmlu with perplexity 12.', tags: [], notes: '', readStatus: 'unread', rating: 0, referenceIds: [], addedAt: 1 },
      ],
    } as never);
  }

  it('renders the comparison table for the selected papers', async () => {
    await seedPapers();
    const { ComparisonMatrixPage } = await import('../../src/pages/ComparisonMatrixPage');
    const { container, getByText } = render(<ComparisonMatrixPage onClose={() => {}} />);
    // Both papers are selected by default (first 5); table header appears.
    expect(getByText('Year')).toBeTruthy();
    expect(getByText('Method')).toBeTruthy();
    const rows = container.querySelectorAll('tbody tr');
    expect(rows.length).toBe(2);
  });

  it('toggles a paper off and rebuilds the matrix', async () => {
    await seedPapers();
    const { ComparisonMatrixPage } = await import('../../src/pages/ComparisonMatrixPage');
    const { container } = render(<ComparisonMatrixPage onClose={() => {}} />);
    // Click the BERT chip inside the selector (not the table cell).
    const selector = container.querySelector('.comparison-selector');
    const bertChip = Array.from(selector!.querySelectorAll('button')).find((b) => /BERT pretraining/.test(b.textContent ?? ''))!;
    fireEvent.click(bertChip);
    const rows = container.querySelectorAll('tbody tr');
    expect(rows.length).toBe(1);
  });

  it('switches to the markdown view', async () => {
    await seedPapers();
    const { ComparisonMatrixPage } = await import('../../src/pages/ComparisonMatrixPage');
    const { container, getByText } = render(<ComparisonMatrixPage onClose={() => {}} />);
    fireEvent.click(getByText(/Markdown/));
    // The markdown view renders the generated table somewhere in the DOM.
    const markdownPane = container.querySelector('.comparison-markdown');
    expect(markdownPane).toBeTruthy();
    expect(markdownPane!.textContent).toContain('Method');
  });

  it('shows the empty state when no paper is selected', async () => {
    await seedPapers();
    const { ComparisonMatrixPage } = await import('../../src/pages/ComparisonMatrixPage');
    const { getByText } = render(<ComparisonMatrixPage onClose={() => {}} />);
    fireEvent.click(getByText(/Clear|清空/));
    expect(getByText(/Select at least one paper|请至少选择/)).toBeTruthy();
  });
});
