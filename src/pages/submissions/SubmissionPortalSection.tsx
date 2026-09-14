/**
 * 投稿门户区（P3）：打开投稿页面、生成表单填写计划（auto/review 可执行，
 * 声明/认证/财务/法律/最终提交级只展示不执行）、执行勾选步骤（需确认）、
 * 最终提交登记与状态不明标记。
 */
import { useCallback, useState } from 'react';
import { useTranslation } from '../../i18n';
import {
  isPortalActionAutomatable,
  type PortalFieldAction,
  type PortalSession,
} from '../../../engine/submission/SubmissionPortalContract.js';
import type { SubmissionCase } from '../../../engine/submission/SubmissionRuntimeContract.js';

export function SubmissionPortalSection({ projectId, caseItem, onRefresh }: {
  projectId: string;
  caseItem: SubmissionCase;
  onRefresh: () => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const [portalUrl, setPortalUrl] = useState('');
  const [session, setSession] = useState<PortalSession | null>(null);
  const [actions, setActions] = useState<PortalFieldAction[] | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<Array<{ fieldKey: string; status: 'done' | 'skipped'; detail: string }> | null>(null);
  const [busy, setBusy] = useState<'' | 'open' | 'plan' | 'execute' | 'confirm' | 'uncertain'>('');
  const [message, setMessage] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [remoteId, setRemoteId] = useState('');
  const [receiptNote, setReceiptNote] = useState('');
  const [uncertainOpen, setUncertainOpen] = useState(false);
  const [uncertainReason, setUncertainReason] = useState('');

  const failText = useCallback((key: string, result: { code: string; message: string } | null): string =>
    t(key, { code: result ? result.code : 'failed', message: result ? result.message : '' }), [t]);

  async function openPortal(): Promise<void> {
    if (!window.metis?.openSubmissionPortal || busy) return;
    setBusy('open'); setMessage('');
    const result = await window.metis.openSubmissionPortal({ projectId, caseId: caseItem.id, portalUrl: portalUrl.trim() || undefined });
    if (result?.ok) setSession(result.session);
    else setMessage(failText('submissionHub.portal.openFailed', result ?? null));
    setBusy('');
  }

  async function plan(): Promise<void> {
    if (!window.metis?.planSubmissionPortalFill || busy) return;
    setBusy('plan'); setMessage(''); setResults(null);
    const result = await window.metis.planSubmissionPortalFill({ projectId, caseId: caseItem.id });
    if (result?.ok) {
      setActions(result.actions);
      // auto 级默认勾选；review 级需用户逐条勾选（执行时再整体确认）。
      const initial: Record<string, boolean> = {};
      for (const action of result.actions) {
        if (isPortalActionAutomatable(action.safetyLevel)) initial[action.fieldKey] = action.safetyLevel === 'auto';
      }
      setChecked(initial);
    } else {
      setMessage(failText('submissionHub.portal.planFailed', result && 'code' in result ? result : null));
    }
    setBusy('');
  }

  async function execute(): Promise<void> {
    const selectedActions = (actions ?? []).filter((action) => checked[action.fieldKey] && isPortalActionAutomatable(action.safetyLevel));
    if (!window.metis?.executeSubmissionPortalSteps || selectedActions.length === 0 || busy) return;
    // review 级步骤必须经用户显式确认（confirmed: true）才允许执行。
    if (!window.confirm(t('submissionHub.portal.executeConfirm'))) return;
    setBusy('execute'); setMessage('');
    const result = await window.metis.executeSubmissionPortalSteps({ projectId, caseId: caseItem.id, actions: selectedActions, confirmed: true });
    if (result?.ok) setResults(result.results);
    else setMessage(failText('submissionHub.portal.executeFailed', result ?? null));
    setBusy('');
  }

  async function confirmSubmitted(): Promise<void> {
    if (!window.metis?.confirmSubmissionPortalSubmitted || busy) return;
    setBusy('confirm'); setMessage('');
    const result = await window.metis.confirmSubmissionPortalSubmitted({
      projectId,
      caseId: caseItem.id,
      remoteSubmissionId: remoteId.trim() || undefined,
      receiptNote: receiptNote.trim() || undefined,
    });
    if (result?.ok) {
      setConfirmOpen(false);
      setMessage(t('submissionHub.portal.confirmOk'));
      await onRefresh();
    } else {
      setMessage(failText('submissionHub.portal.confirmFailed', result ?? null));
    }
    setBusy('');
  }

  async function markUncertain(): Promise<void> {
    if (!window.metis?.markSubmissionPortalUncertain || !uncertainReason.trim() || busy) return;
    setBusy('uncertain'); setMessage('');
    const result = await window.metis.markSubmissionPortalUncertain({ projectId, caseId: caseItem.id, reason: uncertainReason.trim() });
    if (result?.ok) {
      setUncertainOpen(false);
      setUncertainReason('');
      setMessage(t('submissionHub.portal.uncertainDone'));
      await onRefresh();
    } else {
      setMessage(failText('submissionHub.portal.uncertainFailed', result ?? null));
    }
    setBusy('');
  }

  const executableCount = (actions ?? []).filter((action) => checked[action.fieldKey] && isPortalActionAutomatable(action.safetyLevel)).length;

  return (
    <div className="submissions-journal submissions-portal" data-testid="submissions-portal-section">
      <h3>{t('submissionHub.portal.title')}</h3>
      <div className="submissions-portal__toolbar">
        <input className="settings-input" value={portalUrl} placeholder={t('submissionHub.portal.portalUrlOptional')}
          aria-label={t('submissionHub.portal.portalUrlOptional')}
          onChange={(event) => setPortalUrl(event.target.value)} />
        <button type="button" className="submissions-primary" data-testid="submissions-portal-open"
          disabled={busy !== ''} onClick={() => void openPortal()}>
          {busy === 'open' ? t('submissionHub.portal.opening') : t('submissionHub.portal.openPortal')}
        </button>
      </div>
      {session && (
        <div className="submissions-portal__session" data-testid="submissions-portal-session">
          <div className="submissions-journal__meta">
            <span className="submissions-badge">{t(`submissionHub.portal.platformLabels.${session.platform}`)}</span>
            <span className={`submissions-tier ${session.loggedIn === true ? 'ok' : session.loggedIn === false ? 'bad' : ''}`}>
              {session.loggedIn === true ? t('submissionHub.portal.loginYes') : session.loggedIn === false ? t('submissionHub.portal.loginNo') : t('submissionHub.portal.loginUnknown')}
            </span>
          </div>
          <p><small>{t('submissionHub.portal.currentUrl')}：{session.currentUrl || session.portalUrl}</small></p>
          {session.pageTitle && <p><small>{t('submissionHub.portal.pageTitleLabel')}：{session.pageTitle}</small></p>}
          {session.loggedIn === false && <p className="submissions-notice">{t('submissionHub.portal.loginHint')}</p>}
        </div>
      )}
      <div className="submissions-package-actions">
        <button type="button" className="submissions-secondary" data-testid="submissions-portal-plan"
          disabled={busy !== ''} onClick={() => void plan()}>
          {busy === 'plan' ? t('submissionHub.portal.planning') : t('submissionHub.portal.plan')}
        </button>
      </div>
      {actions !== null && (
        <div className="submissions-portal__plan" data-testid="submissions-portal-plan-list">
          {actions.length === 0 && <p className="submissions-empty">{t('submissionHub.portal.planEmpty')}</p>}
          <ul className="submissions-portal__list">
            {actions.map((action) => {
              const automatable = isPortalActionAutomatable(action.safetyLevel);
              return (
                <li key={action.fieldKey} className="submissions-portal__item">
                  <div className="submissions-journal__meta">
                    {automatable ? (
                      <label className="submissions-portal__check">
                        <input type="checkbox" data-testid="submissions-portal-check"
                          checked={Boolean(checked[action.fieldKey])}
                          onChange={(event) => setChecked((current) => ({ ...current, [action.fieldKey]: event.target.checked }))} />
                        <strong>{action.label || action.fieldKey}</strong>
                      </label>
                    ) : (
                      <strong>{action.label || action.fieldKey}</strong>
                    )}
                    <span className={`submissions-badge ${automatable ? '' : 'warn'}`}>{t(`submissionHub.portal.safetyLabels.${action.safetyLevel}`)}</span>
                    {!automatable && <small>{t('submissionHub.portal.manualOnly')}</small>}
                  </div>
                  <p className="submissions-portal__value">{action.value || t('submissionHub.portal.valueEmpty')}</p>
                  <p><small>{action.reason}</small></p>
                </li>
              );
            })}
          </ul>
          <button type="button" className="submissions-primary" data-testid="submissions-portal-execute"
            disabled={busy !== '' || executableCount === 0} onClick={() => void execute()}>
            {busy === 'execute' ? t('submissionHub.portal.executing') : t('submissionHub.portal.execute')}
          </button>
        </div>
      )}
      {results && results.length > 0 && (
        <ul className="submissions-portal__results" data-testid="submissions-portal-results">
          {results.map((item) => (
            <li key={item.fieldKey}>
              <span className={`submissions-tier ${item.status === 'done' ? 'ok' : ''}`}>
                {item.status === 'done' ? t('submissionHub.portal.resultDone') : t('submissionHub.portal.resultSkipped')}
              </span>
              <span>{item.fieldKey}</span>
              {item.detail && <small>{item.detail}</small>}
            </li>
          ))}
        </ul>
      )}
      <div className="submissions-package-actions">
        <button type="button" className="submissions-primary" data-testid="submissions-portal-confirm"
          disabled={busy !== ''} onClick={() => setConfirmOpen(true)}>
          {t('submissionHub.portal.confirmSubmitted')}
        </button>
        <button type="button" className="submissions-secondary" data-testid="submissions-portal-uncertain"
          disabled={busy !== ''} onClick={() => setUncertainOpen(true)}>
          {t('submissionHub.portal.markUncertain')}
        </button>
      </div>
      {message && <p className="submissions-notice" role="status">{message}</p>}

      {confirmOpen && (
        <div className="outcomes-modal-backdrop" role="presentation">
          <div className="outcomes-modal" role="dialog" aria-modal="true" aria-label={t('submissionHub.portal.confirmTitle')}>
            <header><strong>{t('submissionHub.portal.confirmTitle')}</strong><button type="button" onClick={() => setConfirmOpen(false)} aria-label="关闭">×</button></header>
            <label>{t('submissionHub.portal.remoteId')}
              <input className="settings-input" value={remoteId} aria-label={t('submissionHub.portal.remoteId')}
                onChange={(event) => setRemoteId(event.target.value)} />
            </label>
            <label>{t('submissionHub.portal.receiptNote')}
              <textarea rows={3} value={receiptNote} aria-label={t('submissionHub.portal.receiptNote')}
                onChange={(event) => setReceiptNote(event.target.value)} />
            </label>
            <footer>
              <button type="button" onClick={() => setConfirmOpen(false)}>{t('submissionHub.portal.cancel')}</button>
              <button className="primary" type="button" data-testid="submissions-portal-confirm-submit"
                disabled={busy !== ''} onClick={() => void confirmSubmitted()}>
                {busy === 'confirm' ? t('submissionHub.working') : t('submissionHub.portal.confirmAction')}
              </button>
            </footer>
          </div>
        </div>
      )}

      {uncertainOpen && (
        <div className="outcomes-modal-backdrop" role="presentation">
          <div className="outcomes-modal" role="dialog" aria-modal="true" aria-label={t('submissionHub.portal.uncertainTitle')}>
            <header><strong>{t('submissionHub.portal.uncertainTitle')}</strong><button type="button" onClick={() => setUncertainOpen(false)} aria-label="关闭">×</button></header>
            <label>{t('submissionHub.portal.uncertainReason')}
              <textarea rows={3} value={uncertainReason} aria-label={t('submissionHub.portal.uncertainReason')}
                onChange={(event) => setUncertainReason(event.target.value)} />
            </label>
            <footer>
              <button type="button" onClick={() => setUncertainOpen(false)}>{t('submissionHub.portal.cancel')}</button>
              <button className="primary" type="button" data-testid="submissions-portal-uncertain-submit"
                disabled={busy !== '' || !uncertainReason.trim()} onClick={() => void markUncertain()}>
                {busy === 'uncertain' ? t('submissionHub.working') : t('submissionHub.portal.uncertainAction')}
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}
