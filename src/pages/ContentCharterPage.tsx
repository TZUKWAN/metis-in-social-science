import { useCallback, useEffect, useState } from 'react';
import './ContentCharterPage.css';

/**
 * 内容规范（Content Charter，2026-09-01 刘总定名）管理区：
 * 全局/项目两级章程的列表、编辑（写作/演示/绘图/质量四板块）、激活、删除、
 * 章程包导出导入（P3）。与场景正交——场景管步骤，本规范管产出表达与质量。
 */

interface CharterRow {
  id: string;
  name: string;
  scope: 'global' | 'project';
  projectId: string | null;
  writing: {
    tone: string; person: string; sentenceStyle: string; citationStyle: string;
    structurePreference: string; extra: string;
    bannedPhrases: Array<{ phrase: string; replacement: string }>;
    terminology: Array<{ term: string; standardForm: string }>;
  };
  presentation: { themeProfileId: string; density: string; bodyFontMinPt: number | null; narrativePreference: string; extra: string };
  figure: {
    colorPrimary: string | null; colorAccent: string | null; colorEmphasis: string | null;
    style: string; labelMinFont: number; outputFormat: string; dpi: number;
    aiDisclosure: boolean; extra: string;
  };
  quality: { thresholds: Array<{ target: string; score: number }>; maxIterations: number };
  createdAt: number; updatedAt: number;
}

type Draft = {
  id?: string; name: string; scope: 'global' | 'project'; projectId: string | null;
  writing: CharterRow['writing'];
  presentation: CharterRow['presentation'];
  figure: CharterRow['figure'];
  quality: CharterRow['quality'];
};

const emptyWriting = { tone: '', person: '', sentenceStyle: '', citationStyle: 'GB/T 7714', structurePreference: '', extra: '', bannedPhrases: [], terminology: [] };
const THEME_OPTIONS = [
  { id: 'academic-blue', label: '学术蓝（通用）' },
  { id: 'gov-red', label: '政务红（通用）' },
  { id: 'tech-slate', label: '科技深空（通用）' },
  { id: 'minimal-mono', label: '极简黑白（通用）' },
  { id: 'wut', label: '武汉理工（校徽蓝三件套）' },
];

function blankDraft(): Draft {
  return {
    name: '', scope: 'global', projectId: null,
    writing: { ...emptyWriting },
    presentation: { themeProfileId: 'academic-blue', density: 'balanced', bodyFontMinPt: null, narrativePreference: '', extra: '' },
    figure: { colorPrimary: null, colorAccent: null, colorEmphasis: null, style: 'clean', labelMinFont: 12, outputFormat: 'png', dpi: 300, aiDisclosure: true, extra: '' },
    quality: { thresholds: [], maxIterations: 3 },
  };
}

function parseLines(text: string, separator: string): Array<{ phrase: string; replacement: string }> {
  return text.split('\n').map((row) => row.trim()).filter(Boolean).map((row) => {
    const index = row.indexOf(separator);
    if (index < 0) return { phrase: row, replacement: '' };
    return { phrase: row.slice(0, index).trim(), replacement: row.slice(index + separator.length).trim() };
  });
}

function joinLines(entries: Array<{ phrase: string; replacement: string }>, separator: string): string {
  return entries.map((entry) => `${entry.phrase}${separator}${entry.replacement}`).join('\n');
}

function parseTerms(text: string): Array<{ term: string; standardForm: string }> {
  return text.split('\n').map((row) => row.trim()).filter(Boolean).map((row) => {
    const index = row.indexOf('→');
    if (index < 0) return { term: row, standardForm: row };
    return { term: row.slice(0, index).trim(), standardForm: row.slice(index + 1).trim() };
  });
}

function joinTerms(entries: Array<{ term: string; standardForm: string }>): string {
  return entries.map((entry) => `${entry.term}→${entry.standardForm}`).join('\n');
}


