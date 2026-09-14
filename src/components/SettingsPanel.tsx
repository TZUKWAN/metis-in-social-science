/**
 * SettingsPanel — 设置中心（2026-08-23 精简版；UI 统一重构阶段改为 section 结构）。
 *
 * 高频设置保留在主页面；低频功能归拢到「高级设置」二级弹窗：
 *  - 数据备份、云备份(WebDAV)、核心期刊白名单、市场/集成令牌、开发者诊断
 *
 * 布局标准（任务文档第十节）：分组一律用 section（标题 + 描述 + 控件 +
 * 分隔线），禁止卡片框堆叠；共享布局见 ./settings/SectionGroup。
 */

import { useState, useCallback } from 'react';
import { useTranslation } from '../i18n';
import { useMetisStore, isCustomAccent, type AccentSetting, type AccentTheme, type LocaleKey, type ThemeMode } from '../store';
import type { UIMode } from '../../engine/capabilities/DiagnosticMode';
import { Settings as SettingsIcon } from 'lucide-react';
import { Select } from './ui';
import { SectionGroup } from './settings/SectionGroup';
import SettingsProjectArchiveSection from './SettingsProjectArchiveSection';
import SettingsStorageSection from './SettingsStorageSection';
import SettingsWeChatBotSection from './SettingsWeChatBotSection';
import SettingsImageGenerationSection from './SettingsImageGenerationSection';
import SettingsOutcomePromptsSection from './SettingsOutcomePromptsSection';
import ProviderProfilesSection from './ProviderProfilesSection';
import SettingsGlobalMetisSection from './SettingsGlobalMetisSection';
import SettingsAdvancedDialog from './SettingsAdvancedDialog';

export interface SettingsPanelProps {
  uiMode: UIMode;
  onUIModeChange: (mode: UIMode) => void;
}

/** Accent swatch preview colors (light-mode accent values from AcademicTheme.css). */
const ACCENT_OPTIONS: Array<{ id: AccentTheme; labelKey: string; swatch: string }> = [
  { id: 'blue', labelKey: 'settings.accentBlue', swatch: '#2563EB' },
  { id: 'gold', labelKey: 'settings.accentGold', swatch: '#A16207' },
  { id: 'green', labelKey: 'settings.accentGreen', swatch: '#15803D' },
  { id: 'gray', labelKey: 'settings.accentGray', swatch: '#52525B' },
];

export default function SettingsPanel({ uiMode, onUIModeChange }: SettingsPanelProps) {
  const { t, locale, setLocale } = useTranslation();
  const theme = useMetisStore((s) => s.theme);
  const setTheme = useMetisStore((s) => s.setTheme);
  const accent = useMetisStore((s) => s.accent);
  const setAccent = useMetisStore((s) => s.setAccent);
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

      <div className="settings-page__sections">
        {/* Language + Appearance: one row, two section columns */}
        <div className="settings-page__columns">
          {/* Language */}
          <SectionGroup title={t('settings.language')} description={t('settings.languageDescription')}>
            <label htmlFor="locale-select" className="sr-only">{t('settings.language')}</label>
            <Select
              id="locale-select"
              value={locale}
              onChange={(e) => setLocale(e.target.value as LocaleKey)}
              className="settings-input"
              style={{ width: 200 }}
            >
              <option value="en">English</option>
              <option value="zh">中文</option>
            </Select>
          </SectionGroup>

          {/* Appearance */}
          <SectionGroup title={t('settings.appearance')} description={t('settings.appearanceDescription')}>
            <label htmlFor="theme-select" className="sr-only">{t('settings.appearanceTheme')}</label>
            <Select
              id="theme-select"
              value={theme}
              onChange={(e) => setTheme(e.target.value as ThemeMode)}
              className="settings-input"
              style={{ width: 200 }}
              data-testid="appearance-theme-select"
            >
              <option value="light">{t('common.light')}</option>
              <option value="dark">{t('common.dark')}</option>
              <option value="system">{t('common.themeSystem')}</option>
            </Select>
            <div
              role="radiogroup"
              aria-label={t('settings.appearanceAccent')}
              style={{ display: 'flex', alignItems: 'center', gap: 12 }}
            >
              {ACCENT_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={accent === option.id}
                  title={t(option.labelKey)}
                  aria-label={t(option.labelKey)}
                  onClick={() => setAccent(option.id)}
                  data-testid={`accent-swatch-${option.id}`}
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: '50%',
                    background: option.swatch,
                    border: '2px solid var(--ds-bg1)',
                    boxShadow: accent === option.id ? 'var(--focus-ring)' : '0 0 0 1px var(--ds-border-strong)',
                    cursor: 'pointer',
                    padding: 0,
                  }}
                />
              ))}
              <span aria-hidden="true" style={{ width: 1, height: 20, background: 'var(--ds-border-strong)' }} />
              <label
                htmlFor="accent-custom"
                title={t('settings.accentCustom')}
                style={{
                  position: 'relative',
                  display: 'inline-block',
                  width: 24,
                  height: 24,
                  borderRadius: '50%',
                  border: '2px solid var(--ds-bg1)',
                  boxShadow: isCustomAccent(accent) ? 'var(--focus-ring)' : '0 0 0 1px var(--ds-border-strong)',
                  cursor: 'pointer',
                  background: 'conic-gradient(#EF4444, #F59E0B, #10B981, #3B82F6, #8B5CF6, #EC4899, #EF4444)',
                  overflow: 'hidden',
                  padding: 0,
                }}
              >
                <input
                  id="accent-custom"
                  type="color"
                  value={isCustomAccent(accent) ? accent : '#2563EB'}
                  onChange={(e) => setAccent(e.target.value as AccentSetting)}
                  data-testid="accent-custom-picker"
                  aria-label={t('settings.accentCustom')}
                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0, cursor: 'pointer', padding: 0, border: 0 }}
                />
              </label>
            </div>
          </SectionGroup>
        </div>

        <ProviderProfilesSection />

        {/* 全局 METIS.md（刘总 2026-09：规则在设置中可见可改） */}
        <SettingsGlobalMetisSection />

        {/* Outcome image generation (dedicated provider settings + encrypted API key) */}
        <SettingsImageGenerationSection />

        <SettingsOutcomePromptsSection />

        {/* Complete project archive (METIS-F10) */}
        <SettingsProjectArchiveSection uiMode={uiMode} />

        {/* User-configurable data directory (storage location) */}
        <SettingsStorageSection />

        {/* WeChat Bot (METIS-WX-1) */}
        <SettingsWeChatBotSection />

        {/* 高级设置入口 */}
        <SectionGroup
          title="高级设置"
          description="数据备份、云备份(WebDAV)、核心期刊白名单、市场/集成令牌、开发者诊断。"
        >
          <div>
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
        </SectionGroup>
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
