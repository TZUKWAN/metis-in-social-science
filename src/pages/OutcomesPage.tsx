/* eslint-disable react-hooks/refs -- editor selection and external Office callbacks require latest mutable handles. */
/* eslint-disable react-hooks/immutability -- callback refs intentionally bridge effects and async editor actions. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check, Copy, FileSpreadsheet, FileText, LoaderCircle, Plus, Presentation, Save, Send,
  SlidersHorizontal, Trash2, Upload,
} from 'lucide-react';
import { useResearchWorkspaceStore } from '../research/researchWorkspaceStore';
import {
  OutcomeDetailSchema, type OutcomeCategory,
  type OutcomeDetail, type OutcomeDocument, type OutcomeKind,
  type OutcomeSource, type OutcomeSummary, type OutcomeTrashEntry, type OutcomeVersion, type PptDocument, type OutcomePptxWarning, type OutcomeWordDocxWarning,
  type WordDocument,
} from '../../engine/runtime/OutcomeRuntimeContract';
import './OutcomesPage.css';
import { OutcomeWorkbenchPanel } from '../outcomes/OutcomeWorkbenchPanel';
import { OutcomeWordFormattingPanel } from '../components/OutcomeWordFormattingPanel';
import SplitHandle from '../components/SplitHandle';
import { EmptyState, InlineError, QuietLoading, StaleDataNotice } from '../components/async/AsyncFeedback';

import { readStickyValue } from '../hooks/workspacePersistence';
import { navigate } from '../shell/navigation';
import { CreateDialog, OutcomeTrashDialog, PromptDialog, SubmissionDialog } from './outcomes/OutcomeDialogs';
import { OutcomeCategorySection } from './outcomes/OutcomeTree';
import { asRecord, type AssistantApplied, type AssistantSelection, kindIcon, withoutPristineFallbackPages } from './outcomes/shared';
import { WordEditor } from './outcomes/WordEditor';
import { PptStudioEditor } from './outcomes/PptStudioEditor';
import { MediaEditor } from './outcomes/MediaEditor';
import { VersionPanel } from './outcomes/VersionPanel';
import { OutcomeAssistant } from './outcomes/OutcomeAssistant';

const OUTCOMES_TREE_WIDTH_KEY = 'metis-outcomes-tree-width';
const OUTCOMES_ASSISTANT_WIDTH_KEY = 'metis-outcomes-assistant-width';

function loadOutcomesWidth(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = window.localStorage.getItem(key);
    const value = raw === null ? NaN : Number(raw);
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  } catch {
    return fallback;
  }
}

function saveOutcomesWidth(key: string, value: number): void {
  try { window.localStorage.setItem(key, String(Math.round(value))); } catch { /* best-effort */ }
}

const newWord = (): WordDocument => ({ type: 'word', blocks: [{ id: 'p-1', kind: 'paragraph', text: '' }], page: { paper: 'A4', lineSpacing: 1.5 }, header: '', footer: '' });
const newPpt = (): PptDocument => ({ type: 'ppt', ratio: '16:9', theme: {}, templateId: null, generationSkillId: null, pages: [{ id: 'slide-1', title: '封面', pageType: 'cover', humanModified: false, status: 'complete', elements: [] }] });
const makeDocument = (kind: OutcomeKind): OutcomeDocument => kind === 'word'
  ? newWord()
  : kind === 'ppt'
    ? newPpt()
    : kind === 'spreadsheet'
      ? { type: 'spreadsheet', media: null, originalArchiveMediaId: null, workbook: { sheetNames: [], activeSheet: null, activeCell: null, cells: {} } }
      : kind === 'pdf'
        ? { type: 'pdf', media: null, originalArchiveMediaId: null, pageCount: null, activePage: null }
        : { type: 'other', text: '', media: null };
