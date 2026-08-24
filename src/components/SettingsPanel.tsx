/**
 * SettingsPanel — 设置中心（2026-08-23 精简版）。
 *
 * 高频设置保留在主页面；低频功能归拢到「高级设置」二级弹窗：
 *  - 数据备份、云备份(WebDAV)、核心期刊白名单、市场/集成令牌、开发者诊断
 */

import { useState, useCallback } from 'react';
import { useTranslation } from '../i18n';
import type { LocaleKey } from '../store';
import type { UIMode } from '../../engine/capabilities/DiagnosticMode';
import { Settings as SettingsIcon } from 'lucide-react';
import SettingsProjectArchiveSection from './SettingsProjectArchiveSection';
import SettingsStorageSection from './SettingsStorageSection';
import SettingsWeChatBotSection from './SettingsWeChatBotSection';
import SettingsImageGenerationSection from './SettingsImageGenerationSection';
import ProviderProfilesSection from './ProviderProfilesSection';
import SettingsAdvancedDialog from './SettingsAdvancedDialog';

export interface SettingsPanelProps {
  uiMode: UIMode;
  onUIModeChange: (mode: UIMode) => void;
}

export default function SettingsPanel({ uiMode, onUIModeChange }: SettingsPanelProps) {
  const { t, locale, setLocale } = useTranslation();
  const diagnosticMode = uiMode === 'diagnostic';
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [issnNotice, setIssnNotice] = useState('');

  const handleIssnImport = useCallback(async () => {
    const result = await window.metis?.importIssnList?.();
    if (!result) { setIssnNotice(t('settings.issnImportUnavailable')); return; }
    setIssnNotice(result.ok
      ? t('settings.issnImportDone', { added: result.added, total: result.totalCandidates ?? 0 })
      : t('settings.issnImportFailed', { error: result.error ?? '' }));
  }, [t]);

  return (
    <div className="placeholder-page settings-page" role="region" aria-label={t('settings.pageTitle')}>
      <h2>{t('settings.pageTitle')}</h2>

      {/* Language */}
      <div className="settings-group">
        <h3>{t('settings.language')}</h3>
        <p>{t('settings.languageDescription')}</p>
        <label htmlFor="locale-select" className="sr-only">{t('settings.language')}</label>
        <select
          id="locale-select"
          value={locale}
          onChange={(e) => setLocale(e.target.value as LocaleKey)}
          className="settings-input"
          style={{ width: 200 }}
        >
          <option value="en">English</option>
          <option value="zh">中文</option>
        </select>
      </div>

      <ProviderProfilesSection />


      {/* Outcome image generation (dedicated provider settings + encrypted API key) */}
      <SettingsImageGenerationSection />

      {/* Diagnostic mode toggle */}
      <div className="settings-group">
        <h3>{t('settings.advancedTitle')}</h3>
        <p>{t('settings.advancedDescription')}</p>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={diagnosticMode}
            onChange={(event) => {
              const enabled = event.target.checked;
              onUIModeChange(enabled ? 'diagnostic' : 'normal');
            }}
            data-testid="diagnostic-mode-toggle"
          />
          {t('settings.diagnosticMode')}
        </label>
      </div>

      {/* Complete project archive (METIS-F10) */}
      <SettingsProjectArchiveSection uiMode={uiMode} />

      {/* User-configurable data directory (storage location) */}
      <SettingsStorageSection />

      {/* WeChat Bot (METIS-WX-1) */}
      <SettingsWeChatBotSection />

      {/* 高级设置按钮 */}
      <div className="settings-group">
        <h3>高级设置</h3>
        <p>数据备份、云备份(WebDAV)、核心期刊白名单、市场/集成令牌、开发者诊断。</p>
        <button
          type="button"
          className="btn-sm btn-secondary"
          onClick={() => setAdvancedOpen(true)}
          data-testid="advanced-settings-button"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          <SettingsIcon size={14} />
          打开高级设置
        </button>
      </div>

      {/* 高级设置二级弹窗 */}
      <SettingsAdvancedDialog
        open={advancedOpen}
        onClose={() => setAdvancedOpen(false)}
        uiMode={uiMode}
        onUIModeChange={onUIModeChange}
        issnNotice={issnNotice}
        onIssnImport={() => void handleIssnImport()}
      />
    </div>
  );
}
