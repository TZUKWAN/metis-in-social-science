/**
 * SettingsPanel — 真正的设置中心组件（替换 App.tsx 内联 SettingsPage）。
 *
 * P0 修复：
 *  - provider/baseUrl/model 真实可编辑（Save/Cancel/dirty）
 *  - masked API key 输入（绝不回显明文）
 *  - 测试连接走真实 setupProbe（使用已存 key receipt 或新 key，非空 key）
 *  - 保存走 setupSave → SecureStorage → provider/agent reinit
 *  - theme 选择包裹 transactional setTheme（IPC 失败回滚）
 *  - project Metis.md 编辑区（CAS 版本检测，非 CLAUDE_MEMORY.md）
 *  - a11y：label/live-region/键盘/focus
 *  - 保留备份/导入/MCP/HITL/诊断模式全部既有功能
 *
 * 本文件只处理新增 Settings UI 逻辑；备份/MCP/HITL 等非 P0 功能
 * 仍由 App.tsx 内联实现，SettingsPanel 只做 provider/theme/agents P0 替换。
 */

import { useState, useEffect, useRef } from 'react';
import { useTranslation } from '../i18n';
import type { LocaleKey, ThemeMode } from '../store';
import { useMetisStore } from '../store';
import { researchWorkspaceStore, useResearchWorkspaceStore } from '../research/researchWorkspaceStore';
import { WarningIcon } from './Icons';
import type { UIMode } from '../../engine/capabilities/DiagnosticMode';
import {
  WORKSPACE_AGENTS_LIMITS,
  WorkspaceAgentsContentSchema,
  type WorkspaceAgentsMutationResult,
} from '../../engine/runtime/WorkspaceAgentsContract';
import type {
  SetupProbeResponse,
  SetupProbeSuccess,
  SetupSaveResponse,
} from '../../engine/runtime/SetupRuntimeContract';
import SettingsProjectMemorySection from './SettingsProjectMemorySection';
import SettingsBackupSection from './SettingsBackupSection';
import SettingsProjectArchiveSection from './SettingsProjectArchiveSection';
import SettingsWeChatBotSection from './SettingsWeChatBotSection';
import SettingsDiagnosticSection from './SettingsDiagnosticSection';
import { ZoteroSettingsSection } from './ZoteroSettingsSection';
import { ToolCatalogPanel } from './ToolCatalogPanel';

export interface SettingsPanelProps {
  uiMode: UIMode;
  onUIModeChange: (mode: UIMode) => void;
}

