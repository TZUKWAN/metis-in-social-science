/**
 * 场景编译协调器（2026-08-25 刘总要求）：
 * 把编译 promise 从组件状态提升到模块级单例——用户切换页面时组件卸载，
 * 编译仍在后台继续；回到场景页自动重新挂接（显示后台编译状态），
 * 完成后结果可被重新应用。配合主进程侧的自动保存与历史落库，
 * 实现「AI 助手的工作不被用户操作打断，历史可找回（哪怕未完成）」。
 */
import type { ScenarioDefinition } from '../../engine/runtime/PersonalizationRuntimeContract.js';

export interface ScenarioCompileState {
  scenarioId: string;
  startedAt: number;
  done: boolean;
  ok?: boolean;
  code?: string;
  summary?: string;
  scenario?: ScenarioDefinition;
  autosaved?: boolean;
}

type Listener = (state: ScenarioCompileState) => void;

interface ActiveEntry {
  state: ScenarioCompileState;
  listeners: Set<Listener>;
}

const active = new Map<string, ActiveEntry>();

export function isScenarioCompileActive(scenarioId: string): boolean {
  const entry = active.get(scenarioId);
  return Boolean(entry && !entry.state.done);
}

export function getScenarioCompileState(scenarioId: string): ScenarioCompileState | null {
  return active.get(scenarioId)?.state ?? null;
}

/** 订阅编译状态（挂载即回调一次当前状态）；返回取消订阅函数。 */
export function onScenarioCompileUpdate(scenarioId: string, listener: Listener): () => void {
  const entry = active.get(scenarioId);
  if (!entry) return () => {};
  entry.listeners.add(listener);
  listener(entry.state);
  return () => entry.listeners.delete(listener);
}

/**
 * 跟踪一次编译：run 内部执行真正的 IPC 调用；无论组件是否卸载，
 * promise 都由本模块持有并在完成时广播终态。终态保留 5 分钟供重挂载读取。
 */
export function trackScenarioCompile<T>(
  scenarioId: string,
  run: (notify: (patch: Partial<ScenarioCompileState>) => void) => Promise<T>,
): Promise<T> {
  // 同一场景已有在途编译时不重复发起（调用方应先检查 isScenarioCompileActive）。
  const entry: ActiveEntry = {
    state: { scenarioId, startedAt: Date.now(), done: false },
    listeners: new Set<Listener>(),
  } as ActiveEntry;
  active.set(scenarioId, entry);
  const notify = (patch: Partial<ScenarioCompileState>) => {
    Object.assign(entry.state, patch);
    for (const listener of [...entry.listeners]) {
      try { listener(entry.state); } catch { /* 监听器异常不影响编译 */ }
    }
  };
  const promise = (async () => {
    try {
      return await run(notify);
    } finally {
      notify({ done: true });
      // 终态保留 30 分钟（2026-08-29 刘总要求）：用户切页处理别的事，
      // 回到场景页时仍能看到这轮编译的结果与摘要，而不是空空如也。
      setTimeout(() => {
        if (active.get(scenarioId) === entry) active.delete(scenarioId);
      }, 30 * 60_000);
    }
  })();
  (entry as ActiveEntry & { promise?: Promise<unknown> }).promise = promise;
  return promise;
}
