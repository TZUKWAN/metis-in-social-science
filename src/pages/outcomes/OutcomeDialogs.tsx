import { RotateCcw, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { type OutcomeCategory, type OutcomeKind, type OutcomeTrashEntry } from '../../../engine/runtime/OutcomeRuntimeContract';
import { kindIcon } from './shared';

export function OutcomeTrashDialog({ items, now, confirmId, setConfirmId, close, onRestore, onDeleteForever }: { items: OutcomeTrashEntry[]; now: number; confirmId: string | null; setConfirmId: (id: string | null) => void; close: () => void; onRestore: (outcomeId: string) => void; onDeleteForever: (outcomeId: string) => void }) {
  const remainingDays = (expiresAt: number) => Math.max(0, Math.ceil((expiresAt - now) / (24 * 60 * 60 * 1000)));
  return <div className="outcomes-modal-backdrop" role="presentation"><div className="outcomes-modal outcomes-trash-modal" role="dialog" aria-modal="true" aria-label="成果回收站"><header><strong>成果回收站</strong><button type="button" onClick={close} aria-label="关闭"><X size={16} /></button></header><p className="outcomes-trash-modal__hint">删除的成果在此保留 7 天，到期自动彻底删除（含源文件），彻底删除后不可恢复。</p>{items.length === 0 ? <p className="outcomes-trash-modal__empty">回收站是空的。</p> : <ul className="outcomes-trash-list">{items.map((entry) => <li key={entry.outcome.id} className="outcomes-trash-item"><div className="outcomes-trash-item__meta">{kindIcon(entry.outcome.kind)}<div><strong>{entry.outcome.title}</strong><small>删除于 {new Date(entry.deletedAt).toLocaleString()} · 剩余 {remainingDays(entry.expiresAt)} 天</small></div></div><div className="outcomes-trash-item__actions">{confirmId === entry.outcome.id ? <><span className="outcomes-trash-item__warn">不可恢复</span><button className="danger" type="button" onClick={() => onDeleteForever(entry.outcome.id)}>确认彻底删除</button><button type="button" onClick={() => setConfirmId(null)}>取消</button></> : <><button type="button" onClick={() => onRestore(entry.outcome.id)}><RotateCcw size={13} />恢复</button><button type="button" onClick={() => setConfirmId(entry.outcome.id)}><Trash2 size={13} />彻底删除</button></>}</div></li>)}</ul>}</div></div>;
}
export function CreateDialog({ categories, close, create, busy }: { categories: OutcomeCategory[]; close: () => void; create: (kind: OutcomeKind, title: string, categoryId: string | null) => void; busy: boolean }) {
  const [kind, setKind] = useState<OutcomeKind>('word'); const [title, setTitle] = useState(''); const [categoryId, setCategoryId] = useState('');
  return <div className="outcomes-modal-backdrop" role="presentation"><form className="outcomes-modal" onSubmit={(event) => { event.preventDefault(); create(kind, title, categoryId || null); }}><header><strong>新建成果</strong><button type="button" onClick={close} aria-label="关闭" disabled={busy}><X size={16} /></button></header><label>成果名称<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} disabled={busy} /></label><label>成果类型<select value={kind} onChange={(event) => setKind(event.target.value as OutcomeKind)} disabled={busy}><option value="word">Word 论文 / 报告</option><option value="ppt">PPT 演示文稿</option><option value="spreadsheet">Excel 工作簿</option><option value="pdf">PDF</option><option value="image">图片</option><option value="chart">图表</option><option value="other">其他正式交付物</option></select></label><label>分类<select value={categoryId} onChange={(event) => setCategoryId(event.target.value)} disabled={busy}><option value="">未分类</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label><footer><button type="button" onClick={close} disabled={busy}>取消</button><button className="primary" disabled={busy || !title.trim()}>{busy ? '创建中…' : '创建'}</button></footer></form></div>;
}
/** 准备投稿：以当前成果版本创建 Submission Case（匹配期刊 / 指定期刊）。 */
export function SubmissionDialog({ close, onCreated, projectId, outcomeId, outcomeTitle, outcomeVersion }: {
  close: () => void; onCreated: () => void; projectId: string; outcomeId: string; outcomeTitle: string; outcomeVersion: number;
}) {
  const [mode, setMode] = useState<'specify' | 'match'>('specify');
  const [journal, setJournal] = useState('');
  const [articleType, setArticleType] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return <div className="outcomes-modal-backdrop" role="presentation"><form className="outcomes-modal" role="dialog" aria-modal="true" aria-label="准备投稿" onSubmit={(event) => {
    event.preventDefault();
    if (!window.metis?.createSubmissionCase || busy) return;
    if (mode === 'specify' && !journal.trim()) return;
    setBusy(true);
    void window.metis.createSubmissionCase({
      projectId,
      title: outcomeTitle,
      sourceOutcomeId: outcomeId,
      sourceOutcomeVersion: outcomeVersion,
      targetJournalName: mode === 'specify' ? journal.trim() : '',
      articleType: (articleType || null) as null | 'research_article' | 'review' | 'short_communication' | 'letter' | 'case_report' | 'conference_paper' | 'thesis_chapter' | 'other',
      initialStatus: mode === 'specify' ? 'JOURNAL_SELECTED' : 'TARGETING',
    }).then((result) => {
      setBusy(false);
      if (result && 'ok' in result && result.ok === false && result.code === 'duplicate_active') {
        setError(`该成果已有进行中的投稿（${result.activeJournal || '待选刊'}）。同一篇稿件同时投多个期刊存在一稿多投风险；请先等拒稿/撤稿，或确认后再继续。`);
        return;
      }
      // createCase resolves with { series, submissionCase } (no `ok` flag);
      // null means the handler rejected the request.
      if (result && 'submissionCase' in result) onCreated();
      else setError('创建投稿事务失败，请稍后重试。');
    });
  }}><header><strong>准备投稿</strong><button type="button" onClick={close} aria-label="关闭"><X size={16} /></button></header>
    <label>当前成果<input value={`${outcomeTitle}（v${outcomeVersion}）`} readOnly /></label>
    <fieldset className="submissions-create-mode">
      <label><input type="radio" name="outcome-submission-mode" checked={mode === 'specify'} onChange={() => setMode('specify')} />我已经有目标期刊</label>
      {mode === 'specify' && <>
        <input className="settings-input" value={journal} placeholder="输入目标期刊名称" aria-label="目标期刊名称" autoFocus onChange={(event) => setJournal(event.target.value)} />
        <label>文章类型<select value={articleType} aria-label="文章类型" onChange={(event) => setArticleType(event.target.value)}>
          <option value="">未指定</option>
          <option value="research_article">研究论文</option><option value="review">综述</option>
          <option value="short_communication">短文</option><option value="letter">快报</option>
          <option value="case_report">案例报告</option><option value="conference_paper">会议论文</option>
          <option value="thesis_chapter">学位论文章节</option><option value="other">其他</option>
        </select></label>
      </>}
      <label><input type="radio" name="outcome-submission-mode" checked={mode === 'match'} onChange={() => setMode('match')} />帮我匹配期刊</label>
      {mode === 'match' && <p style={{ margin: 0, fontSize: 12, color: 'var(--text-tertiary)' }}>创建后投稿状态为「选刊中」，期刊匹配将在投稿页继续。</p>}
    </fieldset>
    {error && <p role="alert" style={{ margin: '0 0 10px', fontSize: 12, color: 'var(--status-error)' }}>{error}</p>}
    <footer><button type="button" onClick={close}>取消</button><button className="primary" disabled={busy || (mode === 'specify' && !journal.trim())}>创建投稿事务</button></footer>
  </form></div>;
}

export function PromptDialog({ title, fieldLabel, confirmLabel, initialValue = '', close, submit }: { title: string; fieldLabel: string; confirmLabel: string; initialValue?: string; close: () => void; submit: (value: string) => void }) {  const [value, setValue] = useState(initialValue);
  return <div className="outcomes-modal-backdrop" role="presentation"><form className="outcomes-modal" role="dialog" aria-modal="true" aria-label={title} onSubmit={(event) => { event.preventDefault(); if (!value.trim()) return; submit(value.trim()); }}><header><strong>{title}</strong><button type="button" onClick={close} aria-label="关闭"><X size={16} /></button></header><label>{fieldLabel}<input autoFocus value={value} onFocus={(event) => event.currentTarget.select()} onChange={(event) => setValue(event.target.value)} /></label><footer><button type="button" onClick={close}>取消</button><button className="primary" disabled={!value.trim()}>{confirmLabel}</button></footer></form></div>;
}
