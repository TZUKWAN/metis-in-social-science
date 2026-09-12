/**
 * RevisionProposalCard — AI 修订提案卡（任务书 T03.02/T03.03/T03.04/T03.05/T03.08）。
 *
 * 展示 RevisionSet 的每条修订：原文（before）/ 建议文本（after）/ 理由 /
 * 来源与证据引用；逐条 Accept / Reject；「接受全部」在批量时二次确认。
 * Accept 由主进程 OutcomeWorkbenchService 逐条 beforeHash 验证（T03.06：
 * 原文被手改 → outcome_revision_stale，绝不覆盖用户内容），本组件只呈现结果。
 */
import { useCallback, useEffect, useState } from 'react';
import { Check, X, LoaderCircle } from 'lucide-react';

export interface ProposedRevision {
  id: string;
  order: number;
  target: { kind: string; blockId?: string; pageId?: string; elementId?: string; row?: number; column?: number };
  before: unknown;
  after: unknown;
  reason: string;
  sourceRefs: Array<{ kind: string; id: string; label?: string }>;
  evidenceIds: string[];
  status: 'pending' | 'accepted' | 'rejected' | 'stale';
}

export interface ProposedRevisionSet {
  id: string;
  instruction: string;
  createdBy: string;
  status: 'pending' | 'partially_accepted' | 'accepted' | 'rejected' | 'stale' | 'cancelled';
}

const STATUS_LABELS: Record<string, string> = {
  pending: '待定', accepted: '已接受', rejected: '已拒绝', stale: '已过期',
  partially_accepted: '部分接受', cancelled: '已取消',
};

/** 从 after 片段提取人类可读的建议文本。 */
function afterText(after: unknown): string {
  if (typeof after === 'string') return after;
  if (after && typeof after === 'object') {
    const record = after as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (record.title !== undefined || record.elements !== undefined) return '（整页内容更新——保存版本前可在正文中核对）';
  }
  return JSON.stringify(after)?.slice(0, 400) ?? '';
}

function beforeText(before: unknown): string {
  if (typeof before === 'string') return before;
  if (before && typeof before === 'object') {
    const record = before as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
  }
  return JSON.stringify(before)?.slice(0, 400) ?? '';
}

const TARGET_LABELS: Record<string, (target: ProposedRevision['target']) => string> = {
  word_block: (target) => `段落 ${target.blockId}`,
  word_range: (target) => `段落 ${target.blockId} 选区`,
  word_table_cell: (target) => `表格 ${target.blockId}（${(target.row ?? 0) + 1} 行 ${(target.column ?? 0) + 1} 列）`,
  ppt_element: (target) => `页面 ${target.pageId} 元素 ${target.elementId}`,
  ppt_page: (target) => `整页 ${target.pageId}`,
};

