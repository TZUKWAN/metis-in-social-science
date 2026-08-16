/**
 * GoalCardInline — renders an inline Goal card inside the Chat message stream.
 *
 * Shows the full lifecycle of a Goal:
 *   creating → planning → executing → completed / failed
 *
 * Reuses existing CSS classes (.progress-bar, .plan-step, .exec-step, .status-dot, etc.)
 * and the new .goal-card-inline* classes from App.css.
 */

import { useTranslation } from '../i18n';
import type { UIMode } from '../../engine/capabilities/DiagnosticMode';
import { presentExecutionError } from '../presentation/executionPresentation';
import { presentSafeMarkdownText } from '../presentation/SafeMarkdown';

// ─── Types (mirrors ChatPage GoalCardData) ────────────────────

export interface GoalStepStatus {
  stepId: string;
  stepName: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'unknown';
  output: string;
}

export interface GoalCardData {
  goalId: string;
  description: string;
  phase: 'creating' | 'planning' | 'plan_ready' | 'executing' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  planName?: string;
  planDescription?: string;
  steps: Array<{ id: string; name: string; description: string }>;
  stepStatuses: Record<string, GoalStepStatus>;
  progress: { completed: number; total: number; currentStep: string };
  reasoning?: string;
  error?: string;
  canRefine: boolean;
}

interface GoalCardInlineProps {
  data: GoalCardData;
  uiMode?: UIMode;
  registerStepElement?: (stepId: string, element: HTMLDivElement | null) => void;
  onCancel?: () => void;
  onResume?: () => void;
  onRetry?: () => void;
  onOpenBoard?: () => void;
}

// ─── Status color map ────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  pending: 'var(--text-muted, #94a3b8)',
  running: 'var(--status-running, #3b82f6)',
  completed: 'var(--status-completed, #22c55e)',
  failed: 'var(--status-failed, #ef4444)',
  skipped: 'var(--text-muted, #94a3b8)',
};

const STATUS_LABEL_KEYS: Record<string, string> = {
  pending: 'paused',
  running: 'executing',
  completed: 'completed',
  failed: 'failed',
  skipped: 'paused',
  unknown: 'paused',
};

const PHASE_CLASSES: Record<GoalCardData['phase'], string> = {
  creating: 'creating',
  planning: 'planning',
  plan_ready: 'plan-ready',
  executing: 'executing',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  unknown: 'unknown',
};

const STATUS_CLASSES: Record<GoalStepStatus['status'], string> = {
  pending: 'pending',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  skipped: 'skipped',
  unknown: 'pending',
};

// ─── Component ────────────────────────────────────────────────

