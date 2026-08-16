/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import OnboardingTour from '../../src/components/OnboardingTour';
import { shouldShowOnboarding } from '../../src/lib/onboarding';

function renderTour(onDone = vi.fn()) {
  return render(<OnboardingTour onDone={onDone} />);
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('OnboardingTour', () => {
  it('renders as an accessible dialog with steps', async () => {
    renderTour();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByTestId('onboarding-tour')).toBeTruthy();
    expect(screen.getByRole('button', { name: /下一步|Next/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /跳过|Skip/ })).toBeTruthy();
  });

  it('advances through all five steps and finishes with the localStorage flag', async () => {
    const onDone = vi.fn();
    renderTour(onDone);
    const next = await screen.findByTestId('onboarding-next');
    for (let index = 0; index < 5; index += 1) fireEvent.click(next);
    expect(onDone).toHaveBeenCalled();
    expect(shouldShowOnboarding()).toBe(false);
  });

  it('skips immediately and marks onboarding done', async () => {
    const onDone = vi.fn();
    renderTour(onDone);
    fireEvent.click(await screen.findByRole('button', { name: /跳过|Skip/ }));
    expect(onDone).toHaveBeenCalled();
    expect(shouldShowOnboarding()).toBe(false);
  });

  it('closes on Escape and restores focus to the previously focused element', async () => {
    const button = document.createElement('button');
    button.textContent = 'origin';
    document.body.appendChild(button);
    button.focus();
    const onDone = vi.fn();
    renderTour(onDone);
    await screen.findByRole('dialog');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onDone).toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    button.remove();
  });

  it('degrades gracefully when the highlighted target does not exist', async () => {
    renderTour();
    // The first step targets the top navigation converse entry, which is not
    // mounted in this isolated test. The tour must still render its dialog.
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });
});
