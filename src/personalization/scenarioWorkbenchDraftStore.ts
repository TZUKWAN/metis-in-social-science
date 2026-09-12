/**
 * 场景草稿跨页保留（2026-08-29 刘总要求：切页不打断、回来不失状态）。
 * 场景页随导航条件渲染——切到成果/科研项目会卸载整棵组件树；此模块级
 * store 让未保存草稿在同一渲染会话内跨卸载存活，切回时原样恢复，右侧
 * 编辑器和编译实时推送的中间态不再"刷新即清空"。
 *
 * 独立成模块（2026-09-13）：react-refresh 要求组件文件只导出组件；
 * 草稿 store 与测试隔离钩子移到这里，工作台与测试共同消费。
 */
import type { ScenarioDefinition } from '../../engine/runtime/PersonalizationRuntimeContract.js';
import { normalizeScenarioHarness } from '../../engine/personalization/ScenarioHarness.js';
import { cloneDefinition } from './personalizationLib.js';

const scenarioWorkbenchDraftStore = new Map<string, ScenarioDefinition>();

export function readStoredScenarioDraft(id: string): ScenarioDefinition | null {
  const stored = scenarioWorkbenchDraftStore.get(id);
  if (!stored) return null;
  try {
    return normalizeScenarioHarness(cloneDefinition(stored));
  } catch {
    scenarioWorkbenchDraftStore.delete(id);
    return null;
  }
}

export function writeStoredScenarioDraft(draft: ScenarioDefinition | null): void {
  if (!draft || !draft.id) return;
  try {
    scenarioWorkbenchDraftStore.set(draft.id, cloneDefinition(draft));
  } catch { /* 草稿快照失败不影响编辑 */ }
}

/**
 * 全局增量草稿通道（2026-08-29 刘总要求：切页期间编译照常逐块写入）。
 * 组件卸载时页面级订阅随之注销，主进程推送的中间快照会无人接收——
 * 表现为"切回后等全部跑完一次性写入"。此模块级订阅只做一件事：
 * 把每份中间草稿实时写进跨页 store；挂载时的恢复逻辑自然读到最新态。
 */
let scenarioDraftFeedRegistered = false;
export function ensureScenarioDraftFeed(): void {
  if (scenarioDraftFeedRegistered) return;
  const metis = typeof window !== 'undefined' ? window.metis : undefined;
  if (!metis?.onScenarioDraftUpdated) return;
  scenarioDraftFeedRegistered = true;
  try {
    metis.onScenarioDraftUpdated((update: { sessionId: string; scenario: ScenarioDefinition; summaries: readonly string[] }) => {
      if (!update?.scenario?.id) return;
      try {
        writeStoredScenarioDraft(normalizeScenarioHarness(cloneDefinition(update.scenario)));
      } catch { /* 快照失败不影响编译本身 */ }
    });
  } catch { /* 订阅失败不阻塞页面 */ }
}

/** 用户明确丢弃草稿时同步清缓存，避免被丢弃的编辑以幽灵草稿复活。 */
export function clearStoredScenarioDraft(id: string): void {
  scenarioWorkbenchDraftStore.delete(id);
}

/** 测试隔离钩子：jsdom 模块单次加载，用例间清空跨页草稿。 */
export function resetScenarioWorkbenchDraftStoreForTests(): void {
  scenarioWorkbenchDraftStore.clear();
}