function summarize(charter: CharterRow): string {
  const parts: string[] = [];
  if (charter.writing.tone.trim()) parts.push(`语气：${charter.writing.tone.slice(0, 24)}`);
  if (charter.writing.bannedPhrases.length > 0) parts.push(`${charter.writing.bannedPhrases.length} 条禁用表述`);
  if (charter.writing.terminology.length > 0) parts.push(`${charter.writing.terminology.length} 条术语`);
  const themeLabel = THEME_OPTIONS.find((option) => option.id === charter.presentation.themeProfileId)?.label ?? charter.presentation.themeProfileId;
  parts.push(themeLabel.replace(/（.*）/u, ''));
  if (charter.figure.style !== 'clean') parts.push(charter.figure.style === 'dense' ? '高密度绘图' : '示意图');
  if (charter.quality.thresholds.length > 0) parts.push(`${charter.quality.thresholds.length} 项阈值`);
  return parts.length > 0 ? parts.join(' · ') : '未配置细则（按内置缺省生效）';
}

export default function ContentCharterPage() {
  const [charters, setCharters] = useState<CharterRow[]>([]);
  const [activeGlobalId, setActiveGlobalId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const metis = window.metis;
    if (!metis?.contentCharterList) return;
    try {
      const rows = (await metis.contentCharterList({})) as unknown as CharterRow[];
      setCharters(Array.isArray(rows) ? rows : []);
      const active = rows.find((row) => row.scope === 'global' && (row as { isActive?: boolean }).isActive);
      void metis.contentCharterResolveActive?.(null).then((resolved) => {
        if (resolved && typeof resolved.id === 'string') setActiveGlobalId(resolved.id);
      }).catch(() => undefined);
      if (active) setActiveGlobalId(active.id);
    } catch { /* 设置页不因章程失败崩溃 */ }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const save = async () => {
    const metis = window.metis;
    if (!metis?.contentCharterSave || !editing) return;
    if (!editing.name.trim()) { setNotice('请填写章程名称。'); return; }
    setBusy(true);
    try {
      const saved = await metis.contentCharterSave({
        ...(editing.id ? { id: editing.id } : {}),
        name: editing.name.trim(),
        scope: editing.scope,
        projectId: editing.projectId,
        writing: editing.writing,
        presentation: editing.presentation,
        figure: editing.figure,
        quality: editing.quality,
        createdAt: Date.now(), updatedAt: Date.now(),
      });
      if (saved) { setNotice('章程已保存。'); setEditing(null); await refresh(); }
      else setNotice('章程保存未完成。');
    } catch { setNotice('章程保存请求未完成。'); }
    finally { setBusy(false); }
  };

  const activate = async (id: string) => {
    const metis = window.metis;
    if (!metis?.contentCharterSetActive) return;
    const ok = await metis.contentCharterSetActive({ id, projectId: null }).catch(() => false);
    setNotice(ok ? '已激活为全局内容规范。所有场景与对话即时生效。' : '激活未完成。');
    if (ok) { setActiveGlobalId(id); await refresh(); }
  };

  const remove = async (id: string, name: string) => {
    const metis = window.metis;
    if (!metis?.contentCharterDelete) return;
    const ok = await metis.contentCharterDelete(id).catch(() => false);
    if (ok) { setNotice(`已删除「${name}」。`); await refresh(); } else setNotice('删除未完成（默认章程不可删除）。');
  };

  const exportCharter = (row: CharterRow) => {
    const blob = new Blob([JSON.stringify(row, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `内容规范-${row.name}.json`; anchor.click();
    URL.revokeObjectURL(url);
  };

  const importCharter = (file: File) => {
    const metis = window.metis;
    if (!metis?.contentCharterSave) return;
    void file.text().then(async (text) => {
      try {
        const value = JSON.parse(text) as Record<string, unknown>;
        const saved = await metis.contentCharterSave?.({
          ...value,
          id: `charter-${Date.now().toString(36)}`,
          name: `${value.name ?? '导入章程'}（导入）`,
          createdAt: Date.now(), updatedAt: Date.now(),
        });
        setNotice(saved ? '章程包已导入。' : '导入未完成。');
        await refresh();
      } catch { setNotice('章程包格式无效，导入失败。'); }
    });
  };

  return (
    <div className="content-charter-page" data-testid="content-charter-page">
      <header className="content-charter-page__head">
        <div>
          <h2>内容规范</h2>
          <p>场景管「做什么」，内容规范管「产出长什么样」——写作语气、PPT 主题、绘图风格、质量阈值，全场景通用。支持多套并存：理论阐释一套、实证研究一套，一键切换即生效。</p>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" className="btn-sm btn-secondary" onClick={() => setEditing(blankDraft())}>新建规范</button>
          <label className="btn-sm btn-secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            导入
            <input type="file" accept=".json" style={{ display: 'none' }} onChange={(event) => { const file = event.target.files?.[0]; if (file) importCharter(file); event.target.value = ''; }} />
          </label>
        </div>
      </header>
      <ul className="content-charter__list">
        {charters.map((charter) => (
          <li key={charter.id} className={charter.id === activeGlobalId ? 'active' : ''}>
            <div className="content-charter__row-main">
              <strong>{charter.name}</strong>
              <span className="content-charter__summary">{summarize(charter)}</span>
            </div>
            {charter.id === activeGlobalId && <span className="content-charter__active-badge">已激活</span>}
            {charter.id !== activeGlobalId && <button type="button" className="btn-sm btn-secondary" onClick={() => void activate(charter.id)}>激活</button>}
            <button type="button" className="btn-sm btn-secondary" onClick={() => setEditing({
              id: charter.id, name: charter.name, scope: charter.scope, projectId: charter.projectId,
              writing: { ...emptyWriting, ...charter.writing },
              presentation: { ...blankDraft().presentation, ...charter.presentation },
              figure: { ...blankDraft().figure, ...charter.figure },
              quality: { ...blankDraft().quality, ...charter.quality },
            })}>编辑</button>
            <button type="button" className="btn-sm btn-secondary" onClick={() => exportCharter(charter)}>导出</button>
            <button type="button" className="btn-sm btn-secondary" onClick={() => void remove(charter.id, charter.name)}>删除</button>
          </li>
        ))}
      </ul>

      {editing && (
        <div className="content-charter__editor" role="dialog" aria-label="编辑内容规范" style={{ marginTop: 10, padding: 12, border: '1px solid var(--border-light, #e3e8ee)', borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label style={{ fontSize: 12 }}>章程名称<input style={{ width: '100%' }} value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} placeholder="例如：课题组合表达规范" /></label>
          <fieldset style={{ border: '1px solid var(--border-light)', borderRadius: 6, padding: 8 }}>
            <legend style={{ fontSize: 12 }}>写作规范</legend>
            <label style={{ display: 'block', fontSize: 12, marginTop: 4 }}>语气与立场<textarea rows={2} style={{ width: '100%' }} value={editing.writing.tone} onChange={(event) => setEditing({ ...editing, writing: { ...editing.writing, tone: event.target.value } })} placeholder="学术客观、审慎克制，避免夸大与绝对化表述" /></label>
            <label style={{ display: 'block', fontSize: 12, marginTop: 4 }}>人称与自称<input style={{ width: '100%' }} value={editing.writing.person} onChange={(event) => setEditing({ ...editing, writing: { ...editing.writing, person: event.target.value } })} placeholder="例如：正文统一使用本研究，不用我们团队" /></label>
            <label style={{ display: 'block', fontSize: 12, marginTop: 4 }}>句式与用词<textarea rows={2} style={{ width: '100%' }} value={editing.writing.sentenceStyle} onChange={(event) => setEditing({ ...editing, writing: { ...editing.writing, sentenceStyle: event.target.value } })} placeholder="例如：多用主动句，避免空泛动词开头" /></label>
            <label style={{ display: 'block', fontSize: 12, marginTop: 4 }}>禁用表述（每行一条：「禁用词」→「替换词」）<textarea rows={2} style={{ width: '100%' }} value={joinLines(editing.writing.bannedPhrases, '→')} onChange={(event) => setEditing({ ...editing, writing: { ...editing.writing, bannedPhrases: parseLines(event.target.value, '→') } })} placeholder={'进行了分析→分析了\n非常→'} /></label>
            <label style={{ display: 'block', fontSize: 12, marginTop: 4 }}>术语统一（每行一条：词条→标准写法）<textarea rows={2} style={{ width: '100%' }} value={joinTerms(editing.writing.terminology)} onChange={(event) => setEditing({ ...editing, writing: { ...editing.writing, terminology: parseTerms(event.target.value) } })} placeholder={'GPT→GPT 模型\n武汉理工→武汉理工大学'} /></label>
            <label style={{ display: 'block', fontSize: 12, marginTop: 4 }}>引用格式<input style={{ width: '100%' }} value={editing.writing.citationStyle} onChange={(event) => setEditing({ ...editing, writing: { ...editing.writing, citationStyle: event.target.value } })} placeholder="GB/T 7714 / APA 第 7 版…" /></label>
            <label style={{ display: 'block', fontSize: 12, marginTop: 4 }}>结构偏好<textarea rows={2} style={{ width: '100%' }} value={editing.writing.structurePreference} onChange={(event) => setEditing({ ...editing, writing: { ...editing.writing, structurePreference: event.target.value } })} placeholder="例如：每章末尾有小结；问题—方法—结论的段落组织" /></label>
            <label style={{ display: 'block', fontSize: 12, marginTop: 4 }}>其他要求<textarea rows={2} style={{ width: '100%' }} value={editing.writing.extra} onChange={(event) => setEditing({ ...editing, writing: { ...editing.writing, extra: event.target.value } })} /></label>
          </fieldset>
          <fieldset style={{ border: '1px solid var(--border-light)', borderRadius: 6, padding: 8 }}>
            <legend style={{ fontSize: 12 }}>演示（PPT）</legend>
            <label style={{ display: 'block', fontSize: 12, marginTop: 4 }}>主题风格<select style={{ width: '100%' }} value={editing.presentation.themeProfileId} onChange={(event) => setEditing({ ...editing, presentation: { ...editing.presentation, themeProfileId: event.target.value } })}>{THEME_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
            <label style={{ display: 'block', fontSize: 12, marginTop: 4 }}>信息密度<select style={{ width: '100%' }} value={editing.presentation.density} onChange={(event) => setEditing({ ...editing, presentation: { ...editing.presentation, density: event.target.value } })}><option value="sparse">精简</option><option value="balanced">均衡</option><option value="dense">详实</option></select></label>
            <label style={{ display: 'block', fontSize: 12, marginTop: 4 }}>叙事偏好<input style={{ width: '100%' }} value={editing.presentation.narrativePreference} onChange={(event) => setEditing({ ...editing, presentation: { ...editing.presentation, narrativePreference: event.target.value } })} placeholder="例如：问题—方案—成效的汇报逻辑" /></label>
          </fieldset>
          <fieldset style={{ border: '1px solid var(--border-light)', borderRadius: 6, padding: 8 }}>
            <legend style={{ fontSize: 12 }}>科研绘图</legend>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
              <label style={{ fontSize: 12 }}>主色<input type="color" value={editing.figure.colorPrimary ?? '#1F4E79'} onChange={(event) => setEditing({ ...editing, figure: { ...editing.figure, colorPrimary: event.target.value } })} /></label>
              <label style={{ fontSize: 12 }}>点缀色<input type="color" value={editing.figure.colorAccent ?? '#D9A521'} onChange={(event) => setEditing({ ...editing, figure: { ...editing.figure, colorAccent: event.target.value } })} /></label>
              <label style={{ fontSize: 12 }}>强调色<input type="color" value={editing.figure.colorEmphasis ?? '#C0392B'} onChange={(event) => setEditing({ ...editing, figure: { ...editing.figure, colorEmphasis: event.target.value } })} /></label>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
              <label style={{ fontSize: 12 }}>风格<select value={editing.figure.style} onChange={(event) => setEditing({ ...editing, figure: { ...editing.figure, style: event.target.value } })}><option value="clean">简洁矢量</option><option value="dense">高密度逻辑图</option><option value="schematic">示意图</option></select></label>
              <label style={{ fontSize: 12 }}>格式<select value={editing.figure.outputFormat} onChange={(event) => setEditing({ ...editing, figure: { ...editing.figure, outputFormat: event.target.value } })}><option value="png">PNG</option><option value="svg">SVG（矢量可编辑）</option></select></label>
              <label style={{ fontSize: 12 }}>DPI<input type="number" min="72" max="600" value={editing.figure.dpi} onChange={(event) => setEditing({ ...editing, figure: { ...editing.figure, dpi: Number(event.target.value) || 300 } })} style={{ width: 80 }} /></label>
              <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}><input type="checkbox" checked={editing.figure.aiDisclosure} onChange={(event) => setEditing({ ...editing, figure: { ...editing.figure, aiDisclosure: event.target.checked } })} />AI 图标注为示意草稿</label>
            </div>
          </fieldset>
          <fieldset style={{ border: '1px solid var(--border-light)', borderRadius: 6, padding: 8 }}>
            <legend style={{ fontSize: 12 }}>质量阈值（打分迭代，低于阈值自动重做，最多 {editing.quality.maxIterations} 轮）</legend>
            {editing.quality.thresholds.length === 0 && <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '4px 0' }}>未配置时使用内置缺省（期刊 8.5 / 学位论文 8.0 / 会议 8.0 / 报告 7.5 / 演示 6.5 / 图 7.5）。</p>}
            {editing.quality.thresholds.map((entry, index) => (
              <div key={entry.target} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
                <span style={{ fontSize: 12, width: 90 }}>{entry.target}</span>
                <input type="number" min="0" max="10" step="0.5" value={entry.score} onChange={(event) => {
                  const score = Number(event.target.value) || 0;
                  setEditing({ ...editing, quality: { ...editing.quality, thresholds: editing.quality.thresholds.map((item, i) => (i === index ? { ...item, score } : item)) } });
                }} style={{ width: 80 }} />
                <button type="button" className="btn-sm btn-secondary" onClick={() => setEditing({ ...editing, quality: { ...editing.quality, thresholds: editing.quality.thresholds.filter((_, i) => i !== index) } })}>移除</button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'center' }}>
              <select aria-label="新增阈值目标" defaultValue="" onChange={(event) => { const target = event.target.value; if (target && !editing.quality.thresholds.some((item) => item.target === target)) setEditing({ ...editing, quality: { ...editing.quality, thresholds: [...editing.quality.thresholds, { target, score: 7.5 }] } }); event.target.value = ''; }} style={{ fontSize: 12 }}>
                <option value="">+ 添加产出类型阈值…</option>
                {['journal', 'thesis', 'conference', 'grant', 'report', 'presentation', 'figure'].filter((target) => !editing.quality.thresholds.some((item) => item.target === target)).map((target) => <option key={target} value={target}>{target}</option>)}
              </select>
              <label style={{ fontSize: 12 }}>最多迭代轮数<input type="number" min="1" max="5" value={editing.quality.maxIterations} onChange={(event) => setEditing({ ...editing, quality: { ...editing.quality, maxIterations: Math.max(1, Math.min(5, Number(event.target.value) || 3)) } })} style={{ width: 60 }} /></label>
            </div>
          </fieldset>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn-sm btn-secondary" onClick={() => setEditing(null)}>取消</button>
            <button type="button" className="btn-sm btn-primary" onClick={() => void save()} disabled={busy}>保存章程</button>
          </div>
        </div>
      )}

      {notice && <p style={{ marginTop: 6, fontSize: 11, color: 'var(--text-secondary)' }} role="status">{notice}</p>}
    </div>
  );
}
