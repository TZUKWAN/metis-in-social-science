/**
 * GoalPage — read-only Goal history viewer.
 *
 * All goal creation, plan generation, and execution now happens
 * inline in the Chat page. This page shows past goals and their results.
 */

import { useState, useEffect } from 'react';
import { useTranslation } from '../i18n';
import { setPendingChatIntent } from '../lib/chatIntent.js';
import GoalCardInline, { type GoalCardData } from '../components/GoalCardInline';
import type { GoalSummary } from '../../engine/runtime/GoalRuntimeContract.js';

// ─── Types ────────────────────────────────────────────────────

type Goal = GoalSummary;

interface GoalProgress {
  goalId: string;
  status: string;
  totalSteps: number;
  completedSteps: number;
  failedSteps: number;
  currentStepId: string | null;
  startedAt: number;
  completedAt: number | null;
}

interface WorkflowStep {
  id: string;
  name: string;
  description: string;
}

interface WorkflowDef {
  name?: string;
  description?: string;
  steps: WorkflowStep[];
}

// ─── Component ────────────────────────────────────────────────

interface GoalPageProps {
  onNavigate?: (page: string) => void;
}

export default function GoalPage({ onNavigate }: GoalPageProps) {
  const { t } = useTranslation();

  function handleSocraticPlan() {
    const message = `I want to plan and structure this research goal through Socratic dialogue.\n\nPlease ask me focused diagnostic questions to help clarify the research question, motivation, key claims, methodology, evidence needs, and paper structure.`;
    setPendingChatIntent({ skillId: 'socratic-plan', message });
    onNavigate?.('chat');
  }

  const [goals, setGoals] = useState<Goal[]>([]);
  const [selectedGoal, setSelectedGoal] = useState<Goal | null>(null);
  const [goalProgress, setGoalProgress] = useState<GoalProgress | null>(null);
  const [goalWorkflow, setGoalWorkflow] = useState<WorkflowDef | null>(null);
  const [archives] = useState<Array<{ goal: Goal; summary: string; archivedAt: number }>>([]);
  const [loading, setLoading] = useState(false);

  // Load goals and archives on mount
  useEffect(() => {
    async function loadGoals() {
      const metis = window.metis;
      if (!metis?.listGoals) return;
      try {
        const response = await metis.listGoals();
        setGoals(response.success ? response.goals : []);
      } catch {
        console.warn('Failed to load goals safely');
      }
    }

    loadGoals();
  }, []);

  function selectGoal(goal: Goal) {
    setSelectedGoal(goal);
    setGoalProgress(null);
    setGoalWorkflow(null);
    setLoading(false);
  }

  function goalStatusLabel(status: Goal['status']): string {
    if (status === 'completed') return t('goal.completed');
    if (status === 'failed') return t('goal.failed');
    if (status === 'running') return t('chat.goalExecuting');
    if (status === 'paused') return t('goal.paused');
    if (status === 'cancelled') return t('chat.goalCancel');
    if (status === 'unknown') return t('chat.goalUnavailable');
    return t('chat.goalPlanning');
  }

  // Build a GoalCardData from selected goal info
  function buildGoalCard(): GoalCardData | null {
    if (!selectedGoal) return null;

    const steps = goalWorkflow?.steps ?? [];
    const stepStatuses: Record<string, { stepId: string; stepName: string; status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'; output: string }> = {};

    for (const step of steps) {
      let status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' = 'pending';
      if (selectedGoal.status === 'completed') status = 'completed';
      else if (selectedGoal.status === 'failed') status = 'failed';
      stepStatuses[step.id] = { stepId: step.id, stepName: step.name, status, output: '' };
    }

    const phase = selectedGoal.status === 'completed' ? 'completed' :
      selectedGoal.status === 'failed' ? 'failed' :
      selectedGoal.status === 'running' ? 'executing' :
      selectedGoal.status === 'cancelled' ? 'cancelled' :
      selectedGoal.status === 'unknown' ? 'unknown' : 'plan_ready';

    return {
      goalId: selectedGoal.goalId,
      description: t('goal.genericLabel'),
      phase,
      planName: goalWorkflow?.name,
      planDescription: goalWorkflow?.description,
      steps,
      stepStatuses,
      progress: {
        completed: goalProgress?.completedSteps ?? 0,
        total: goalProgress?.totalSteps ?? steps.length,
        currentStep: goalProgress?.currentStepId ?? '',
      },
      canRefine: false,
    };
  }

  const goalCard = buildGoalCard();

  return (
    <div className="goal-page">
      {/* Left sidebar: Goal list */}
      <div className="goal-sidebar">
        <h3>{t('goal.historyTitle')}</h3>
        <div className="goal-list">
          {goals.length === 0 && archives.length === 0 ? (
            <p className="goal-sidebar-text">{t('goal.noGoals')}</p>
          ) : (
            goals.map((g) => (
              <button
                key={g.goalId}
                onClick={() => selectGoal(g)}
                className={`goal-item ${selectedGoal?.goalId === g.goalId ? 'active' : ''}`}
              >
                <div className="goal-item-title">
                  {t('goal.genericLabel')}
                </div>
                <div className="goal-item-status">{goalStatusLabel(g.status)}</div>
              </button>
            ))
          )}
        </div>

        {archives.length > 0 && (
          <>
            <h4>{t('goal.archiveTitle')}</h4>
            <div style={{ maxHeight: 200, overflow: 'auto' }}>
              {archives.map((a, i) => (
                <div key={i} className="archive-item">
                  {t('goal.genericLabel')}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Main content */}
      <div className="goal-main">
        {!selectedGoal ? (
          <>
            <h2>{t('goal.historyTitle')}</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16 }}>
              {t('chat.goalUseChat')}
            </p>
            {goals.length === 0 && archives.length === 0 && (
              <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
                {t('goal.noGoals')}
              </p>
            )}
          </>
        ) : (
          <>
            <div className="plan-card-header" style={{ marginBottom: 16 }}>
              <div>
                <h3>{t('goal.genericLabel')}</h3>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>
                  {goalStatusLabel(selectedGoal.status)}
                </span>
                <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 8 }}>
                  {new Date(selectedGoal.createdAt).toLocaleString()}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn-secondary"
                  data-testid="goal-socratic-plan"
                  onClick={handleSocraticPlan}
                >
                  {t('goal.socraticPlan')}
                </button>
                <button className="btn-secondary" onClick={() => { setSelectedGoal(null); setGoalProgress(null); setGoalWorkflow(null); }}>
                  {t('common.close')}
                </button>
              </div>
            </div>

            {loading && (
              <div className="goal-card-spinner">
                <div className="hydration-spinner" />
                <span>Loading...</span>
              </div>
            )}

            {!loading && goalCard && (
              <GoalCardInline data={goalCard} />
            )}

            {!loading && !goalCard && (
              <p style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
                No details available for this goal.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
