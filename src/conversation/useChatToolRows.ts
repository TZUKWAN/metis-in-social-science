/**
 * useChatToolRows — 2.4 Harness 式工具行状态（刘总 2026-09）。
 *
 * 订阅主进程 chat:tool-event：running 行按 toolCallId 去重，done/failed
 * 原位更新；run 结束（isLoading→false）统一收起——完整时间线已随消息
 * 气泡留档。从 ChatPage 迁出（2026-09-13 拆分）。
 */
import { useEffect, useState, type RefObject } from 'react';

export interface LiveToolRow {
  key: string;
  tool: string | null;
  state: 'running' | 'done' | 'failed';
  summary: string | null;
}

export function useChatToolRows(
  activeSessionIdRef: RefObject<string>,
  isLoading: boolean,
): { liveToolRows: LiveToolRow[]; clearToolRows: () => void } {
  const [liveToolRows, setLiveToolRows] = useState<LiveToolRow[]>([]);

  useEffect(() => {
    const subscribe = window.metis?.onChatToolEvent;
    if (!subscribe) return;
    return subscribe((row) => {
      if (row.sessionId !== activeSessionIdRef.current) return;
      setLiveToolRows((current) => {
        const key = row.toolCallId || `tool-${current.length}-${row.tool ?? ''}`;
        if (row.state === 'running') {
          if (current.some((item) => item.key === key)) return current;
          return [...current.slice(-11), { key, tool: row.tool, state: row.state, summary: row.summary ?? null }];
        }
        return current.map((item) => (item.key === key
          ? { ...item, state: row.state, summary: row.summary ?? item.summary }
          : item));
      });
    });
  }, [activeSessionIdRef]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on settle is intentionally deferred to effect order
    if (!isLoading) setLiveToolRows([]);
  }, [isLoading]);

  return { liveToolRows, clearToolRows: () => setLiveToolRows([]) };
}
