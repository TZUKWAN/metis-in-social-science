/**
 * GoalCardInline — renders an inline Goal card inside the Chat message stream.
 *
 * Shows the full lifecycle of a Goal:
 *   creating → planning → executing → completed / failed
 *
 * Reuses existing CSS classes (.progress-bar, .plan-step, .exec-step, .status-dot, etc.)
 * and the new .goal-card-inline* classes from App.css.
 */

import { useState } from 'react';
import { useTranslation } from '../i18n';
import type { UIMode } from '../../engine/capabilities/DiagnosticMode';
import { presentExecutionError } from '../presentation/executionPresentation';
import { presentSafeMarkdownText } from '../presentation/SafeMarkdown';
import { isInternalExecutionCopy } from '../presentation/executionCopy';

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
  phase: 'creating' | 'planning' | 'plan_ready' | 'executing' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  planName?: string;
  planDescription?: string;
  steps: Array<{ id: string; name: string; description: string }>;
  stepStatuses: Record<string, GoalStepStatus>;
  progress: { completed: number; total: number; currentStep: string };
  reasoning?: string;
  error?: string;
  /** Main process accepted a cooperative pause request; the current step still owns the boundary. */
  pauseRequested?: boolean;
  canRefine: boolean;
}

interface GoalCardInlineProps {
  data: GoalCardData;
  uiMode?: UIMode;
  registerStepElement?: (stepId: string, element: HTMLElement | null) => void;
  onPause?: () => void;
  onCancel?: () => void;
  onResume?: () => void;
  onRetry?: () => void;
  onOpenBoard?: () => void;
  /** 2.6 已完成任务「调整」：以该步骤为上下文新开对话（会话标签名=任务名）。 */
  onStepAdjust?: (stepId: string, stepName: string, summary: string) => void;
  /** 2.6/2.7 删除该任务及其产物（调用方负责二次确认）。 */
  onDeleteTask?: () => void;
  /** 2.7 未完成任务「编辑任务」：用户自然语言输入，调用方交给引擎自动调整计划。 */
  onStepEditTask?: (instruction: string) => void;
  /** 2.7 未完成任务「启动」。 */
  onStepStart?: () => void;
  /** 2.8 拖动排序：提交新的步骤顺序。 */
  onStepsReorder?: (orderedIds: string[]) => void;
}

