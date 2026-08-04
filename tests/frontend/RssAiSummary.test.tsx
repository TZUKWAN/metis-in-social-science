/**
 * PapersPage RSS AI summaries: fetch a feed, then generate one-line AI
 * summaries per entry via the main-process one-shot channel.
 *
 * @vitest-environment jsdom
 */

import { fireEvent, render, waitFor, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMetisStore } from '../../src/store';

const fetchRssFeedMock = vi.fn();

vi.mock('@engine/research/RssFeedResolver.js', () => ({
  fetchRssFeed: (...args: unknown[]) => fetchRssFeedMock(...args),
}));

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

describe('PapersPage RSS AI summaries', () => {
  beforeEach(() => {
    resetStore();
    fetchRssFeedMock.mockReset();
    localStorage.clear();
    fetchRssFeedMock.mockResolvedValue({
      entries: [
        { id: 'e1', title: 'New arXiv Paper', authors: ['Alice'], publishedAt: '2026-08-01', summary: 'Abstract of the new paper.' },
        { id: 'e2', title: 'Another Paper', authors: ['Bob'], publishedAt: '2026-08-01', summary: 'Second abstract.' },
      ],
    });
    window.metis = {
      aiExplainPaper: vi.fn().mockResolvedValue({ ok: true, text: '一句话中文摘要' }),
    } as unknown as typeof window.metis;
  });

  it('generates one-line AI summaries for feed entries', async () => {
    localStorage.setItem('metis-rss-feeds', JSON.stringify(['https://arxiv.org/rss/cs.CL']));
    // Fresh refresh timestamp so the auto-refresh effect stays out of the way.
    localStorage.setItem('metis-rss-last-refresh', String(Date.now()));

    const { default: PapersPage } = await import('../../src/pages/PapersPage');
    const { container } = render(<PapersPage />);

    // Open the RSS panel and click the feed to load entries.
    const manageBtn = container.querySelector('[data-testid="rss-manage"]') as HTMLButtonElement | null;
    expect(manageBtn).toBeTruthy();
    await act(async () => { fireEvent.click(manageBtn!); });

    const feedBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('arxiv.org/rss'));
    expect(feedBtn).toBeTruthy();
    await act(async () => { fireEvent.click(feedBtn!); });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="rss-ai-summarize"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="rss-ai-summarize"]')!);
    });

    await waitFor(() => {
      expect(window.metis?.aiExplainPaper).toHaveBeenCalledWith(expect.objectContaining({
        action: 'summarize',
        passage: expect.stringContaining('New arXiv Paper'),
      }));
    });
    await waitFor(() => {
      expect(container.textContent).toContain('一句话中文摘要');
    });
  });

  it('auto-refreshes the first feed when the panel opens after 6 hours', async () => {
    localStorage.setItem('metis-rss-feeds', JSON.stringify(['https://arxiv.org/rss/cs.CL']));
    // Stale timestamp → auto refresh should fire on panel open.
    localStorage.setItem('metis-rss-last-refresh', String(Date.now() - 7 * 3600 * 1000));

    const { default: PapersPage } = await import('../../src/pages/PapersPage');
    const { container } = render(<PapersPage />);

    const manageBtn = container.querySelector('[data-testid="rss-manage"]') as HTMLButtonElement | null;
    await act(async () => { fireEvent.click(manageBtn!); });

    await waitFor(() => {
      expect(fetchRssFeedMock).toHaveBeenCalledWith('https://arxiv.org/rss/cs.CL');
    });
  });
});
