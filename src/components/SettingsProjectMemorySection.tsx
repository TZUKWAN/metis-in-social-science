/**
 * SettingsProjectMemorySection — CLAUDE_MEMORY.md editor section.
 *
 * Retains the original project memory semantics (CLAUDE_MEMORY.md via
 * memory:getProject / memory:setProject IPC). This is separate from the
 * new WorkspaceAgentsManager (AGENTS.md CAS-protected) which lives in
 * the main SettingsPanel provider/agents area.
 */

import { useState, useEffect, useRef } from 'react';
import { useTranslation } from '../i18n';

export default function SettingsProjectMemorySection() {
  const { t } = useTranslation();
  const [projectMemory, setProjectMemory] = useState('');
  const [memoryDirty, setMemoryDirty] = useState(false);
  const [memorySaveStatus, setMemorySaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const metis = window.metis;
    if (!metis?.getProjectMemory) return;
    metis.getProjectMemory().then((content) => {
      setProjectMemory(content);
    }).catch(() => { /* ignore */ });
  }, []);

  const handleSaveMemory = async () => {
    setMemorySaveStatus('saving');
    try {
      const metis = window.metis;
      if (metis?.setProjectMemory) {
        const result = await metis.setProjectMemory(projectMemory);
        // Check DTO result — reject fake success
        if (!result || !result.success) {
          setMemorySaveStatus('idle');
          return;
        }
      }
      setMemorySaveStatus('saved');
      setMemoryDirty(false);
      setTimeout(() => setMemorySaveStatus('idle'), 2000);
    } catch {
      setMemorySaveStatus('idle');
    }
  };

  return (
    <div className="settings-group">
      <h3>{t('settings.projectMemory')}</h3>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
        {t('settings.projectMemoryDescription')}
      </p>
      <textarea
        ref={textareaRef}
        value={projectMemory}
        onChange={(e) => { setProjectMemory(e.target.value); setMemoryDirty(true); }}
        rows={10}
        className="settings-input"
        style={{ fontFamily: 'monospace', fontSize: 13 }}
        placeholder={t('settings.projectMemoryPlaceholder')}
        maxLength={50000}
        aria-label={t('settings.projectMemory')}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
        <span
          style={{ fontSize: 11, color: memoryDirty ? 'var(--accent-warm)' : 'var(--text-muted)' }}
          role="status"
          aria-live="polite"
        >
          {memoryDirty ? '● ' : ''}{projectMemory.length.toLocaleString()} / 50,000
        </span>
        <button
          type="button"
          className="btn-primary"
          onClick={handleSaveMemory}
          disabled={memorySaveStatus === 'saving'}
          data-testid="save-project-memory"
        >
          {memorySaveStatus === 'saving' ? t('common.saving') : memorySaveStatus === 'saved' ? t('common.saved') : t('settings.saveMemory')}
        </button>
      </div>
    </div>
  );
}
