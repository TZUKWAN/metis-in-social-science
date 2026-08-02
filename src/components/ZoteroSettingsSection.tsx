/**
 * ZoteroSettingsSection — configure Zotero library sync credentials.
 *
 * The API key is stored in the personalization secret vault (encrypted at
 * rest via safeStorage); the user/group id is non-secret and lives in the
 * normal settings store. Mirrors the masked-key + dirty + save pattern used
 * by the provider configuration section.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from '../i18n';

const SECRET_NAME = 'ZOTERO_API_KEY';
const USERID_KEY = 'metis:zoteroUserId';
const GROUPID_KEY = 'metis:zoteroGroupId';

export function ZoteroSettingsSection() {
  const { t } = useTranslation();
  const [userId, setUserId] = useState('');
  const [groupId, setGroupId] = useState('');
  const [hasApiKey, setHasApiKey] = useState(false);
  const [keyMode, setKeyMode] = useState<'saved' | 'replace'>('saved');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Latest vault revision, needed for the optimistic-lock field on set/remove.
  const revisionRef = useRef(0);

  // Load the persisted view (settings + whether a vault key exists).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const metis = window.metis;
        const secrets = await metis?.listPersonalizationSecrets({ contractVersion: 1, operationId: 'zotero-load' });
        if (cancelled) return;
        // User/group ids are non-secret renderer preferences; keep them in
        // localStorage so no engine contract change is needed.
        setUserId(localStorage.getItem(USERID_KEY) ?? '');
        setGroupId(localStorage.getItem(GROUPID_KEY) ?? '');
        const list = secrets as { ok?: boolean; revision?: number; secrets?: Array<{ name: string }> } | undefined;
        if (list?.revision !== undefined) revisionRef.current = list.revision;
        const hasKey = Boolean(list?.secrets?.some((s) => s.name === SECRET_NAME));
        setHasApiKey(hasKey);
        // If no key is stored yet, start in replace mode so the input is shown.
        if (!hasKey) setKeyMode('replace');
      } catch {
        // Settings/vault unavailable in this environment; keep empty defaults.
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const dirty = loaded && (
    keyMode === 'replace'
    || (hasApiKey === false && apiKey.trim() !== '')
  );

  const handleTest = useCallback(async () => {
    setNotice(null);
    setBusy(true);
    try {
      const metis = window.metis;
      if (!metis?.listPersonalizationSecrets) {
        setNotice(t('settings.zoteroUnavailable'));
        return;
      }
      // Resolve the key: use the typed value in replace mode, otherwise read vault.
      // The vault does not return values on list, so for the saved path we can
      // only confirm presence; a real probe requires the key to be re-entered.
      const key = apiKey.trim();
      if (!key && hasApiKey) {
        setNotice(t('settings.zoteroSavedKeyNoProbe'));
        return;
      }
      if (!key || !userId.trim()) {
        setNotice(t('settings.zoteroMissingFields'));
        return;
      }
      const { searchZoteroLibrary } = await import('@engine/research/ZoteroClient.js');
      const result = await searchZoteroLibrary({
        apiKey: key,
        userId: userId.trim(),
        groupId: groupId.trim() || undefined,
        query: '',
        start: 0,
        maxResults: 1,
      });
      setNotice(t('settings.zoteroTestOk', { total: result.totalResults ?? 0 }));
    } catch (err) {
      setNotice(t('settings.zoteroTestFailed', { error: String((err as Error).message ?? err) }));
    } finally {
      setBusy(false);
    }
  }, [apiKey, hasApiKey, userId, groupId, t]);

  const handleSave = useCallback(async () => {
    setNotice(null);
    setBusy(true);
    try {
      const metis = window.metis;
      if (!metis?.setPersonalizationSecret) {
        setNotice(t('settings.zoteroUnavailable'));
        return;
      }
      // Persist the API key into the vault when a new value was typed. The
      // vault uses optimistic locking: pass the current revision and refresh
      // it from the response so subsequent mutations stay consistent.
      if (keyMode === 'replace' && apiKey.trim()) {
        const opId = `zotero-set-${Date.now().toString(36)}`;
        const res = await metis.setPersonalizationSecret({
          contractVersion: 1,
          operationId: opId,
          expectedRevision: revisionRef.current,
          name: SECRET_NAME,
          value: apiKey.trim(),
        }) as { ok?: boolean; revision?: number; code?: string };
        if (!res?.ok) {
          setNotice(t('settings.zoteroSaveFailed', { error: res?.code ?? 'storage_unavailable' }));
          return;
        }
        if (res.revision !== undefined) revisionRef.current = res.revision;
        setHasApiKey(true);
        setKeyMode('saved');
        setApiKey('');
      }
      // Persist non-secret ids locally; the engine settings contract does not
      // carry Zotero fields, so renderer-local storage keeps this self-contained.
      localStorage.setItem(USERID_KEY, userId.trim());
      localStorage.setItem(GROUPID_KEY, groupId.trim());
      setNotice(t('settings.zoteroSaved'));
    } catch (err) {
      setNotice(t('settings.zoteroSaveFailed', { error: String((err as Error).message ?? err) }));
    } finally {
      setBusy(false);
    }
  }, [apiKey, keyMode, userId, groupId, t]);

  const handleRemoveKey = useCallback(async () => {
    setNotice(null);
    setBusy(true);
    try {
      const metis = window.metis;
      if (!metis?.removePersonalizationSecret) {
        setNotice(t('settings.zoteroUnavailable'));
        return;
      }
      const opId = `zotero-remove-${Date.now().toString(36)}`;
      const res = await metis.removePersonalizationSecret({
        contractVersion: 1,
        operationId: opId,
        expectedRevision: revisionRef.current,
        name: SECRET_NAME,
      }) as { ok?: boolean; revision?: number; code?: string };
      if (!res?.ok) {
        setNotice(t('settings.zoteroSaveFailed', { error: res?.code ?? 'storage_unavailable' }));
        return;
      }
      if (res.revision !== undefined) revisionRef.current = res.revision;
      setHasApiKey(false);
      setKeyMode('replace');
      setApiKey('');
      setNotice(t('settings.zoteroKeyRemoved'));
    } finally {
      setBusy(false);
    }
  }, [t]);

  if (!loaded) return null;

  return (
    <div className="settings-group">
      <h3>{t('settings.zoteroTitle')}</h3>
      <p className="settings-hint">{t('settings.zoteroHint')}</p>

      <label className="settings-label">
        {t('settings.zoteroUserId')}
        <input
          className="settings-input"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          placeholder="e.g. 12345"
          autoComplete="off"
        />
      </label>

      <label className="settings-label">
        {t('settings.zoteroGroupId')}
        <input
          className="settings-input"
          value={groupId}
          onChange={(e) => setGroupId(e.target.value)}
          placeholder={t('settings.zoteroGroupIdOptional')}
          autoComplete="off"
        />
      </label>

      <div className="settings-label">
        {t('settings.zoteroApiKey')}
        {hasApiKey && keyMode === 'saved' ? (
          <div className="settings-key-row">
            <span className="settings-key-mask">••••••••</span>
            <button type="button" className="btn-toggle" onClick={() => setKeyMode('replace')} disabled={busy}>
              {t('settings.zoteroChangeKey')}
            </button>
            <button type="button" className="btn-toggle" onClick={handleRemoveKey} disabled={busy}>
              {t('settings.zoteroRemoveKey')}
            </button>
          </div>
        ) : (
          <input
            type="password"
            className="settings-input"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={t('settings.zoteroApiKeyPlaceholder')}
            autoComplete="off"
          />
        )}
      </div>

      <div className="settings-actions">
        <button type="button" className="btn-toggle" onClick={handleTest} disabled={busy || !userId.trim()}>
          {busy ? t('settings.zoteroWorking') : t('settings.zoteroTest')}
        </button>
        <button type="button" className="btn-toggle" onClick={handleSave} disabled={busy || !dirty}>
          {t('settings.zoteroSave')}
        </button>
      </div>

      {notice && <div className="settings-notice">{notice}</div>}
    </div>
  );
}
