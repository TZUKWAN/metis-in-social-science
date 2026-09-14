/**
 * 最终提交确认（P3）：Human Approval 门控。只有材料包已冻结且预检通过才渲染，
 * 提交必须由研究者本人勾选声明并点击确认；系统记录投稿方式与回执编号。
 */
import { useState } from 'react';
import { useTranslation } from '../../i18n';
import type { SubmissionCase } from '../../../engine/submission/SubmissionRuntimeContract.js';
import { journalApi } from './shared';

export function FinalSubmitConfirm({ projectId, caseItem, preflightPassed, onRefresh }: {
  projectId: string;
  caseItem: SubmissionCase;
  preflightPassed: boolean;
  onRefresh: () => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const api = journalApi();
  const [method, setMethod] = useState<'portal_web' | 'email' | 'offline_manual'>('portal_web');
  const [portalUrl, setPortalUrl] = useState('');
  const [remoteId, setRemoteId] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function confirm(): Promise<void> {
    if (!api?.confirmFinalSubmission || busy || !agreed) return;
    setBusy(true); setResult(null);
    const response = await api.confirmFinalSubmission({
      projectId, caseId: caseItem.id,
      submissionMethod: method,
      ...(portalUrl.trim() ? { portalUrl: portalUrl.trim() } : {}),
      ...(remoteId.trim() ? { remoteSubmissionId: remoteId.trim() } : {}),
      confirmed: true,
    });
    if (response?.ok) {
      const idSuffix = caseItem.remoteSubmissionId ? ` · ${t('submissionHub.remoteIdLabel')} ${response.submissionCase.remoteSubmissionId}` : '';
      setResult({ ok: true, text: t('submissionHub.submitDone', { journal: response.submissionCase.targetJournalName, id: idSuffix }) });
      await onRefresh();
    } else {
      const code = response && 'code' in response ? String(response.code) : 'failed';
      const textByCode: Record<string, string> = {
        preflight_not_passed: t('submissionHub.submitBlockedPreflight'),
        package_not_frozen: t('submissionHub.submitBlockedPackage'),
        illegal_status: t('submissionHub.submitBlockedStatus'),
        illegal_transition: t('submissionHub.submitBlockedStatus'),
        approval_required: t('submissionHub.confirmStatement'),
        use_submit_flow: t('submissionHub.submitNeedsFlow'),
      };
      setResult({ ok: false, text: textByCode[code] ?? t('submissionHub.journalActionFailed', { code }) });
    }
    setBusy(false);
  }

  return (
    <div className="submissions-final-submit" data-testid="final-submit">
      <h3>{t('submissionHub.submitTitle')}</h3>
      <label>
        <span>{t('submissionHub.methodLabel')}</span>
        <select value={method} onChange={(event) => setMethod(event.target.value as typeof method)}>
          <option value="portal_web">{t('submissionHub.methodPortalWeb')}</option>
          <option value="email">{t('submissionHub.methodEmail')}</option>
          <option value="offline_manual">{t('submissionHub.methodOfflineManual')}</option>
        </select>
      </label>
      <input placeholder={t('submissionHub.portalUrlLabel')} value={portalUrl} onChange={(event) => setPortalUrl(event.target.value)} />
      <input placeholder={t('submissionHub.remoteIdLabel')} value={remoteId} onChange={(event) => setRemoteId(event.target.value)} />
      <label className="submissions-confirm-statement">
        <input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} />
        <span>{t('submissionHub.confirmStatement')}</span>
      </label>
      {!preflightPassed && <p className="submissions-gap__problem">{t('submissionHub.submitBlockedPreflight')}</p>}
      <button type="button" className="submissions-primary" disabled={!agreed || !preflightPassed || busy} onClick={() => void confirm()}>
        {busy ? t('submissionHub.confirming') : t('submissionHub.confirmSubmit')}
      </button>
      {result && <p className={result.ok ? 'submissions-notice' : 'submissions-gap__problem'} role="status">{result.text}</p>}
    </div>
  );
}
