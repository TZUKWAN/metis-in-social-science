/**
 * @vitest-environment jsdom
 */

import { render, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('ArtifactsPage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('loads and groups artifacts by session', async () => {
    (window as unknown as { metis: unknown }).metis = {
      listArtifacts: vi.fn(async () => ({
        success: true,
        items: [
          { id: 'a1', sessionId: 'sess-1', name: 'report.md', type: 'markdown', createdAt: 1000 },
          { id: 'a2', sessionId: 'sess-1', name: 'data.csv', type: 'csv', createdAt: 2000 },
          { id: 'a3', sessionId: 'sess-2', name: 'chart.png', type: 'image', createdAt: 3000 },
        ],
      })),
      getArtifactContent: vi.fn(async () => ({ success: true, id: 'a1', name: 'report.md', type: 'markdown', content: '# Report', createdAt: 1000 })),
    };
    const { default: ArtifactsPage } = await import('../../src/pages/ArtifactsPage');
    const { container, getByText } = render(<ArtifactsPage />);
    await waitFor(() => {
      expect(getByText('report.md')).toBeTruthy();
      expect(getByText('chart.png')).toBeTruthy();
    });
    const sessions = container.querySelectorAll('.artifacts-session');
    expect(sessions.length).toBe(2);
  });

  it('loads content preview on artifact click', async () => {
    (window as unknown as { metis: unknown }).metis = {
      listArtifacts: vi.fn(async () => ({
        success: true,
        items: [{ id: 'a1', sessionId: 'sess-1', name: 'report.md', type: 'markdown', createdAt: 1000 }],
      })),
      getArtifactContent: vi.fn(async () => ({ success: true, id: 'a1', name: 'report.md', type: 'markdown', content: '# Report Title', createdAt: 1000 })),
    };
    const { default: ArtifactsPage } = await import('../../src/pages/ArtifactsPage');
    const { container, getByText, findByText } = render(<ArtifactsPage />);
    await findByText('report.md');
    fireEvent.click(getByText('report.md'));
    // SafeMarkdown renders markdown to HTML; # becomes an h1, not a text node.
    await waitFor(() => {
      const h1 = container.querySelector('h1');
      expect(h1?.textContent).toContain('Report Title');
    });
  });

  it('shows empty state when no artifacts', async () => {
    (window as unknown as { metis: unknown }).metis = {
      listArtifacts: vi.fn(async () => ({ success: true, items: [] })),
    };
    const { default: ArtifactsPage } = await import('../../src/pages/ArtifactsPage');
    const { getByText } = render(<ArtifactsPage />);
    await waitFor(() => {
      // Empty state shows localized text (key resolves to translated string).
      expect(getByText(/No artifacts yet|暂无产物/i)).toBeTruthy();
    });
  });
});
