/**
 * ConfirmDialog — reusable confirmation modal.
 */

import { useTranslation } from '../i18n';
import { Dialog, Button } from './ui';

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
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }} title={title} size="sm" footer={(
      <>
        <Button variant="secondary" onClick={onCancel}>
          {cancelLabel ?? t('common.cancel')}
        </Button>
        <Button variant="danger" data-testid="confirm-delete" onClick={onConfirm}>
          {confirmLabel ?? t('common.delete')}
        </Button>
      </>
    )}>
      <p style={{ fontSize: 14, color: 'var(--text-body)', margin: 0 }}>{message}</p>
    </Dialog>
  );
}
