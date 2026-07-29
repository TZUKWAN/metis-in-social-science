import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '../i18n';
import type { UIMode } from '../../engine/capabilities/DiagnosticMode';
import type { ApprovalAction, ApprovalRequestView } from '../../engine/runtime/ApprovalRuntimeContract';

interface ApprovalModalProps {
  request: ApprovalRequestView | null;
  uiMode?: UIMode;
  onApprove: (requestId: string, remember: boolean) => void;
  onReject: (requestId: string, remember: boolean) => void;
}

export default function ApprovalModal({
  request,
  uiMode = 'normal',
  onApprove,
  onReject,
}: ApprovalModalProps) {
  const { t } = useTranslation();
  const [remember, setRemember] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!request) return;
    dialogRef.current?.focus();
  }, [request]);

  if (!request) return null;

  const actionLabels: Record<ApprovalAction, string> = {
    read_source: t('approval.actionReadSource'),
    write_research_data: t('approval.actionWriteResearchData'),
    access_external_source: t('approval.actionAccessExternalSource'),
    run_analysis: t('approval.actionRunAnalysis'),
    perform_research_action: t('approval.actionResearch'),
  };

  return (
    <div className="approval-modal-overlay">
      <div
        ref={dialogRef}
        className="approval-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="approval-modal-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onReject(request.requestId, remember);
        }}
      >
        <div className="approval-modal-header">
          <span className="approval-modal-icon" aria-hidden="true">!</span>
          <h3 id="approval-modal-title">{t('approval.title')}</h3>
        </div>

        <div className="approval-modal-body">
          <p className="approval-reason">{t('approval.safeSummary')}</p>
          <div className="approval-detail">
            <label>{t('approval.tool')}</label>
            <span className="approval-tool-name">{actionLabels[request.action]}</span>
          </div>
          {uiMode === 'diagnostic' && (
            <div className="approval-detail">
              <label>{t('approval.technicalAction')}</label>
              <code className="approval-tool-name">{request.action}</code>
            </div>
          )}
        </div>

        <div className="approval-modal-footer">
          <label className="approval-remember">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
            />
            {t('approval.remember')}
          </label>
          <div className="approval-actions">
            <button className="btn-secondary" onClick={() => onReject(request.requestId, remember)}>
              {t('approval.reject')}
            </button>
            <button className="btn-primary" onClick={() => onApprove(request.requestId, remember)}>
              {t('approval.approve')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
