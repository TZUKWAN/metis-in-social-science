/**
 * Onboarding persistence helpers (kept outside the component file for
 * react-refresh compliance).
 */

const TOUR_KEY = 'metis-onboarding-done';

export function shouldShowOnboarding(): boolean {
  try {
    return !localStorage.getItem(TOUR_KEY);
  } catch {
    return false;
  }
}

export function markOnboardingDone(): void {
  try { localStorage.setItem(TOUR_KEY, '1'); } catch { /* best-effort */ }
}
