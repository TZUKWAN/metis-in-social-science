// @vitest-environment jsdom
/**
 * METIS-OPT-3 — FirstRunWizard "configure later" exit (onSkip).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import FirstRunWizard from '../../src/components/FirstRunWizard';

const CLIENT = {
  probe: vi.fn(async () => ({ ok: true })),
  save: vi.fn(async () => ({ ok: true })),
  abort: vi.fn(async () => ({ ok: true })),
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('FirstRunWizard onSkip (configure later)', () => {
  it('shows a skip button when onSkip is provided', () => {
    render(<FirstRunWizard client={CLIENT} onComplete={() => undefined} onSkip={() => undefined} />);
    expect(screen.getByTestId('first-run-skip')).toBeDefined();
    expect(screen.getByText(/稍后配置|Configure later/i)).toBeDefined();
  });

  it('hides the skip button when onSkip is not provided', () => {
    render(<FirstRunWizard client={CLIENT} onComplete={() => undefined} />);
    expect(screen.queryByTestId('first-run-skip')).toBeNull();
  });

  it('invokes onSkip and does not save anything', () => {
    const onSkip = vi.fn();
    render(<FirstRunWizard client={CLIENT} onComplete={() => undefined} onSkip={onSkip} />);
    fireEvent.click(screen.getByTestId('first-run-skip'));
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(CLIENT.save).not.toHaveBeenCalled();
  });
});
