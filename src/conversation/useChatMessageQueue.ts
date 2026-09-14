/**
 * useChatMessageQueue — 2.5 消息排队（刘总 2026-09）。
 *
 * 运行中用户发送的消息自动排队，小条展示（立即发送/编辑/删除）。任何 run
 * （聊天/Goal 执行/恢复/取消）结算后由宿主调用 flushNext() 依序补发；
 * 补发撞上新一轮 run 时由宿主 requeueFront 放回队首，保持 FIFO 语义。
 * 从 ChatPage 迁出（2026-09-13 拆分）。
 */
import { useCallback, useState } from 'react';

export interface QueuedMessage {
  id: number;
  text: string;
}

export interface ChatMessageQueueOptions {
  send: (text: string, options?: { fromQueue?: boolean; immediate?: boolean }) => Promise<void> | void;
}

function newQueueId(): number {
  return Date.now() + Math.floor(Math.random() * 1000);
}

export function useChatMessageQueue({ send }: ChatMessageQueueOptions) {
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);

  /** 运行中用户按下发送：进入队尾。 */
  const enqueue = useCallback((text: string) => {
    setQueuedMessages((current) => [...current, { id: newQueueId(), text }]);
  }, []);

  /** 队列自动补发撞上新一轮 run：放回队首（不是引导）。 */
  const requeueFront = useCallback((text: string) => {
    setQueuedMessages((current) => [{ id: newQueueId(), text }, ...current]);
  }, []);

  /** 删除一条排队消息（小条 × 按钮）。 */
  const remove = useCallback((id: number) => {
    setQueuedMessages((current) => current.filter((item) => item.id !== id));
  }, []);

  /** 编辑：放回输入框（宿主负责 setInput/聚焦），并从队列移除。 */
  const takeForEdit = useCallback((id: number): QueuedMessage | null => {
    let taken: QueuedMessage | null = null;
    setQueuedMessages((current) => current.filter((item) => {
      if (item.id === id) { taken = item; return false; }
      return true;
    }));
    return taken;
  }, []);

  /** 小条「立即发送」：显式插队，作为实时引导下发给当前 run。 */
  const sendNow = useCallback((text: string) => {
    void send(text, { fromQueue: true, immediate: true });
  }, [send]);

  /**
   * 统一队列收口：任何一个 run 结算后从这里补发下一条排队消息。若补发时
   * 又有 run 在跑，宿主的 send 路径会把它放回队首而不是变成引导。
   */
  const flushNext = useCallback(() => {
    window.setTimeout(() => {
      setQueuedMessages((current) => {
        if (current.length === 0) return current;
        const next = current[0]!;
        window.setTimeout(() => { void send(next.text, { fromQueue: true }); }, 50);
        return current.slice(1);
      });
    }, 100);
  }, [send]);

  return { queuedMessages, enqueue, requeueFront, remove, takeForEdit, sendNow, flushNext };
}