export default function GoalCardInline({
  data,
  uiMode = 'normal',
  registerStepElement,
  onCancel,
  onResume,
  onRetry,
  onOpenBoard,
}: GoalCardInlineProps) {
  const { t, locale } = useTranslation();
  const diagnosticMode = uiMode === 'diagnostic';

  const phaseLabel: Record<string, string> = {
    creating: t('chat.goalCreating'),
    planning: t('chat.goalPlanning'),
    plan_ready: t('chat.goalPlanning'),
    executing: t('chat.goalExecuting'),
    completed: t('chat.goalCompleted'),
    failed: t('chat.goalFailed'),
    cancelled: t('chat.goalCancel'),
    unknown: t('chat.goalUnavailable'),
  };
  const safeText = (value: string) => presentSafeMarkdownText(value, uiMode, locale);
  const safeCompleted = Number.isFinite(data.progress.completed)
    ? Math.max(0, data.progress.completed)
    : 0;
  const safeTotal = Number.isFinite(data.progress.total)
    ? Math.max(0, data.progress.total)
    : 0;
  const progressPercent = safeTotal > 0
    ? Math.min(100, (Math.min(safeCompleted, safeTotal) / safeTotal) * 100)
    : 0;

  return (
    <div className="goal-card-inline">
      {/* Header */}
      <div className="goal-card-header">
        <span className="goal-card-title">{safeText(data.description)}</span>
        <span className={`goal-card-phase ${PHASE_CLASSES[data.phase]}`}>{phaseLabel[data.phase]}</span>
      </div>

      {/* Creating / Planning spinner */}
      {(data.phase === 'creating' || data.phase === 'planning') && (
        <div className="goal-card-spinner">
          <div className="hydration-spinner" />
          <span>{data.phase === 'creating' ? t('chat.goalCreating') : t('chat.goalPlanning')}</span>
        </div>
      )}

      {/* Plan + Execution progress */}
      {(data.phase === 'executing' || data.phase === 'completed' || data.phase === 'failed' || data.phase === 'cancelled') && data.steps.length > 0 && (
        <div className="goal-card-plan">
          <div className="goal-card-plan-name">
            {diagnosticMode && data.planName ? safeText(data.planName) : t('chat.researchPlan')}
          </div>
          {diagnosticMode && data.planDescription && (
            <div className="goal-card-plan-desc">{safeText(data.planDescription)}</div>
          )}

          {/* Progress bar */}
          {safeTotal > 0 && (
            <>
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{
                    background: data.phase === 'failed' ? 'var(--status-failed, #ef4444)' : 'var(--status-running, #3b82f6)',
                    width: `${progressPercent}%`,
                  }}
                />
              </div>
              <div className="goal-card-progress-text">
                {Math.min(safeCompleted, safeTotal)} / {safeTotal}
                {diagnosticMode && data.progress.currentStep && ` — ${safeText(data.progress.currentStep)}`}
              </div>
            </>
          )}

          {/* Step list */}
          <div className="goal-card-steps">
            {data.steps.map((step, index) => {
              const status = data.stepStatuses[step.id]?.status ?? 'pending';
              return (
                <div
                  key={step.id}
                  ref={(element) => registerStepElement?.(step.id, element)}
                  className={`exec-step ${status === 'running' ? 'running' : ''}`}
                >
                  <span className={`status-dot ${STATUS_CLASSES[status]}`} />
                  <span className="exec-step-name">
                    {diagnosticMode
                      ? safeText(step.name)
                      : t('chat.researchPlanStep', { index: index + 1 })}
                  </span>
                  <span
                    className="status-indicator"
                    style={{ fontSize: 11, color: STATUS_COLORS[status] ?? STATUS_COLORS['pending'] }}
                  >
                    {t(`goal.${STATUS_LABEL_KEYS[status] ?? 'paused'}`)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Technical planning rationale is available only in developer diagnostics. */}
      {diagnosticMode && data.reasoning && (
        <div className="goal-card-reasoning">{safeText(data.reasoning)}</div>
      )}

      {/* Raw execution errors are sanitized in normal mode. */}
      {data.error && (
        <div className="goal-card-error">
          {presentExecutionError(safeText(data.error), locale, uiMode)}
        </div>
      )}

      {/* Completed step output can contain internal execution details. */}
      {diagnosticMode && data.phase === 'completed' && (
        <div className="goal-card-results">
          {Object.values(data.stepStatuses)
            .filter((s) => s.output && s.status === 'completed')
            .map((s) => (
              <div key={s.stepId} className="goal-card-result-item">
                <div className="goal-card-result-title">{safeText(s.stepName)}</div>
                <div style={{ color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'auto' }}>
                  {safeText(s.output.length > 300 ? `${s.output.slice(0, 300)}...` : s.output)}
                </div>
              </div>
            ))}
        </div>
      )}

      {/* Action buttons */}
      <div className="goal-card-actions">
        {(data.phase === 'executing' || data.phase === 'plan_ready') && onCancel && (
          <button className="btn-sm btn-secondary" onClick={onCancel}>{t('chat.goalCancel')}</button>
        )}
        {data.phase === 'failed' && onRetry && (
          <button className="btn-sm btn-primary" onClick={onRetry}>{t('chat.goalRetry')}</button>
        )}
        {data.phase === 'failed' && onResume && (
          <button className="btn-sm btn-secondary" onClick={onResume}>{t('chat.goalResume')}</button>
        )}
        {data.goalId && onOpenBoard && (
          <button className="btn-sm btn-secondary" data-testid="goal-open-board" onClick={onOpenBoard}>{t('chat.goalOpenBoard')}</button>
        )}
      </div>
    </div>
  );
}
