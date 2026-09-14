/**
 * 投稿通信区（P3）：邮箱账户同步收件、全项目待确认收件的确认/否认、
 * 本 Case 通信时间线，以及「预览 → 确认」两段式发信（operationId 幂等）。
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '../../i18n';
import type { SubmissionCorrespondence } from '../../../engine/submission/SubmissionCorrespondenceContract.js';
import type { SubmissionCase } from '../../../engine/submission/SubmissionRuntimeContract.js';

/** 邮箱账户的渲染端视图（不含授权码，与 preload 返回一致）。 */
interface MailAccountLite { id: string; label: string; user: string; host: string }

interface MailPreviewState {
  accountLabel: string;
  from: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  attachments: Array<{ filename: string; source: 'content' | 'path' | 'empty' }>;
  smtp: { host: string; port: number; secure: boolean } | null;
}

const ROUNDABLE_CLASSIFICATIONS = ['decision_letter', 'revision_request'];

export function SubmissionCorrespondenceSection({ projectId, caseItem, onRefresh }: {
  projectId: string;
  caseItem: SubmissionCase;
  onRefresh: () => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const [accounts, setAccounts] = useState<MailAccountLite[]>([]);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [accountId, setAccountId] = useState('');
  const [pending, setPending] = useState<SubmissionCorrespondence[]>([]);
  const [timeline, setTimeline] = useState<SubmissionCorrespondence[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState<'' | 'sync' | 'preview' | 'send' | 'round'>('');
  const [message, setMessage] = useState('');
  const [composeOpen, setComposeOpen] = useState(false);
  const [compose, setCompose] = useState({ to: '', cc: '', bcc: '', subject: '', bodyText: '', attachments: '' });
  const [operationId, setOperationId] = useState('');
  const [preview, setPreview] = useState<MailPreviewState | null>(null);
  const [composeNote, setComposeNote] = useState('');

  const loadData = useCallback(async () => {
    const api = window.metis;
    if (!api?.listSubmissionMailAccounts || !api?.listPendingSubmissionCorrespondence || !api?.listSubmissionCorrespondence) {
      setLoadError(true);
      return;
    }
    try {
      const [accountRows, pendingRows, timelineRows] = await Promise.all([
        api.listSubmissionMailAccounts(),
        api.listPendingSubmissionCorrespondence({ projectId }),
        api.listSubmissionCorrespondence({ projectId, caseId: caseItem.id }),
      ]);
      setAccounts(accountRows);
      setAccountsLoaded(true);
      setAccountId((current) => (accountRows.some((row) => row.id === current) ? current : accountRows[0]?.id ?? ''));
      setPending(pendingRows);
      setTimeline(timelineRows);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, [projectId, caseItem.id]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      // 让出微任务，避免在 effect 体内同步 setState 引发级联渲染。
      await Promise.resolve();
      if (alive) await loadData();
    })();
    return () => { alive = false; };
  }, [loadData]);

  async function sync(): Promise<void> {
    if (!window.metis?.syncSubmissionMail || !accountId || busy) return;
    setBusy('sync'); setMessage('');
    const result = await window.metis.syncSubmissionMail({ projectId, accountId });
    if (result?.ok) {
      setMessage(t('submissionHub.mail.syncResult', {
        fetched: result.fetched, recorded: result.recorded, duplicates: result.duplicates, pending: result.pending,
      }));
    } else {
      setMessage(t('submissionHub.mail.syncFailed', {
        code: result && 'code' in result ? result.code : 'failed',
        message: result && 'message' in result ? result.message : '',
      }));
    }
    await loadData();
    setBusy('');
  }

  async function confirmMatch(id: string): Promise<void> {
    if (!window.metis?.confirmSubmissionCorrespondenceMatch) return;
    const result = await window.metis.confirmSubmissionCorrespondenceMatch({ projectId, id, caseId: caseItem.id });
    if (result?.ok) { setMessage(t('submissionHub.mail.matchConfirmed')); await loadData(); }
    else setMessage(t('submissionHub.mail.actionFailed', { code: result && 'code' in result ? result.code : 'failed' }));
  }

  async function rejectMatch(id: string): Promise<void> {
    if (!window.metis?.rejectSubmissionCorrespondenceMatch) return;
    const result = await window.metis.rejectSubmissionCorrespondenceMatch({ projectId, id });
    if (result?.ok) { setMessage(t('submissionHub.mail.matchRejected')); await loadData(); }
    else setMessage(t('submissionHub.mail.actionFailed', { code: result && 'code' in result ? result.code : 'failed' }));
  }

  async function toRound(id: string): Promise<void> {
    if (!window.metis?.createSubmissionRoundFromCorrespondence || busy) return;
    setBusy('round'); setMessage('');
    const result = await window.metis.createSubmissionRoundFromCorrespondence({ projectId, id });
    if (result?.ok) {
      setMessage(t('submissionHub.mail.roundDone'));
      await onRefresh();
    } else {
      setMessage(t('submissionHub.mail.actionFailed', { code: result && 'code' in result ? result.code : 'failed' }));
    }
    setBusy('');
  }

  function openCompose(): void {
    setCompose({ to: '', cc: '', bcc: '', subject: '', bodyText: '', attachments: '' });
    // 幂等键：整个发送会话（含失败重试）共用同一个 operationId。
    setOperationId(crypto.randomUUID());
    setPreview(null);
    setComposeNote('');
    setComposeOpen(true);
  }

  function composeAttachments(): Array<{ filename: string; path: string }> {
    return compose.attachments.split('\n').map((line) => line.trim()).filter(Boolean)
      .map((path) => ({ filename: path.split(/[\\/]/).pop() || path, path }));
  }

  async function previewMail(): Promise<void> {
    if (!window.metis?.previewSubmissionMail || !accountId || busy) return;
    setBusy('preview'); setComposeNote('');
    const result = await window.metis.previewSubmissionMail({
      accountId,
      to: compose.to.trim(),
      cc: compose.cc.trim() || undefined,
      bcc: compose.bcc.trim() || undefined,
      subject: compose.subject,
      bodyText: compose.bodyText,
      attachments: composeAttachments(),
    });
    if (result?.ok) setPreview(result.preview);
    else setComposeNote(t('submissionHub.mail.previewFailed', {
      code: result && 'code' in result ? result.code : 'failed',
      message: result && 'message' in result ? result.message : '',
    }));
    setBusy('');
  }

  async function sendMail(): Promise<void> {
    if (!window.metis?.sendSubmissionMail || !accountId || busy) return;
    setBusy('send'); setComposeNote('');
    const result = await window.metis.sendSubmissionMail({
      projectId,
      caseId: caseItem.id,
      accountId,
      operationId,
      to: compose.to.trim(),
      cc: compose.cc.trim() || undefined,
      bcc: compose.bcc.trim() || undefined,
      subject: compose.subject,
      bodyText: compose.bodyText,
      attachments: composeAttachments(),
      confirmed: true,
    });
    if (result?.ok) {
      setComposeOpen(false);
      setPreview(null);
      setMessage(result.alreadySent ? t('submissionHub.mail.sentDuplicate') : t('submissionHub.mail.sentOk'));
      await loadData();
    } else {
      // 发送失败：保持弹层与 operationId 不变，用户重试不会产生第二封邮件。
      setComposeNote(t('submissionHub.mail.sendFailed', {
        code: result && 'code' in result ? result.code : 'failed',
        message: result && 'message' in result ? result.message : '',
      }));
    }
    setBusy('');
  }

  return (
    <div className="submissions-journal submissions-mail" data-testid="submissions-mail-section">
      <h3>{t('submissionHub.mail.title')}</h3>
      {loadError && <p className="submissions-gap__problem" role="alert">{t('submissionHub.mail.loadFailed')}</p>}
      <div className="submissions-mail__toolbar">
        <label>
          <span>{t('submissionHub.mail.accountLabel')}</span>
          <select value={accountId} aria-label={t('submissionHub.mail.accountLabel')}
            onChange={(event) => setAccountId(event.target.value)}>
            {accounts.length === 0 && <option value="">—</option>}
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>{account.label || account.user}（{account.host}）</option>
            ))}
          </select>
        </label>
        <button type="button" className="submissions-secondary" data-testid="submissions-mail-sync"
          disabled={!accountId || busy !== ''} onClick={() => void sync()}>
          {busy === 'sync' ? t('submissionHub.mail.syncing') : t('submissionHub.mail.syncInbox')}
        </button>
        <button type="button" className="submissions-primary" data-testid="submissions-mail-compose"
          disabled={accounts.length === 0} onClick={openCompose}>
          {t('submissionHub.mail.compose')}
        </button>
      </div>
      {accountsLoaded && accounts.length === 0 && (
        <p className="submissions-notice" role="status">{t('submissionHub.mail.noAccounts')}</p>
      )}
      {message && <p className="submissions-notice" role="status">{message}</p>}

      <h4 className="submissions-mail__subtitle">{t('submissionHub.mail.pendingTitle')}</h4>
      {pending.length === 0 && <p className="submissions-empty">{t('submissionHub.mail.pendingEmpty')}</p>}
      <ul className="submissions-mail__list" data-testid="submissions-mail-pending">
        {pending.map((item) => (
          <li key={item.id} className="submissions-mail__item">
            <div className="submissions-journal__meta">
              <strong>{item.subject || t('submissionHub.mail.noSubject')}</strong>
              <span className="submissions-badge">{t(`submissionHub.mail.classLabels.${item.classification}`)}</span>
            </div>
            <div className="submissions-journal__meta">
              <small>{item.fromAddr}</small>
              <small>{item.receivedAt ? new Date(item.receivedAt).toLocaleString() : '—'}</small>
            </div>
            {item.matchReason && <p><small>{t('submissionHub.mail.matchReason')}：{item.matchReason}</small></p>}
            <div className="submissions-package-actions">
              <button type="button" className="submissions-secondary" data-testid="submissions-mail-confirm"
                onClick={() => void confirmMatch(item.id)}>{t('submissionHub.mail.confirmMatch')}</button>
              <button type="button" className="submissions-secondary" data-testid="submissions-mail-reject"
                onClick={() => void rejectMatch(item.id)}>{t('submissionHub.mail.rejectMatch')}</button>
            </div>
          </li>
        ))}
      </ul>

      <h4 className="submissions-mail__subtitle">{t('submissionHub.mail.timelineTitle')}</h4>
      {timeline.length === 0 && <p className="submissions-empty">{t('submissionHub.mail.timelineEmpty')}</p>}
      <ul className="submissions-mail__list" data-testid="submissions-mail-timeline">
        {timeline.map((item) => (
          <li key={item.id} className="submissions-mail__item">
            <div className="submissions-journal__meta">
              <span className={`submissions-tier ${item.direction === 'out' ? 'ok' : ''}`}>
                {t(item.direction === 'in' ? 'submissionHub.mail.directionIn' : 'submissionHub.mail.directionOut')}
              </span>
              <strong>{item.subject || t('submissionHub.mail.noSubject')}</strong>
              <span className="submissions-badge">{t(`submissionHub.mail.classLabels.${item.classification}`)}</span>
              <small>{(item.receivedAt ?? item.sentAt) ? new Date((item.receivedAt ?? item.sentAt)!).toLocaleString() : '—'}</small>
            </div>
            {item.direction === 'in' && item.matchStatus === 'matched' && ROUNDABLE_CLASSIFICATIONS.includes(item.classification) && (
              <button type="button" className="submissions-secondary" data-testid="submissions-mail-to-round"
                disabled={busy !== ''} onClick={() => void toRound(item.id)}>
                {busy === 'round' ? t('submissionHub.working') : t('submissionHub.mail.toRound')}
              </button>
            )}
          </li>
        ))}
      </ul>

      {composeOpen && (
        <div className="outcomes-modal-backdrop" role="presentation">
          <div className="outcomes-modal submissions-mail__compose" role="dialog" aria-modal="true" aria-label={t('submissionHub.mail.composeTitle')}>
            <header><strong>{t('submissionHub.mail.composeTitle')}</strong><button type="button" onClick={() => setComposeOpen(false)} aria-label="关闭">×</button></header>
            <label>{t('submissionHub.mail.fieldTo')}
              <input className="settings-input" value={compose.to} aria-label={t('submissionHub.mail.fieldTo')}
                onChange={(event) => { setCompose((current) => ({ ...current, to: event.target.value })); setPreview(null); }} />
            </label>
            <label>{t('submissionHub.mail.fieldCc')}
              <input className="settings-input" value={compose.cc} aria-label={t('submissionHub.mail.fieldCc')}
                onChange={(event) => { setCompose((current) => ({ ...current, cc: event.target.value })); setPreview(null); }} />
            </label>
            <label>{t('submissionHub.mail.fieldBcc')}
              <input className="settings-input" value={compose.bcc} aria-label={t('submissionHub.mail.fieldBcc')}
                onChange={(event) => { setCompose((current) => ({ ...current, bcc: event.target.value })); setPreview(null); }} />
            </label>
            <label>{t('submissionHub.mail.fieldSubject')}
              <input className="settings-input" value={compose.subject} aria-label={t('submissionHub.mail.fieldSubject')}
                onChange={(event) => { setCompose((current) => ({ ...current, subject: event.target.value })); setPreview(null); }} />
            </label>
            <label>{t('submissionHub.mail.fieldBody')}
              <textarea rows={6} value={compose.bodyText} aria-label={t('submissionHub.mail.fieldBody')}
                onChange={(event) => { setCompose((current) => ({ ...current, bodyText: event.target.value })); setPreview(null); }} />
            </label>
            <label>{t('submissionHub.mail.fieldAttachments')}
              <textarea rows={2} value={compose.attachments} aria-label={t('submissionHub.mail.fieldAttachments')}
                onChange={(event) => { setCompose((current) => ({ ...current, attachments: event.target.value })); setPreview(null); }} />
            </label>
            <button type="button" className="submissions-secondary" data-testid="submissions-mail-preview-btn"
              disabled={busy !== '' || !compose.to.trim() || !compose.subject.trim()} onClick={() => void previewMail()}>
              {busy === 'preview' ? t('submissionHub.mail.previewing') : t('submissionHub.mail.preview')}
            </button>
            {preview && (
              <div className="submissions-mail__preview" data-testid="submissions-mail-preview">
                <strong>{t('submissionHub.mail.previewTitle')}</strong>
                <p><small>{t('submissionHub.mail.previewFrom')}：{preview.from}（{preview.accountLabel}）</small></p>
                <p><small>{t('submissionHub.mail.previewTo')}：{preview.to}</small></p>
                {preview.cc && <p><small>{t('submissionHub.mail.fieldCc')}：{preview.cc}</small></p>}
                <p><small>{t('submissionHub.mail.previewSmtp')}：{preview.smtp ? `${preview.smtp.host}:${preview.smtp.port}` : t('submissionHub.mail.previewSmtpUnknown')}</small></p>
                {preview.attachments.length > 0 && (
                  <p><small>{t('submissionHub.mail.previewAttachments')}：{preview.attachments.map((item) => item.filename).join('、')}</small></p>
                )}
              </div>
            )}
            {composeNote && <p className="submissions-notice" role="status">{composeNote}</p>}
            <footer>
              <button type="button" onClick={() => setComposeOpen(false)}>{t('submissionHub.mail.cancel')}</button>
              <button className="primary" type="button" data-testid="submissions-mail-send"
                disabled={!preview || busy !== ''} onClick={() => void sendMail()}>
                {busy === 'send' ? t('submissionHub.mail.sending') : t('submissionHub.mail.confirmSend')}
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}
