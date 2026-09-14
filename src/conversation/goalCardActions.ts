/**
 * Goal 卡片交互动作构造器（2.6/2.7/2.8，刘总 2026-09）。
 *
 * 从 ChatPage 内联 JSX 迁出（2026-09-13 拆分）：调整/删除/编辑任务/启动/
 * 拖动排序的真实引擎路径集中在这里，宿主注入依赖，保持纯函数可测。
 */
import type { GoalCardData } from '../components/GoalCardInline';
import type { ToastEventDetail } from '../lib/toast';

export interface GoalCardActionDeps {
  msg: { goalCard?: GoalCardData };
  locale: 'zh' | 'en';
  updateGoalCard: (index: number, updater: (card: GoalCardData) => GoalCardData) => void;
  findGoalCardIndex: (goalId: string) => number | undefined;
  syncGoalCardWorkflow: (goalId: string, index: number) => Promise<void>;
  createNewSession: () => Promise<string | null>;
  renameSession: (sessionId: string, title: string) => Promise<void>;
  focusComposer: () => void;
  setComposerDraft: (text: string) => void;
  resumeGoal: (goalId: string) => Promise<void>;
  startPlannedGoal: (goalId: string) => Promise<void>;
  showToast: (detail: ToastEventDetail) => void;
}

export function buildGoalCardActions(deps: GoalCardActionDeps) {
  const { msg, locale } = deps;
  return {
    onStepAdjust: (_stepId: string, stepName: string, summary: string) => {
      // 2.6 调整：创建并激活一个正式会话，标题直接反映来源任务。
      // 输入框只预填上下文，用户写下具体调整要求后再发送，避免把
      // "我会告诉你"这种占位句误当成真实任务提交给模型。
      const goalCard = msg.goalCard!;
      const adjustText = locale === 'zh'
        ? `【任务调整】针对任务「${goalCard.description}」的步骤「${stepName}」：
已完成的工作摘要：${summary.slice(0, 400) || '（无输出记录）'}
请说明你希望如何调整。`
        : `[Task adjustment] Step "${stepName}" of "${goalCard.description}":
Completed-work summary: ${summary.slice(0, 400) || '(no recorded output)'}
Describe the change you would like to make.`;
      void (async () => {
        const newSessionId = await deps.createNewSession();
        if (!newSessionId) {
          deps.showToast({ kind: 'error', text: locale === 'zh' ? '无法创建调整对话，请稍后重试。' : 'Could not create the adjustment conversation. Please try again.' });
          return;
        }
        const title = locale === 'zh'
          ? `调整 · ${stepName || goalCard.description}`
          : `Adjust · ${stepName || goalCard.description}`;
        await deps.renameSession(newSessionId, title.slice(0, 120));
        deps.setComposerDraft(adjustText);
        deps.focusComposer();
      })();
    },
    onDeleteTask: () => {
      // 2.6/2.7 删除任务（GoalCardInline 已二次确认；仅删研究记录，
      // 成果文件保留——文案与引擎行为一致）。
      const goalId = msg.goalCard!.goalId;
      if (!goalId) return;
      void window.metis?.deleteGoal?.(goalId);
    },
    onStepEditTask: (instruction: string) => {
      // 2.7 编辑任务：refinePlan 才会让模型按自然语言重规划；
      // updatePlan 只接受已结构化的 WorkflowDefinition，不能伪装成
      // "自动调整"。成功后同步权威工作流和当前卡片。
      const goalId = msg.goalCard!.goalId;
      if (!goalId) return;
      const cardIndex = deps.findGoalCardIndex(goalId);
      if (cardIndex === undefined) return;
      void (async () => {
        const metis = window.metis;
        if (!metis?.refinePlan) return;
        const result = await metis.refinePlan(goalId, instruction);
        if (!result.success) {
          deps.updateGoalCard(cardIndex, (card) => ({
            ...card,
            error: locale === 'zh' ? '任务调整未完成，原计划保持不变。' : 'Task adjustment did not complete; the original plan is unchanged.',
          }));
          return;
        }
        await deps.syncGoalCardWorkflow(goalId, cardIndex);
      })();
    },
    onStepStart: () => {
      // 2.7 启动：plan_ready 走 executeGoal（全新 run），
      // paused 走 resumeGoal（引擎要求已存在暂停 run）。
      const goalId = msg.goalCard!.goalId;
      if (!goalId) return;
      if (msg.goalCard!.phase === 'plan_ready') void deps.startPlannedGoal(goalId);
      else void deps.resumeGoal(goalId);
    },
    onStepsReorder: (orderedIds: string[]) => {
      // 2.8 拖动排序：以权威 WorkflowDefinition 为基准重排后整体提交
      // updatePlan。卡片上只有 id/name/description 摘要，直接拼凑的
      // 残缺定义会被 GoalPlanner 校验拒绝（缺 dependencies 等字段）。
      const goalId = msg.goalCard!.goalId;
      if (!goalId) return;
      const cardIndex = deps.findGoalCardIndex(goalId);
      if (cardIndex === undefined) return;
      void (async () => {
        const metis = window.metis;
        if (!metis?.getGoalWorkflow || !metis.updatePlan) return;
        const view = await metis.getGoalWorkflow(goalId);
        const workflow = (view as { workflow?: Record<string, unknown> } | undefined)?.workflow;
        if (!workflow) {
          deps.updateGoalCard(cardIndex, (card) => ({
            ...card,
            error: locale === 'zh' ? '暂时无法读取任务计划，排序未生效。' : 'Could not read the plan; reordering was not applied.',
          }));
          return;
        }
        const steps = Array.isArray(workflow.steps)
          ? (workflow.steps as Array<Record<string, unknown>>)
          : [];
        const position = new Map(orderedIds.map((id, order) => [id, order]));
        const orderedSteps = [...steps].sort((left, right) => (
          (position.get(String(left.id)) ?? Number.MAX_SAFE_INTEGER)
          - (position.get(String(right.id)) ?? Number.MAX_SAFE_INTEGER)
        ));
        const result = await metis.updatePlan(goalId, {
          ...workflow,
          steps: orderedSteps,
        } as unknown as Record<string, unknown>);
        if (!result || (result as { valid?: boolean }).valid !== true) {
          const errors = (result as { errors?: string[] } | null | undefined)?.errors ?? [];
          deps.updateGoalCard(cardIndex, (card) => ({
            ...card,
            error: locale === 'zh'
              ? `排序未保存（${errors[0] ?? 'plan_update_rejected'}）；原顺序保持不变。`
              : `Reorder was not saved (${errors[0] ?? 'plan_update_rejected'}); the original order is kept.`,
          }));
          return;
        }
        await deps.syncGoalCardWorkflow(goalId, cardIndex);
      })();
    },
  };
}
