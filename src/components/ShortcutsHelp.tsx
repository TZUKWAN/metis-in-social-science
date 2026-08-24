/**
 * ShortcutsHelp — a global keyboard shortcut reference modal.
 * Opened from App via Shift+/ (?) or a sidebar button.
 */

import { useTranslation } from '../i18n';
import { useOverlayDialog } from '../hooks/useOverlayDialog';

interface ShortcutsHelpProps {
  onClose: () => void;
}

export default function ShortcutsHelp({ onClose }: ShortcutsHelpProps) {
  const { t } = useTranslation();
  const { containerRef } = useOverlayDialog({ onClose });

  const rows = [
    { action: t('shortcuts.openGlobalSearch'), shortcut: 'Ctrl+K / ⌘K' },
    { action: t('shortcuts.focusSearch'), shortcut: '/' },
    { action: t('shortcuts.newNote'), shortcut: 'Ctrl+N / ⌘N' },
    { action: t('shortcuts.newExperiment'), shortcut: 'Ctrl+N / ⌘N' },
    { action: t('shortcuts.openShortcuts'), shortcut: 'Shift+?' },
  ];

  return (
    <div className="modal-overlay" onClick={onClose} style={{ alignItems: 'center' }}>
      <div
        ref={containerRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        style={{ width: 420, maxWidth: '90vw', padding: 0, overflow: 'hidden' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 id="shortcuts-title" style={{ margin: 0, fontSize: 15 }}>{t('shortcuts.title')}</h3>
          <button className="btn-sm" onClick={onClose}>{t('shortcuts.close')}</button>
        </div>
        <div style={{ maxHeight: '60vh', overflowY: 'auto', padding: '12px 16px' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={{ textAlign: 'left', padding: '6px 0', fontWeight: 600 }}>{t('shortcuts.action')}</th>
                <th style={{ textAlign: 'right', padding: '6px 0', fontWeight: 600 }}>{t('shortcuts.shortcut')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.action} style={{ borderBottom: '1px solid var(--border-light)' }}>
                  <td style={{ padding: '8px 0' }}>{row.action}</td>
                  <td style={{ padding: '8px 0', textAlign: 'right' }}>
                    <kbd style={{ fontFamily: 'inherit', padding: '2px 6px', borderRadius: 3, background: 'var(--bg-hover)', border: '1px solid var(--border)', fontSize: 12 }}>
                      {row.shortcut}
                    </kbd>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
