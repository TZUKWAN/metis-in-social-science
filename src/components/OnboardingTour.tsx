/**
 * OnboardingTour — first-run interactive feature tour.
 *
 * Shows once (localStorage flag) after the app is hydrated. Steps through the
 * key features with a spotlight highlight on the relevant UI area. User can
 * skip at any time.
 */

import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from '../i18n';
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

  const steps: TourStep[] = [
    {
      title: t('onboarding.step1Title'),
      description: t('onboarding.step1Desc'),
      selector: '.nav-item[data-nav-id="projects"]',
    },
    {
      title: t('onboarding.step2Title'),
      description: t('onboarding.step2Desc'),
      selector: '.nav-item[data-nav-id="library"]',
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
    onDone();
  }, [onDone]);

  const next = useCallback(() => {
    if (step < steps.length - 1) setStep(step + 1);
    else finish();
  }, [step, steps.length, finish]);

  // Highlight the target element if a selector is provided.
  useEffect(() => {
    if (!current?.selector) return;
    const el = document.querySelector(current.selector) as HTMLElement | null;
    if (!el) return;
    el.style.outline = '2px solid var(--primary)';
    el.style.outlineOffset = '2px';
    el.style.zIndex = '60';
    return () => {
      el.style.outline = '';
      el.style.outlineOffset = '';
      el.style.zIndex = '';
    };
  }, [step, current?.selector]);

  if (!visible || !current) return null;

  return (
    <div className="onboarding-overlay" data-testid="onboarding-tour" onClick={next}>
      <div className="onboarding-card" onClick={(e) => e.stopPropagation()}>
        <div className="onboarding-step-indicator">
          {steps.map((_, i) => (
            <span key={i} className={`onboarding-dot ${i === step ? 'active' : ''} ${i < step ? 'done' : ''}`} />
          ))}
        </div>
        <h3 className="onboarding-title">{current.title}</h3>
        <p className="onboarding-desc">{current.description}</p>
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