type ProviderTestStatus = 'idle' | 'testing' | 'success' | 'error';
type ProviderSaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export default function SettingsPanel({ uiMode, onUIModeChange }: SettingsPanelProps) {
  const { t, locale, setLocale } = useTranslation();
  const weeklyReadingGoal = useMetisStore((s) => s.weeklyReadingGoal);
  const setWeeklyReadingGoal = useMetisStore((s) => s.setWeeklyReadingGoal);
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
  const [providerTestMessage, setProviderTestMessage] = useState('');
  const [providerSaveStatus, setProviderSaveStatus] = useState<ProviderSaveStatus>('idle');
  const [providerSaveMessage, setProviderSaveMessage] = useState('');

  // ─── Project Metis.md (CAS) ──────────────────────────────────
  const [agentsContent, setAgentsContent] = useState('');
  const [agentsVersion, setAgentsVersion] = useState(0);
  const [serverContent, setServerContent] = useState('');
  const [serverVersion, setServerVersion] = useState(0);
  const [agentsDirty, setAgentsDirty] = useState(false);
  const [agentsSaveStatus, setAgentsSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'conflict' | 'error'>('idle');
  const [agentsSaveMessage, setAgentsSaveMessage] = useState('');
  const [agentsProjectId, setAgentsProjectId] = useState<string | null>(null);
  const [agentsBlocked, setAgentsBlocked] = useState(true);
  const agentsTextareaRef = useRef<HTMLTextAreaElement>(null);
  const agentsAlertRef = useRef<HTMLDivElement>(null);
  // Ref for stale-closure-safe status reads in setTimeout
  const providerSaveStatusRef = useRef<ProviderSaveStatus>('idle');
  const agentsSaveStatusRef = useRef<'idle' | 'saving' | 'saved' | 'conflict' | 'error'>('idle');
  // Monotonic save sequence — prevents stale responses from corrupting UI state
  const agentsRequestSeq = useRef(0);
  // Timer refs for cleanup and stale detection
  const agentsSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Per-project server cache for stale-response fallback updates
  const agentsServerCache = useRef<Map<string, { content: string; version: number }>>(new Map());
  // Latest t() ref — avoids adding t to effect deps (locale switch would
  // re-run the project-load effect and overwrite dirty drafts).
  const tRef = useRef(t);
  useEffect(() => { tRef.current = t; });
  const providerErrorRef = useRef<HTMLDivElement>(null);
  const providerTestErrorRef = useRef<HTMLDivElement>(null);

  const activeProjectId = useResearchWorkspaceStore((s) => s.activeProjectId);
  const agentsBoundToActiveProject = Boolean(activeProjectId && agentsProjectId === activeProjectId);
  const agentsDisabled = !agentsBoundToActiveProject || agentsBlocked;
  // Per-project draft cache: preserves unsaved edits when switching projects
  const draftCache = useRef<Map<string, { content: string; version: number; dirty: boolean }>>(new Map());
  const previousProjectIdRef = useRef<string | null>(activeProjectId);
  const latestAgentsStateRef = useRef({ content: agentsContent, version: agentsVersion, dirty: agentsDirty });

  // Cleanup save timer on unmount
  useEffect(() => {
    return () => { if (agentsSaveTimer.current) clearTimeout(agentsSaveTimer.current); };
  }, []);

  // Keep latestAgentsStateRef in sync (in its own effect, before the project-change effect)
  useEffect(() => {
    latestAgentsStateRef.current = { content: agentsContent, version: agentsVersion, dirty: agentsDirty };
  });

  // Keep providerSaveStatusRef in sync for stale-closure-safe setTimeout reads
  useEffect(() => {
    providerSaveStatusRef.current = providerSaveStatus;
    agentsSaveStatusRef.current = agentsSaveStatus;
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

  useEffect(() => {
    if ((agentsSaveStatus === 'error' || agentsSaveStatus === 'conflict') && agentsAlertRef.current) {
      agentsAlertRef.current.focus();
    }
  }, [agentsSaveStatus]);

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

  // ─── Load project Metis.md on project change ──────────────────
  useEffect(() => {
    const previousId = previousProjectIdRef.current;
    const nextId = activeProjectId ?? null;
    previousProjectIdRef.current = nextId;

    // Save draft to PREVIOUS project id (not the new one)
    if (previousId && previousId !== nextId) {
      agentsRequestSeq.current += 1;
      const snap = latestAgentsStateRef.current;
      if (snap.dirty) {
        draftCache.current.set(previousId, { content: snap.content, version: snap.version, dirty: true });
      }
      // Reset save status — pending saves from previous project must not
      // leave the new project's button in saving/disabled state.
      setAgentsSaveStatus('idle');
      setAgentsSaveMessage('');
    }

    let cancelled = false;

    queueMicrotask(() => {
      if (cancelled || researchWorkspaceStore.getState().activeProjectId !== nextId) return;
      setAgentsProjectId(nextId);
      setAgentsBlocked(true);
      setAgentsContent('');
      setAgentsVersion(0);
      setServerContent('');
      setServerVersion(0);
      setAgentsDirty(false);
    });

    if (!nextId) {
      queueMicrotask(() => {
        if (!cancelled) {
          setAgentsProjectId(null);
          setAgentsBlocked(true);
          setAgentsContent(''); setAgentsVersion(0); setServerContent(''); setServerVersion(0); setAgentsDirty(false);
        }
      });
      return () => { cancelled = true; };
    }

    const metis = window.metis;
    if (!metis?.getWorkspaceAgents) {
      queueMicrotask(() => {
        if (cancelled || researchWorkspaceStore.getState().activeProjectId !== nextId) return;
        setAgentsSaveStatus('error');
        setAgentsSaveMessage(tRef.current('settings.agentsSaveUnavailable'));
      });
      return () => { cancelled = true; };
    }

    metis.getWorkspaceAgents(nextId).then((view) => {
      if (cancelled || researchWorkspaceStore.getState().activeProjectId !== nextId) return;
      if (view.projectId !== nextId || !WorkspaceAgentsContentSchema.safeParse(view.content).success) {
        setAgentsProjectId(nextId);
        setAgentsBlocked(true);
        setAgentsContent('');
        setAgentsVersion(0);
        setServerContent('');
        setServerVersion(0);
        setAgentsDirty(false);
        setAgentsSaveStatus('error');
        setAgentsSaveMessage(tRef.current('settings.agentsResponseMismatch'));
        return;
      }
      if (view.externalConflict) {
        setAgentsProjectId(nextId);
        setAgentsBlocked(true);
        // External conflict detected — show immediately, block save
        setAgentsContent('');
        setAgentsVersion(0);
        setAgentsDirty(false);
        setServerContent('');
        setServerVersion(0);
        setAgentsSaveStatus('error');
        setAgentsSaveMessage(tRef.current('settings.agentsIntegrityConflict'));
        return;
      }
      setAgentsProjectId(nextId);
      setAgentsBlocked(false);
      setServerContent(view.content);
      setServerVersion(view.version);
      const cached = draftCache.current.get(nextId);
      if (cached && cached.dirty) {
        setAgentsContent(cached.content);
        setAgentsVersion(cached.version);
        setAgentsDirty(true);
      } else {
        setAgentsContent(view.content);
        setAgentsVersion(view.version);
        setAgentsDirty(false);
      }
    }).catch(() => {
      if (cancelled || researchWorkspaceStore.getState().activeProjectId !== nextId) return;
      setAgentsProjectId(nextId);
      setAgentsBlocked(true);
      setAgentsContent('');
      setAgentsVersion(0);
      setServerContent('');
      setServerVersion(0);
      setAgentsDirty(false);
      setAgentsSaveStatus('error');
      setAgentsSaveMessage(tRef.current('settings.agentsSaveUnavailable'));
    });

    return () => { cancelled = true; };
  }, [activeProjectId]);

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

  // ─── Save project Metis.md (CAS) ─────────────────────────────
  const handleResolveConflictKeepLocal = () => {
    const projectId = researchWorkspaceStore.getState().activeProjectId;
    if (!projectId || agentsProjectId !== projectId || agentsBlocked) return;
    const dirty = agentsContent !== serverContent;
    setAgentsVersion(serverVersion);
    setAgentsDirty(dirty);
    setAgentsSaveStatus('idle');
    setAgentsSaveMessage('');
    latestAgentsStateRef.current = { content: agentsContent, version: serverVersion, dirty };
    if (projectId) {
      draftCache.current.set(projectId, { content: agentsContent, version: serverVersion, dirty });
    }
    agentsTextareaRef.current?.focus();
  };

  const handleResolveConflictUseServer = () => {
    const projectId = researchWorkspaceStore.getState().activeProjectId;
    if (!projectId || agentsProjectId !== projectId || agentsBlocked) return;
    setAgentsContent(serverContent);
    setAgentsVersion(serverVersion);
    setAgentsDirty(false);
    setAgentsSaveStatus('idle');
    setAgentsSaveMessage('');
    latestAgentsStateRef.current = { content: serverContent, version: serverVersion, dirty: false };
    if (projectId) draftCache.current.delete(projectId);
    agentsTextareaRef.current?.focus();
  };

  const handleSaveAgents = async () => {
    const snapshotProjectId = researchWorkspaceStore.getState().activeProjectId;
    if (!snapshotProjectId || agentsProjectId !== snapshotProjectId || agentsBlocked
      || !WorkspaceAgentsContentSchema.safeParse(latestAgentsStateRef.current.content).success) {
      setAgentsSaveStatus('error');
      setAgentsSaveMessage(t('settings.agentsNoProject'));
      return;
    }

    setAgentsSaveStatus('saving');
    setAgentsSaveMessage('');

    // Capture snapshot for race detection: what was the state at the moment
    // the user clicked "save"?  The response must not overwrite newer edits or
    // a different project's content.
    const seq = ++agentsRequestSeq.current;
    const snapshotContent = latestAgentsStateRef.current.content;
    const snapshotVersion = latestAgentsStateRef.current.version;

    try {
      const metis = window.metis;
      if (!metis?.setWorkspaceAgents) {
        setAgentsSaveStatus('error');
        setAgentsSaveMessage(t('settings.agentsSaveUnavailable'));
        return;
      }

      const result: WorkspaceAgentsMutationResult = await metis.setWorkspaceAgents(
        snapshotProjectId,
        snapshotContent,
        snapshotVersion,
      );

      // Helper: only clear draft cache if it still matches the saved snapshot.
      // A newer save request may have updated the cache — never blindly delete.
      const clearDraftIfSnapshotMatch = () => {
        const cached = draftCache.current.get(snapshotProjectId);
        if (cached && cached.content === snapshotContent && cached.version === snapshotVersion) {
          draftCache.current.delete(snapshotProjectId);
        }
      };

      // ── Stale request guard ──────────────────────────────
      if (seq !== agentsRequestSeq.current) {
        // Newer save was dispatched — this response is obsolete.
        // Still update caches so the data isn't lost.
        if (result.success) {
          agentsServerCache.current.set(snapshotProjectId, { content: snapshotContent, version: result.version });
          clearDraftIfSnapshotMatch();
        }
        return;
      }

      const currentProjectId = researchWorkspaceStore.getState().activeProjectId;
      const currentContent = latestAgentsStateRef.current.content;

      if (result.success) {
        // ── Project switched? ──────────────────────────────
        if (currentProjectId !== snapshotProjectId) {
          agentsServerCache.current.set(snapshotProjectId, { content: snapshotContent, version: result.version });
          clearDraftIfSnapshotMatch();
          return;
        }

        // ── User kept editing? ─────────────────────────────
        if (currentContent !== snapshotContent) {
          // Snapshot version was saved, but the user has since changed the
          // textarea.  Update the baseline version so the next save won't CAS
          // with a stale expectedVersion.  Keep dirty=true and do NOT show
          // 'saved' — the current content is still unsaved.
          setAgentsVersion(result.version);
          setServerVersion(result.version);
          setServerContent(snapshotContent);
          clearDraftIfSnapshotMatch();
          // Status stays idle/dirty — user is still editing.
          return;
        }

        // ── Perfect match → clean save ────────────────────
        setAgentsVersion(result.version);
        setServerVersion(result.version);
        setServerContent(snapshotContent);
        setAgentsDirty(false);
        clearDraftIfSnapshotMatch();
        setAgentsSaveStatus('saved');
        setAgentsSaveMessage(t('settings.agentsSaved'));
        scheduleAgentsIdleTimer(seq, snapshotProjectId);
      } else if (result.code === 'cas_conflict') {
        // CAS conflict — only update UI if still on the same project
        if (seq === agentsRequestSeq.current && researchWorkspaceStore.getState().activeProjectId === snapshotProjectId) {
          setAgentsSaveStatus('conflict');
          setAgentsSaveMessage(t('settings.agentsConflict'));
          const serverView = await metis.getWorkspaceAgents(snapshotProjectId);
          // Re-check staleness after the reload
          if (seq === agentsRequestSeq.current && researchWorkspaceStore.getState().activeProjectId === snapshotProjectId) {
            if (serverView.projectId !== snapshotProjectId
              || !WorkspaceAgentsContentSchema.safeParse(serverView.content).success) {
              setAgentsBlocked(true);
              setAgentsSaveStatus('error');
              setAgentsSaveMessage(t('settings.agentsResponseMismatch'));
              return;
            }
            if (serverView.externalConflict) {
              setAgentsBlocked(true);
              setAgentsSaveStatus('error');
              setAgentsSaveMessage(t('settings.agentsIntegrityConflict'));
              return;
            }
            setServerContent(serverView.content);
            setServerVersion(serverView.version);
          }
        }
      } else {
        if (seq === agentsRequestSeq.current && researchWorkspaceStore.getState().activeProjectId === snapshotProjectId) {
          if (result.code === 'project_not_found' || result.code === 'external_conflict') setAgentsBlocked(true);
          setAgentsSaveStatus('error');
          setAgentsSaveMessage(result.code === 'project_not_found'
            ? t('settings.agentsNoProject')
            : result.code === 'external_conflict'
              ? t('settings.agentsIntegrityConflict')
              : t('settings.agentsSaveFailed'));
        }
      }
    } catch {
      if (seq === agentsRequestSeq.current && researchWorkspaceStore.getState().activeProjectId === snapshotProjectId) {
        setAgentsSaveStatus('error');
        setAgentsSaveMessage(t('settings.agentsSaveFailed'));
      }
    }
  };

  // Schedule auto-idle timer with seq + project snapshot for stale-resistance
  const scheduleAgentsIdleTimer = (seq: number, projectId: string) => {
    if (agentsSaveTimer.current) clearTimeout(agentsSaveTimer.current);
    agentsSaveTimer.current = setTimeout(() => {
      if (
        seq === agentsRequestSeq.current &&
        researchWorkspaceStore.getState().activeProjectId === projectId &&
        agentsSaveStatusRef.current !== 'error' &&
        agentsSaveStatusRef.current !== 'conflict'
      ) {
        setAgentsSaveStatus('idle');
        setAgentsSaveMessage('');
      }
    }, 2000);
  };

  const displayedAgentsContent = agentsBoundToActiveProject ? agentsContent : '';
  const agentsCharCount = displayedAgentsContent.length;
  const agentsOverLimit = agentsCharCount > WORKSPACE_AGENTS_LIMITS.maxChars;

  // ─── Theme change (transactional via store) ──────────────────
  const handleThemeChange = (newTheme: ThemeMode) => {
    setTheme(newTheme); // store.setTheme handles transactional rollback
  };

  // ─── Render ──────────────────────────────────────────────────
  return (
    <div className="placeholder-page" role="region" aria-label={t('settings.pageTitle')}>
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

      {/* Reading goal */}
      <div className="settings-group">
        <h3>{t('settings.readingGoal')}</h3>
        <p>{t('settings.readingGoalDescription')}</p>
        <label htmlFor="reading-goal-input">
          {t('settings.weeklyReadingGoal')}
          <input
            id="reading-goal-input"
            type="number"
            min={1}
            max={100}
            value={weeklyReadingGoal}
            onChange={(e) => setWeeklyReadingGoal(Number(e.target.value))}
            className="settings-input"
            style={{ width: 120, marginLeft: 12 }}
            data-testid="reading-goal-input"
          />
        </label>
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8 }}>
          {t('settings.readingGoalRange', { min: 1, max: 100 })}
        </p>
        <button
          type="button"
          className="btn-sm btn-secondary"
          style={{ marginTop: 8 }}
          onClick={() => setWeeklyReadingGoal(5)}
          data-testid="reading-goal-reset"
        >
          {t('settings.readingGoalReset')}
        </button>
      </div>

      {/* Provider config — real editable fields */}
      <div className="settings-group">
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
                  weeklyReadingGoal,
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
                  weeklyReadingGoal,
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
        </div>

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

      <ZoteroSettingsSection />

      {/* Project Metis.md — CAS protected */}
      <div className="settings-group">
        <h3>{t('settings.workspaceAgents')}</h3>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
          {t('settings.workspaceAgentsDescription')}
        </p>
        <label htmlFor="agents-textarea" className="sr-only">{t('settings.workspaceAgents')}</label>
        <div ref={agentsAlertRef} role="alert" aria-live="assertive" tabIndex={-1} data-testid="agents-alert" style={{ marginBottom: 8 }}>
          {agentsSaveStatus === 'conflict' && <div style={{ fontSize: 12, color: 'var(--status-failed)', fontWeight: 500 }}>{agentsSaveMessage}</div>}
          {agentsSaveStatus === 'error' && <div style={{ fontSize: 12, color: 'var(--status-failed)', fontWeight: 500 }}>{agentsSaveMessage}</div>}
        </div>
        {!activeProjectId && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>{t('settings.agentsNoProject')}</div>}

        <textarea
          ref={agentsTextareaRef}
          id="agents-textarea"
          value={displayedAgentsContent}
          onChange={(e) => { setAgentsContent(e.target.value); setAgentsDirty(true); setAgentsSaveStatus('idle'); }}
          rows={10}
          className="settings-input"
          style={{ fontFamily: 'monospace', fontSize: 13 }}
          placeholder={t('settings.workspaceAgentsPlaceholder')}
          maxLength={WORKSPACE_AGENTS_LIMITS.maxChars}
          disabled={agentsDisabled}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
          <span
            style={{ fontSize: 11, color: agentsOverLimit ? 'var(--status-failed)' : agentsDirty ? 'var(--accent-warm)' : 'var(--text-muted)' }}
            role="status"
            aria-live="polite"
          >
            {agentsDirty ? '● ' : ''}{agentsCharCount.toLocaleString()} / {WORKSPACE_AGENTS_LIMITS.maxChars.toLocaleString()}
            {agentsVersion > 0 && !agentsDirty && <span style={{ marginLeft: 8 }}>v{agentsVersion}</span>}
          </span>
          <button
            type="button"
            className="btn-primary"
            onClick={handleSaveAgents}
            disabled={agentsDisabled || !agentsDirty || agentsOverLimit || agentsSaveStatus === 'saving'}
            data-testid="agents-save"
            data-status={agentsSaveStatus}
          >
            {agentsSaveStatus === 'saving' ? t('common.saving') : agentsSaveStatus === 'saved' ? t('common.saved') : t('settings.saveAgents')}
          </button>
        </div>
        {agentsSaveStatus === 'conflict' && (
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button type="button" className="btn-sm btn-secondary" onClick={handleResolveConflictKeepLocal} data-testid="agents-keep-local">{t('settings.agentsKeepLocal')}</button>
            <button type="button" className="btn-sm btn-primary" onClick={handleResolveConflictUseServer} data-testid="agents-use-server">{t('settings.agentsUseServer')}</button>
          </div>
        )}
        <div role="status" aria-live="polite" style={{ marginTop: 4 }}>
          {agentsSaveStatus === 'saved' && <div style={{ fontSize: 12, color: 'var(--status-completed)' }}>{agentsSaveMessage}</div>}
        </div>
      </div>

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

      {/* Project Memory (CLAUDE_MEMORY.md — legacy semantics) */}
      <SettingsProjectMemorySection />

      {/* Data backup / import */}
      <SettingsBackupSection uiMode={uiMode} />

      {/* Complete project archive (METIS-F10) */}
      <SettingsProjectArchiveSection uiMode={uiMode} />

      {/* WeChat Bot (METIS-WX-1) */}
      <SettingsWeChatBotSection />

      {/* Tool catalog — browse builtin agent tools by category */}
      <ToolCatalogPanel />

      {/* Diagnostic-only: MCP + HITL */}
      {diagnosticMode && <SettingsDiagnosticSection />}
    </div>
  );
}
