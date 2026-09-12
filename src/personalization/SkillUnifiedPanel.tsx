/**
 * SkillUnifiedPanel — 技能页「全部技能」统一视图（刘总 2026-09 重构）。
 *
 * 已安装技能（含内置/自定义）与能力库（预置目录）条目在同一个卡片网格呈现：
 * - 已安装卡片沿用现有管理操作：编辑（内置走「创建可编辑副本」）/归档/删除/分类/对话优化；
 * - 未安装目录条目提供「安装」（走 window.metis.capabilityVaultInstall，装完由上层刷新为已安装态）；
 * - 顶部搜索框同时过滤已安装（名称/说明，本地）与目录条目（名称/描述，走 vault 查询）；
 * - 已安装按「category: 标签」分组；目录条目归入末尾「技能目录」组并保留「显示更多」机制。
 * 入库不注入：安装只是写入定义清单，只有场景步骤绑定后才在执行时加载。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PersonalizationDefinition } from '../../engine/runtime/PersonalizationRuntimeContract.js';

interface VaultEntryMeta {
  id: string; kind: 'skill' | 'mcp'; name: string; description: string;
  sourceRepo: string; originalPath: string;
  licenseStatus: string; domains: string[]; tags: string[];
  included: boolean; installedDefinitionId: string | null;
}

interface VaultEntryDetail extends VaultEntryMeta { systemPrompt?: string }

/** 技能分类沿用场景的「category: 标签」机制（刘总 2026-09）：分类名存进定义 tags，随定义持久化。 */
const SKILL_CATEGORY_PREFIX = 'category:';
function skillCategoryOf(definition: PersonalizationDefinition): string {
  const marker = definition.tags.find((tag) => tag.startsWith(SKILL_CATEGORY_PREFIX));
  return marker?.slice(SKILL_CATEGORY_PREFIX.length).trim() ?? '';
}

export interface SkillUnifiedPanelProps {
  zh: boolean;
  /** 全部已安装技能定义（含内置）。 */
  definitions: readonly PersonalizationDefinition[];
  /** 是否还没有任何自定义技能（控制空态提示）。 */
  hasNoCustom: boolean;
  selectedId: string | null;
  draftIds: ReadonlySet<string>;
  pendingDeleteId: string | null;
  onSelect: (definitionId: string) => void;
  onFork: (definition: PersonalizationDefinition) => void;
  onArchive: (definition: PersonalizationDefinition) => void;
  onRequestDelete: (definitionId: string) => void;
  onConfirmDelete: (definition: PersonalizationDefinition) => void;
  onCancelDelete: () => void;
  onSaveCategory: (definition: PersonalizationDefinition, category: string) => void;
  /** 「对话优化」：把技能作为上下文送入常驻对话窗。 */
  onOptimize: (definition: PersonalizationDefinition) => void;
}

