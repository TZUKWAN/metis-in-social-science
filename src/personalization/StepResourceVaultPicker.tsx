import React from 'react';
import { X } from 'lucide-react';

/**
 * StepResourceVaultPicker — 场景步骤「选择内置技能 / 选择内置 MCP」弹窗。
 * 列出能力库（预置目录）条目，点击即安装并绑定到当前步骤。
 * 已安装的条目直接绑定，不重复安装。
 */

interface VaultEntryMeta {
  id: string;
  kind: 'skill' | 'mcp';
  name: string;
  description: string;
  sourceRepo: string;
  tags: string[];
  included: boolean;
  installedDefinitionId?: string | null;
}

interface Props {
  kind: 'skill' | 'mcp';
  /** 已安装定义（id/名称）：排在目录之前，点击直接绑定，不走安装。 */
  installed: ReadonlyArray<{ id: string; name: string }>;
  onPick: (definitionId: string) => void;
  onClose: () => void;
}

export default function StepResourceVaultPicker({ kind, installed, onPick, onClose }: Props) {
  const [entries, setEntries] = React.useState<VaultEntryMeta[]>([]);
  const [keyword, setKeyword] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState('');

  React.useEffect(() => {
    let alive = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- kind/keyword 变化时重置列表是状态重置而非派生；setState(true) 同步但语义为加载复位
    setLoading(true);
    const timer = window.setTimeout(() => {
      void window.metis?.capabilityVaultList?.({ kind, keyword: keyword.trim() || undefined, limit: 200 }).then((res) => {
        if (!alive) return;
        setEntries(res?.ok && Array.isArray(res.entries) ? res.entries : []);
        setLoading(false);
      });
    }, 200);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [kind, keyword]);

  const pick = async (entry: VaultEntryMeta) => {
    if (busyId) return;
    setBusyId(entry.id);
    setNotice('');
    try {
      if (entry.installedDefinitionId) {
        onPick(entry.installedDefinitionId);
        onClose();
        return;
      }
      const res = await window.metis?.capabilityVaultInstall?.(entry.id);
      if (res?.ok && res.definitionId) {
        onPick(res.definitionId);
        onClose();
      } else if (res?.code === 'already_installed') {
        setNotice('该条目已安装，但未取到定义编号——请重试。');
      } else {
        setNotice(`安装失败：${res?.message ?? res?.code ?? '未知原因'}`);
      }
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="step-vault-picker__backdrop" role="presentation" onClick={onClose}>
      <section
        className="step-vault-picker"
        role="dialog"
        aria-modal="true"
        aria-label={kind === 'skill' ? '选择内置技能' : '选择内置 MCP'}
        data-testid="step-vault-picker"
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <strong>{kind === 'skill' ? '选择内置技能' : '选择内置 MCP'}</strong>
          <button type="button" aria-label="关闭" onClick={onClose}><X size={15} /></button>
        </header>
        <input
          type="search"
          autoFocus
          placeholder="搜索名称 / 描述 / 标签…"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          data-testid="step-vault-picker-search"
        />
        {notice && <p className="step-vault-picker__notice" role="alert">{notice}</p>}
        <div className="step-vault-picker__grid" data-testid="step-vault-picker-list">
          {installed.length > 0 && (
            <>
              <p className="step-vault-picker__group">已安装</p>
              {installed.map((definition) => (
                <button
                  key={definition.id}
                  type="button"
                  className="step-vault-picker__card step-vault-picker__card--installed"
                  onClick={() => { onPick(definition.id); onClose(); }}
                  data-testid={`step-vault-installed-${definition.id}`}
                >
                  <strong>{definition.name}</strong>
                  <small>已安装，点击直接选用</small>
                </button>
              ))}
              <p className="step-vault-picker__group">内置目录</p>
            </>
          )}
          {loading && <p className="step-vault-picker__hint">正在加载目录…</p>}
          {!loading && entries.length === 0 && <p className="step-vault-picker__hint">没有匹配的条目。</p>}
          {!loading && entries.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="step-vault-picker__card"
              disabled={busyId !== null || !entry.included}
              onClick={() => void pick(entry)}
              data-testid={`step-vault-pick-${entry.id}`}
              title={entry.installedDefinitionId ? '已安装，点击直接选用' : '点击安装并选用'}
            >
              <strong>{entry.name}</strong>
              <span>{entry.description || entry.sourceRepo}</span>
              <small>{entry.sourceRepo}{entry.installedDefinitionId ? ' · 已安装' : ''}</small>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
