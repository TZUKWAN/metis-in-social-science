/** 全局 toast 事件助手（与 ToastHost 组件分离，满足 fast-refresh 规则）。 */

export interface ToastEventDetail {
  kind?: 'info' | 'success' | 'error' | string;
  text?: string;
  durationMs?: number;
}

export function showToast(detail: ToastEventDetail): void {
  window.dispatchEvent(new CustomEvent('metis:toast', { detail }));
}