export function SkillUnifiedPanel({
  zh,
  definitions,
  hasNoCustom,
  selectedId,
  draftIds,
  pendingDeleteId,
  onSelect,
  onFork,
  onArchive,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
  onSaveCategory,
  onOptimize,
}: SkillUnifiedPanelProps) {
  const [keyword, setKeyword] = useState('');
  const [entries, setEntries] = useState<VaultEntryMeta[]>([]);
  const [visibleCount, setVisibleCount] = useState(48);
  const [detail, setDetail] = useState<VaultEntryDetail | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const debounceRef = useRef<number | null>(null);

  const loadEntries = useCallback(async (nextKeyword: string) => {
    const res = await window.metis?.capabilityVaultList?.({
      kind: 'skill',
      keyword: nextKeyword.trim() || undefined,
      limit: 200,
    });
    if (res?.ok && res.entries) setEntries(res.entries as VaultEntryMeta[]);
  }, []);

  // 搜索防抖：关键字变化时重置「显示更多」并重新拉取目录条目。
  useEffect(() => {
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      setVisibleCount(48);
      void loadEntries(keyword);
    }, 250);
    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    };
  }, [keyword, loadEntries]);

  const openDetail = async (entry: VaultEntryMeta) => {
    const res = await window.metis?.capabilityVaultGetDetail?.(entry.id);
    if (res?.ok && res.entry) setDetail(res.entry as VaultEntryDetail);
    else setMessage({ tone: 'error', text: `${zh ? '详情获取失败' : 'Detail failed'}: ${res?.error ?? 'unknown'}` });
  };

  // 已安装技能：按关键字（名称/说明）本地过滤后，沿用 category 分组。
  const lowered = keyword.trim().toLowerCase();
  const installed = definitions.filter((definition) => (
    !lowered
    || definition.name.toLowerCase().includes(lowered)
    || definition.description.toLowerCase().includes(lowered)
  ));
  const groups = new Map<string, PersonalizationDefinition[]>();
  for (const definition of installed) {
    const category = skillCategoryOf(definition);
    const list = groups.get(category) ?? [];
    list.push(definition);
    groups.set(category, list);
  }
  const sortedGroups = [...groups.entries()].sort(([left], [right]) => {
    if (left === '') return 1;
    if (right === '') return -1;
    return left.localeCompare(right, zh ? 'zh-CN' : 'en');
  });
  const skillCategories = sortedGroups.map(([category]) => category).filter(Boolean);

  // 目录条目与已安装定义合并：已被安装定义代表的条目不再重复出现；
  // 其 installedDefinitionId 用于给对应已安装卡片打「目录」来源标记。
  const catalogInstalledIds = new Set(
    entries.map((entry) => entry.installedDefinitionId).filter((id): id is string => Boolean(id)),
  );
  const catalogEntries = entries.filter((entry) => (
    !entry.installedDefinitionId || !definitions.some((definition) => definition.id === entry.installedDefinitionId)
  ));

  // 卡片序号跨分组连续（按渲染顺序预计算，避免渲染期变量重赋值），保证 data-testid 稳定。
  const installedIndexById = new Map(
    sortedGroups.flatMap(([, group]) => group).map((definition, index) => [definition.id, index] as const),
  );
  const renderInstalledCard = (definition: PersonalizationDefinition) => {
    const index = installedIndexById.get(definition.id) ?? 0;
    const isBuiltin = definition.provenance.origin === 'builtin';
    const skillCategory = skillCategoryOf(definition);
    return <article key={definition.id} className={`personalization-card ${selectedId === definition.id ? 'selected' : ''}`}>
      <button className="personalization-card__select" data-definition-id={definition.id} onClick={() => onSelect(definition.id)}>
        <span className="personalization-card__meta">
          <b>{isBuiltin ? (zh ? '内置' : 'Built-in') : catalogInstalledIds.has(definition.id) ? (zh ? '目录' : 'Catalog') : (zh ? '自定义' : 'Custom')}</b>
          <span>r{definition.revision}</span>
          <span className="vault-pill vault-pill--installed">{zh ? '已安装' : 'Installed'}</span>
        </span>
        <strong>{definition.name}</strong>
        <span>{definition.description || (zh ? '暂无说明' : 'No description')}</span>
      </button>
      <div className="personalization-card__actions">
        {draftIds.has(definition.id) && <span className="personalization-card__draft">{zh ? '草稿已保留' : 'Draft preserved'}</span>}
        {!isBuiltin && (
          <input
            className="personalization-card__category"
            list="personalization-skill-category-options"
            defaultValue={skillCategory}
            key={`${definition.id}:${skillCategory}`}
            placeholder={zh ? '分类' : 'Category'}
            aria-label={zh ? '技能分类' : 'Skill category'}
            data-testid={`personalization-skill-category-${index}`}
            onBlur={(event) => onSaveCategory(definition, event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onSaveCategory(definition, (event.target as HTMLInputElement).value);
            }}
          />
        )}
        <button
          type="button"
          data-testid={`personalization-studio-optimize-${index}`}
          onClick={() => onOptimize(definition)}
        >
          {zh ? '对话优化' : 'Improve via chat'}
        </button>
        {isBuiltin
          ? <button onClick={() => onFork(definition)}>{zh ? '创建可编辑副本' : 'Create editable copy'}</button>
          : <button onClick={() => onArchive(definition)}>{zh ? '归档' : 'Archive'}</button>}
        {!isBuiltin && (
          pendingDeleteId === definition.id ? (
            <span className="personalization-card__delete-confirm">
              {zh ? '永久删除？不可恢复' : 'Delete forever? Irreversible'}
              <button
                className="personalization-card__delete personalization-card__delete--armed"
                data-testid={`personalization-skill-delete-confirm-${index}`}
                onClick={() => onConfirmDelete(definition)}
              >
                {zh ? '确认删除' : 'Confirm'}
              </button>
              <button onClick={onCancelDelete}>{zh ? '取消' : 'Cancel'}</button>
            </span>
          ) : (
            <button
              className="personalization-card__delete"
              data-testid={`personalization-skill-delete-${index}`}
              title={zh ? '永久删除该技能及其全部版本历史' : 'Permanently delete this skill and its version history'}
              onClick={() => onRequestDelete(definition.id)}
            >
              {zh ? '删除' : 'Delete'}
            </button>
          )
        )}
      </div>
    </article>;
  };

  return (
    <div className="skill-unified" data-testid="skill-unified-panel">
      <div className="vault-filters">
        <input
          type="search"
          className="vault-filters__search"
          data-testid="personalization-skill-search"
          placeholder={zh ? '搜索技能名称 / 说明…' : 'Search skill name / description…'}
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
        />
      </div>
      {message && (
        <p className={message.tone === 'ok' ? 'vault-message vault-message--ok' : 'vault-message vault-message--error'} data-testid="skill-unified-message">
          {message.text}
        </p>
      )}
      {hasNoCustom && !lowered && (
        <p>{zh ? '还没有自定义内容。' : 'No custom definitions yet.'}</p>
      )}
      {installed.length > 0 && (
        <datalist id="personalization-skill-category-options">
          {skillCategories.map((category) => <option key={category} value={category} />)}
        </datalist>
      )}
      {sortedGroups.map(([category, group]) => (
        <div className="personalization-category-group" key={category || '__uncategorized'}>
          <h3 className="personalization-category-group__title">{category || (zh ? '未分类' : 'Uncategorized')}</h3>
          <div className="personalization-cards">{group.map(renderInstalledCard)}</div>
        </div>
      ))}
      {/* 目录条目：未安装为主，统一归入末尾分组；保留「显示更多」按需展开。 */}
      {catalogEntries.length > 0 && (
        <div className="personalization-category-group" key="__catalog">
          <h3 className="personalization-category-group__title">{zh ? '技能目录（能力库）' : 'Skill catalog (capability vault)'}</h3>
          <p className="personalization-category-group__hint" style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--text-secondary)' }}>
            {zh ? '目录是 METIS 预置的技能清单。在场景步骤中选用某条时会自动加入你的技能库，无需提前操作。' : 'Preset skill catalog — picking one in a scenario step adds it to your library automatically.'}
          </p>
          <div className="personalization-cards" data-testid="skill-catalog-entries">
            {catalogEntries.slice(0, visibleCount).map((entry) => {
              const entryInstalled = Boolean(entry.installedDefinitionId);
              return <article key={entry.id} className="personalization-card vault-card" data-testid="vault-entry">
                <div className="personalization-card__body">
                  <div className="personalization-card__meta">
                    <span className="vault-pill">{zh ? '目录' : 'Catalog'}</span>
                    {entryInstalled && <span className="vault-pill vault-pill--installed">{zh ? '已在库中' : 'In library'}</span>}
                    {!entry.included && <span className="vault-pill vault-pill--excluded">{zh ? '未通过核验' : 'excluded'}</span>}
                    <span>{entry.sourceRepo}</span>
                  </div>
                  <strong>{entry.name}</strong>
                  <span className="personalization-card__description">{entry.description || entry.originalPath}</span>
                  {entry.tags.length > 0 && (
                    <div className="personalization-card__tags">
                      {entry.tags.slice(0, 6).map((tag) => (
                        <span key={tag} className="personalization-tag">{tag}</span>
                      ))}
                    </div>
                  )}
                  <div className="vault-card__actions">
                    <button type="button" className="vault-card__btn" onClick={() => void openDetail(entry)} data-testid="vault-detail-btn">
                      {zh ? '查看详情' : 'Details'}
                    </button>
                  </div>
                </div>
              </article>;
            })}
          </div>
          {catalogEntries.length > visibleCount && (
            <button
              type="button"
              className="btn-secondary vault-card__more"
              data-testid="vault-show-more"
              onClick={() => setVisibleCount((count) => count + 48)}
            >
              {zh ? `显示更多（还有 ${catalogEntries.length - visibleCount} 条，可用上方搜索缩小范围）` : `Show more (${catalogEntries.length - visibleCount} remaining)`}
            </button>
          )}
        </div>
      )}
      {detail && (
        <div className="vault-detail" data-testid="vault-detail-body">
          <div className="vault-detail__head">
            <strong>{detail.name}</strong>
            <span className="vault-detail__path">{detail.originalPath}</span>
            <button type="button" className="vault-detail__close" onClick={() => setDetail(null)}>
              {zh ? '关闭' : 'Close'}
            </button>
          </div>
          <p className="vault-detail__meta">
            {detail.sourceRepo} · {detail.domains.join(' / ') || '—'}
          </p>
          <pre className="vault-detail__body">{(detail.systemPrompt ?? '').slice(0, 8000) || (zh ? '（无正文）' : '(empty)')}</pre>
        </div>
      )}
    </div>
  );
}

export default SkillUnifiedPanel;