// ─── Status color map ────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  pending: 'var(--text-muted)',
  running: 'var(--status-running)',
  completed: 'var(--status-completed)',
  failed: 'var(--status-failed)',
  skipped: 'var(--text-muted)',
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
  paused: 'paused',
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
  onPause,
  onCancel,
  onResume,
  onRetry,
  onOpenBoard,
  onStepAdjust,
  onDeleteTask,
  onStepEditTask,
  onStepStart,
  onStepsReorder,
}: GoalCardInlineProps) {
  const { t, locale } = useTranslation();
  const diagnosticMode = uiMode === 'diagnostic';
  // 2.6/2.7: 步骤点击展开面板；2.8: 拖动排序状态。
  const [expandedStepId, setExpandedStepId] = useState<string | null>(null);
  const [editInstruction, setEditInstruction] = useState('');
  const [dragStepId, setDragStepId] = useState<string | null>(null);
  const [dragOverStepId, setDragOverStepId] = useState<string | null>(null);

  const phaseLabel: Record<string, string> = {
    creating: t('chat.goalCreating'),
    planning: t('chat.goalPlanning'),
    plan_ready: t('chat.goalPlanning'),
    executing: t('chat.goalExecuting'),
    paused: t('goal.paused'),
    completed: t('chat.goalCompleted'),
    failed: t('chat.goalFailed'),
    cancelled: locale === 'zh' ? '已取消' : 'Cancelled',
    unknown: t('chat.goalUnavailable'),
  };
  const safeText = (value: string) => presentSafeMarkdownText(value, uiMode, locale);
  const displayPlanName = data.planName && (diagnosticMode || !isInternalExecutionCopy(data.planName))
    ? safeText(data.planName)
    : t('chat.researchPlan');
  const displayPlanDescription = data.planDescription
    && (diagnosticMode || !isInternalExecutionCopy(data.planDescription))
    ? safeText(data.planDescription)
    : '';
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
    <section className="goal-card-inline" data-testid="goal-card-inline" aria-label={safeText(data.description)}>
      {/* Header */}
      <div className="goal-card-header">
        <span className="goal-card-title">{safeText(data.description)}</span>
        <span className={`goal-card-phase ${PHASE_CLASSES[data.phase]}`} role="status">{phaseLabel[data.phase]}</span>
      </div>

      {/* Creating / Planning spinner */}
      {(data.phase === 'creating' || data.phase === 'planning') && (
        <div className="goal-card-spinner">
          <div className="hydration-spinner" />
          <span>{data.phase === 'creating' ? t('chat.goalCreating') : t('chat.goalPlanning')}</span>
        </div>
      )}

      {data.pauseRequested && data.phase === 'executing' && (
        <div className="goal-card-pause-notice" data-testid="goal-pause-requested" role="status">
          {locale === 'zh'
            ? '暂停请求中：当前步骤跑完后即暂停，届时按钮区会出现「继续」。'
            : 'Pause requested: the run pauses after the current step; a Resume button will appear.'}
        </div>
      )}
      {data.phase === 'paused' && (
        <div className="goal-card-pause-notice" role="status">
          {locale === 'zh'
            ? '已暂停：点下方「继续」从当前步骤恢复执行。'
            : 'Paused: click Resume below to continue from the current step.'}
        </div>
      )}

      {/* This is a real Workflow timeline. Steps come from Goal/Workflow IPC and
          receive their status only through the goal live event stream.
          plan_ready is included so a generated-but-not-started plan is visible
          and can be reordered / started (2.7/2.8). */}
      {(data.phase === 'plan_ready' || data.phase === 'executing' || data.phase === 'paused' || data.phase === 'completed' || data.phase === 'failed' || data.phase === 'cancelled') && data.steps.length > 0 && (
        <div className="goal-card-plan">
          <div className="goal-card-plan-name">
            {displayPlanName}
          </div>
          {displayPlanDescription && (
            <div className="goal-card-plan-desc">{displayPlanDescription}</div>
          )}

          {/* Progress bar */}
          {safeTotal > 0 && (
            <>
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{
                    background: data.phase === 'failed' ? 'var(--status-failed)' : 'var(--status-running)',
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

          {/* Step list - 2.6/2.7/2.8: click to expand detail panel; drag to reorder (pending tasks). */}
          <ol className="goal-card-steps" data-testid="goal-execution-timeline" aria-label={t('chat.researchPlan')}>
            {data.steps.map((step, index) => {
              const status = data.stepStatuses[step.id]?.status ?? 'pending';
              const displayStepName = step.name && (diagnosticMode || !isInternalExecutionCopy(step.name))
                ? safeText(step.name)
                : t('chat.researchPlanStep', { index: index + 1 });
              const displayStepDescription = step.description
                && (diagnosticMode || !isInternalExecutionCopy(step.description))
                ? safeText(step.description)
                : '';
              const stepOutput = data.stepStatuses[step.id]?.output ?? '';
              const expanded = expandedStepId === step.id;
              const isDone = status === 'completed';
              const isDraggable = Boolean(onStepsReorder) && data.phase === 'plan_ready';
              return (
                <li
                  key={step.id}
                  ref={(element) => registerStepElement?.(step.id, element)}
                  className={`exec-step ${status === 'running' ? 'running' : ''}${expanded ? ' expanded' : ''}${dragOverStepId === step.id ? ' drag-over' : ''}`}
                  aria-current={status === 'running' ? 'step' : undefined}
                  data-testid={`goal-step-${step.id}`}
                  onClick={() => setExpandedStepId(expanded ? null : step.id)}
                  draggable={isDraggable}
                  onDragStart={isDraggable ? () => setDragStepId(step.id) : undefined}
                  onDragOver={isDraggable && dragStepId && dragStepId !== step.id ? (event) => { event.preventDefault(); setDragOverStepId(step.id); } : undefined}
                  onDrop={isDraggable && dragStepId ? (event) => {
                    event.preventDefault();
                    const from = data.steps.findIndex((item) => item.id === dragStepId);
                    const to = data.steps.findIndex((item) => item.id === step.id);
                    if (from >= 0 && to >= 0 && from !== to && onStepsReorder) {
                      const ordered = data.steps.map((item) => item.id);
                      ordered.splice(to, 0, ...ordered.splice(from, 1));
                      onStepsReorder(ordered);
                    }
                    setDragStepId(null);
                    setDragOverStepId(null);
                  } : undefined}
                  onDragEnd={() => { setDragStepId(null); setDragOverStepId(null); }}
                  style={{ cursor: isDraggable ? 'grab' : 'pointer' }}
                >
                  {isDraggable && <span className="goal-step-drag" aria-hidden draggable={false}>⋮⋮</span>}
                  <span className={`status-dot ${STATUS_CLASSES[status]}`} />
                  <span className="goal-card-step-copy">
                    <span className="exec-step-name">
                      {displayStepName}
                    </span>
                    {displayStepDescription && <span className="goal-card-step-description">{displayStepDescription}</span>}
                  </span>
                  <span
                    className="status-indicator"
                    style={{ fontSize: 11, color: STATUS_COLORS[status] ?? STATUS_COLORS['pending'] }}
                  >
                    {t(`goal.${STATUS_LABEL_KEYS[status] ?? 'paused'}`)}
                  </span>
                  {expanded && (
                    <div className="goal-step-panel" data-testid={`goal-step-panel-${step.id}`} onClick={(event) => event.stopPropagation()}>
                      {isDone ? (
                        <>
                          <div className="goal-step-panel__summary" data-testid="goal-step-summary">
                            <strong>{locale === 'zh' ? '已完成：' : 'Completed: '}</strong>
                            {stepOutput
                              ? safeText(stepOutput.length > 400 ? `${stepOutput.slice(0, 400)}…` : stepOutput)
                              : (displayStepDescription || (locale === 'zh' ? '本步骤已完成。' : 'This step finished.'))}
                          </div>
                          <div className="goal-step-panel__actions">
                            {onStepAdjust && (
                              <button type="button" className="btn-sm btn-secondary" data-testid="goal-step-adjust" onClick={() => onStepAdjust(step.id, step.name, stepOutput)}>
                                {locale === 'zh' ? '调整' : 'Adjust'}
                              </button>
                            )}
                            {onDeleteTask && (
                              <button type="button" className="btn-sm btn-secondary goal-step-panel__danger" data-testid="goal-step-delete-task" onClick={() => {
                                if (window.confirm(locale === 'zh' ? `确定删除任务「${data.description}」的研究记录（计划与执行历史）？已生成的成果文件会保留。` : `Delete the research record of task "${data.description}" (plan and run history)? Generated outcome files are kept.`)) {
                                  onDeleteTask();
                                }
                              }}>{locale === 'zh' ? '删除任务' : 'Delete task'}</button>
                            )}
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="goal-step-panel__summary" data-testid="goal-step-plan">
                            <strong>{locale === 'zh' ? '准备做：' : 'Planned: '}</strong>
                            {displayStepDescription || safeText(step.description) || (locale === 'zh' ? '等待执行。' : 'Waiting to run.')}
                          </div>
                          <div className="goal-step-panel__actions">
                            {onDeleteTask && (
                              <button type="button" className="btn-sm btn-secondary goal-step-panel__danger" data-testid="goal-step-delete-task" onClick={() => {
                                if (window.confirm(locale === 'zh' ? `确定删除任务「${data.description}」的研究记录（计划与执行历史）？已生成的成果文件会保留。` : `Delete the research record of task "${data.description}" (plan and run history)? Generated outcome files are kept.`)) {
                                  onDeleteTask();
                                }
                              }}>{locale === 'zh' ? '删除任务' : 'Delete task'}</button>
                            )}
                            {onStepEditTask && (
                              <span className="goal-step-panel__edit">
                                <input
                                  value={editInstruction}
                                  placeholder={locale === 'zh' ? '用自然语言描述要怎么调整这一步…' : 'Describe the adjustment in plain language…'}
                                  onChange={(event) => setEditInstruction(event.target.value)}
                                  data-testid="goal-step-edit-input"
                                />
                                <button type="button" className="btn-sm btn-secondary" disabled={!editInstruction.trim()} data-testid="goal-step-edit-apply" onClick={() => {
                                  onStepEditTask(editInstruction.trim());
                                  setEditInstruction('');
                                }}>{locale === 'zh' ? '让 METIS 调整' : 'Let METIS adjust'}</button>
                              </span>
                            )}
                            {onStepStart && (data.phase === 'plan_ready' || data.phase === 'paused') && (
                              <button type="button" className="btn-sm btn-primary" data-testid="goal-step-start" onClick={onStepStart}>{locale === 'zh' ? '启动' : 'Start'}</button>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
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
        {data.phase === 'executing' && onPause && (
          <button type="button" className="btn-sm btn-secondary" data-testid="goal-pause" disabled={data.pauseRequested} onClick={onPause}>{data.pauseRequested ? (locale === 'zh' ? '暂停请求中…' : 'Pausing…') : (locale === 'zh' ? '暂停' : 'Pause')}</button>
        )}
        {(data.phase === 'executing' || data.phase === 'plan_ready' || data.phase === 'paused') && onCancel && (
          <button type="button" className="btn-sm btn-secondary" onClick={onCancel}>{t('chat.goalCancel')}</button>
        )}
        {data.phase === 'paused' && onResume && (
          <button type="button" className="btn-sm btn-primary" data-testid="goal-resume" onClick={onResume}>{t('chat.goalResume')}</button>
        )}
        {data.phase === 'failed' && onRetry && (
          <button type="button" className="btn-sm btn-primary" onClick={onRetry}>{t('chat.goalRetry')}</button>
        )}
        {data.phase === 'failed' && onResume && (
          <button type="button" className="btn-sm btn-secondary" onClick={onResume}>{t('chat.goalResume')}</button>
        )}
        {data.goalId && onOpenBoard && (
          <button type="button" className="btn-sm btn-secondary" data-testid="goal-open-board" onClick={onOpenBoard}>{t('chat.goalOpenBoard')}</button>
        )}
      </div>
    </section>
  );
}
