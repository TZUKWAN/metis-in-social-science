/**
 * ConfirmDialog — reusable confirmation modal.
 */

import { useTranslation } from '../i18n';

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
      <div className="modal-content">
        <h3 id="confirm-title">{title}</h3>
        <p style={{ fontSize: 14, color: 'var(--text-body)', marginBottom: 20 }}>{message}</p>
        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={onCancel}>
            {cancelLabel ?? t('common.cancel')}
          </button>
          <button type="button" className="btn-primary" data-testid="confirm-delete" onClick={onConfirm} style={{ background: 'var(--status-failed)', borderColor: 'var(--status-failed)' }}>
            {confirmLabel ?? t('common.delete')}
          </button>
        </div>
      </div>
    </div>
  );
}
