/**
 * SettingsGlobalMetisSection — 设置中心里的「全局 METIS.md」编辑区。
 *
 * 刘总 2026-09 需求：METIS.md 要能在设置里直接看到并修改。这里读写的是
 * 真实的 personalization rules 定义（kind='rules', scope='global'），与
 * 场景中心/引导流程共用同一条 revision 受控保存通道；不存在时可一键创建
 * 默认全局规则（真实落盘，不是占位文本）。
 */
import { useCallback, useEffect, useState } from 'react';
import type { MetisRulesDefinition, PersonalizationDefinition } from '../../engine/runtime/PersonalizationRuntimeContract.js';
import { useTranslation } from '../i18n';

const DEFAULT_GLOBAL_METIS_MARKDOWN = [
  '# METIS.md',
  '',
  '- 真实性优先：不编造文献、数据或结论；无法核验时如实说明。',
  '- 证据导向：关键论断给出可追溯的出处（DOI/链接/文件路径）。',
  '- 过程透明：执行研究任务时逐条说明正在做什么、产出在哪里。',
  '- 学术规范：默认中文社会科学学术写作惯例，术语前后一致、论证连续。',
  '- 工具纪律：检索、数据分析和文件写入必须真实调用工具，不伪造结果。',
  '- 失败处理：任务失败时给出原因与可执行的下一步，而不是笼统道歉。',
].join('\n');

function isGlobalRules(definition: PersonalizationDefinition): definition is MetisRulesDefinition {
  return definition.kind === 'rules'
    && (definition as MetisRulesDefinition).scope === 'global'
    && typeof (definition as MetisRulesDefinition).markdown === 'string';
}

export default function SettingsGlobalMetisSection() {
  const { locale } = useTranslation();
  const zh = locale === 'zh';
  const [definition, setDefinition] = useState<MetisRulesDefinition | null>(null);
  const [markdown, setMarkdown] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setNotice('');
    try {
      const response = await window.metis?.listPersonalization?.({ contractVersion: 1, kind: 'rules', includeDisabled: true });
      const found = (response?.definitions ?? []).find(isGlobalRules) ?? null;
      setDefinition(found);
      setMarkdown(found?.markdown ?? '');
    } catch {
      setNotice(zh ? '全局规则加载失败，可稍后重试。' : 'Failed to load the global rules; try again later.');
    } finally {
      setLoading(false);
    }
  }, [zh]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async load defers state writes to a microtask
    void Promise.resolve().then(load);
  }, [load]);

  const save = useCallback(async () => {
    const metis = window.metis;
    if (!metis?.savePersonalization || saving) return;
    setSaving(true);
    setNotice('');
    try {
      if (definition) {
        const next: MetisRulesDefinition = {
          ...definition,
          markdown,
          revision: definition.revision + 1,
          enabled: true,
          provenance: { ...definition.provenance, locallyModified: true, updatedAt: Date.now() },
        };
        const result = await metis.savePersonalization({ contractVersion: 1, definition: next, expectedRevision: definition.revision });
        if (result.ok && result.code === 'saved' && result.definition?.kind === 'rules') {
          setDefinition(result.definition);
          setMarkdown((result.definition as MetisRulesDefinition).markdown);
          setNotice(zh ? '已保存。' : 'Saved.');
        } else {
          setNotice(zh ? `保存未完成（${result.code ?? 'unknown'}），当前编辑已保留。` : `Save did not complete (${result.code ?? 'unknown'}); your edits are kept.`);
        }
        return;
      }
      // 尚无全局规则：以默认全文创建（真实落盘）。
      const now = Date.now();
      const created: MetisRulesDefinition = {
        contractVersion: 1,
        id: `user:rules/global-metis-${now.toString(36)}`,
        kind: 'rules',
        name: zh ? '全局 METIS.md' : 'Global METIS.md',
        description: zh ? '全局研究行为规则：真实性、证据、过程透明、学术规范。' : 'Global research behavior rules: truthfulness, evidence, transparency, academic norms.',
        enabled: true,
        tags: [],
        revision: 1,
        scope: 'global',
        scopeId: null,
        markdown: markdown.trim() || DEFAULT_GLOBAL_METIS_MARKDOWN,
        provenance: {
          origin: 'user',
          author: zh ? '刘总' : 'local user',
          version: '1.0.0',
          license: null,
          sourceUrl: null,
          sourceRevision: null,
          installedDigest: null,
          parentId: null,
          parentVersion: null,
          locallyModified: true,
          createdAt: now,
          updatedAt: now,
        },
      };
      const result = await metis.savePersonalization({ contractVersion: 1, definition: created, expectedRevision: 0 });
      if (result.ok && result.code === 'saved' && result.definition?.kind === 'rules') {
        setDefinition(result.definition);
        setMarkdown((result.definition as MetisRulesDefinition).markdown);
        setNotice(zh ? '已创建全局 METIS.md。' : 'Global METIS.md created.');
      } else {
        setNotice(zh ? `创建未完成（${result.code ?? 'unknown'}）。` : `Creation did not complete (${result.code ?? 'unknown'}).`);
      }
    } catch {
      setNotice(zh ? '保存服务不可用，当前编辑已保留。' : 'The save service is unavailable; your edits are kept.');
    } finally {
      setSaving(false);
    }
  }, [definition, markdown, saving, zh]);

  return (
    <div className="settings-group settings-group--wide" data-testid="settings-global-metis">
      <h3>{zh ? '全局 METIS.md' : 'Global METIS.md'}</h3>
      <p>{zh
        ? '对全部对话与研究任务生效的长期规则。场景/项目级 Metis.md 会在此基础上叠加。'
        : 'Long-term rules applied to every conversation and research task. Scenario/project Metis.md layer on top.'}</p>
      {loading ? (
        <p role="status" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{zh ? '加载中…' : 'Loading…'}</p>
      ) : (
        <>
          <textarea
            value={markdown}
            onChange={(event) => setMarkdown(event.target.value)}
            rows={10}
            spellCheck={false}
            aria-label={zh ? '全局 METIS.md 内容' : 'Global METIS.md content'}
            data-testid="settings-global-metis-markdown"
            placeholder={zh ? '编写全局规则，例如真实性、引用、数据处理与工具使用纪律。' : 'Write global rules: truthfulness, citation, data handling, tool discipline.'}
            style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'var(--font-mono, monospace)', fontSize: 12, lineHeight: 1.6, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-primary)', color: 'var(--text-primary)', resize: 'vertical' }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <button
              type="button"
              className="btn-primary btn-sm"
              disabled={saving || (Boolean(definition) && markdown === definition?.markdown)}
              onClick={() => void save()}
              data-testid="settings-global-metis-save"
            >{saving ? (zh ? '保存中…' : 'Saving…') : (definition ? (zh ? '保存' : 'Save') : (zh ? '创建全局 METIS.md' : 'Create global METIS.md'))}</button>
            {!definition && !markdown && (
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() => setMarkdown(DEFAULT_GLOBAL_METIS_MARKDOWN)}
                data-testid="settings-global-metis-default"
              >{zh ? '填入推荐规则' : 'Insert recommended rules'}</button>
            )}
            {notice && <span role="status" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{notice}</span>}
          </div>
        </>
      )}
    </div>
  );
}
