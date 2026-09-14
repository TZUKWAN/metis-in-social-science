/**
 * 返修工作台（P4）：粘贴 Decision Letter → 确定性拆解（原文逐字保留）→
 * 逐条意见处理（回复文本/状态）→ 汇总 Response to Reviewers 成果。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from '../../i18n';
import type { ReviewRound, ReviewerComment } from '../../../engine/submission/SubmissionReviewContract.js';
import type { SubmissionCase } from '../../../engine/submission/SubmissionRuntimeContract.js';
import { journalApi } from './shared';

export function SubmissionRevisionSection({ projectId, caseItem, onRefresh }: {
  projectId: string;
  caseItem: SubmissionCase;
  onRefresh: () => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const api = journalApi();
  const [letterText, setLetterText] = useState('');
  const [rounds, setRounds] = useState<Array<ReviewRound & { comments: ReviewerComment[] }>>([]);
  const [busy, setBusy] = useState<'' | 'parse' | 'revision' | 'response'>('');
  const [message, setMessage] = useState('');
  const [draftResponses, setDraftResponses] = useState<Record<string, string>>({});
  const [selectedCommentId, setSelectedCommentId] = useState('');
  const [goalMessage, setGoalMessage] = useState('');
  // 倒计时基准时间：渲染期不许调用 Date.now（react-hooks/purity），用状态快照。
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    // 每小时刷新一次倒计时基准（初始值已在 useState 初始化器里同步取）。
    const timer = setInterval(() => setNowMs(Date.now()), 60 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const rows = await api?.listSubmissionReviewRounds?.({ projectId, caseId: caseItem.id });
      if (alive && rows) setRounds(rows);
    })();
    return () => { alive = false; };
  }, [projectId, caseItem.id, api]);

  const allComments = rounds.flatMap((round) => round.comments);
  const selectedComment = allComments.find((comment) => comment.id === selectedCommentId) ?? null;
  const latestRoundWithDeadline = rounds.find((round) => round.deadline !== null) ?? null;

  /** 距返修截止的自然语言倒计时（过期如实显示已过期）。 */
  function deadlineCountdown(deadline: number): string {
    if (!nowMs) return '';
    const days = Math.ceil((deadline - nowMs) / 86_400_000);
    if (days > 0) return t('submissionHub.daysLeft', { days });
    if (days === 0) return t('submissionHub.dueToday');
    return t('submissionHub.overdueBy', { days: -days });
  }

  /** 把最新轮次的返修截止日期同步到任务板（Goal）。幂等。 */
  async function syncDeadline(): Promise<void> {
    const target = latestRoundWithDeadline;
    if (!target || busy) return;
    setBusy('response'); setGoalMessage('');
    const result = await window.metis?.syncSubmissionDeadlineToGoal?.({ projectId, caseId: caseItem.id, roundId: target.id });
    if (result?.ok) setGoalMessage(t('submissionHub.goalSynced'));
    else setGoalMessage(t('submissionHub.journalActionFailed', { code: result && !result.ok ? result.code : 'failed' }));
    setBusy('');
  }

  async function parseLetter(): Promise<void> {
    if (!api?.createSubmissionReviewRound || busy) return;
    if (!letterText.trim()) { setMessage(t('submissionHub.letterEmpty')); return; }
    setBusy('parse'); setMessage('');
    const result = await api.createSubmissionReviewRound({ projectId, caseId: caseItem.id, decisionLetterText: letterText });
    if (result?.ok) {
      const rows = await api.listSubmissionReviewRounds?.({ projectId, caseId: caseItem.id });
      if (rows) setRounds(rows);
      const count = result.parsed.reviewerComments.length + result.parsed.editorComments.length;
      setMessage(result.parsed.decision === 'unclear'
        ? t('submissionHub.parsedUnclear')
        : `${t('submissionHub.parsedOk', { decision: result.parsed.decision, count })}${result.parsed.deadline ? ` ${t('submissionHub.deadlineAt', { date: new Date(result.parsed.deadline).toLocaleDateString() })}` : ` ${t('submissionHub.noDeadline')}`}`);
      setLetterText('');
    } else {
      setMessage(t('submissionHub.journalActionFailed', { code: result && 'code' in result ? result.code : 'failed' }));
    }
    setBusy('');
  }

  async function beginRevision(): Promise<void> {
    if (!api?.beginSubmissionRevision || busy) return;
    setBusy('revision'); setMessage('');
    const result = await api.beginSubmissionRevision({ projectId, caseId: caseItem.id });
    if (result?.ok) await onRefresh();
    else setMessage(t('submissionHub.journalActionFailed', { code: result && 'code' in result ? result.code : 'failed' }));
    setBusy('');
  }

  async function saveResponse(commentId: string): Promise<void> {
    const text = draftResponses[commentId];
    if (!api?.updateSubmissionReviewComment || !text?.trim()) return;
    const updated = await api.updateSubmissionReviewComment({ projectId, commentId, patch: { responseText: text, status: 'addressed' } });
    if (updated) {
      setRounds((current) => current.map((round) => ({
        ...round,
        comments: round.comments.map((comment) => (comment.id === updated.id ? updated : comment)),
      })));
      setDraftResponses((current) => ({ ...current, [commentId]: '' }));
    }
  }

  async function generateResponse(): Promise<void> {
    if (!api?.generateSubmissionResponseLetter || busy) return;
    setBusy('response'); setMessage('');
    const result = await api.generateSubmissionResponseLetter({ projectId, caseId: caseItem.id });
    if (result?.ok) setMessage(t('submissionHub.responseDone', { version: result.version, unresolved: result.unresolvedCount }));
    else setMessage(t('submissionHub.journalActionFailed', { code: result && 'code' in result ? result.code : 'failed' }));
    setBusy('');
  }

  return (
    <div className="submissions-journal submissions-revision" data-testid="submission-revision-section">
      <h3>{t('submissionHub.revisionTitle')}</h3>
      {latestRoundWithDeadline?.deadline && (
        <p className="submissions-deadline" role="status">
          {`${t('submissionHub.deadlineAt', { date: new Date(latestRoundWithDeadline.deadline).toLocaleDateString() })} · ${deadlineCountdown(latestRoundWithDeadline.deadline)}`}
          <button type="button" className="submissions-secondary" disabled={busy !== ''} onClick={() => void syncDeadline()}>
            {t('submissionHub.syncToTaskBoard')}
          </button>
        </p>
      )}
      {/* 返修工作台：左 意见树 / 中 选中意见与回复 / 右 返修动作 */}
      <div className="submissions-revision__grid">
        <div className="submissions-revision__col submissions-revision__tree" aria-label={t('submissionHub.revisionComments')}>
          <details open={rounds.length === 0}>
            <summary>{t('submissionHub.pasteLetter')}</summary>
            <p><small>{t('submissionHub.pasteLetterHint')}</small></p>
            <textarea aria-label={t('submissionHub.pasteLetter')} rows={8} value={letterText} onChange={(event) => setLetterText(event.target.value)} />
            <button type="button" className="submissions-secondary" disabled={busy !== ''} onClick={() => void parseLetter()}>
              {busy === 'parse' ? t('submissionHub.parsing') : t('submissionHub.parseLetter')}
            </button>
          </details>
          {rounds.length === 0 && <p className="submissions-empty">{t('submissionHub.noRounds')}</p>}
          {rounds.map((round) => (
            <div key={round.id} className="submissions-journal__group">
              <strong>{`#${round.roundNo} · ${t(`submissionHub.decisionLabels.${round.decision}`)}`}{round.deadline ? ` · ${deadlineCountdown(round.deadline)}` : ''}</strong>
              <ul>
                {round.comments.map((comment) => (
                  <li key={comment.id}>
                    <button type="button" className={`submissions-comment-link${comment.id === selectedCommentId ? ' active' : ''}`}
                      onClick={() => setSelectedCommentId(comment.id)}>
                      <span className="submissions-tier">{comment.reviewerLabel || 'Reviewer'}</span>
                      {' '}
                      <span className={`submissions-tier ${comment.status === 'addressed' ? 'ok' : ''}`}>{t(`submissionHub.commentStatusLabels.${comment.status}`)}</span>
                      <span className="submissions-comment-snippet">{comment.originalText.slice(0, 60)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="submissions-revision__col" aria-label={t('submissionHub.originalComment')}>
          {!selectedComment && <p className="submissions-empty">{t('submissionHub.selectComment')}</p>}
          {selectedComment && (
            <>
              <div className="submissions-journal__meta">
                <span className="submissions-tier">{selectedComment.reviewerLabel || 'Reviewer'}</span>
                <span className={`submissions-tier ${selectedComment.status === 'addressed' ? 'ok' : ''}`}>{t(`submissionHub.commentStatusLabels.${selectedComment.status}`)}</span>
              </div>
              <blockquote>{selectedComment.originalText}</blockquote>
              {selectedComment.responseText
                ? <p><strong>Response:</strong> {selectedComment.responseText}</p>
                : (
                  <div className="submissions-response-edit">
                    <textarea aria-label={t('submissionHub.saveResponse')} rows={5} placeholder={t('submissionHub.responsePlaceholder')}
                      value={draftResponses[selectedComment.id] ?? ''} readOnly={false}
                      onChange={(event) => setDraftResponses((current) => ({ ...current, [selectedComment.id]: event.target.value }))} />
                    <button type="button" className="submissions-secondary" onClick={() => void saveResponse(selectedComment.id)}>{t('submissionHub.saveResponse')}</button>
                  </div>
                )}
            </>
          )}
        </div>
        <div className="submissions-revision__col" aria-label={t('submissionHub.revisionAssistant')}>
          {caseItem.status === 'REVISION_REQUIRED' && (
            <button type="button" className="submissions-primary" disabled={busy !== ''} onClick={() => void beginRevision()}>
              {busy === 'revision' ? t('submissionHub.working') : t('submissionHub.beginRevision')}
            </button>
          )}
          <button type="button" className="submissions-secondary" disabled={busy !== '' || rounds.length === 0} onClick={() => void generateResponse()}>
            {busy === 'response' ? t('submissionHub.generatingResponse') : t('submissionHub.generateResponse')}
          </button>
          {goalMessage && <p><small>{goalMessage}</small></p>}
        </div>
      </div>
      {message && <p className="submissions-notice" role="status">{message}</p>}
    </div>
  );
}
