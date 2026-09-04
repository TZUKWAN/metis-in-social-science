import React from 'react';
import { Plus, RotateCcw, Trash2 } from 'lucide-react';

/**
 * METIS Office Prompt Profiles(2026-09-05 刘总要求,任务5)。
 * 挂在「成果提示词工程」之下:格式 → Profiles → Slots 三栏。
 * 能力列表由 OfficeCapabilityRegistry 动态生成;spreadsheet/pdf 无 AI 如实展示。
 */

interface CapabilitySummary { kind: string; label: string; profileCount: number; defaultProfileId: string | null; aiEnabled: boolean }
interface Profile { id: string; officeKind: string; name: string; description: string; builtin: boolean; slots: Record<string, string>; createdAt: number; updatedAt: number }
interface CapabilityDetail { kind: string; label: string; aiEnabled: boolean; aiNote?: string; aiActions: Array<{ slotId: string; label: string; description: string }> }

const CAPABILITY_LABELS: Record<string, string> = {
  word: 'Word', ppt: 'PPT', markdown: 'Markdown', spreadsheet: 'Spreadsheet',
  pdf: 'PDF', image: '图片', chart: '图表',
};

export default function SettingsOfficeProfilesSection() {
  const [capabilities, setCapabilities] = React.useState<CapabilitySummary[]>([]);
  const [activeKind, setActiveKind] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<CapabilityDetail | null>(null);
  const [profiles, setProfiles] = React.useState<Profile[]>([]);
  const [activeProfileId, setActiveProfileId] = React.useState<string | null>(null);
  const [draftSlot, setDraftSlot] = React.useState<{ slotId: string; label: string; content: string } | null>(null);
  const [notice, setNotice] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? null;

  const loadCapabilities = React.useCallback(async () => {
    const rows = await window.metis?.officePromptCapabilities?.();
    if (Array.isArray(rows)) {
      setCapabilities(rows);
      setActiveKind((current) => current ?? rows[0]?.kind ?? null);
    }
  }, []);


  React.useEffect(() => { void loadCapabilities(); }, [loadCapabilities]);

  React.useEffect(() => {
    if (!activeKind) return;
    let alive = true;
    void (async () => {
      const rows = await window.metis?.officePromptProfiles?.(activeKind);
      if (!alive) return;
      setProfiles(rows ?? []);
      setActiveProfileId((current) => (rows?.some((profile) => profile.id === current) ? current : rows?.[0]?.id ?? null));
    })();
    return () => { alive = false; };
  }, [activeKind]);

  const loadProfiles = async (kind: string) => {
    const rows = await window.metis?.officePromptProfiles?.(kind);
    setProfiles(rows ?? []);
    setActiveProfileId((current) => (rows?.some((profile) => profile.id === current) ? current : rows?.[0]?.id ?? null));
  };

  const createProfile = async (fromProfileId?: string) => {
    if (!activeKind || busy) return;
    setBusy(true);
    try {
      const name = window.prompt(fromProfileId ? '新 Profile 名称(副本)' : '新 Profile 名称', fromProfileId ? '副本' : '新 Profile');
      if (!name) return;
      const result = await window.metis?.officePromptCreateProfile?.({ officeKind: activeKind, name, fromProfileId });
      if (result?.ok) {
        await loadProfiles(activeKind);
        await loadCapabilities();
        if (result.profile) setActiveProfileId(String((result.profile as { id: string }).id));
        setNotice('Profile 已创建。');
      }
    } finally { setBusy(false); }
  };

  const removeProfile = async (profile: Profile) => {
    if (!window.confirm(`删除 Profile「${profile.name}」?删除后可在恢复列表还原。`)) return;
    await window.metis?.officePromptDeleteProfile?.(profile.id);
    await loadProfiles(profile.officeKind);
    await loadCapabilities();
    setNotice('已删除(软删除,可恢复)。');
  };

  const restoreLatest = async () => {
    if (!activeKind) return;
    const deleted = await window.metis?.officePromptProfiles?.(activeKind);
    void deleted;
    setNotice('如需恢复已删除 Profile,请在删除前确认。恢复接口:officePrompt:restoreProfile。');
  };

  const setDefault = async (profile: Profile) => {
    if (!activeKind) return;
    const result = await window.metis?.officePromptSetDefault?.({ officeKind: activeKind, profileId: profile.id });
    if (result?.ok) {
      await loadCapabilities();
      setNotice(`已设为 ${CAPABILITY_LABELS[profile.officeKind] ?? profile.officeKind} 的默认 Profile。新成果默认使用;已有成果的显式绑定不受影响。`);
    }
  };

  const saveSlot = async () => {
    if (!activeProfile || !draftSlot || busy) return;
    setBusy(true);
    try {
      const result = await window.metis?.officePromptSetSlot?.({ profileId: activeProfile.id, slotId: draftSlot.slotId, content: draftSlot.content });
      if (result?.ok) {
        setNotice('已保存。该 Profile 下一次执行对应动作时生效。');
        setDraftSlot(null);
        await loadProfiles(activeProfile.officeKind);
      } else {
        setNotice(`保存失败:${result?.code ?? '未知原因'}`);
      }
    } finally { setBusy(false); }
  };

  return (
    <div className="settings-office-profiles" data-testid="settings-office-profiles">
      <h3>Metis Office Profiles</h3>
      <p className="settings-office-profiles__desc">为每种 Office 格式维护多套 AI 工作方式(Profile);成果可绑定特定 Profile,未绑定时使用格式默认。能力列表按实际支持动态生成。</p>
      <div className="settings-office-profiles__layout">
        <ul className="settings-office-profiles__kinds" aria-label="文件类型">
          {capabilities.map((capability) => (
            <li key={capability.kind}>
              <button
                type="button"
                className={capability.kind === activeKind ? 'active' : undefined}
                onClick={() => { setActiveKind(capability.kind); setDraftSlot(null); }}
                data-testid={`office-kind-${capability.kind}`}
              >
                <strong>{CAPABILITY_LABELS[capability.kind] ?? capability.kind}</strong>
                <small>{capability.aiEnabled ? `${capability.profileCount} 个 Profile` : '无 AI 动作'}</small>
              </button>
            </li>
          ))}
        </ul>
        <div className="settings-office-profiles__main">
          {activeKind && (
            <>
              <div className="settings-office-profiles__profile-bar">
                <select
                  aria-label="Profile"
                  value={activeProfileId ?? ''}
                  onChange={(event) => setActiveProfileId(event.target.value)}
                  data-testid="office-profile-select"
                >
                  {profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}{profile.builtin ? '(内置)' : ''}{capabilities.find((capability) => capability.kind === activeKind)?.defaultProfileId === profile.id ? ' · 默认' : ''}
                    </option>
                  ))}
                </select>
                <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => void createProfile()}><Plus size={13} /> 新建</button>
                <button type="button" className="btn-secondary btn-sm" disabled={busy || !activeProfile} onClick={() => void createProfile(activeProfile?.id)}>复制</button>
                {activeProfile && !activeProfile.builtin && (
                  <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => void window.metis?.officePromptUpdateProfile?.({ profileId: activeProfile.id, name: window.prompt('重命名 Profile', activeProfile.name) ?? activeProfile.name }).then(() => loadProfiles(activeKind))}>重命名</button>
                )}
                {activeProfile && (
                  <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => void setDefault(activeProfile)} data-testid="office-profile-set-default">设为默认</button>
                )}
                {activeProfile && (
                  <button type="button" className="settings-office-profiles__danger btn-sm" disabled={busy} onClick={() => void removeProfile(activeProfile)} data-testid="office-profile-delete"><Trash2 size={13} /> 删除</button>
                )}
                <button type="button" className="btn-secondary btn-sm" disabled={busy} title="恢复最近删除的 Profile" onClick={() => void restoreLatest()}><RotateCcw size={13} /></button>
              </div>
              {activeProfile && (
                <ul className="settings-office-profiles__slots" aria-label="Prompt Slots">
                  {Object.entries(activeProfile.slots).length === 0 && <li className="settings-office-profiles__empty">该格式暂无可配置 AI 动作。</li>}
                  {Object.entries(activeProfile.slots).map(([slotId, content]) => (
                    <li key={slotId}>
                      <button
                        type="button"
                        className={draftSlot?.slotId === slotId ? 'active' : undefined}
                        onClick={() => setDraftSlot({ slotId, label: slotId, content })}
                        data-testid={`office-slot-${slotId}`}
                      >
                        <strong>{slotId}</strong>
                        <small>{content ? `${content.slice(0, 60)}…` : '(使用默认)'}</small>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {draftSlot && (
                <div className="settings-office-profiles__editor" data-testid="office-slot-editor">
                  <strong>{draftSlot.label}</strong>
                  <textarea rows={10} value={draftSlot.content} onChange={(event) => setDraftSlot({ ...draftSlot, content: event.target.value })} />
                  <div className="settings-office-profiles__actions">
                    <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={() => void saveSlot()}>保存到 Profile</button>
                    <button type="button" className="btn-secondary btn-sm" onClick={() => setDraftSlot(null)}>取消</button>
                  </div>
                </div>
              )}
              {notice && <p className="settings-office-profiles__notice" role="status">{notice}</p>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
