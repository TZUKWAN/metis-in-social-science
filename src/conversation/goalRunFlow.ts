/**
 * Goal 运行流构造器（2026-09-13 拆分）。
 *
 * 从 ChatPage 迁出五个 Goal 运行函数：handleGoalFlow（创建→规划→执行）、
 * handlePauseGoal / handleCancelGoal / handleResumeGoal（运行控制）、
 * handleStartPlannedGoal（plan_ready 的全新 run 启动）。它们共享
 * isLoading、活动目标注册表、卡片索引与队列补发等宿主状态，全部通过
 * deps 对象显式注入；window.metis 桥接按 goalCardActions 的同一约定由
 * 宿主传入。纯移动，行为语义不变。
 */
import type { RefObject, SetStateAction } from 'react';
import type { UIMode } from '../../engine/capabilities/DiagnosticMode';
import type { GoalCardData } from '../components/GoalCardInline';
import type { ChatMessage } from '../pages/ChatPage';
import { presentExecutionError } from '../presentation/executionPresentation';
import type { TranslateFn } from '../i18n';

function now(): number {
  return Date.now();
}

export interface GoalRunFlowDeps {
  /** preload 桥接（生产传 window.metis；显式注入以便测试替换）。 */
  metis: typeof window.metis;
  locale: 'zh' | 'en';
  uiMode: UIMode;
  t: TranslateFn;
  currentSessionId: string;
  activeResearchProjectId: string | null;
  /** 创建 Goal 卡时的消息数快照：卡索引 = messagesLength + 1（与迁出前一致）。 */
  messagesLength: number;
  setMessages: (update: SetStateAction<ChatMessage[]>) => void;
  setIsLoading: (value: boolean) => void;
  setActiveGoalId: (value: string | null) => void;
  activeGoalIdRef: RefObject<string | null>;
  goalEventSequenceRef: RefObject<Map<string, number>>;
  goalCardIndexMapRef: RefObject<Map<string, number>>;
  updateGoalCard: (index: number, updater: (card: GoalCardData) => GoalCardData) => void;
  findGoalCardIndex: (goalId: string) => number | undefined;
  syncGoalCardWorkflow: (goalId: string, index: number) => Promise<void>;
  refreshSessionSummaries: () => void;
  /** 2.5 队列补发：Goal 轮结算后消费排队消息。 */
  flushNext: () => void;
}