const wordSelectionStillExists = (selection: Extract<AssistantSelection, { kind: 'word' }>, document: WordDocument): boolean => {
  // Table cells are persisted as an unkeyed 2D string array, so row/column
  // coordinates cannot prove that the same semantic cell survived a save.
  if (selection.row !== undefined || selection.column !== undefined) return false;
  const block = document.blocks.find((candidate) => candidate.id === selection.blockId);
  if (!block) return false;
  const sourceText = block.text ?? '';
  if (selection.start === undefined && selection.end === undefined) return true;
  if (selection.start === undefined || selection.end === undefined || !Number.isInteger(selection.start) || !Number.isInteger(selection.end) || selection.start < 0 || selection.end < selection.start || selection.end > sourceText.length) return false;
  return sourceText.slice(selection.start, selection.end) === selection.text;
};
const docxWarningNotice = (warnings: OutcomeWordDocxWarning[]): string => warnings.length === 0 ? '' : `已完成可编辑导入，但有 ${warnings.length} 项未完全保真：${warnings.map((warning) => warning.message).join('；')}`;
const pptxWarningNotice = (warnings: OutcomePptxWarning[]): string => warnings.length === 0 ? '' : `已完成 PPTX 处理，但有 ${warnings.length} 项未完全保真：${warnings.map((warning) => warning.message).join('；')}`;
export default function OutcomesPage({ onNavigateToSubmissions }: { onNavigateToSubmissions?: () => void } = {}) {
  const projectId = useResearchWorkspaceStore((state) => state.activeProjectId);
  const projects = useResearchWorkspaceStore((state) => state.projects);
  const project = projects.find((item) => item.id === projectId);
  const [submissionOpen, setSubmissionOpen] = useState(false);
  const [categories, setCategories] = useState<OutcomeCategory[]>([]);
  const [items, setItems] = useState<OutcomeSummary[]>([]);
  const [selected, setSelected] = useState<OutcomeDetail | null>(null);
  const [versions, setVersions] = useState<OutcomeVersion[]>([]);
  const [editorDocument, setEditorDocument] = useState<OutcomeDocument | null>(null);
  // Outcomes 2.0（T02.01/T02.03）：工作草稿状态——baseVersion 标记、冲突提示与自动保存时间。
  const [draftInfo, setDraftInfo] = useState<{ baseVersion: number; conflict: boolean } | null>(null);
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(null);
  const draftAutosaveTimer = useRef<number | null>(null);
  const draftHistoricalRef = useRef(false);
  const draftScopeRef = useRef<{ projectId: string; outcomeId: string } | null>(null);
  const [assistantSelection, setAssistantSelection] = useState<AssistantSelection>();
  const assistantSelectionRef = useRef<AssistantSelection>(undefined);
  const updateAssistantSelection = useCallback((selection: AssistantSelection) => {
    assistantSelectionRef.current = selection;
    setAssistantSelection(selection);
  }, []);
  const [assistantHistoryRevision, setAssistantHistoryRevision] = useState(0);
  const [isWordDocxImporting, setIsWordDocxImporting] = useState(false);
  const [isPptxImporting, setIsPptxImporting] = useState(false);
  const [isPptxExporting, setIsPptxExporting] = useState(false);
  const wordDocxImportInFlight = useRef(false);
  const pptxImportInFlight = useRef(false);
  const pptxExportInFlight = useRef(false);
  const [operationNotice, setOperationNotice] = useState('');
  const [formattingOpenRequest, setFormattingOpenRequest] = useState(0);
  const [externalEditorSession, setExternalEditorSession] = useState<{ token: string; outcomeId: string; kind: 'word' | 'ppt' | 'spreadsheet' | 'pdf'; fileName: string } | null>(null);
  // 嵌入式视图（已停用）：保留状态供将来重启该方案；当前 Metis Office 走独立窗口。
  const [embeddedViewId, setEmbeddedViewId] = useState<number | null>(null);
  const embeddedStageRef = useRef<HTMLDivElement | null>(null);
  const externalEditorSessionRef = useRef<typeof externalEditorSession>(null);
  const [externalEditorBusy, setExternalEditorBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [categoryPrompt, setCategoryPrompt] = useState<{ mode: 'create' } | { mode: 'rename'; categoryId: string; initialName: string } | null>(null);
  // ── 任务4 统一 Async View State：列表加载 loading / error / stale 三态 ──
  // 首次加载失败 → listState='error'（可重试，绝不冒充空列表）；
  // 已有数据刷新失败 → 保留旧列表 + listStale 提示"当前显示上次成功加载的数据"。
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [listStale, setListStale] = useState(false);
  const [listRetrying, setListRetrying] = useState(false);
  // 任务4：新建成果对话框提交防双击。
  const [createBusy, setCreateBusy] = useState(false);
  // 任务4：复制成果防双击。
  const [duplicateBusy, setDuplicateBusy] = useState(false);
  // 任务4：标记最终版防双击。
  const [markFinalBusy, setMarkFinalBusy] = useState(false);
  // 任务4：保存版本防双击（保存进行中禁用按钮）。
  const [saveBusy, setSaveBusy] = useState(false);

  const loadOutcomes = useCallback(async (phase: 'initial' | 'refresh') => {
    if (!projectId || !window.metis) return;
    if (phase === 'initial') setListState((state) => (state === 'ready' ? 'ready' : 'loading'));
    else setListRetrying(true);
    try {
      const [nextCategories, nextItems] = await Promise.all([
        window.metis.listOutcomeCategories(),
        window.metis.listOutcomes({ projectId, query: '' }),
      ]);
      setCategories(nextCategories as OutcomeCategory[]);
      setItems(nextItems as OutcomeSummary[]);
      setListState('ready');
      setListStale(false);
    } catch (error) {
      console.error('[OutcomesPage] list load failed:', error);
      if (phase === 'initial') setListState('error');
      else setListStale(true);
    } finally {
      setListRetrying(false);
    }
  }, [projectId]);

  const refresh = useCallback(async () => {
    // refresh 是 mutation 后的再同步：失败必须保留旧数据并标 stale，不得静默清空。
    await loadOutcomes('refresh');
  }, [loadOutcomes]);

  // ── 成果回收站（2026-08-24）：软删除进回收站，7 天到期由主进程惰性彻底删除 ──
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashItems, setTrashItems] = useState<OutcomeTrashEntry[]>([]);
  const [trashConfirmId, setTrashConfirmId] = useState<string | null>(null);
  const [trashOpenedAt, setTrashOpenedAt] = useState(0);

  const loadTrash = useCallback(async () => {
    if (!projectId || !window.metis?.listOutcomeTrash) return;
    setTrashItems(await window.metis.listOutcomeTrash({ projectId }) as OutcomeTrashEntry[]);
  }, [projectId]);
  const openTrash = useCallback(async () => { setTrashConfirmId(null); setTrashOpenedAt(Date.now()); setTrashOpen(true); await loadTrash(); }, [loadTrash]);
  const archiveOutcome = useCallback(async (item: OutcomeSummary) => {
    if (!projectId || !window.metis?.archiveOutcome) return;
    if (externalEditorSession?.outcomeId === item.id) {
      const state = window.metis.stateOutcomeGenofficeEditor
        ? await window.metis.stateOutcomeGenofficeEditor({ projectId, outcomeId: item.id })
        : { exists: true, changed: false, session: null };
      if (state.changed) { setOperationNotice('外部文件有未同步修改，请先同步回 METIS 或明确放弃会话。'); return; }
      const token = state.session?.token ?? externalEditorSession.token;
      if (!await window.metis.closeOutcomeGenofficeEditor?.({ projectId, outcomeId: item.id, token })) {
        setOperationNotice('Metis Office 会话未能关闭，成果仍未移入回收站。'); return;
      }
      setExternalEditorSession(null);
    }
    const ok = await window.metis.archiveOutcome({ projectId, outcomeId: item.id });
    if (!ok) { setOperationNotice('移入回收站未完成，成果未被删除。'); return; }
    if (selected?.outcome.id === item.id) { setSelected(null); setEditorDocument(null); setVersions([]); updateAssistantSelection(undefined); }
    // 已移入回收站：清掉"上次选中"记忆，避免下次进入尝试打开已删除成果。
    try { window.localStorage.removeItem(`metis:outcomes-selected:${projectId}`); } catch { /* best-effort */ }
    setOperationNotice(`「${item.title}」已移入回收站，7 天后自动彻底删除；可在回收站恢复。`);
    await refresh();
  }, [externalEditorSession, projectId, refresh, selected, updateAssistantSelection]);
  const restoreTrashOutcome = useCallback(async (outcomeId: string) => {
    if (!projectId || !window.metis?.restoreOutcomeFromTrash) return;
    const ok = await window.metis.restoreOutcomeFromTrash({ projectId, outcomeId });
    if (!ok) { setOperationNotice('恢复未完成，请刷新回收站后重试。'); return; }
    setOperationNotice('成果已从回收站恢复。');
    await Promise.all([loadTrash(), refresh()]);
  }, [loadTrash, projectId, refresh]);
  const deleteTrashOutcomeForever = useCallback(async (outcomeId: string) => {
    if (!projectId || !window.metis?.deleteOutcomePermanent) return;
    if (externalEditorSession?.outcomeId === outcomeId) {
      const state = window.metis.stateOutcomeGenofficeEditor
        ? await window.metis.stateOutcomeGenofficeEditor({ projectId, outcomeId })
        : { exists: true, changed: false, session: null };
      if (state.changed) { setOperationNotice('外部文件有未同步修改，请先同步回 METIS 或明确放弃会话。'); return; }
      const token = state.session?.token ?? externalEditorSession.token;
      if (!await window.metis.closeOutcomeGenofficeEditor?.({ projectId, outcomeId, token })) {
        setOperationNotice('Metis Office 会话未能关闭，成果仍保留在回收站。'); return;
      }
      setExternalEditorSession(null);
    }
    const ok = await window.metis.deleteOutcomePermanent({ projectId, outcomeId });
    if (!ok) { setOperationNotice('彻底删除未完成，成果仍保留在回收站。'); return; }
    setTrashConfirmId(null);
    setOperationNotice('成果及其源文件已彻底删除。');
    await loadTrash();
  }, [externalEditorSession, loadTrash, projectId]);

  useEffect(() => {
    let current = true;
    void (async () => {
      if (!projectId || !window.metis) return;
      if (!current) return;
      await loadOutcomes('initial');
      // 任务4 第十一节：切走再回来恢复上次选中的成果（open 对已删除的成果自会空处理）。
      if (!current) return;
      const stickyId = readStickyValue(`metis:outcomes-selected:${projectId}`);
      if (stickyId && !selected?.outcome.id) void openRef.current?.(stickyId);
    })();
    return () => { current = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 初始加载仅依赖 projectId；open 通过 ref 取最新
  }, [projectId, loadOutcomes]);
  useEffect(() => { externalEditorSessionRef.current = externalEditorSession; }, [externalEditorSession]);

  // Metis Office 关闭自动同步（2026-09-01 刘总要求）：编辑器一关，主进程
  // 已自动同步/收尾并推送结果——这里刷新列表与版本，并清掉本地会话状态。
  const projectIdForAutoSyncRef = useRef(projectId);
  projectIdForAutoSyncRef.current = projectId;
  const refreshForAutoSyncRef = useRef<(() => Promise<void>) | undefined>(undefined);
  refreshForAutoSyncRef.current = refresh;
  useEffect(() => {
    const unsubscribe = window.metis?.onOutcomeExternalEditorAutoSync?.((payload) => {
      if (payload.projectId !== projectIdForAutoSyncRef.current) return;
      setExternalEditorSession(null);
      setEmbeddedViewId(null);
      void refreshForAutoSyncRef.current?.();
      if (payload.ok && payload.changed && payload.version !== undefined) {
        setOperationNotice(payload.message || `检测到 Metis Office 已关闭，改动已自动同步为新版本 v${payload.version}。`);
      } else if (payload.ok) {
        setOperationNotice(payload.message || 'Metis Office 已关闭：内容没有修改，会话已自动结束。');
      } else {
        setOperationNotice(payload.message || 'Metis Office 已关闭，自动同步没有完成。');
      }
    });
    return () => unsubscribe?.();
  }, []);

  const open = useCallback(async (id: string, version?: number) => {
    if (!projectId || !window.metis) return;
    if (externalEditorSession && externalEditorSession.outcomeId !== id) {
      const state = window.metis.stateOutcomeGenofficeEditor
        ? await window.metis.stateOutcomeGenofficeEditor({ projectId, outcomeId: externalEditorSession.outcomeId })
        : { exists: true, changed: false, session: null };
      if (state.changed) { setOperationNotice('外部文件有未同步修改，请先同步回 METIS 或明确放弃会话。'); return; }
      const token = state.session?.token ?? externalEditorSession.token;
      if (!await window.metis.closeOutcomeGenofficeEditor?.({ projectId, outcomeId: externalEditorSession.outcomeId, token })) {
        setOperationNotice('Metis Office 会话未能关闭，当前成果未切换。'); return;
      }
      setExternalEditorSession(null);
    }
    const detail = await window.metis.getOutcome({ projectId, outcomeId: id, ...(version ? { version } : {}) }).catch((error) => {
      console.error('[OutcomesPage] open outcome failed:', error);
      setOperationNotice('打开成果未完成，成果未被修改；可直接重试。');
      return null;
    });
    if (!detail) return;
    const typed = detail as OutcomeDetail;
    setSelected(typed);
    setDraftInfo(null);
    setDraftSavedAt(null);
    draftHistoricalRef.current = version !== undefined && version !== typed.outcome.currentVersion;
    draftScopeRef.current = { projectId, outcomeId: id };
    updateAssistantSelection(undefined); setOperationNotice('');
    // Outcomes 2.0（T02.01）：读取优先级——有未保存草稿 → 打开草稿并明确标记；历史版本只读不触碰草稿。
    if (!version && window.metis.outcome2DraftOpen) {
      try {
        const draftState = await window.metis.outcome2DraftOpen({ projectId, outcomeId: id });
        if (draftState?.ok && draftState.draft && !draftState.requestedHistorical) {
          const draft = draftState.draft as { baseVersion: number; content: OutcomeDocument };
          setEditorDocument(draft.content);
          // 徽标只在草稿内容确实偏离正式版本时显示（初始化的空差异草稿不算）。
          const drifted = JSON.stringify(draft.content) !== JSON.stringify(typed.version.content);
          if (drifted || draftState.conflict) {
            setDraftInfo({ baseVersion: draft.baseVersion, conflict: draftState.conflict === true });
          }
          if (draftState.conflict) setOperationNotice(`当前成果已经产生新版本 v${typed.outcome.currentVersion}；你的未保存草稿基于 v${draft.baseVersion}。`);
          else if (drifted) setOperationNotice('已恢复未保存的工作草稿（尚未创建正式版本）。');
        } else {
          setEditorDocument(typed.version.content);
        }
      } catch { setEditorDocument(typed.version.content); }
    } else {
      setEditorDocument(typed.version.content);
    }
    // 任务4 第十一节：记住当前项目里上次打开的成果，切走再回来不重置。
    try { window.localStorage.setItem(`metis:outcomes-selected:${projectId}`, typed.outcome.id); } catch { /* best-effort */ }
    try {
      setVersions(await window.metis.listOutcomeVersions({ projectId, outcomeId: id }) as OutcomeVersion[]);
    } catch (error) {
      console.error('[OutcomesPage] list versions failed:', error);
      setVersions([]);
    }
  }, [externalEditorSession, projectId, updateAssistantSelection]);
  // open 定义于其后使用前的场景（初始 sticky 恢复 effect）：经 ref 取最新版本。
  const openRef = useRef<typeof open>(undefined);
  useEffect(() => { openRef.current = open; }, [open]);
  // Outcomes 2.0（T02.02/T02.03）：编辑只更新草稿（debounce 1.2s），不产生版本；
  // late async 结果按 scope 丢弃，切换成果后不会写错对象。
  const handleEditorChange = useCallback((next: OutcomeDocument) => {
    setEditorDocument(next);
    if (draftHistoricalRef.current || !projectId || !selected || !window.metis?.outcome2DraftSave) return;
    const scope = { projectId, outcomeId: selected.outcome.id };
    draftScopeRef.current = scope;
    if (draftAutosaveTimer.current !== null) window.clearTimeout(draftAutosaveTimer.current);
    draftAutosaveTimer.current = window.setTimeout(() => {
      if (draftScopeRef.current?.projectId !== projectId || draftScopeRef.current.outcomeId !== selected.outcome.id) return;
      const baseVersion = draftInfo?.baseVersion ?? selected.outcome.currentVersion;
      void window.metis?.outcome2DraftSave({
        projectId, outcomeId: selected.outcome.id, baseVersion, content: next, updatedBy: 'human', force: draftInfo?.conflict === true,
      }).then((result) => {
        if (result?.ok) {
          setDraftSavedAt(new Date().toLocaleTimeString('zh-CN', { hour12: false }));
          setDraftInfo((current) => current ?? { baseVersion, conflict: false });
        }
        else if (result && !result.ok && result.code === 'outcome_draft_conflict') {
          setOperationNotice(`工作草稿基于 v${baseVersion}，但成果已更新到 v${selected.outcome.currentVersion}；草稿保留未覆盖。`);
        }
      }).catch(() => { /* 写失败保留页面草稿，不打断编辑 */ });
    }, 1200);
  }, [projectId, selected, draftInfo]);

  const performSave = useCallback(async (content: OutcomeDocument, note = '保存编辑', actor: 'human' | 'ai' | 'import' | 'restore' = 'human', sources: OutcomeSource[] = [], importToken?: string) => {
    if (!projectId || !selected || !window.metis) return false;
    if (externalEditorSession?.outcomeId === selected.outcome.id) {
      setOperationNotice('当前成果正在 Metis Office 中编辑。请先同步回 METIS 或放弃外部编辑会话，再保存本地草稿。');
      return false;
    }
    setOperationNotice('');
    // Promise.resolve 包一层：IPC 缺失或测试桩返回非 Promise 时不至于抛 TypeError。
    const saved = await Promise.resolve(window.metis.saveOutcome({ projectId, outcomeId: selected.outcome.id, baseVersion: selected.outcome.currentVersion, content, note, actor, sources, ...(importToken ? { importToken } : {}) })).catch((error) => {
      console.error('[OutcomesPage] saveOutcome failed:', error);
      return null;
    });
    const parsed = OutcomeDetailSchema.safeParse(saved);
    if (!parsed.success) { setOperationNotice('保存未完成（可能是版本已更新或运行服务不可用）。当前未保存编辑仍保留在页面，请检查后重试。'); return false; }
     setSelected(parsed.data); setEditorDocument(parsed.data.version.content);
      // Outcomes 2.0（T02.04）：保存版本后清工作草稿并以新版本为 base。
      void window.metis?.outcome2DraftClear?.({ projectId, outcomeId: parsed.data.outcome.id });
      setDraftInfo(null);
      setDraftSavedAt(null);
      draftHistoricalRef.current = false;
      const selection = assistantSelectionRef.current;
     const selectionStillExists = selection?.kind === 'word'
       ? parsed.data.version.content.type === 'word' && wordSelectionStillExists(selection, parsed.data.version.content)
       : selection?.kind === 'ppt'
         ? parsed.data.version.content.type === 'ppt' && parsed.data.version.content.pages.some((page) => page.id === selection.pageId && (!selection.elementId || page.elements.some((element) => element.id === selection.elementId)))
         : false;
      updateAssistantSelection(selectionStillExists ? selection : undefined);
     try {
       setVersions(await window.metis.listOutcomeVersions({ projectId, outcomeId: parsed.data.outcome.id }) as OutcomeVersion[]);
     } catch (error) {
       console.error('[OutcomesPage] list versions failed:', error);
       setVersions([]);
     }
    await refresh(); return true;
     }, [externalEditorSession, projectId, refresh, selected, updateAssistantSelection]);
  const save = useCallback(async (content: OutcomeDocument, note = '保存编辑', actor: 'human' | 'ai' | 'import' | 'restore' = 'human', sources: OutcomeSource[] = [], importToken?: string) => {
    if (!projectId || !selected || !window.metis) return false;
    if (saveBusy) { setOperationNotice('上一次保存仍在进行中，请稍候。'); return false; } // 任务4：防双击/防并发保存。
    setSaveBusy(true);
    try {
      return await performSave(content, note, actor, sources, importToken);
    } finally {
      setSaveBusy(false);
    }
  }, [saveBusy, performSave, projectId, selected]);
  const create = useCallback(async (kind: OutcomeKind, title: string, categoryId: string | null) => {
    if (!projectId || !window.metis || !title.trim()) return;
    if (createBusy) return; // 任务4：防双击——同一时刻只允许一个创建请求。
    setCreateBusy(true);
    try {
      const created = await window.metis.createOutcome({ projectId, kind, title: title.trim(), categoryId, content: makeDocument(kind), note: '创建成果' });
      if (!created) {
        setOperationNotice('成果创建未完成，未被创建；请重试。');
        return;
      }
      setCreateOpen(false); await refresh(); await open((created as OutcomeDetail).outcome.id);
    } catch (error) {
      console.error('[OutcomesPage] create outcome failed:', error);
      setOperationNotice('成果创建未完成，未被创建；请重试。');
    } finally {
      setCreateBusy(false);
    }
  }, [createBusy, open, projectId, refresh]);
  const submitCategoryPrompt = useCallback(async (rawName: string) => {
    const pending = categoryPrompt;
    const name = rawName.trim();
    setCategoryPrompt(null);
    if (!pending || !name || !window.metis) return;
    try {
      if (pending.mode === 'rename') await window.metis.renameOutcomeCategory({ categoryId: pending.categoryId, name });
      else await window.metis.createOutcomeCategory({ name });
    } catch (error) {
      console.error('[OutcomesPage] category write failed:', error);
      setOperationNotice(pending.mode === 'rename' ? '分类重命名未完成，分类未改动；请重试。' : '分类创建未完成；请重试。');
      return;
    }
    await refresh();
  }, [categoryPrompt, refresh]);
  // 刘总规格：用户可删除自建分类；删除后该分类下的成果由数据库外键 ON DELETE SET NULL 自动回落「未分类」，成果本身不删除。
  const deleteCategory = useCallback(async (category: OutcomeCategory) => {
    if (!window.metis) return;
    if (!window.confirm(`删除分类「${category.name}」？该分类下的成果会移回「未分类」，成果本身不会被删除。`)) return;
    try {
      if (!await window.metis.deleteOutcomeCategory({ categoryId: category.id })) { setOperationNotice('分类删除未完成，分类仍保留；请重试。'); return; }
    } catch (error) {
      console.error('[OutcomesPage] category delete failed:', error);
      setOperationNotice('分类删除未完成，分类仍保留；请重试。');
      return;
    }
    await refresh();
  }, [refresh]);
  useEffect(() => {
    if (!operationNotice) return undefined;
    const timer = window.setTimeout(() => setOperationNotice(''), 8000);
    return () => { window.clearTimeout(timer); };
  }, [operationNotice]);
  const restoreVersion = useCallback(async (version: OutcomeVersion) => {
    if (!projectId || !selected || !window.metis) return;
    setOperationNotice('');
    const restored = await window.metis.restoreOutcome({ projectId, outcomeId: selected.outcome.id, version: version.version, note: `恢复到 v${version.version}` });
    const parsed = OutcomeDetailSchema.safeParse(restored);
    if (!parsed.success) { setOperationNotice('恢复未完成，当前编辑仍保留在页面；没有创建新的恢复版本。请刷新版本列表后重试。'); return; }
    setSelected(parsed.data); setEditorDocument(parsed.data.version.content); updateAssistantSelection(undefined);
    setVersions(await window.metis.listOutcomeVersions({ projectId, outcomeId: parsed.data.outcome.id }) as OutcomeVersion[]);
    await refresh();
  }, [projectId, refresh, selected, updateAssistantSelection]);
  const moveOutcome = useCallback(async (outcomeId: string, categoryId: string | null) => {
    if (!projectId || !window.metis) return;
    try {
      if (await window.metis.moveOutcome({ projectId, outcomeId, categoryId })) await refresh();
      else setOperationNotice('成果移动未完成，仍留在原分类；请重试。');
    } catch (error) {
      console.error('[OutcomesPage] move outcome failed:', error);
      setOperationNotice('成果移动未完成，仍留在原分类；请重试。');
    }
  }, [projectId, refresh]);
  const duplicateCurrent = useCallback(async () => {
    if (!selected || !projectId || !window.metis) return;
    if (duplicateBusy) return; // 任务4：防双击。
    setDuplicateBusy(true);
    try {
      const title = `${selected.outcome.title} 副本`;
      const created = await window.metis.createOutcome({ projectId, kind: selected.outcome.kind, title, categoryId: selected.outcome.categoryId, content: editorDocument ?? selected.version.content, note: `从 ${selected.outcome.title} 复制`, applyDefaultTemplate: false });
      if (!created) { setOperationNotice('复制未完成，副本未被创建；请重试。'); return; }
      await refresh(); await open((created as OutcomeDetail).outcome.id);
    } catch (error) {
      console.error('[OutcomesPage] duplicate outcome failed:', error);
      setOperationNotice('复制未完成，副本未被创建；请重试。');
    } finally {
      setDuplicateBusy(false);
    }
  }, [editorDocument, open, projectId, refresh, selected, duplicateBusy]);
  const applyAssistantVersion = useCallback(async (applied: AssistantApplied | undefined) => {
    const raw = asRecord(applied); if (!raw) return;
    const parsed = OutcomeDetailSchema.safeParse({ outcome: raw.outcome, version: raw.version });
    if (!parsed.success) return;
    setSelected(parsed.data); setEditorDocument(parsed.data.version.content); updateAssistantSelection(undefined);
    if (window.metis) setVersions(await window.metis.listOutcomeVersions({ projectId: parsed.data.outcome.projectId, outcomeId: parsed.data.outcome.id }) as OutcomeVersion[]);
    await refresh();
  }, [refresh, updateAssistantSelection]);
  const selectedForProject = selected?.outcome.projectId === projectId ? selected : null;
  const hasUnsavedChanges = Boolean(selectedForProject && editorDocument && JSON.stringify(editorDocument) !== JSON.stringify(selectedForProject.version.content));
  const openOutcomeSource = useCallback((source: OutcomeSource) => {
    if (source.kind !== 'outcome_version' || source.version === undefined) return;
    if (hasUnsavedChanges) {
      setOperationNotice('当前成果有未保存的编辑。请先保存版本，再打开来源成果，避免丢失本地草稿。');
      return;
    }
    void open(source.id, source.version);
  }, [hasUnsavedChanges, open]);
  const locateSource = useCallback((source: OutcomeSource) => {
    if (!projectId || !window.metis?.locateOutcomeSource) {
      setOperationNotice('当前界面无法定位该来源（定位服务不可用）。');
      return;
    }
    setOperationNotice('');
    void window.metis.locateOutcomeSource({ projectId, outcomeId: selected?.outcome.id ?? '', source }).then((located) => {
      if (located && located.ok) {
        if (located.kind === 'artifact') {
          navigate({ kind: 'project', projectId, section: 'artifacts' }); // 任务4：typed navigation contract
          setOperationNotice(`已定位研究资料：${located.targetId}（已在项目资料区打开）。`);
        } else {
          setOperationNotice(`已定位：${located.label}`);
        }
      } else {
        const code = located && !located.ok ? located.code : 'source_not_found';
        setOperationNotice(code === 'source_not_locatable'
          ? '该来源当前无法在界面中定位；本次修改仅记录了它的来源标识。'
          : '未找到该来源对应的可打开内容。');
      }
    });
  }, [projectId, selected]);
  const importWordDocx = useCallback(async () => {
    if (!projectId || !window.metis?.importOutcomeWordDocx || !window.metis.commitOutcomeWordDocxImportMedia || isWordDocxImporting || wordDocxImportInFlight.current) return;
    const currentWord = selected?.outcome.projectId === projectId && selected.outcome.kind === 'word' ? selected : null;
    if (hasUnsavedChanges || (currentWord && editorDocument && JSON.stringify(editorDocument) !== JSON.stringify(currentWord.version.content))) { setOperationNotice('当前 Word 有未保存的编辑。请先保存版本，再导入 DOCX，避免覆盖本地草稿。'); return; }
    wordDocxImportInFlight.current = true; setIsWordDocxImporting(true);
    try {
      const imported = await window.metis.importOutcomeWordDocx({ projectId });
      if (!imported.ok) { if (imported.code !== 'cancelled') setOperationNotice(imported.message); return; }
      const warnings = docxWarningNotice(imported.warnings);
      const committedMedia = await window.metis.commitOutcomeWordDocxImportMedia({ projectId, importToken: imported.importToken, ...(currentWord ? { outcomeId: currentWord.outcome.id } : {}), document: imported.document });
      if (!committedMedia || !committedMedia.ok) { setOperationNotice(committedMedia && !committedMedia.ok ? committedMedia.message : 'DOCX 图片没有写入成果媒体区；当前成果没有被修改。'); return; }
      if (currentWord) {
        const committed = await save(committedMedia.document, `导入 ${imported.fileName}`, 'import', [], imported.importToken);
        if (committed) setOperationNotice(`已导入 ${imported.fileName} 并保存为新版本。${warnings}`);
        return;
      }
      const title = imported.fileName.replace(/\.docx$/iu, '').trim() || '导入 Word 文档';
      const created = await window.metis.createOutcome({ projectId, outcomeId: committedMedia.outcomeId, categoryId: null, title, kind: 'word', content: committedMedia.document, note: `导入 ${imported.fileName}`, actor: 'import', importToken: imported.importToken });
      const parsed = OutcomeDetailSchema.safeParse(created);
      if (!parsed.success) { setOperationNotice('DOCX 已读取并完成媒体提交，但未能创建成果版本；当前成果内容没有被修改。'); return; }
      await refresh(); await open(parsed.data.outcome.id); setOperationNotice(`已导入 ${imported.fileName} 并创建成果 v1。${warnings}`);
    } catch { setOperationNotice('DOCX 导入请求没有完成；当前成果没有被修改。'); }
    finally { wordDocxImportInFlight.current = false; setIsWordDocxImporting(false); }
  }, [editorDocument, hasUnsavedChanges, isWordDocxImporting, open, projectId, refresh, save, selected]);
  const exportWordDocx = useCallback(async () => {
    if (!projectId || !selected || selected.outcome.kind !== 'word' || !window.metis?.exportOutcomeWordDocx) return;
    if (editorDocument && JSON.stringify(editorDocument) !== JSON.stringify(selected.version.content)) { setOperationNotice('当前 Word 有未保存的编辑。请先保存版本，再导出 DOCX。'); return; }
    const exported = await window.metis.exportOutcomeWordDocx({ projectId, outcomeId: selected.outcome.id, version: selected.version.version });
    if (!exported.ok) { if (exported.code !== 'cancelled') setOperationNotice(exported.message); return; }
    const warnings = docxWarningNotice(exported.warnings);
    setOperationNotice(`已导出 ${exported.fileName}。${warnings}`);
  }, [editorDocument, projectId, selected]);
  const importPptx = useCallback(async () => {
    if (!projectId || !window.metis?.importOutcomePptx || isPptxImporting || pptxImportInFlight.current) return;
    if (hasUnsavedChanges) { setOperationNotice('当前成果有未保存的编辑。请先保存版本，再导入 PPTX，避免覆盖本地草稿。'); return; }
    const currentPpt = selected?.outcome.projectId === projectId && selected.outcome.kind === 'ppt' ? selected : null;
    pptxImportInFlight.current = true; setIsPptxImporting(true);
    try {
      const imported = await window.metis.importOutcomePptx({ projectId });
      if (!imported.ok) { setOperationNotice(imported.message); return; }
      const warnings = pptxWarningNotice(imported.warnings);
      if (!window.metis.commitOutcomePptxImportMedia) {
        setOperationNotice('当前版本缺少 PPTX 图片保存桥接；预览已完成，但没有写入成果或媒体。');
        return;
      }
      const committedMedia = await window.metis.commitOutcomePptxImportMedia({ projectId, importToken: imported.importToken, ...(currentPpt ? { outcomeId: currentPpt.outcome.id } : {}), document: imported.document });
      if (!committedMedia || !committedMedia.ok) {
        setOperationNotice(committedMedia && !committedMedia.ok ? committedMedia.message : 'PPTX 图片没有写入成果媒体区；当前成果没有被修改。');
        return;
      }
      if (currentPpt) {
        const committed = await save(committedMedia.document, `导入 ${imported.fileName}`, 'import', [], imported.importToken);
        if (committed) setOperationNotice(`已导入 ${imported.fileName} 并保存为新版本。${warnings}`);
        return;
      }
      const title = imported.fileName.replace(/\.pptx$/iu, '').trim() || '导入 PPT 演示文稿';
      const created = await window.metis.createOutcome({ projectId, outcomeId: committedMedia.outcomeId, categoryId: null, title, kind: 'ppt', content: committedMedia.document, note: `导入 ${imported.fileName}`, actor: 'import', importToken: imported.importToken });
      const parsed = OutcomeDetailSchema.safeParse(created);
      if (!parsed.success) { setOperationNotice('PPTX 已读取，但未能创建成果版本；请重试，当前项目内容没有被修改。'); return; }
      await refresh(); await open(parsed.data.outcome.id); setOperationNotice(`已导入 ${imported.fileName} 并创建成果 v1。${warnings}`);
    } catch {
      setOperationNotice('PPTX 导入请求没有完成，当前成果没有被修改。');
    } finally { pptxImportInFlight.current = false; setIsPptxImporting(false); }
  }, [hasUnsavedChanges, isPptxImporting, open, projectId, refresh, save, selected]);
  const exportPptx = useCallback(async () => {
    if (!projectId || !selected || selected.outcome.kind !== 'ppt' || !window.metis?.exportOutcomePptx || isPptxExporting || pptxExportInFlight.current) return;
    if (hasUnsavedChanges) { setOperationNotice('当前 PPT 有未保存的编辑。请先保存版本，再导出 PPTX。'); return; }
    pptxExportInFlight.current = true; setIsPptxExporting(true);
    try {
      const exported = await window.metis.exportOutcomePptx({ projectId, outcomeId: selected.outcome.id, version: selected.version.version });
      if (!exported.ok) { setOperationNotice(exported.message); return; }
      setOperationNotice(`已导出 ${exported.fileName}。${pptxWarningNotice(exported.warnings)}`);
    } catch {
      setOperationNotice('PPTX 导出请求没有完成，当前成果没有被修改。');
    } finally { pptxExportInFlight.current = false; setIsPptxExporting(false); }
  }, [hasUnsavedChanges, isPptxExporting, projectId, selected]);
  const openInGenoffice = useCallback(async (options?: { embedded?: boolean }) => {
    const embedded = options?.embedded === true;
    if (!projectId || !selectedForProject || !window.metis?.openOutcomeInGenoffice) return;
    // Outcomes 2.0（T14.02）：打开 Office 前必须先处理工作草稿，不静默丢弃。
    const workbenchDraft = draftInfo
      ? await window.metis.outcome2DraftGet?.({ projectId, outcomeId: selectedForProject.outcome.id }) as { baseVersion?: number; content?: OutcomeDocument } | null
      : null;
    if (workbenchDraft?.content) {
      const choice = window.confirm(
        `当前成果有未保存的工作草稿（基于 v${workbenchDraft.baseVersion ?? selectedForProject.version.version}）。` +
        '\n\n确定=保存草稿为新版本并打开 Office；取消=留在 METIS（草稿保留）。' +
        '\n（如需以当前正式版本打开并保留草稿，请先在历史中处理草稿）',
      );
      if (!choice) { setOperationNotice('已取消打开 Metis Office；工作草稿原样保留。'); return; }
      const saved = await save(workbenchDraft.content, '打开 Metis Office 前保存工作草稿', 'human');
      if (!saved) { setOperationNotice('草稿保存为新版本未完成，Office 未打开。'); return; }
    }
    if (hasUnsavedChanges) { setOperationNotice('当前成果有未保存的编辑。请先保存版本，再交给 Metis Office 编辑，避免覆盖本地草稿。'); return; }
    setExternalEditorBusy(true);
    try {
      const result = await window.metis.openOutcomeInGenoffice({ projectId, outcomeId: selectedForProject.outcome.id, version: selectedForProject.version.version, ...(embedded ? { embedded: true } : {}) });
      if (!result.ok) { setOperationNotice(result.message); return; }
      setExternalEditorSession({ ...result.session, outcomeId: selectedForProject.outcome.id });
      if (embedded && typeof result.webContentsId === 'number') {
        setEmbeddedViewId(result.webContentsId);
        setOperationNotice(`已在页面内打开「${result.session.fileName}」原生编辑器；保存并关闭后改动会自动同步回 METIS，也可随时手动同步。`);
      } else {
        setEmbeddedViewId(null);
        setOperationNotice(`已在 Metis Office 中打开「${result.session.fileName}」。保存并关闭 Metis Office 后改动会自动同步回 METIS，也可随时手动同步。`);
      }
    } catch { setOperationNotice('Metis Office 编辑器没有成功打开当前成果，当前版本没有被修改。'); }
    finally { setExternalEditorBusy(false); }
  }, [hasUnsavedChanges, projectId, selectedForProject]);
  const syncFromGenoffice = useCallback(async () => {
    if (!projectId || !externalEditorSession || !window.metis?.syncOutcomeFromGenoffice || externalEditorBusy) return;
    setExternalEditorBusy(true);
    try {
      const result = await window.metis.syncOutcomeFromGenoffice({ projectId, outcomeId: externalEditorSession.outcomeId, token: externalEditorSession.token });
      if (!result.ok) { setOperationNotice(result.message); return; }
      setSelected(result.detail);
      setEditorDocument(result.detail.version.content);
      setVersions(await window.metis.listOutcomeVersions({ projectId, outcomeId: result.detail.outcome.id }) as OutcomeVersion[]);
      // Outcomes 2.0（T14.03/T14.04）：sync 产生新版本后——
      // 1) 工作草稿与 baseVersion 对账（落后即标记冲突，不自动覆盖）；
      // 2) pending revision 逐条 target hash 检查，失配标 stale；
      // 3) 审查 issue 基线失配标 stale。
      let staleNote = '';
      try {
        const draft = await window.metis.outcome2DraftGet?.({ projectId, outcomeId: result.detail.outcome.id }) as { baseVersion?: number } | null;
        if (draft && (draft.baseVersion ?? 0) < result.detail.outcome.currentVersion) {
          setDraftInfo({ baseVersion: draft.baseVersion ?? 0, conflict: true });
          staleNote += ' 你的未保存草稿基于旧版本，已进入冲突处理。';
        } else {
          setDraftInfo(null);
        }
      } catch { /* 对账失败不阻塞同步 */ }
      try {
        const marked = await window.metis.outcome2RevisionMarkStaleByHash?.({ projectId, outcomeId: result.detail.outcome.id });
        if (marked && marked.marked > 0) staleNote += ` ${marked.marked} 条修改建议因内容已变化被标记为过期。`;
        const staleIssues = await window.metis.outcome2ReviewMarkStaleByDraftHash?.({ projectId, outcomeId: result.detail.outcome.id, currentDraftHash: null });
        if (staleIssues && staleIssues.marked > 0) staleNote += ` ${staleIssues.marked} 条审查问题已过期。`;
      } catch { /* 对账失败不阻塞同步 */ }
      if (!result.warning) { setExternalEditorSession(null); setEmbeddedViewId(null); }
      await refresh();
       setOperationNotice(`已将 Metis Office 保存的「${externalEditorSession.fileName}」同步为 METIS v${result.detail.version.version}。${result.warning ? ` ${result.warning}` : ''}${staleNote}`);
    } catch { setOperationNotice('Metis Office 文件同步没有完成，当前成果版本没有被修改。'); }
    finally { setExternalEditorBusy(false); }
  }, [externalEditorBusy, externalEditorSession, projectId, refresh]);
  const closeGenofficeEditor = useCallback(async () => {
    if (!projectId || !externalEditorSession || !window.metis?.closeOutcomeGenofficeEditor || externalEditorBusy) return;
    setExternalEditorBusy(true);
    try {
      const closed = await window.metis.closeOutcomeGenofficeEditor({ projectId, outcomeId: externalEditorSession.outcomeId, token: externalEditorSession.token });
      if (closed) { setExternalEditorSession(null); setEmbeddedViewId(null); setOperationNotice('已关闭 Metis Office 会话；未同步的外部文件没有写入 METIS。'); }
      else setOperationNotice('Metis Office 会话未能关闭；未同步内容仍未写入 METIS。');
    } catch { setOperationNotice('Metis Office 会话关闭失败；当前成果版本没有被修改。'); }
    finally { setExternalEditorBusy(false); }
  }, [externalEditorBusy, externalEditorSession, projectId]);
  const selectedOutcomeId = selectedForProject?.outcome.id;
  const nativeEmbeddedActive = Boolean(
    embeddedViewId !== null
    && externalEditorSession?.outcomeId === selectedOutcomeId
    && selectedForProject
    && ['word', 'ppt', 'spreadsheet', 'pdf'].includes(selectedForProject.outcome.kind),
  );
  // 内嵌 WebContentsView 方案已停用（黑屏未解）；Metis Office 以独立窗口为唯一入口。
  // 几何上报：嵌入视图悬浮于 DOM 之上，矩形必须逐帧跟随占位节点。
  useEffect(() => {
    if (embeddedViewId === null) return undefined;
    let observer: ResizeObserver | undefined;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const report = () => {
      const node = embeddedStageRef.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) return;
      void window.metis?.genofficeEmbeddedSetBounds?.({
        webContentsId: embeddedViewId,
        rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      });
    };
    const attach = () => {
      if (!embeddedStageRef.current) return false;
      report();
      observer = new ResizeObserver(report);
      observer.observe(embeddedStageRef.current);
      window.addEventListener('scroll', report, true);
      window.addEventListener('resize', report);
      settle = setTimeout(report, 250);
      return true;
    };
    // stage 节点与 viewId 分属两次渲染，首次拿不到就轮询补挂。
    if (!attach()) {
      const retry = setInterval(() => { if (attach()) clearInterval(retry); }, 100);
      return () => { clearInterval(retry); observer?.disconnect(); };
    }
    return () => {
      observer?.disconnect();
      window.removeEventListener('scroll', report, true);
      window.removeEventListener('resize', report);
      if (settle) clearTimeout(settle);
    };
  }, [embeddedViewId, nativeEmbeddedActive]);
  // METIS 弹层（排版面板/各对话框）出现时收起视图，避免原生画布盖住 DOM 弹层。
  useEffect(() => {
    if (embeddedViewId === null) return undefined;
    const check = () => {
      const blocked = Boolean(document.querySelector('.outcomes-modal-backdrop, .outcome-word-format-backdrop'));
      void window.metis?.genofficeEmbeddedSetVisible?.({ webContentsId: embeddedViewId, visible: !blocked });
    };
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      void window.metis?.genofficeEmbeddedSetVisible?.({ webContentsId: embeddedViewId, visible: false });
    };
  }, [embeddedViewId]);
  useEffect(() => {
    if (!projectId || !selectedOutcomeId || externalEditorSession || !window.metis?.stateOutcomeGenofficeEditor) return undefined;
    let active = true;
    void window.metis.stateOutcomeGenofficeEditor({ projectId, outcomeId: selectedOutcomeId }).then((state) => {
      if (active && state.session) setExternalEditorSession({ ...state.session, outcomeId: selectedOutcomeId });
    });
    return () => { active = false; };
  }, [externalEditorSession, projectId, selectedOutcomeId]);
  const visible = useMemo(() => items.filter((item) => item.title.toLowerCase().includes(query.toLowerCase())), [items, query]);

  const outcomesPageRef = useRef<HTMLDivElement>(null);
  const [treeWidth, setTreeWidth] = useState(() => loadOutcomesWidth(OUTCOMES_TREE_WIDTH_KEY, 250, 190, 420));
  const [assistantWidth, setAssistantWidth] = useState(() => loadOutcomesWidth(OUTCOMES_ASSISTANT_WIDTH_KEY, 320, 260, 520));
  useEffect(() => { saveOutcomesWidth(OUTCOMES_TREE_WIDTH_KEY, treeWidth); }, [treeWidth]);
  useEffect(() => { saveOutcomesWidth(OUTCOMES_ASSISTANT_WIDTH_KEY, assistantWidth); }, [assistantWidth]);
  const handleTreeDrag = useCallback((clientX: number) => {
    const rect = outcomesPageRef.current?.getBoundingClientRect();
    if (!rect) return;
    setTreeWidth(Math.min(420, Math.max(190, clientX - rect.left)));
  }, []);
  const handleAssistantDrag = useCallback((clientX: number) => {
    const rect = outcomesPageRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAssistantWidth(Math.min(520, Math.max(260, rect.right - clientX)));
  }, []);

  if (!projectId) return <div className="outcomes-empty"><FileText size={30} /><h2>成果属于科研项目</h2><p>请先选择一个科研项目，再管理论文、PPT、报告和正式交付物。</p></div>;
  return <div className="outcomes-page" ref={outcomesPageRef} style={{ '--outcomes-cols': `${treeWidth}px auto minmax(0, 1fr) auto ${assistantWidth}px` } as React.CSSProperties}>
    <aside className="outcomes-tree" aria-label="成果树">
      <header><div><small>当前项目</small><strong>{project?.title ?? projectId}</strong></div><div className="outcomes-tree__actions"><button type="button" onClick={() => void importWordDocx()} title="导入 Word DOCX" aria-label="导入 Word DOCX" disabled={isWordDocxImporting}>{isWordDocxImporting ? <LoaderCircle size={16} className="spin" /> : <Upload size={16} />}</button><button type="button" onClick={() => void importPptx()} title="导入 PPTX" aria-label="导入 PPTX" disabled={isPptxImporting}>{isPptxImporting ? <LoaderCircle size={16} className="spin" /> : <Presentation size={16} />}</button><button type="button" onClick={() => setCreateOpen(true)} title="新建成果" aria-label="新建成果"><Plus size={17} /></button></div></header>
      <input className="outcomes-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索成果" aria-label="搜索成果" />
      {listStale && !listRetrying && <StaleDataNotice onRetry={() => void loadOutcomes('refresh')} retrying={listRetrying} />}
      <div className="outcomes-tree-scroll">
        {listState === 'error' ? (
          <InlineError
            compact
            title="成果列表加载失败。"
            hint="成果数据没有丢失，只是暂时读不到。"
            onRetry={() => void loadOutcomes('initial')}
            retrying={listRetrying}
          />
        ) : listState === 'loading' ? (
          <QuietLoading compact label="正在加载成果…" />
        ) : (
          <>
            {categories.map((category) => <OutcomeCategorySection key={category.id} category={category} outcomes={visible.filter((item) => item.categoryId === category.id)} activeId={selectedForProject?.outcome.id} onOpen={open} onMove={moveOutcome} onTrash={(item) => void archiveOutcome(item)} onRename={() => setCategoryPrompt({ mode: 'rename', categoryId: category.id, initialName: category.name })} onDelete={() => void deleteCategory(category)} />)}
            <OutcomeCategorySection category={null} outcomes={visible.filter((item) => !item.categoryId)} activeId={selectedForProject?.outcome.id} onOpen={open} onMove={moveOutcome} onTrash={(item) => void archiveOutcome(item)} />
            {items.length === 0 && (
              <EmptyState
                compact
                title="还没有成果"
                description="成果是当前项目的正式交付物（论文、PPT、报告）。用上方「新建成果」或导入 Word/PPTX 开始。"
              />
            )}
          </>
        )}
      </div>
      <div className="outcomes-tree-footer">
        <button className="outcomes-new-category" type="button" onClick={() => setCategoryPrompt({ mode: 'create' })}><Plus size={14} />新建分类</button>
        <button className="outcomes-trash-entry" type="button" onClick={() => void openTrash()} title="回收站：删除的成果保留 7 天" aria-label="打开成果回收站"><Trash2 size={14} />回收站</button>
      </div>
    </aside>
    <SplitHandle
      label="拖动调整成果树宽度"
      testId="outcomes-split-tree"
      onDrag={handleTreeDrag}
      onKeyDelta={(delta) => setTreeWidth((current) => Math.min(420, Math.max(190, current + delta)))}
    />
    <main className="outcomes-editor">
      {operationNotice && <p className="outcomes-operation-notice" role="status">{operationNotice}</p>}
      {!selectedForProject || !editorDocument ? <div className="outcomes-empty outcomes-empty--editor"><FileText size={34} /><h2>打开或创建成果</h2><p>成果是当前项目的正式交付物，不自动存放运行日志、缓存或工具中间结果。</p><button className="primary" type="button" onClick={() => setCreateOpen(true)}>新建成果</button></div> : <>
         <header className="outcomes-editor-head"><div>{kindIcon(selectedForProject.outcome.kind)}<div><input defaultValue={selectedForProject.outcome.title} key={selectedForProject.outcome.id} aria-label="成果名称" onBlur={async (event) => { const title = event.currentTarget.value.trim(); if (title && title !== selectedForProject.outcome.title && window.metis) { try { await window.metis.renameOutcome({ projectId, outcomeId: selectedForProject.outcome.id, title }); } catch (error) { console.error('[OutcomesPage] rename failed:', error); setOperationNotice('重命名未完成，标题未改动；请重试。'); return; } await refresh(); } }} /><small>v{selectedForProject.version.version}{draftInfo && draftInfo.baseVersion === selectedForProject.version.version ? ' · 有未保存草稿' : ''}{draftInfo && draftInfo.baseVersion < selectedForProject.version.version ? ` · 草稿基于 v${draftInfo.baseVersion}（版本冲突）` : ''}{!draftInfo && selectedForProject.outcome.status !== 'final' ? ' · 草稿' : ''}{selectedForProject.outcome.status === 'final' ? ' · 最终版' : ''}</small>
           {draftSavedAt && <small className="outcomes-draft-saved" data-testid="draft-saved-at">已自动保存草稿 {draftSavedAt}</small>}</div></div><div className="outcomes-editor-head__actions"><button className="primary" type="button" disabled={saveBusy} onClick={() => void save(editorDocument.type === 'ppt' ? withoutPristineFallbackPages(editorDocument) : editorDocument)}>{saveBusy ? <LoaderCircle size={15} className="spin" aria-hidden="true" /> : <Save size={15} />}保存版本</button>{selectedForProject.outcome.kind === 'word' && <button type="button" onClick={() => setFormattingOpenRequest((value) => value + 1)}><SlidersHorizontal size={14} />排版</button>}{selectedForProject.outcome.kind === 'word' && <button type="button" onClick={() => void exportWordDocx()}><FileText size={14} />导出 DOCX</button>}{selectedForProject.outcome.kind === 'ppt' && <button type="button" onClick={() => void exportPptx()} disabled={isPptxExporting}>{isPptxExporting ? <LoaderCircle size={14} className="spin" /> : <Presentation size={14} />}导出 PPTX</button>}<button type="button" onClick={() => setSubmissionOpen(true)} title="以当前版本创建投稿事务"><Send size={14} />投稿</button><button type="button" disabled={duplicateBusy} onClick={() => void duplicateCurrent()}><Copy size={14} />复制</button><button type="button" data-testid="outcome-create-snapshot" onClick={async () => { if (!projectId || !selectedForProject || !window.metis?.outcome2SnapshotCreate) return; try { const result = await window.metis.outcome2SnapshotCreate({ projectId, outcomeId: selectedForProject.outcome.id, reason: 'manual', content: editorDocument ?? undefined, baseVersion: selectedForProject.outcome.currentVersion }); setOperationNotice(result?.ok ? '已创建快照（历史 → 快照）。快照不是版本，正式版本未变化。' : '快照创建未完成。'); } catch { setOperationNotice('快照创建未完成。'); } }}><Copy size={14} />创建快照</button><button type="button" disabled={markFinalBusy} onClick={async () => { if (!window.metis || markFinalBusy) return; setMarkFinalBusy(true); try { await window.metis.markOutcomeFinal({ projectId, outcomeId: selectedForProject.outcome.id, version: selectedForProject.outcome.currentVersion }); await refresh(); await open(selectedForProject.outcome.id); } catch (error) { console.error('[OutcomesPage] markOutcomeFinal failed:', error); setOperationNotice('标记最终版未完成，状态未改动；请重试。'); } finally { setMarkFinalBusy(false); } }}><Check size={14} />标记最终版</button></div></header>
         {['word', 'ppt', 'spreadsheet', 'pdf'].includes(selectedForProject.outcome.kind) && <section className="outcomes-external-editor-actions" aria-label="Metis Office"><div><strong>Metis Office 原生编辑</strong></div>{externalEditorSession?.outcomeId === selectedForProject.outcome.id ? <div><button type="button" onClick={() => void syncFromGenoffice()} disabled={externalEditorBusy}>同步回 METIS</button><button type="button" onClick={() => void closeGenofficeEditor()} disabled={externalEditorBusy}>放弃会话</button><span>当前文件：{externalEditorSession.fileName}</span></div> : <><button type="button" onClick={() => void openInGenoffice()} disabled={externalEditorBusy} title="在独立窗口中用原生 Ribbon 编辑当前文件"><FileSpreadsheet size={14} />Metis Office</button></>}</section>}
           {nativeEmbeddedActive && <div ref={embeddedStageRef} className="genoffice-embedded-stage" aria-label="Metis Office 原生编辑区"><span>Metis Office 原生编辑器正在此区域运行；在该画布中直接编辑，保存后回到右侧“同步回 METIS”。</span></div>}
           {!nativeEmbeddedActive && editorDocument.type === 'word' && <WordEditor key={`${selectedForProject.outcome.id}-word-${selectedForProject.version.version}`} projectId={projectId} outcomeId={selectedForProject.outcome.id} hasUnsavedChanges={hasUnsavedChanges} document={editorDocument} onChange={handleEditorChange} onSave={(next, note) => save(next, note)} onNotice={setOperationNotice} onSelectionChange={updateAssistantSelection} onAssistantApplied={applyAssistantVersion} onConversationChanged={() => setAssistantHistoryRevision((revision) => revision + 1)} />}
           {editorDocument.type === 'word' && <OutcomeWordFormattingPanel document={editorDocument} openRequest={formattingOpenRequest} hideTrigger onApply={(next, note) => { setEditorDocument(next); setOperationNotice(note); }} />}
          {!nativeEmbeddedActive && editorDocument.type === 'ppt' && <PptStudioEditor key={`${selectedForProject.outcome.id}-ppt-${selectedForProject.version.version}`} projectId={projectId} outcomeId={selectedForProject.outcome.id} baseVersion={selectedForProject.version.version} hasUnsavedChanges={hasUnsavedChanges} document={editorDocument} initialPageId={assistantSelection?.kind === 'ppt' ? assistantSelection.pageId : undefined} initialSelectedElementId={assistantSelection?.kind === 'ppt' ? assistantSelection.elementId : undefined} onChange={handleEditorChange} onSave={(next) => void save(next, '保存 PPT Grid 布局')} onNotice={setOperationNotice} onGenerationApplied={async (applied) => { await applyAssistantVersion(applied as unknown as AssistantApplied); setOperationNotice('PPT Generation Skill 已生成并保存为新版本；可在版本面板查看或恢复。'); }} onGenerationConflict={async () => { await open(selectedForProject.outcome.id); setOperationNotice('PPT 生成因版本已更新而未提交；已刷新到当前版本。'); }} onSelectionChange={updateAssistantSelection} />}
         {(!nativeEmbeddedActive) && (editorDocument.type === 'other' || editorDocument.type === 'spreadsheet' || editorDocument.type === 'pdf') && <MediaEditor projectId={projectId} outcomeId={selectedForProject.outcome.id} kind={selectedForProject.outcome.kind} hasUnsavedChanges={hasUnsavedChanges} document={editorDocument} onChange={handleEditorChange} onSave={(next, note, actor = 'human') => void save(next, note, actor)} />}
        <OutcomeWorkbenchPanel projectId={projectId} outcomeId={selectedForProject.outcome.id} onNotice={setOperationNotice} onDraftUpdated={() => { const draft = window.metis?.outcome2DraftGet?.({ projectId, outcomeId: selectedForProject.outcome.id }) as Promise<{ content?: OutcomeDocument } | null> | undefined; void draft?.then((value) => { if (value?.content) setEditorDocument(value.content); }); }} />
        <VersionPanel versions={versions} activeVersion={selectedForProject.version.version} onOpen={(version) => void open(selectedForProject.outcome.id, version.version)} onRestore={(version) => void restoreVersion(version)} />
      </>}
    </main>
    <SplitHandle
      label="拖动调整助手面板宽度"
      testId="outcomes-split-assistant"
      onDrag={handleAssistantDrag}
      onKeyDelta={(delta) => setAssistantWidth((current) => Math.min(520, Math.max(260, current - delta)))}
    />
    <OutcomeAssistant key={`${projectId}-${selectedForProject?.outcome.id ?? 'none'}`} projectId={projectId} projectName={project?.title ?? projectId} detail={selectedForProject} selection={assistantSelection} hasUnsavedChanges={hasUnsavedChanges} historyRevision={assistantHistoryRevision} onOpenOutcomeVersion={openOutcomeSource} onLocate={locateSource} onApplied={(applied) => void applyAssistantVersion(applied)} onConversationChanged={() => setAssistantHistoryRevision((revision) => revision + 1)} onDraftContentUpdated={(content) => setEditorDocument(content)} />
    {createOpen && <CreateDialog categories={categories} close={() => setCreateOpen(false)} create={create} busy={createBusy} />}
    {submissionOpen && selectedForProject && <SubmissionDialog
      close={() => setSubmissionOpen(false)}
      onCreated={() => { setSubmissionOpen(false); setOperationNotice('投稿事务已创建；已转到投稿页。'); onNavigateToSubmissions?.(); }}
      projectId={projectId}
      outcomeId={selectedForProject.outcome.id}
      outcomeTitle={selectedForProject.outcome.title}
      outcomeVersion={selectedForProject.version.version}
    />}
    {trashOpen && <OutcomeTrashDialog items={trashItems} now={trashOpenedAt} confirmId={trashConfirmId} setConfirmId={setTrashConfirmId} close={() => setTrashOpen(false)} onRestore={(id) => void restoreTrashOutcome(id)} onDeleteForever={(id) => void deleteTrashOutcomeForever(id)} />}
    {categoryPrompt && <PromptDialog title={categoryPrompt.mode === 'rename' ? '重命名分类' : '新建分类'} fieldLabel="分类名称" confirmLabel={categoryPrompt.mode === 'rename' ? '重命名' : '创建'} initialValue={categoryPrompt.mode === 'rename' ? categoryPrompt.initialName : ''} close={() => setCategoryPrompt(null)} submit={(value) => void submitCategoryPrompt(value)} />}
  </div>;
}
