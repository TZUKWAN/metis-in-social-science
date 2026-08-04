/**
 * ArtifactsPage management console: project-scoped artifact list, filters,
 * review-status transitions, version history, and review timeline.
 *
 * @vitest-environment jsdom
 */

import { fireEvent, render, waitFor, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { researchWorkspaceStore } from '../../src/research/researchWorkspaceStore';

function makeArtifact(overrides: Record<string, unknown> & { id: string; title: string }) {
  return {
    projectId: 'project-1',
    artifactType: 'manuscript',
    reviewStatus: 'draft',
    version: 1,
    createdAt: 1000,
    updatedAt: 2000,
    citedSourceIds: [],
    reviewTrail: [],
    ...overrides,
  };
}

describe('ArtifactsPage management console', () => {
  beforeEach(() => {
    researchWorkspaceStore.setState({
      activeProjectId: 'project-1',
      projects: [{ id: 'project-1', name: 'Demo Project' }] as never,
    });
    window.metis = {
      artifactListByProject: vi.fn().mockResolvedValue({
        items: [
          makeArtifact({ id: 'a1', title: 'Literature Review Draft' }),
          makeArtifact({ id: 'a2', title: 'Results Chart', artifactType: 'chart', reviewStatus: 'verified', version: 3 }),
        ],
      }),
      artifactUpdateReviewStatus: vi.fn().mockResolvedValue({ ok: true }),
      artifactListVersions: vi.fn().mockResolvedValue({
        versions: [
          { version: 3, createdAt: 3000, createdBy: 'ai', contentPreview: 'latest content' },
          { version: 2, createdAt: 2000, createdBy: 'user', contentPreview: 'older content' },
        ],
      }),
      artifactRestoreVersion: vi.fn().mockResolvedValue({ ok: true, version: 4 }),
    } as unknown as typeof window.metis;
  });

  it('renders project artifact cards with status badges and stats', async () => {
    const { default: ArtifactsPage } = await import('../../src/pages/ArtifactsPage');
    const { container } = render(<ArtifactsPage />);

    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid="artifact-card"]')).toHaveLength(2);
    });
    expect(container.textContent).toContain('Literature Review Draft');
    expect(container.textContent).toContain('Results Chart');
    expect(container.textContent).toContain('草稿');
    expect(container.textContent).toContain('已验证');
    // Overview stats show the total and per-status counts.
    expect(container.querySelector('[data-testid="artifacts-stats"]')?.textContent).toContain('共 2 项');
  });

  it('filters artifacts by status', async () => {
    const { default: ArtifactsPage } = await import('../../src/pages/ArtifactsPage');
    const { container } = render(<ArtifactsPage />);

    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid="artifact-card"]')).toHaveLength(2);
    });
    const statusSelect = container.querySelector('[data-testid="artifacts-filter-status"]') as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(statusSelect, { target: { value: 'verified' } });
    });
    expect(container.querySelectorAll('[data-testid="artifact-card"]')).toHaveLength(1);
    expect(container.textContent).toContain('Results Chart');
    expect(container.textContent).not.toContain('Literature Review Draft');
  });

  it('submits a draft for review and reloads', async () => {
    const { default: ArtifactsPage } = await import('../../src/pages/ArtifactsPage');
    const { container } = render(<ArtifactsPage />);

    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid="artifact-card"]')).toHaveLength(2);
    });
    // Select the draft artifact.
    await act(async () => {
      fireEvent.click(container.querySelectorAll('[data-testid="artifact-card"]')[0]!);
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="artifact-action-submitReview"]')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="artifact-action-submitReview"]')!);
    });
    expect(window.metis?.artifactUpdateReviewStatus).toHaveBeenCalledWith(expect.objectContaining({
      artifactId: 'a1',
      toStatus: 'pending',
    }));
    // List reloads after a successful transition.
    await waitFor(() => {
      expect(window.metis?.artifactListByProject).toHaveBeenCalledTimes(2);
    });
  });

  it('shows version history and restores an older version', async () => {
    const { default: ArtifactsPage } = await import('../../src/pages/ArtifactsPage');
    const { container } = render(<ArtifactsPage />);

    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid="artifact-card"]')).toHaveLength(2);
    });
    // Select the verified artifact (version 3).
    await act(async () => {
      fireEvent.click(container.querySelectorAll('[data-testid="artifact-card"]')[1]!);
    });
    await waitFor(() => {
      expect(container.textContent).toContain('older content');
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="artifact-restore-v2"]')!);
    });
    expect(window.metis?.artifactRestoreVersion).toHaveBeenCalledWith({ artifactId: 'a2', version: 2 });
  });

  it('shows the review timeline for an artifact with trail entries', async () => {
    (window.metis as unknown as { artifactListByProject: unknown }).artifactListByProject =
      vi.fn().mockResolvedValue({
        items: [makeArtifact({
          id: 'a1',
          title: 'Reviewed Report',
          reviewStatus: 'pending',
          reviewTrail: [{ at: 5000, from: 'draft', to: 'pending', reason: 'manual' }],
        })],
      });
    const { default: ArtifactsPage } = await import('../../src/pages/ArtifactsPage');
    const { container } = render(<ArtifactsPage />);

    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid="artifact-card"]')).toHaveLength(1);
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="artifact-card"]')!);
    });
    await waitFor(() => {
      expect(container.textContent).toContain('草稿 → 待审核');
    });
  });
});
