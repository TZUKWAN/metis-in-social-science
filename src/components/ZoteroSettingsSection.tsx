import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from '../i18n';
import { useMetisStore } from '../store';
import { researchWorkspaceStore } from '../research/researchWorkspaceStore';

const SECRET_NAME = 'ZOTERO_API_KEY';
const LIBRARY_TYPE_KEY = 'metis:zoteroLibraryType';
const LIBRARY_ID_KEY = 'metis:zoteroLibraryId';

type LibraryType = 'personal' | 'group';
type Notice = { kind: 'success' | 'error' | 'info'; message: string } | null;

/**
 * Zotero connection with an explicit library identity. Credentials are written
 * once to the encrypted vault; all imports are executed in the main process.
 */
export function ZoteroSettingsSection() {
  const { t, locale } = useTranslation();
  const zh = locale === 'zh';
  const [libraryType, setLibraryType] = useState<LibraryType>('personal');
  const [libraryId, setLibraryId] = useState('');
  const [savedLibraryType, setSavedLibraryType] = useState<LibraryType>('personal');
  const [savedLibraryId, setSavedLibraryId] = useState('');
  const [hasApiKey, setHasApiKey] = useState(false);
  const [keyMode, setKeyMode] = useState<'saved' | 'replace'>('saved');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [probing, setProbing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [summary, setSummary] = useState<{ imported: number; merged: number; skipped: number } | null>(null);
  const revisionRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const secrets = await window.metis?.listPersonalizationSecrets({ contractVersion: 1, operationId: 'zotero-load' });
        if (cancelled) return;
        const storedType = localStorage.getItem(LIBRARY_TYPE_KEY);
        const type: LibraryType = storedType === 'group' ? 'group' : 'personal';
        const id = localStorage.getItem(LIBRARY_ID_KEY) ?? '';
        setLibraryType(type);
        setSavedLibraryType(type);
        setLibraryId(id);
        setSavedLibraryId(id);
        if (secrets?.ok) {
          revisionRef.current = secrets.revision;
          const keySaved = secrets.secrets.some((secret) => secret.name === SECRET_NAME);
          setHasApiKey(keySaved);
          setKeyMode(keySaved ? 'saved' : 'replace');
        }
      } catch {
        setNotice({ kind: 'error', message: zh ? '无法读取 Zotero 连接状态。' : 'Could not load Zotero connection status.' });
      }
    })();
    return () => { cancelled = true; };
  }, [zh]);

  const identityDirty = libraryType !== savedLibraryType || libraryId.trim() !== savedLibraryId;
  const keyDirty = keyMode === 'replace' && apiKey.trim().length > 0;
  const canSave = !busy && (identityDirty || keyDirty) && Boolean(libraryId.trim());
  const identityValid = /^\d{1,128}$/u.test(libraryId.trim());

  const save = useCallback(async () => {
    if (!identityValid) {
      setNotice({ kind: 'error', message: zh ? '请输入有效的 Zotero 库 ID（仅数字）。' : 'Enter a valid numeric Zotero library ID.' });
      return;
    }
    if (keyMode === 'replace' && !apiKey.trim() && !hasApiKey) {
      setNotice({ kind: 'error', message: zh ? '请输入 Zotero API 密钥。' : 'Enter a Zotero API key.' });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      if (keyMode === 'replace' && apiKey.trim()) {
        const response = await window.metis?.setPersonalizationSecret({
          contractVersion: 1,
          operationId: `zotero-save-${Date.now().toString(36)}`,
          expectedRevision: revisionRef.current,
          name: SECRET_NAME,
          value: apiKey.trim(),
        });
        if (!response?.ok) {
          setNotice({ kind: 'error', message: zh ? `密钥保存失败（${response?.code ?? 'storage_unavailable'}）。` : `Key save failed (${response?.code ?? 'storage_unavailable'}).` });
          return;
        }
        revisionRef.current = response.revision;
        setHasApiKey(true);
        setKeyMode('saved');
        setApiKey('');
      }
      localStorage.setItem(LIBRARY_TYPE_KEY, libraryType);
      localStorage.setItem(LIBRARY_ID_KEY, libraryId.trim());
      setSavedLibraryType(libraryType);
      setSavedLibraryId(libraryId.trim());
      setNotice({ kind: 'success', message: zh ? 'Zotero 连接已保存。现在可安全探测和导入。' : 'Zotero connection saved. It can now be probed and imported securely.' });
    } catch {
      setNotice({ kind: 'error', message: zh ? '保存 Zotero 连接时发生错误。' : 'An error occurred while saving the Zotero connection.' });
    } finally {
      setBusy(false);
    }
  }, [apiKey, hasApiKey, identityValid, keyMode, libraryId, libraryType, zh]);

  const removeKey = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      const response = await window.metis?.removePersonalizationSecret({
        contractVersion: 1,
        operationId: `zotero-remove-${Date.now().toString(36)}`,
        expectedRevision: revisionRef.current,
        name: SECRET_NAME,
      });
      if (!response?.ok) {
        setNotice({ kind: 'error', message: zh ? `移除密钥失败（${response?.code ?? 'storage_unavailable'}）。` : `Key removal failed (${response?.code ?? 'storage_unavailable'}).` });
        return;
      }
      revisionRef.current = response.revision;
      setHasApiKey(false);
      setKeyMode('replace');
      setApiKey('');
      setNotice({ kind: 'success', message: zh ? 'Zotero API 密钥已移除。' : 'Zotero API key removed.' });
    } catch {
      setNotice({ kind: 'error', message: zh ? '移除 Zotero API 密钥时发生错误。' : 'An error occurred while removing the Zotero API key.' });
    } finally {
      setBusy(false);
    }
  }, [zh]);

  const probeConnection = useCallback(async () => {
    if (!hasApiKey || !identityValid || probing) return;
    setProbing(true);
    setNotice(null);
    setSummary(null);
    try {
      const result = await window.metis?.probeZotero({ libraryType, libraryId: libraryId.trim() });
      if (!result?.ok) {
        setNotice({ kind: 'error', message: zh ? `连接检测失败（${result?.error ?? 'unknown'}）。` : `Connection probe failed (${result?.error ?? 'unknown'}).` });
        return;
      }
      setNotice({ kind: 'success', message: zh ? `连接成功，库中共 ${result.totalResults ?? 0} 篇条目。` : `Connected — ${result.totalResults ?? 0} items in the library.` });
    } catch {
      setNotice({ kind: 'error', message: zh ? '连接检测时发生错误。' : 'An error occurred while probing the connection.' });
    } finally {
      setProbing(false);
    }
  }, [hasApiKey, identityValid, libraryId, libraryType, probing, zh]);

  const importLibrary = useCallback(async () => {
    if (!hasApiKey || !identityValid || importing) return;
    setImporting(true);
    setNotice(null);
    setSummary(null);
    try {
      const projectId = researchWorkspaceStore.getState().activeProjectId ?? undefined;
      const result = await window.metis?.importZotero({
        libraryType,
        libraryId: libraryId.trim(),
        query: '',
        maxItems: 50,
        projectId,
      }) as { ok?: boolean; imported?: number; merged?: number; skipped?: number; error?: string } | undefined;
      if (!result?.ok) {
        setNotice({ kind: 'error', message: zh ? `导入失败（${result?.error ?? 'unknown'}）。` : `Import failed (${result?.error ?? 'unknown'}).` });
        return;
      }
      // Refresh the library store so newly imported papers appear immediately.
      const data = await window.metis?.loadAllData?.();
      if (data) {
        useMetisStore.getState().hydrateFromPersistence({
          papers: data.papers ?? [],
          notes: data.notes ?? [],
          experiments: data.experiments ?? [],
          collections: data.collections ?? [],
        });
      }
      setSummary({ imported: result.imported ?? 0, merged: result.merged ?? 0, skipped: result.skipped ?? 0 });
      setNotice({
        kind: 'success',
        message: projectId
          ? zh ? `已导入 ${result.imported ?? 0} 篇并关联当前项目。` : `Imported ${result.imported ?? 0} items and linked them to the active project.`
          : zh ? 'Zotero 文献已同步到全局资料库。' : 'Zotero items have been synchronized into the global library.',
      });
    } catch {
      setNotice({ kind: 'error', message: zh ? '导入 Zotero 文献时发生错误。' : 'An error occurred while importing Zotero items.' });
    } finally {
      setImporting(false);
    }
  }, [hasApiKey, identityValid, importing, libraryId, libraryType, zh]);

  return (
    <section className="settings-group zotero-connection" aria-labelledby="zotero-connection-title">
      <div className="settings-section-heading">
        <div>
          <p className="settings-section-kicker">{zh ? '连接' : 'Connections'}</p>
          <h3 id="zotero-connection-title">{t('settings.zoteroTitle')}</h3>
        </div>
        <span className={`zotero-connection__status ${hasApiKey ? 'is-connected' : ''}`}>{hasApiKey ? (zh ? '已连接' : 'Ready') : (zh ? '未连接' : 'Not connected')}</span>
      </div>
      <p className="settings-hint">{zh ? '选择个人库或群组库。密钥只保存于本机加密存储，导入在主进程中执行，不会回传密钥。' : 'Choose a personal or group library. The key stays in local encrypted storage and imports run in the main process without returning the key.'}</p>

      <div className="zotero-connection__identity">
        <label className="settings-label">
          {zh ? '文献库类型' : 'Library type'}
          <select className="settings-input" value={libraryType} onChange={(event) => setLibraryType(event.target.value as LibraryType)} disabled={busy || importing}>
            <option value="personal">{zh ? '个人库' : 'Personal library'}</option>
            <option value="group">{zh ? '群组库' : 'Group library'}</option>
          </select>
        </label>
        <label className="settings-label">
          {libraryType === 'group' ? (zh ? '群组 ID' : 'Group ID') : (zh ? '用户 ID' : 'User ID')}
          <input className="settings-input" value={libraryId} onChange={(event) => setLibraryId(event.target.value)} inputMode="numeric" autoComplete="off" disabled={busy || importing} />
        </label>
      </div>

      <label className="settings-label">
        {t('settings.zoteroApiKey')}
        {hasApiKey && keyMode === 'saved' ? (
          <div className="settings-key-row">
            <span className="settings-key-mask" aria-label={zh ? '已保存的 Zotero API 密钥' : 'Saved Zotero API key'}>••••••••</span>
            <button type="button" className="btn-sm btn-secondary" onClick={() => setKeyMode('replace')} disabled={busy || importing}>{zh ? '更换密钥' : 'Replace key'}</button>
            <button type="button" className="btn-sm btn-secondary" onClick={() => void removeKey()} disabled={busy || importing}>{zh ? '移除' : 'Remove'}</button>
          </div>
        ) : (
          <input type="password" className="settings-input" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" disabled={busy || importing} />
        )}
      </label>

      <div className="settings-actions">
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={!canSave}>{busy ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存连接' : 'Save connection')}</button>
        <button type="button" className="btn-secondary" onClick={() => void probeConnection()} disabled={!hasApiKey || !identityValid || busy || importing || probing}>{probing ? (zh ? '检测中…' : 'Probing…') : (zh ? '检测连接' : 'Probe connection')}</button>
        <button type="button" className="btn-secondary" onClick={() => void importLibrary()} disabled={!hasApiKey || !identityValid || busy || importing || probing}>{importing ? (zh ? '同步中…' : 'Syncing…') : (zh ? '同步到资料库' : 'Sync to library')}</button>
      </div>
      {summary && <p className="zotero-connection__summary" role="status">{zh ? `新增 ${summary.imported} · 合并 ${summary.merged} · 跳过 ${summary.skipped}` : `Imported ${summary.imported} · Merged ${summary.merged} · Skipped ${summary.skipped}`}</p>}
      {notice && <div className={`provider-profiles__notice provider-profiles__notice--${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.message}</div>}
    </section>
  );
}