export function RevisionProposalCard({ projectId, set, revisions, onDraftUpdated, onNotice, compact }: {
  projectId: string;
  set: ProposedRevisionSet;
  revisions: ProposedRevision[];
  /** 任一修订被接受后回调（宿主把编辑器内容刷新为新草稿）。 */
  onDraftUpdated: (draftContent: unknown) => void;
  onNotice?: (notice: string) => void;
  compact?: boolean;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [localRevisions, setLocalRevisions] = useState(revisions);
  const [setStatus, setSetStatus] = useState(set.status);
  const [summary, setSummary] = useState<string | null>(null);

  useEffect(() => { setLocalRevisions(revisions); setSetStatus(set.status); }, [revisions, set.status]);

  const pendingCount = localRevisions.filter((item) => item.status === 'pending').length;

  const accept = useCallback(async (revision: ProposedRevision) => {
    setBusyId(revision.id);
    try {
      const result = await window.metis?.outcome2RevisionAccept?.({ projectId, setId: set.id, revisionId: revision.id });
      if (result?.ok && result.value) {
        const draft = result.value.draft as { content?: unknown };
        if (draft?.content !== undefined) onDraftUpdated(draft.content);
        setLocalRevisions((current) => current.map((item) => (item.id === revision.id
          ? { ...item, status: 'accepted' as const }
          : item)));
        setSetStatus((result.value.set as { status?: ProposedRevisionSet['status'] }).status ?? setStatus);
      } else if (result && !result.ok) {
        const code = result.code ?? '';
        setLocalRevisions((current) => current.map((item) => (item.id === revision.id && (code === 'outcome_revision_stale' || code === 'outcome_revision_target_missing')
          ? { ...item, status: 'stale' as const }
          : item)));
        onNotice?.(code === 'outcome_revision_stale'
          ? '该位置的原文已被你修改，建议已标记为过期，未覆盖你的内容。'
          : code === 'outcome_revision_target_missing'
            ? '该位置已不存在，建议已标记为过期。'
            : `接受未完成：${code}`);
      }
    } finally {
      setBusyId(null);
    }
  }, [projectId, set.id, onDraftUpdated, onNotice, setStatus]);

  const reject = useCallback(async (revision: ProposedRevision) => {
    setBusyId(revision.id);
    try {
      const result = await window.metis?.outcome2RevisionReject?.({ projectId, setId: set.id, revisionId: revision.id });
      if (result?.ok) {
        setLocalRevisions((current) => current.map((item) => (item.id === revision.id ? { ...item, status: 'rejected' as const } : item)));
      } else if (result && !result.ok) {
        onNotice?.(`拒绝未完成：${result.code ?? ''}`);
      }
    } finally {
      setBusyId(null);
    }
  }, [projectId, set.id, onNotice]);

  const acceptAll = useCallback(async () => {
    if (pendingCount >= 3 && !window.confirm(`确认接受全部 ${pendingCount} 条修改建议？`)) return;
    const result = await window.metis?.outcome2RevisionAcceptSet?.({ projectId, setId: set.id });
    if (result?.ok && result.value) {
      onDraftUpdated(undefined); // 宿主应重新读取 draft
      setSummary(`接受 ${result.value.accepted} · 过期 ${result.value.stale} · 拒绝 ${result.value.rejected}`);
      const refreshed = await window.metis?.outcome2RevisionGetSet?.({ projectId, setId: set.id });
      if (refreshed) setLocalRevisions((refreshed.revisions ?? []) as ProposedRevision[]);
      setSetStatus((refreshed?.set as { status?: ProposedRevisionSet['status'] } | null)?.status ?? setStatus);
    }
  }, [pendingCount, projectId, set.id, onDraftUpdated, setStatus]);

  const rejectAll = useCallback(async () => {
    if (pendingCount >= 3 && !window.confirm(`确认拒绝全部 ${pendingCount} 条修改建议？`)) return;
    const result = await window.metis?.outcome2RevisionRejectSet?.({ projectId, setId: set.id });
    if (result?.ok) {
      const refreshed = await window.metis?.outcome2RevisionGetSet?.({ projectId, setId: set.id });
      if (refreshed) setLocalRevisions((refreshed.revisions ?? []) as ProposedRevision[]);
      setSetStatus((refreshed?.set as { status?: ProposedRevisionSet['status'] } | null)?.status ?? setStatus);
    }
  }, [pendingCount, projectId, set.id, setStatus]);

  return (
    <section className="revision-card" data-testid="revision-proposal-card" aria-label="AI 修改建议">
      <header className="revision-card__head">
        <strong>{compact ? '修改建议' : 'AI 修改建议'}</strong>
        <span className="revision-card__status">{STATUS_LABELS[setStatus] ?? setStatus}</span>
        {pendingCount > 1 && (
          <span className="revision-card__bulk">
            <button type="button" className="revision-card__btn" onClick={() => void acceptAll()} disabled={busyId !== null}>接受全部</button>
            <button type="button" className="revision-card__btn" onClick={() => void rejectAll()} disabled={busyId !== null}>拒绝全部</button>
          </span>
        )}
      </header>
      {set.instruction && !compact && <p className="revision-card__instruction">指令：{set.instruction}</p>}
      {summary && <p className="revision-card__summary" role="status">{summary}（未创建正式版本；「保存版本」后才会进入版本历史）</p>}
      <ul className="revision-card__list">
        {localRevisions.map((revision, index) => (
          <li key={revision.id} className={`revision-card__item revision-card__item--${revision.status}`} data-testid={`revision-item-${index}`}>
            <div className="revision-card__target">
              {TARGET_LABELS[revision.target.kind]?.(revision.target) ?? revision.target.kind}
              <span className={`revision-card__pill revision-card__pill--${revision.status}`}>{STATUS_LABELS[revision.status] ?? revision.status}</span>
            </div>
            {revision.status === 'stale'
              ? <p className="revision-card__stale">该修改建议基于旧内容，不能直接应用。</p>
              : (
                <>
                  <div className="revision-card__diff">
                    <del>{beforeText(revision.before) || '（空）'}</del>
                    <ins>{afterText(revision.after)}</ins>
                  </div>
                  {revision.reason && <p className="revision-card__reason">理由：{revision.reason}</p>}
                  {(revision.sourceRefs.length > 0 || revision.evidenceIds.length > 0) && (
                    <p className="revision-card__refs">
                      {revision.sourceRefs.length > 0 && <span>来源 {revision.sourceRefs.length}</span>}
                      {revision.evidenceIds.length > 0 && <span>证据 {revision.evidenceIds.length}</span>}
                    </p>
                  )}
                  {revision.status === 'pending' && (
                    <div className="revision-card__actions">
                      <button type="button" className="revision-card__btn revision-card__btn--accept" data-testid={`revision-accept-${index}`} disabled={busyId !== null} aria-label="接受此修改建议" onClick={() => void accept(revision)}>
                        {busyId === revision.id ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />} 接受
                      </button>
                      <button type="button" className="revision-card__btn" data-testid={`revision-reject-${index}`} disabled={busyId !== null} aria-label="拒绝此修改建议" onClick={() => void reject(revision)}>
                        <X size={13} /> 拒绝
                      </button>
                    </div>
                  )}
                </>
              )}
          </li>
        ))}
      </ul>
      <p className="revision-card__hint">接受只写入工作草稿；点「保存版本」才会创建正式版本。</p>
    </section>
  );
}
