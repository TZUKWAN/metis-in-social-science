/**
 * Composer 键盘处理工厂（2026-09-15 拆分）。
 *
 * 从 ChatPage 迁出 composer textarea 的 handleKeyDown：IME 组合输入中
 * （isComposing）不处理；事件先交给斜杠命令列表框的键盘导航，被消费则
 * 返回；否则 Enter（无 Shift）阻止默认换行并发送，Shift+Enter 始终保留
 * 换行。宿主依赖（斜杠键盘处理与发送回调）经 deps 显式注入；宿主每渲染
 * 重建工厂，闭包取当前渲染快照，与迁出前的内联函数声明等价。
 * 纯移动，行为语义不变。
 */
import type { KeyboardEvent } from 'react';

export interface ComposerKeyDownHandlerDeps {
  /** 斜杠命令列表框键盘导航（消费事件时返回 true，来自 useSlashCommands）。 */
  handleSlashKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** 发送当前输入（宿主每渲染重建的快照闭包）。 */
  handleSend: () => void | Promise<void>;
}

/**
 * 构建 composer textarea 的 onKeyDown 处理器。
 */
export function createComposerKeyDownHandler(
  deps: ComposerKeyDownHandlerDeps,
): (e: KeyboardEvent<HTMLTextAreaElement>) => void {
  const { handleSlashKeyDown, handleSend } = deps;
  // Handle the slash listbox before Enter-to-send. Shift+Enter always preserves a newline.
  return function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing) return;
    if (handleSlashKeyDown(e)) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };
}
