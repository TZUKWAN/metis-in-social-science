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
import { useMetisStore, isCustomAccent, resolveTheme, type AccentSetting, type AccentTheme, type LocaleKey, type ThemeMode } from '../store';
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

/** Accent swatch preview colors, per resolved theme (values from AcademicTheme.css). */
const ACCENT_OPTIONS: Array<{ id: AccentTheme; labelKey: string; swatch: string; swatchDark: string }> = [
  { id: 'blue', labelKey: 'settings.accentBlue', swatch: '#2563EB', swatchDark: '#3B82F6' },
  { id: 'gold', labelKey: 'settings.accentGold', swatch: '#A16207', swatchDark: '#D97706' },
  { id: 'green', labelKey: 'settings.accentGreen', swatch: '#15803D', swatchDark: '#22C55E' },
  { id: 'gray', labelKey: 'settings.accentGray', swatch: '#52525B', swatchDark: '#A1A1AA' },
];

export default function SettingsPanel({ uiMode, onUIModeChange }: SettingsPanelProps) {
  const { t, locale, setLocale } = useTranslation();
  const theme = useMetisStore((s) => s.theme);
  const setTheme = useMetisStore((s) => s.setTheme);
  // 色板预览跟随解析后的主题（system 也解析），暗色下展示暗色 accent 值，
  // 避免亮色深值块在暗背景上不可辨（P2：外观区色板对比度）。
  const resolvedTheme = resolveTheme(theme);
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
                  className="accent-swatch"
                  style={{
                    width: 24,
                    height: 24,
                    padding: 0,
                    cursor: 'pointer',
                    // SkyAgentTheme 的全局 button 重置带 !important，内联
                    // background/radius/shadow 都会被压掉；改由例外规则
                    // 消费该变量渲染圆形色板（见 SkyAgentTheme.css 尾部）。
                    ['--swatch-fill' as string]: resolvedTheme === 'dark' ? option.swatchDark : option.swatch,
                  }}
                />
              ))}
              <span aria-hidden="true" style={{ width: 1, height: 20, background: 'var(--ds-border-strong)' }} />
              <label
                htmlFor="accent-custom"
                title={t('settings.accentCustom')}
                className="accent-swatch accent-swatch-custom"
                data-custom-active={isCustomAccent(accent) ? 'true' : 'false'}
                style={{
                  position: 'relative',
                  display: 'inline-block',
                  width: 24,
                  height: 24,
                  cursor: 'pointer',
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
