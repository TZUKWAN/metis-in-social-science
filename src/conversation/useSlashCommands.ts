/**
 * useSlashCommands — 斜杠命令建议状态机（2026-09-13 拆分）。
 *
 * 从 ChatPage 迁出：建议列表过滤、菜单开关/忽略态、键盘导航（↑↓/Home/
 * End/Escape/Enter/Tab）与补全。宿主注入输入框值、setter 与 ref；
 * 键盘事件返回值表示「是否已被斜杠菜单消费」，宿主据此决定是否继续
 * Enter-to-send，行为与迁出前完全一致。
 */
import { useCallback, useState, type KeyboardEvent, type RefObject } from 'react';
import { filterSlashCommands, type SlashCommand } from '../lib/slashCommands';

export interface SlashCommandState {
  /** 当前输入（以「/」开头时）命中的建议列表。 */
  slashSuggestions: SlashCommand[];
  /** 建议菜单是否展开。 */
  slashMenuOpen: boolean;
  /** 当前高亮项（钳制在列表范围内）。 */
  activeSlashIndex: number;
  /** 直接设置高亮项（菜单项 onMouseEnter 使用）。 */
  setSlashActiveIndex: (index: number) => void;
  /** 用选中命令补全输入框并重新聚焦。 */
  completeSlashCommand: (index: number) => void;
  /**
   * 键盘事件先交给斜杠菜单处理；返回 true 表示已消费（宿主不得再触发发送）。
   */
  handleSlashKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** 输入变化时重置高亮与忽略态（宿主 onChange 调用）。 */
  resetSlashTracking: () => void;
}

export function useSlashCommands(options: {
  input: string;
  setInput: (value: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}): SlashCommandState {
  const { input, setInput, inputRef } = options;
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [slashMenuDismissed, setSlashMenuDismissed] = useState(false);

  const slashSuggestions = (() => {
    if (slashMenuDismissed || !input.startsWith('/') || input.length > 80 || /\s/.test(input.slice(1))) return [];
    return filterSlashCommands(input.slice(1));
  })();
  const slashMenuOpen = slashSuggestions.length > 0;
  const activeSlashIndex = Math.min(slashActiveIndex, Math.max(0, slashSuggestions.length - 1));

  const completeSlashCommand = useCallback((index: number) => {
    const command = slashSuggestions[index];
    if (!command) return;
    setInput(`/${command.name}${command.hasArg ? ' ' : ''}`);
    setSlashActiveIndex(0);
    setSlashMenuDismissed(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [slashSuggestions, setInput, inputRef]);

  // Handle the slash listbox before Enter-to-send. Shift+Enter always preserves a newline.
  const handleSlashKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!slashMenuOpen) return false;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSlashActiveIndex((current) => (current + 1) % slashSuggestions.length);
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSlashActiveIndex((current) => (current - 1 + slashSuggestions.length) % slashSuggestions.length);
      return true;
    }
    if (e.key === 'Home') {
      e.preventDefault();
      setSlashActiveIndex(0);
      return true;
    }
    if (e.key === 'End') {
      e.preventDefault();
      setSlashActiveIndex(slashSuggestions.length - 1);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setSlashMenuDismissed(true);
      return true;
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
      e.preventDefault();
      completeSlashCommand(activeSlashIndex);
      return true;
    }
    return false;
  }, [slashMenuOpen, slashSuggestions, activeSlashIndex, completeSlashCommand]);

  const resetSlashTracking = useCallback(() => {
    setSlashActiveIndex(0);
    setSlashMenuDismissed(false);
  }, []);

  return {
    slashSuggestions,
    slashMenuOpen,
    activeSlashIndex,
    setSlashActiveIndex,
    completeSlashCommand,
    handleSlashKeyDown,
    resetSlashTracking,
  };
}