export function createGoalRunFlow(deps: GoalRunFlowDeps) {
  const {
    metis,
    locale,
    uiMode,
    t,
    currentSessionId,
    activeResearchProjectId,
    messagesLength,
    setMessages,
    setIsLoading,
    setActiveGoalId,
    activeGoalIdRef,
    goalEventSequenceRef,
    goalCardIndexMapRef,
    updateGoalCard,
    findGoalCardIndex,
    syncGoalCardWorkflow,
    refreshSessionSummaries,
    flushNext,
  } = deps;

  // ─── Goal flow ─────────────────────────────────────────────

  async function handleGoalFlow(description: string, sessionIdOverride?: string) {
    setIsLoading(true);
    const sessionId = sessionIdOverride ?? currentSessionId;
    if (metis?.appendMessage) {
      void metis.appendMessage(sessionId, 'user', description);
    }
    if (!metis?.createGoal) {
      setMessages((prev) => [...prev, {
        role: 'assistant',
        content: presentExecutionError('Research task service not available', locale, uiMode),
        timestamp: now(),
      }]);
      setIsLoading(false);
      return;
    }

    // 1. Insert GoalCard message
    const goalCard: GoalCardData = {
      goalId: '', description, phase: 'creating',
      steps: [], stepStatuses: {},
      progress: { completed: 0, total: 0, currentStep: '' },
      canRefine: false,
    };
    const goalMsg: ChatMessage = { role: 'goal', content: '', timestamp: now(), goalCard };
    // Index: messages.length is the user msg just pushed; +1 is the goal card
    const goalMsgIndex = messagesLength + 1;

    setMessages((prev) => [...prev, goalMsg]);

    try {
      // 2. Create Goal
      const goal = await metis.createGoal(description, undefined, activeResearchProjectId ?? undefined);
      if (!goal.success) throw new Error(goal.code);
      const goalId = goal.goalId;
      updateGoalCard(goalMsgIndex, (card) => ({ ...card, goalId, phase: 'planning' }));
      setActiveGoalId(goalId);
      activeGoalIdRef.current = goalId;
      goalEventSequenceRef.current.delete(goalId);
      goalCardIndexMapRef.current.set(goalId, goalMsgIndex);

      // 3. Generate Plan
      const planResult = await metis.generatePlan(goalId);
      if (!planResult.success) throw new Error(planResult.code);
      const steps = planResult.steps.map((step) => ({
        id: step.stepId,
        name: t('rightPanel.researchStep', { number: step.ordinal }),
        description: '',
      }));
      const executingCard: GoalCardData = {
        ...goalCard,
        goalId,
        phase: 'executing',
        planName: t('chat.researchPlan'),
        steps,
        stepStatuses: Object.fromEntries(steps.map((s) => [s.id, { stepId: s.id, stepName: s.name, status: 'pending' as const, output: '' }])),
        progress: { completed: 0, total: steps.length, currentStep: '' },
        canRefine: false,
      };
      updateGoalCard(goalMsgIndex, () => executingCard);
      await syncGoalCardWorkflow(goalId, goalMsgIndex);

      // 4. Persist goal card state
      if (metis.appendMessage) {
        void metis.appendMessage(sessionId, 'goal', `__GOAL_CARD__${JSON.stringify(executingCard)}`);
      }

      // 5. Auto-execute
      const execution = await metis.executeGoal(goalId);
      if (execution.success) {
        updateGoalCard(goalMsgIndex, (card) => ({ ...card, phase: 'completed', pauseRequested: false }));
      } else if (execution.code === 'paused') {
        updateGoalCard(goalMsgIndex, (card) => ({ ...card, phase: 'paused', pauseRequested: false }));
      } else if (execution.code === 'cancelled') {
        updateGoalCard(goalMsgIndex, (card) => ({ ...card, phase: 'cancelled', pauseRequested: false }));
      } else {
        throw new Error(execution.code ?? 'goal_execution_failed');
      }
    } catch {
      updateGoalCard(goalMsgIndex, (card) => ({
        ...card,
        phase: 'failed',
        error: 'goal_execution_failed',
      }));
    } finally {
      setActiveGoalId(null);
      activeGoalIdRef.current = null;
      goalEventSequenceRef.current.clear();
      setIsLoading(false);
      // UX-CHAT-004: 用户消息与 Goal 卡均已持久化，刷新会话摘要。
      refreshSessionSummaries();
      // 2.5: Goal 轮结算同样要消费排队消息，否则运行期间的用户输入永久滞留。
      flushNext();
    }
  }

  /** Controls operate on the same persisted Goal ID as the visible timeline. */
  async function handlePauseGoal(goalId: string) {
    const index = findGoalCardIndex(goalId);
    if (!metis?.pauseGoal || index === undefined) return;
    try {
      const result = await metis.pauseGoal(goalId);
      if (result?.success) {
        // The engine pauses at a Workflow boundary. Until its status event
        // arrives this is intentionally a request receipt, not a fake pause.
        updateGoalCard(index, (card) => ({ ...card, pauseRequested: true }));
      } else {
        // 暂停请求被引擎拒绝时必须给出可见回执，不能静默无反应。
        updateGoalCard(index, (card) => ({
          ...card,
          error: locale === 'zh' ? '暂停请求未被执行：任务当前状态不接受暂停。' : 'The pause request was not applied: the task state does not accept a pause.',
        }));
      }
    } catch {
      updateGoalCard(index, (card) => ({
        ...card,
        error: locale === 'zh' ? '暂停服务暂时不可用，请稍后重试。' : 'The pause service is temporarily unavailable. Try again later.',
      }));
    }
  }

  async function handleCancelGoal(goalId: string) {
    const index = findGoalCardIndex(goalId);
    if (!metis?.cancelGoal || index === undefined) return;
    try {
      const result = await metis.cancelGoal(goalId);
      if (result?.success) {
        updateGoalCard(index, (card) => ({ ...card, phase: 'cancelled', pauseRequested: false }));
      } else {
        updateGoalCard(index, (card) => ({
          ...card,
          error: locale === 'zh' ? '取消请求未被执行：任务可能已经结束。' : 'The cancel request was not applied: the task may have already finished.',
        }));
      }
    } catch {
      updateGoalCard(index, (card) => ({
        ...card,
        error: locale === 'zh' ? '取消服务暂时不可用，请稍后重试。' : 'The cancel service is temporarily unavailable. Try again later.',
      }));
    } finally {
      // 2.5: 取消也是一种结算——排队消息照常补发。
      flushNext();
    }
  }

  async function handleResumeGoal(goalId: string) {
    const index = findGoalCardIndex(goalId);
    if (!metis?.resumeGoal || index === undefined) return;
    setIsLoading(true);
    setActiveGoalId(goalId);
    activeGoalIdRef.current = goalId;
    goalEventSequenceRef.current.delete(goalId);
    updateGoalCard(index, (card) => ({ ...card, phase: 'executing', pauseRequested: false, error: undefined }));
    try {
      const execution = await metis.resumeGoal(goalId);
      if (execution.success) {
        updateGoalCard(index, (card) => ({ ...card, phase: 'completed', pauseRequested: false }));
      } else if (execution.code === 'paused') {
        updateGoalCard(index, (card) => ({ ...card, phase: 'paused', pauseRequested: false }));
      } else if (execution.code === 'cancelled') {
        updateGoalCard(index, (card) => ({ ...card, phase: 'cancelled', pauseRequested: false }));
      } else if (execution.code === 'goal_cancelled' || execution.code === 'goal_not_found') {
        // 终态目标（已取消/不存在）永远无法恢复——卡片必须转入诚实的终态：
        // 收起注定失败的重试/继续按钮，清除僵死的“执行中”步骤显示，
        // 并明确告诉用户需要重新发起，而不是提示“稍后重试”。
        updateGoalCard(index, (card) => ({
          ...card,
          phase: 'cancelled',
          pauseRequested: false,
          stepStatuses: Object.fromEntries(Object.entries(card.stepStatuses).map(([stepId, status]) => [
            stepId,
            status.status === 'running' ? { ...status, status: 'pending' as const } : status,
          ])),
          error: locale === 'zh'
            ? '该研究任务已被取消，无法继续恢复。请重新发送指令开始新的研究任务。'
            : 'This research task was cancelled and can no longer be resumed. Send a new instruction to start a fresh task.',
        }));
      } else {
        // 恢复失败必须带真实原因（2026-08-29 刘总要求：不再笼统"未能完成"）。
        const codeText = String(execution.code ?? 'goal_execution_failed');
        updateGoalCard(index, (card) => ({
          ...card,
          phase: codeText === 'goal_cancelled' ? 'cancelled' : 'failed',
          error: locale === 'zh'
            ? `恢复未执行（${codeText}）。若任务已取消请重新发起；若仍在运行请稍候重试。`
            : `Resume did not run (${codeText}). Re-send if cancelled; retry shortly if still running.`,
        }));
      }
      await syncGoalCardWorkflow(goalId, index);
    } catch {
      updateGoalCard(index, (card) => ({ ...card, phase: 'failed', error: 'goal_execution_failed' }));
    } finally {
      setActiveGoalId(null);
      activeGoalIdRef.current = null;
      goalEventSequenceRef.current.clear();
      setIsLoading(false);
      refreshSessionSummaries();
      // 2.5: 恢复轮结算同样消费排队消息。
      flushNext();
    }
  }

  /**
   * 2.7 启动一个已生成计划但尚未执行的任务。executeGoal（全新 run）与
   * resumeGoal（要求已存在 paused run）是不同引擎路径：对 plan_ready 调
   * resume 会被引擎以 no run 拒绝，这里必须按阶段分流。
   */
  async function handleStartPlannedGoal(goalId: string) {
    const index = findGoalCardIndex(goalId);
    if (!metis?.executeGoal || index === undefined) return;
    setIsLoading(true);
    setActiveGoalId(goalId);
    activeGoalIdRef.current = goalId;
    goalEventSequenceRef.current.delete(goalId);
    updateGoalCard(index, (card) => ({ ...card, phase: 'executing', pauseRequested: false, error: undefined }));
    try {
      const execution = await metis.executeGoal(goalId);
      if (execution.success) {
        updateGoalCard(index, (card) => ({ ...card, phase: 'completed', pauseRequested: false }));
      } else if (execution.code === 'paused') {
        updateGoalCard(index, (card) => ({ ...card, phase: 'paused', pauseRequested: false }));
      } else if (execution.code === 'cancelled') {
        updateGoalCard(index, (card) => ({ ...card, phase: 'cancelled', pauseRequested: false }));
      } else {
        const codeText = String(execution.code ?? 'goal_execution_failed');
        updateGoalCard(index, (card) => ({
          ...card,
          phase: 'failed',
          error: locale === 'zh' ? `启动未执行（${codeText}）。` : `Start did not run (${codeText}).`,
        }));
      }
      await syncGoalCardWorkflow(goalId, index);
    } catch {
      updateGoalCard(index, (card) => ({ ...card, phase: 'failed', error: 'goal_execution_failed' }));
    } finally {
      setActiveGoalId(null);
      activeGoalIdRef.current = null;
      goalEventSequenceRef.current.clear();
      setIsLoading(false);
      refreshSessionSummaries();
      flushNext();
    }
  }

  return {
    handleGoalFlow,
    handlePauseGoal,
    handleCancelGoal,
    handleResumeGoal,
    handleStartPlannedGoal,
  };
}
