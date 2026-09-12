/**
 * 选题页会话左侧列表 + 会话管理(2026-09 刘总:对话记录回左侧;分类/重命名/删除)。
 *
 * 契约:
 *   1. 会话渲染为左侧竖排列表,按分类分组(命名分类有组标签),归档会话不显示;
 *   2. 条目上的 × 关闭 = 删除,必须先 window.confirm;
 *   3. 会话栏的分类下拉/重命名通过 topicUpdateSession patch 持久化;
 *   4. 新建面板可直接选择/新建分类,随 topicCreateSession 一并提交。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import TopicWorkspacePage from '../../src/pages/TopicWorkspacePage';

type SessionRow = { id: string; title: string; status: string; category?: string | null };

const SESSIONS: SessionRow[] = [
  { id: 's1', title: '劳动社会学选题', status: 'exploring', category: '劳动研究' },
  { id: 's2', title: '平台经济选题', status: 'comparing', category: '劳动研究' },
  { id: 's3', title: '教育技术选题', status: 'exploring', category: null },
  { id: 's4', title: '已归档选题', status: 'archived', category: null },
];

afterEach(() => {
  cleanup();
  (window as unknown as { metis: unknown }).metis = undefined;
  vi.restoreAllMocks();
});

function makeMetis(sessions: SessionRow[]) {
  const metis = {
    topicListSessions: vi.fn(async () => sessions),
    topicGetSession: vi.fn(async (id: string) => ({
      session: sessions.find((row) => row.id === id) ?? { id, title: id, status: 'exploring', category: null },
      candidates: [],
      messages: [],
    })),
    topicCreateSession: vi.fn(async () => ({ ok: true, session: { id: 's-new', title: '新选题', status: 'exploring', category: null } })),
    topicChat: vi.fn(async () => ({ ok: false, code: 'agent_unavailable' })),
    topicUpdateSession: vi.fn(async () => ({})),
    topicDeleteSession: vi.fn(async () => true),
    externalRefList: vi.fn(async () => ({ ok: true, references: [] })),
    onTopicStreamChunk: vi.fn(() => () => {}),
  };
  (window as unknown as { metis: unknown }).metis = metis;
  return metis;
}

describe('Topic workspace 会话左侧列表(分类分组 + 管理操作)', () => {
  it('renders sessions in the left list grouped by category; archived sessions are hidden', async () => {
    makeMetis(SESSIONS);
    render(<TopicWorkspacePage />);
    expect(await screen.findByTestId('topic-session-s1')).toBeTruthy();
    expect(screen.getByTestId('topic-session-s2')).toBeTruthy();
    expect(screen.getByTestId('topic-session-s3')).toBeTruthy();
    // 分组标签:命名分类有组标签;未分类组无标签;归档会话不进列表。
    expect(screen.getByText('劳动研究')).toBeTruthy();
    expect(screen.queryByTestId('topic-session-s4')).toBeNull();
  });

  it('list item close deletes the session only after confirmation', async () => {
    const metis = makeMetis(SESSIONS);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<TopicWorkspacePage />);
    const item = await screen.findByTestId('topic-session-s3');
    fireEvent.click(item.parentElement!.querySelector('.topic-workspace__session-close')!);
    expect(confirmSpy).toHaveBeenCalled();
    expect(metis.topicDeleteSession).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    fireEvent.click(item.parentElement!.querySelector('.topic-workspace__session-close')!);
    await waitFor(() => expect(metis.topicDeleteSession).toHaveBeenCalledWith('s3'));
  });

  it('setting a category via the right-click menu patches via topicUpdateSession', async () => {
    const metis = makeMetis(SESSIONS);
    render(<TopicWorkspacePage />);
    const item = await screen.findByTestId('topic-session-s3');
    fireEvent.contextMenu(item);
    fireEvent.click(await screen.findByRole('menuitem', { name: '移到「劳动研究」' }));
    await waitFor(() => expect(metis.topicUpdateSession).toHaveBeenCalledWith({ sessionId: 's3', patch: { category: '劳动研究' } }));
  });

  it('rename via the right-click menu patches the session title', async () => {
    const metis = makeMetis(SESSIONS);
    render(<TopicWorkspacePage />);
    const item = await screen.findByTestId('topic-session-s1');
    fireEvent.contextMenu(item);
    fireEvent.click(await screen.findByRole('menuitem', { name: '重命名' }));
    const input = await screen.findByTestId('topic-session-rename-input');
    fireEvent.change(input, { target: { value: '新标题' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(metis.topicUpdateSession).toHaveBeenCalledWith({ sessionId: 's1', patch: { title: '新标题' } }));
  });

  it('typing into the composer without a session creates one and auto-names it', async () => {
    const metis = makeMetis(SESSIONS);
    render(<TopicWorkspacePage />);
    // 刘总 2026-09：新建面板已删——直接在底部输入框输入即创建会话并自动命名。
    fireEvent.change(await screen.findByTestId('topic-input'), { target: { value: '想研究零工经济' } });
    fireEvent.click(screen.getByTestId('topic-send'));
    await waitFor(() => expect(metis.topicCreateSession).toHaveBeenCalledWith({ initialIntent: '想研究零工经济' }));
    await waitFor(() => expect(metis.topicUpdateSession).toHaveBeenCalledWith({ sessionId: 's-new', patch: { title: '想研究零工经济' } }));
  });
});
