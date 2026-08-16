/**
 * OnboardingTour — first-run interactive feature tour.
 *
 * Shows once (localStorage flag) after the app is hydrated. Steps through the
 * key features with a spotlight highlight on the relevant UI area. User can
 * skip at any time.
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { useTranslation } from '../i18n';
import './OnboardingTour.css';
import { markOnboardingDone } from '../lib/onboarding';

interface TourStep {
  title: string;
  description: string;
  /** CSS selector for the element to highlight (optional). */
  selector?: string;
}



export default function OnboardingTour({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const [step, setStep] = useState(0);
  const [visible, setVisible] = useState(true);
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const steps: TourStep[] = [
    {
      title: t('onboarding.step1Title'),
      description: t('onboarding.step1Desc'),
      selector: '.topbar-nav__item[data-nav-id="converse"]',
    },
    {
      title: t('onboarding.step2Title'),
      description: t('onboarding.step2Desc'),
      selector: '.topbar-nav__item[data-nav-id="library"]',
    },
    {
      title: t('onboarding.step3Title'),
      description: t('onboarding.step3Desc'),
    },
    {
      title: t('onboarding.step4Title'),
      description: t('onboarding.step4Desc'),
    },
    {
      title: t('onboarding.step5Title'),
      description: t('onboarding.step5Desc'),
    },
  ];

  const current = steps[step];

  const finish = useCallback(() => {
    markOnboardingDone();
    setVisible(false);
    returnFocusRef.current?.focus();
    onDone();
  }, [onDone]);

  const next = useCallback(() => {
    if (step < steps.length - 1) setStep(step + 1);
    else finish();
  }, [step, steps.length, finish]);

  useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
  }, []);

  // Highlight the target element if a selector is provided. A missing target is
  // intentionally a graceful dialog-only tour rather than an invisible overlay.
  useEffect(() => {
    if (!current?.selector) return;
    const el = document.querySelector(current.selector) as HTMLElement | null;
    if (!el) return;
    el.classList.add('onboarding-spotlight-target');
    return () => { el.classList.remove('onboarding-spotlight-target'); };
  }, [step, current?.selector]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); finish(); return; }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled])'));
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [finish]);

  if (!visible || !current) return null;

  return (
    <div className="onboarding-overlay" data-testid="onboarding-tour">
      <div
        ref={dialogRef}
        className="onboarding-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
        aria-describedby="onboarding-description"
        tabIndex={-1}
      >
        <div className="onboarding-step-indicator" aria-label={`${step + 1} / ${steps.length}`}>
          {steps.map((_, i) => (
            <span key={i} className={`onboarding-dot ${i === step ? 'active' : ''} ${i < step ? 'done' : ''}`} />
          ))}
        </div>
        <h3 id="onboarding-title" className="onboarding-title">{current.title}</h3>
        <p id="onboarding-description" className="onboarding-desc">{current.description}</p>
        <div className="onboarding-actions">
          <button className="btn-secondary btn-sm" onClick={finish}>{t('onboarding.skip')}</button>
          <button className="btn-primary btn-sm" data-testid="onboarding-next" onClick={next}>
            {step < steps.length - 1 ? t('onboarding.next') : t('onboarding.finish')}
          </button>
        </div>
      </div>
    </div>
  );
}
