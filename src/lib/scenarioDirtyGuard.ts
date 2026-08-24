/**
 * 场景未保存守卫（2026-08-23 刘总要求）：
 * 场景工作台在存在未保存编辑时注册同步确认回调；
 * App 层任何会离开场景工作台页面的导航都必须先经过它。
 *
 * 调用方把「真正要执行的导航动作」一并传入：守卫放行时返回 true，
 * 由调用方立即执行；拦截时返回 false，并把动作暂存给确认弹窗，
 * 用户选择「不保存并离开 / 保存并离开」后由弹窗补执行该动作。
 */
export type ScenarioDirtyGuard = (action: () => void) => boolean;

let guard: ScenarioDirtyGuard | null = null;

export function setScenarioDirtyGuard(next: ScenarioDirtyGuard | null): void {
  guard = next;
}

/** true 表示可以安全离开（调用方应立即执行 action）；false 表示用户取消了离开。 */
export function confirmLeaveScenario(action: () => void): boolean {
  try {
    return guard ? guard(action) : true;
  } catch {
    return true;
  }
}
