/**
 * SettingsPanel — 真正的设置中心组件（替换 App.tsx 内联 SettingsPage）。
 *
 * P0 修复：
 *  - provider/baseUrl/model 真实可编辑（Save/Cancel/dirty）
 *  - masked API key 输入（绝不回显明文）
 *  - 测试连接走真实 setupProbe（使用已存 key receipt 或新 key，非空 key）
 *  - 保存走 setupSave → SecureStorage → provider/agent reinit
 *  - theme 选择包裹 transactional setTheme（IPC 失败回滚）
 *  - theme 选择包裹 transactional setTheme（IPC 失败回滚）
 *  - a11y：label/live-region/键盘/focus
 *  - 保留备份/导入/MCP/HITL/诊断模式全部既有功能
 *
 * 本文件只处理新增 Settings UI 逻辑；备份/MCP/HITL 等非 P0 功能
 * 仍由 App.tsx 内联实现，SettingsPanel 只做 provider/theme P0 替换。
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from '../i18n';
import type { LocaleKey, ThemeMode } from '../store';
import { useMetisStore } from '../store';
import { WarningIcon } from './Icons';
import type { UIMode } from '../../engine/capabilities/DiagnosticMode';
import type {
  SetupProbeResponse,
  SetupProbeSuccess,
  SetupSaveResponse,
} from '../../engine/runtime/SetupRuntimeContract';
import SettingsBackupSection from './SettingsBackupSection';
import CloudSyncSection from './CloudSyncSection';
import SettingsProjectArchiveSection from './SettingsProjectArchiveSection';
import SettingsStorageSection from './SettingsStorageSection';
import SettingsWeChatBotSection from './SettingsWeChatBotSection';
import SettingsDiagnosticSection from './SettingsDiagnosticSection';
import { ZoteroSettingsSection } from './ZoteroSettingsSection';
import ProviderProfilesSection from './ProviderProfilesSection';
import SettingsProjectProviderSection from './SettingsProjectProviderSection';

export interface SettingsPanelProps {
  uiMode: UIMode;
  onUIModeChange: (mode: UIMode) => void;
}

type ProviderTestStatus = 'idle' | 'testing' | 'success' | 'error';
type ProviderSaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export default function SettingsPanel({ uiMode, onUIModeChange }: SettingsPanelProps) {
  const { t, locale, setLocale } = useTranslation();
  const theme = useMetisStore((s) => s.theme);
  const setTheme = useMetisStore((s) => s.setTheme);
  const diagnosticMode = uiMode === 'diagnostic';

  // ─── Provider config (editable) ──────────────────────────────
  const [savedBaseUrl, setSavedBaseUrl] = useState('');
  const [savedModel, setSavedModel] = useState('');
  const [hasApiKey, setHasApiKey] = useState(false);
  const [needsReauth, setNeedsReauth] = useState(false);

  // Editable working copy
  const [editBaseUrl, setEditBaseUrl] = useState('');
  const [editModel, setEditModel] = useState('');
  const [editApiKey, setEditApiKey] = useState('');
  const [showApiKeyInput, setShowApiKeyInput] = useState(false);
  const [providerVision, setProviderVision] = useState(false);
  const [providerMaxContextTokens, setProviderMaxContextTokens] = useState(0);
  const [visionSaveStatus, setVisionSaveStatus] = useState<'idle' | 'saved'>('idle');
  const [maxContextSaveStatus, setMaxContextSaveStatus] = useState<'idle' | 'saved'>('idle');

  const [providerTestStatus, setProviderTestStatus] = useState<ProviderTestStatus>('idle');
  const [evalStatus, setEvalStatus] = useState<'idle' | 'running' | 'error'>('idle');
  const [evalNotice, setEvalNotice] = useState('');
  const [issnNotice, setIssnNotice] = useState('');

  const handleIssnImport = useCallback(async () => {
    const result = await window.metis?.importIssnList?.();
    if (!result) { setIssnNotice(t('settings.issnImportUnavailable')); return; }
    setIssnNotice(result.ok
      ? t('settings.issnImportDone', { added: result.added, total: result.totalCandidates ?? 0 })
      : t('settings.issnImportFailed', { error: result.error ?? '' }));
  }, [t]);

  const handleRunEval = useCallback(async () => {
    const metis = window.metis;
    if (!metis?.runEvalSuite) return;
    setEvalStatus('running');
    setEvalNotice(t('settings.evalRunning'));
    const result = await metis.runEvalSuite(undefined);
    setEvalStatus('idle');
    if (!result || result.status === 'cancelled') {
      setEvalNotice(t('settings.evalFailed', { error: 'cancelled' }));
      return;
    }
    if (result.status === 'error') {
      setEvalNotice(t('settings.evalFailed', { error: String((result as { error?: string }).error ?? '') }));
      return;
    }
    const summary = result.summary;
    const lines = [
      t('settings.evalDone', { passed: summary.passed ?? 0, total: summary.taskCount ?? 0, rate: Math.round((summary.successRate ?? 0) * 100), model: '?' }),
      t('settings.evalRubricNote'),
    ];
    setEvalNotice(lines.join('\n'));
  }, [t]);
  const [providerTestMessage, setProviderTestMessage] = useState('');
  const [providerSaveStatus, setProviderSaveStatus] = useState<ProviderSaveStatus>('idle');
  const [providerSaveMessage, setProviderSaveMessage] = useState('');

  // Ref for stale-closure-safe status reads in setTimeout
  const providerSaveStatusRef = useRef<ProviderSaveStatus>('idle');
  // Monotonic save sequence — prevents stale responses from corrupting UI state
  const providerErrorRef = useRef<HTMLDivElement>(null);
  const providerTestErrorRef = useRef<HTMLDivElement>(null);




  // Keep providerSaveStatusRef in sync for stale-closure-safe setTimeout reads
  useEffect(() => {
    providerSaveStatusRef.current = providerSaveStatus;
  });

  // Move focus to error messages when they appear (a11y)
  useEffect(() => {
    if (providerSaveStatus === 'error' && providerErrorRef.current) {
      providerErrorRef.current.focus();
    }
  }, [providerSaveStatus]);

  useEffect(() => {
    if (providerTestStatus === 'error' && providerTestErrorRef.current) {
      providerTestErrorRef.current.focus();
    }
  }, [providerTestStatus]);


  // ─── Load settings on mount ──────────────────────────────────
  useEffect(() => {
    const metis = window.metis;
    if (!metis?.getSettings) return;
    metis.getSettings().then((settings) => {
      if (!settings) return;
      const url = settings.baseUrl ?? '';
      const mdl = settings.model ?? '';
      setSavedBaseUrl(url);
      setSavedModel(mdl);
      setEditBaseUrl(url);
      setEditModel(mdl);
      setHasApiKey(settings.hasApiKey);
      setNeedsReauth(settings.needsReauth);
      if (settings.needsReauth) setShowApiKeyInput(true);
      if (typeof settings.providerVision === 'boolean') setProviderVision(settings.providerVision);
      if (typeof settings.providerMaxContextTokens === 'number') setProviderMaxContextTokens(settings.providerMaxContextTokens);
    }).catch(() => { /* ignore */ });
  }, []);


  // ─── Provider dirty check ────────────────────────────────────
  const providerDirty =
    editBaseUrl !== savedBaseUrl ||
    editModel !== savedModel ||
    editApiKey !== '';

  // ─── Test connection (real probe, never empty key) ───────────
  const handleTestConnection = async () => {
    // P0 fix: reject empty key when no saved key exists
    if (!hasApiKey && !editApiKey.trim()) {
      setProviderTestStatus('error');
      setProviderTestMessage(t('settings.testConnectionEmptyKey'));
      return;
    }

    setProviderTestStatus('testing');
    setProviderTestMessage('');
    try {
      const metis = window.metis;
      if (!metis?.setupProbe) {
        setProviderTestStatus('error');
        setProviderTestMessage(t('settings.testConnectionUnavailable'));
        return;
      }

      // keyMode: 'saved' instructs main to decrypt the stored key;
      // 'replace' sends a new key via the existing secure channel.
      const keyMode: 'saved' | 'replace' = editApiKey.trim() ? 'replace' : 'saved';

      const result = await metis.setupProbe({
        version: 1,
        operationId: `settings-test-${Date.now()}`,
        keyMode,
        baseUrl: editBaseUrl || 'https://api.openai.com/v1',
        model: editModel || 'gpt-4o',
        ...(keyMode === 'replace' ? { newApiKey: editApiKey.trim() } : {}),
      }) as SetupProbeResponse;

      if (result && typeof result === 'object' && result.success) {
        setProviderTestStatus('success');
        setProviderTestMessage(t('settings.testConnectionSuccess'));
      } else {
        setProviderTestStatus('error');
        const recoveryCode = (result && typeof result === 'object' && 'recovery' in result)
          ? (result.recovery as { code?: string })?.code
          : undefined;
        setProviderTestMessage(t('settings.testConnectionFailed') + (recoveryCode ? ` (${recoveryCode})` : ''));
      }
    } catch {
      setProviderTestStatus('error');
      setProviderTestMessage(t('settings.testConnectionFailed'));
    }
  };

  // ─── Save provider (probe then save → SecureStorage → reinit) ─
  const handleSaveProvider = async () => {
    // P0 fix: reject empty key when no saved key exists
    if (!hasApiKey && !editApiKey.trim()) {
      setProviderSaveStatus('error');
      setProviderSaveMessage(t('settings.saveEmptyKey'));
      return;
    }

    setProviderSaveStatus('saving');
    setProviderSaveMessage('');
    try {
      const metis = window.metis;
      if (!metis?.setupProbe || !metis?.setupSave) {
        setProviderSaveStatus('error');
        setProviderSaveMessage(t('settings.saveUnavailable'));
        return;
      }

      const apiKeyForSave = editApiKey.trim();
      const keyMode: 'saved' | 'replace' = apiKeyForSave ? 'replace' : 'saved';

      // Step 1: probe to get probeId, configVersion, and capabilities
      const probeResult = await metis.setupProbe({
        version: 1,
        operationId: `settings-save-probe-${Date.now()}`,
        keyMode,
        baseUrl: editBaseUrl || 'https://api.openai.com/v1',
        model: editModel || 'gpt-4o',
        ...(keyMode === 'replace' ? { newApiKey: apiKeyForSave } : {}),
      }) as SetupProbeResponse;

      if (!probeResult || typeof probeResult !== 'object' || !probeResult.success) {
        setProviderSaveStatus('error');
        const recoveryCode = (probeResult && typeof probeResult === 'object' && 'recovery' in probeResult)
          ? (probeResult.recovery as { code?: string })?.code
          : 'probe_failed';
        setProviderSaveMessage(t('settings.saveFailed') + ` (${recoveryCode})`);
        return;
      }

      const probeSuccess = probeResult as SetupProbeSuccess;
      const probeId = probeSuccess.probeId;
      const configVersion = probeSuccess.configVersion;

      // Step 2: save using probeId and real configVersion (never hardcoded 0)
      const saveResult = await metis.setupSave({
        version: 1,
        operationId: `settings-save-${Date.now()}`,
        expectedConfigVersion: configVersion,
        probeId,
      }) as SetupSaveResponse;

      if (saveResult && typeof saveResult === 'object' && saveResult.success) {
        setSavedBaseUrl(editBaseUrl);
        setSavedModel(editModel);
        setHasApiKey(true);
        setNeedsReauth(false);
        setEditApiKey('');
        setShowApiKeyInput(false);
        setProviderSaveStatus('saved');
        setProviderSaveMessage(t('settings.saveSuccess'));
      } else {
        setProviderSaveStatus('error');
        const recoveryCode = (saveResult && typeof saveResult === 'object' && 'recovery' in saveResult)
          ? (saveResult.recovery as { code?: string })?.code
          : 'unknown';
        setProviderSaveMessage(t('settings.saveFailed') + ` (${recoveryCode})`);
      }
    } catch {
      setProviderSaveStatus('error');
      setProviderSaveMessage(t('settings.saveFailed'));
    }
    setTimeout(() => {
      if (providerSaveStatusRef.current !== 'error') {
        setProviderSaveStatus('idle');
        setProviderSaveMessage('');
      }
    }, 3000);
  };

  // ─── Cancel provider edits ───────────────────────────────────
  const handleCancelProvider = () => {
    setEditBaseUrl(savedBaseUrl);
    setEditModel(savedModel);
    setEditApiKey('');
    setShowApiKeyInput(false);
    setProviderTestStatus('idle');
    setProviderTestMessage('');
    setProviderSaveStatus('idle');
    setProviderSaveMessage('');
  };


  // ─── Theme change (transactional via store) ──────────────────
  const handleThemeChange = (newTheme: ThemeMode) => {
    setTheme(newTheme); // store.setTheme handles transactional rollback
  };

  // ─── Render ──────────────────────────────────────────────────
  return (
    <div className="placeholder-page settings-page" role="region" aria-label={t('settings.pageTitle')}>
      <h2>{t('settings.pageTitle')}</h2>

      {/* Provider status summary */}
      <div className="settings-group" style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>
            {t('settings.providerStatus')}
          </div>
          <div style={{ fontSize: 13 }} aria-live="polite">
            {savedBaseUrl
              ? <span style={{ color: 'var(--status-completed)' }}>● {t('settings.connected')}</span>
              : <span style={{ color: 'var(--text-muted)' }}>○ {t('settings.notConfigured')}</span>}
            {savedModel && <span style={{ marginLeft: 12, color: 'var(--text-secondary)' }}>{savedModel}</span>}
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 180 }}>
          <label htmlFor="theme-select" style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4, display: 'block' }}>
            {t('settings.themeLabel')}
          </label>
          <select
            id="theme-select"
            value={theme}
            onChange={(e) => handleThemeChange(e.target.value as ThemeMode)}
            className="settings-input"
            style={{ width: 140 }}
          >
            <option value="light">{t('common.light')}</option>
            <option value="dark">{t('common.dark')}</option>
            <option value="system">{t('common.themeSystem')}</option>
          </select>
        </div>
      </div>

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

      {/* O13: 项目级 provider/model 覆盖 */}
      <SettingsProjectProviderSection />

      {/* Legacy single-connection recovery editor. Existing users retain a safe recovery path while profile migration completes. */}
      <details className="settings-group settings-legacy-connection" open>
        <summary>{locale === 'zh' ? '单连接恢复与兼容选项' : 'Single-connection recovery and compatibility'}</summary>
        <p className="settings-hint">{locale === 'zh' ? '新的模型连接请使用上方连接列表。此处仅用于迁移或恢复旧配置。' : 'Use the connection list above for new model connections. This section only supports legacy migration and recovery.'}</p>
      <div>
        <h3>{t('settings.providerConfig')}</h3>
        {needsReauth && (
          <div
            style={{ padding: '10px 14px', marginBottom: 12, background: 'var(--warning-bg, #fff3cd)', border: '1px solid var(--warning-border, #ffc107)', borderRadius: 6, color: 'var(--warning-text, #856404)', fontSize: 13 }}
            role="alert"
          >
            <WarningIcon size={14} /> {t('settings.needsReauth')}
          </div>
        )}

        {/* Base URL */}
        <div style={{ marginBottom: 12 }}>
          <label htmlFor="provider-baseurl" style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>
            {t('settings.apiBaseUrl')}
          </label>
          <input
            id="provider-baseurl"
            type="text"
            value={editBaseUrl}
            onChange={(e) => setEditBaseUrl(e.target.value)}
            className="settings-input"
            style={{ width: '100%' }}
            placeholder="https://api.openai.com/v1"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        {/* Model */}
        <div style={{ marginBottom: 12 }}>
          <label htmlFor="provider-model" style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>
            {t('settings.model')}
          </label>
          <input
            id="provider-model"
            type="text"
            value={editModel}
            onChange={(e) => setEditModel(e.target.value)}
            className="settings-input"
            style={{ width: '100%' }}
            placeholder="gpt-4o"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        {/* Vision (multimodal) — METIS-WX-2: gates WeChat image understanding */}
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: 'var(--text-secondary)', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={providerVision}
              onChange={(e) => {
                const next = e.target.checked;
                setProviderVision(next);
                void window.metis?.setSettings?.({
                  theme,
                  providerVision: next,
                }).then((result) => {
                  if (result?.success) setVisionSaveStatus('saved');
                });
              }}
              data-testid="provider-vision-toggle"
            />
            {t('settings.providerVision')}
            {visionSaveStatus === 'saved' && (
              <span style={{ fontSize: 11, color: 'var(--status-completed)' }}>✓</span>
            )}
          </label>
        </div>

        {/* Max context tokens — 0 = auto-detect from model; 70% threshold triggers compression */}
        <div style={{ marginBottom: 12 }}>
          <label htmlFor="provider-max-context" style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>
            {t('settings.providerMaxContext')}
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              id="provider-max-context"
              type="number"
              min={0}
              step={1000}
              value={providerMaxContextTokens || ''}
              placeholder={t('settings.providerMaxContextPlaceholder')}
              onChange={(e) => setProviderMaxContextTokens(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
              onBlur={() => {
                const next = providerMaxContextTokens;
                void window.metis?.setSettings?.({
                  theme,
                  providerMaxContextTokens: next,
                }).then((result) => {
                  if (result?.success) setMaxContextSaveStatus('saved');
                });
              }}
              className="settings-input"
              style={{ width: 180 }}
              data-testid="provider-max-context-input"
              autoComplete="off"
              spellCheck={false}
            />
            {maxContextSaveStatus === 'saved' && (
              <span style={{ fontSize: 11, color: 'var(--status-completed)' }}>✓</span>
            )}
          </div>
        </div>

        {/* API Key — masked, never displayed */}
        <div style={{ marginBottom: 12 }}>
          <label
            htmlFor={showApiKeyInput || !hasApiKey ? 'provider-apikey' : undefined}
            style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}
          >
            {t('settings.apiKey')}
          </label>
          {hasApiKey && !showApiKeyInput ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span aria-label={t('settings.apiKeyMasked')}>••••••••</span>
          <button
            type="button"
            className="btn-sm btn-secondary"
            onClick={() => setShowApiKeyInput(true)}
            data-testid="change-api-key"
          >
                {t('settings.changeApiKey')}
              </button>
            </div>
          ) : (
            <input
              id="provider-apikey"
              type="password"
              value={editApiKey}
              onChange={(e) => setEditApiKey(e.target.value)}
              className="settings-input"
              style={{ width: '100%' }}
              placeholder={t('settings.apiKeyPlaceholder')}
              autoComplete="off"
            />
          )}
        </div>

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }} role="group" aria-label={t('settings.providerActions')}>
          <button
            type="button"
            className="btn-primary"
            onClick={handleSaveProvider}
            disabled={!providerDirty || providerSaveStatus === 'saving'}
            data-testid="provider-save"
          >
            {providerSaveStatus === 'saving' ? t('common.saving') : providerSaveStatus === 'saved' ? t('common.saved') : t('common.save')}
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={handleCancelProvider}
            disabled={!providerDirty || providerSaveStatus === 'saving'}
            data-testid="provider-cancel"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={handleTestConnection}
            disabled={providerTestStatus === 'testing' || providerSaveStatus === 'saving'}
            data-testid="provider-test"
          >
            {providerTestStatus === 'testing' ? t('common.testing') : t('settings.testConnection')}
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void handleRunEval()}
            disabled={evalStatus === 'running'}
            data-testid="run-research-eval"
          >
            {evalStatus === 'running' ? t('common.testing') : t('settings.runResearchEval')}
          </button>
        </div>

        {evalNotice && (
          <div role="status" data-testid="eval-notice" style={{ marginTop: 8, fontSize: 12, whiteSpace: 'pre-wrap', color: evalStatus === 'error' ? 'var(--status-failed)' : 'var(--status-completed)' }}>
            {evalNotice}
          </div>
        )}

        {/* Live status region — errors use role="alert" for immediate announcement */}
        <div role="alert" data-testid="provider-error-region" style={{ marginTop: 8 }}>
          {providerSaveStatus === 'error' && <div ref={providerErrorRef} tabIndex={-1} style={{ fontSize: 12, color: 'var(--status-failed)', outline: '2px solid var(--status-failed)', outlineOffset: 2 }}>{providerSaveMessage}</div>}
          {providerTestStatus === 'error' && <div ref={providerTestErrorRef} tabIndex={-1} style={{ fontSize: 12, color: 'var(--status-failed)', outline: '2px solid var(--status-failed)', outlineOffset: 2 }}>{providerTestMessage}</div>}
        </div>
        <div role="status" aria-live="polite">
          {providerSaveStatus === 'saved' && <div style={{ fontSize: 12, color: 'var(--status-completed)' }}>{providerSaveMessage}</div>}
          {providerTestStatus === 'success' && <div style={{ fontSize: 12, color: 'var(--status-completed)' }}>{providerTestMessage}</div>}
        </div>
      </div>
      </details>

      <ZoteroSettingsSection />


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

      {/* Data backup / import */}
      <SettingsBackupSection uiMode={uiMode} />
      <CloudSyncSection />
      <div className="settings-group" data-testid="issn-import-section" data-settings-section="issn-import">
        <h3>{t('settings.issnImportTitle')}</h3>
        <p className="cloud-sync__hint">{t('settings.issnImportHint')}</p>
        <button
          type="button"
          className="btn-secondary btn-sm"
          onClick={() => void handleIssnImport()}
          data-testid="issn-import-button"
        >
          {t('settings.issnImportButton')}
        </button>
        {issnNotice && <div role="status" data-testid="issn-import-notice" className="cloud-sync__notice">{issnNotice}</div>}
      </div>

      {/* Complete project archive (METIS-F10) */}
      <SettingsProjectArchiveSection uiMode={uiMode} />

      {/* User-configurable data directory (storage location) */}
      <SettingsStorageSection />

      {/* WeChat Bot (METIS-WX-1) */}
      <SettingsWeChatBotSection />

      {/* Diagnostic-only: MCP + HITL */}
      {diagnosticMode && <SettingsDiagnosticSection />}
    </div>
  );
}
