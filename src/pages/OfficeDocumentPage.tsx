/**
 * OfficeDocumentPage — native Word/PPT/Excel editing via OfficeCli.
 *
 * The user creates/opens a document; OfficeCli's `watch` server renders it
 * live on a local port, which we load in a <webview>. Subsequent edits (by
 * the user tools or the AI integration) refresh the preview automatically.
 * On unmount the watch server and the resident document are torn down.
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { useTranslation } from '../i18n';
import { useResearchWorkspaceStore } from '../research/researchWorkspaceStore';
import OfficeFormatToolbar from '../components/OfficeFormatToolbar';
import { WYSIWYG_BRIDGE_SCRIPT } from '../lib/officeIframeBridge';
import './OfficeDocumentPage.css';

type DocType = 'docx' | 'pptx' | 'xlsx';

interface OfficeStatus {
  available: boolean;
  binary: string;
  version?: string;
  error?: string;
}

export default function OfficeDocumentPage() {
  const { t } = useTranslation();
  const activeProjectId = useResearchWorkspaceStore((state) => state.activeProjectId);
  const [status, setStatus] = useState<OfficeStatus | null>(null);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Quick-edit panel state (direct element insertion + AI natural-language edit).
  const [editMode, setEditMode] = useState<'heading' | 'paragraph' | 'table'>('paragraph');
  const [headingText, setHeadingText] = useState('');
  const [paragraphText, setParagraphText] = useState('');
  const [tableRows, setTableRows] = useState('2');
  const [tableCols, setTableCols] = useState('2');
  const [aiInstruction, setAiInstruction] = useState('');
  const [aiRunning, setAiRunning] = useState(false);
  // The paragraph path currently targeted by the format toolbar. Empty targets
  // the last paragraph (the most recently added/edited one).
  const [selectedPath, setSelectedPath] = useState<string>('');
  const [paragraphPaths, setParagraphPaths] = useState<Array<{ path: string; label: string }>>([]);
  // PPT edit panel state.
  const [slideTitle, setSlideTitle] = useState('');
  const [slideText, setSlideText] = useState('');
  const [themeColor, setThemeColor] = useState('#2E5C8A');
  const [shapeText, setShapeText] = useState('');
  // Excel edit panel state.
  const [cellRow, setCellRow] = useState('1');
  const [cellCol, setCellCol] = useState('1');
  const [cellValue, setCellValue] = useState('');
  // Track the document we are closing so cleanup does not race the next open.
  const cleanupRef = useRef<string | null>(null);

  // Detect officecli availability on mount.
  useEffect(() => {
    let cancelled = false;
    const metis = window.metis;
    if (!metis?.officeCliStatus) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot fallback when the IPC bridge is absent
      setStatus({ available: false, binary: '', error: 'ipc_unavailable' });
      return;
    }
    void metis.officeCliStatus().then((result) => {
      if (!cancelled) setStatus(result);
    });
    return () => { cancelled = true; };
  }, []);

  const closeDocument = useCallback(async (target: string) => {
    const metis = window.metis;
    if (!metis) return;
    await metis.officeCliClose?.(target).catch(() => {});
  }, []);

  /** Ensure built-in heading styles exist (officecli warns if they don't). */
  const ensureHeadingStyles = useCallback(async (target: string) => {
    const metis = window.metis;
    if (!metis?.officeCliAdd) return;
    const styles = [
      { id: 'Heading1', name: 'Heading 1', size: '18' },
      { id: 'Heading2', name: 'Heading 2', size: '16' },
      { id: 'Heading3', name: 'Heading 3', size: '14' },
    ];
    for (const s of styles) {
      try {
        await metis.officeCliAdd({ filePath: target, parent: '/styles', type: 'style', props: { id: s.id, name: s.name, basedOn: 'Normal', size: s.size, bold: 'true' } });
      } catch { /* style may already exist */ }
    }
  }, []);

  /** Refresh the preview by rendering the current document to HTML via the
   *  main process, then inject the WYSIWYG bridge script into the iframe. */
  const refreshPreview = useCallback(async (target: string) => {    const metis = window.metis;
    if (!metis?.officeCliRenderHtml) return;
    try {
      const result = await metis.officeCliRenderHtml(target);
      if (result.success && typeof result.data === 'string') {
        setPreviewHtml(result.data);
      }
      // Also refresh the paragraph picker so the toolbar can target any paragraph.
      if (metis.officeCliQuery) {
        const query = await metis.officeCliQuery({ filePath: target, selector: 'paragraph' });
        if (query.success && Array.isArray(query.data)) {
          const items = (query.data as Array<{ path?: string; text?: string }>).map((item, i) => ({
            path: item.path ?? `/body/p[${i + 1}]`,
            label: `${i + 1}. ${(item.text ?? '').slice(0, 30) || '(空段落)'}`,
          }));
          setParagraphPaths(items);
        }
      }
    } catch { /* preview is best-effort */ }
  }, []);

  // Inject the WYSIWYG bridge script into the iframe after each render.
  useEffect(() => {
    if (!previewHtml) return;
    const iframe = document.querySelector('[data-testid="office-preview"]') as HTMLIFrameElement | null;
    if (!iframe?.contentDocument) return;
    try {
      const script = iframe.contentDocument.createElement('script');
      script.textContent = WYSIWYG_BRIDGE_SCRIPT;
      iframe.contentDocument.body?.appendChild(script);
    } catch { /* iframe may not be ready yet */ }
  }, [previewHtml]);

  // Listen for selection/editing messages from the preview iframe.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const data = event.data as Record<string, unknown> | undefined;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'office-select') {
        setSelectedPath(typeof data.path === 'string' ? data.path : '');
      } else if (data.type === 'office-text-edit') {
        const path = typeof data.path === 'string' ? data.path : '';
        const text = typeof data.text === 'string' ? data.text : '';
        if (path && filePath) {
          void window.metis?.officeCliSet?.({ filePath, path, props: { text } })
            .then(() => void refreshPreview(filePath));
        }
      } else if (data.type === 'office-shape-move') {
        const path = typeof data.path === 'string' ? data.path : '';
        const x = typeof data.x === 'string' ? data.x : '';
        const y = typeof data.y === 'string' ? data.y : '';
        if (path && filePath && x && y) {
          void window.metis?.officeCliSet?.({ filePath, path, props: { x, y } })
            .then(() => void refreshPreview(filePath));
        }
      } else if (data.type === 'office-deselect') {
        setSelectedPath('');
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [filePath, refreshPreview]);

  // Open (or create) a document and start the live watch server.
  const openOrCreate = useCallback(async (action: 'new' | 'open', ext?: DocType) => {
    const metis = window.metis;
    if (!metis?.officeCliStatus) {
      setError(t('office.errorIpcUnavailable'));
      return;
    }
    if (status && !status.available) {
      setError(t('office.errorNotInstalled'));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      let target = filePath;
      if (action === 'new') {
        const created = await metis.officeCliNewDocument!(ext ?? 'docx', activeProjectId ?? undefined);
        if (!created.success || !created.filePath) {
          setError(t('office.errorCreateFailed'));
          return;
        }
        target = created.filePath;
        setFilePath(target);
        // Register heading styles so the format toolbar works immediately.
        if (ext === 'docx') await ensureHeadingStyles(target);
      } else if (!target) {
        // Open needs a path — for the MVP the user picks via the file dialog below.
        return;
      }
      cleanupRef.current = target;
      // Render the initial preview via the main-process HTML renderer.
      await refreshPreview(target);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('office.errorWatchFailed'));
    } finally {
      setLoading(false);
    }
  }, [activeProjectId, ensureHeadingStyles, filePath, refreshPreview, status, t]);

  const openFromFile = useCallback(async () => {
    const metis = window.metis;
    if (!metis?.officeCliOpen) return;
    // For the MVP we accept a path the user types (the picker API differs across
    // Electron versions; a typed path is universally reliable for local files).
    const candidate = window.prompt(t('office.openPathPrompt')) ?? '';
    if (!candidate) return;
    setLoading(true);
    setError(null);
    try {
      const opened = await metis.officeCliOpen(candidate);
      if (!opened.success) {
        setError(opened.error ?? t('office.errorOpenFailed'));
        return;
      }
      setFilePath(candidate);
      cleanupRef.current = candidate;
      await refreshPreview(candidate);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('office.errorOpenFailed'));
    } finally {
      setLoading(false);
    }
  }, [refreshPreview, t]);

  const handleClose = useCallback(async () => {
    const target = cleanupRef.current;
    setPreviewHtml(null);
    setFilePath(null);
    setSelectedPath('');
    setParagraphPaths([]);
    cleanupRef.current = null;
    if (target) await closeDocument(target);
  }, [closeDocument]);

  /** Resolve the path to format: the user-selected path, or the last paragraph. */
  const resolveTargetPath = useCallback(async (): Promise<string | null> => {
    if (!filePath) return null;
    const metis = window.metis;
    if (!metis?.officeCliQuery) return null;
    if (selectedPath) return selectedPath;
    // Query all paragraphs and pick the last one's path.
    try {
      const result = await metis.officeCliQuery({ filePath, selector: 'paragraph' });
      if (result.success && Array.isArray(result.data) && result.data.length > 0) {
        const items = result.data as Array<{ path?: string }>;
        const last = items[items.length - 1];
        return last?.path ?? null;
      }
    } catch { /* best-effort */ }
    return null;
  }, [filePath, selectedPath]);

  /** Apply format properties to the selected (or last) paragraph. */
  const handleFormatProps = useCallback(async (props: Record<string, string>) => {
    const metis = window.metis;
    if (!metis || !filePath) return;
    const targetPath = await resolveTargetPath();
    if (!targetPath) return;
    await metis.officeCliSet!({ filePath, path: targetPath, props });
    await refreshPreview(filePath);
  }, [filePath, refreshPreview, resolveTargetPath]);

  /** PPT: add a new slide with title + content. */
  const handleAddSlide = useCallback(async () => {
    const metis = window.metis;
    if (!metis?.officeCliAddSlide || !filePath) return;
    setLoading(true);
    try {
      const result = await metis.officeCliAddSlide({ filePath, layout: 'Title and Content', title: slideTitle, text: slideText });
      if (result.success) {
        setSlideTitle('');
        setSlideText('');
        await refreshPreview(filePath);
      } else {
        setError(result.error ?? t('office.errorWatchFailed'));
      }
    } finally { setLoading(false); }
  }, [filePath, slideTitle, slideText, refreshPreview, t]);

  /** PPT: add a text shape with non-overlap enforcement. Uses the outline view
   *  to resolve the last slide's numeric index (officecli does not support
   *  XPath [last()] — only /slide[N]). */
  const handleAddShape = useCallback(async () => {
    const metis = window.metis;
    if (!metis?.officeCliAddShapeNoOverlap || !filePath || !shapeText.trim()) return;
    setLoading(true);
    try {
      // Query the outline to find the total slide count.
      const outline = await metis.officeCliOutline?.(filePath).catch(() => ({ success: false as const }));
      const outlineData = (outline?.success ? (outline as { data?: unknown }).data : null) as { totalSlides?: number } | null;
      const slideIndex = outlineData?.totalSlides ?? 1;
      const result = await metis.officeCliAddShapeNoOverlap({ filePath, slidePath: `/slide[${slideIndex}]`, text: shapeText, x: '2.5', y: '5', w: '8', h: '3' });
      if (result.success) {
        setShapeText('');
        await refreshPreview(filePath);
      } else {
        setError(result.error ?? t('office.errorWatchFailed'));
      }
    } finally { setLoading(false); }
  }, [filePath, shapeText, refreshPreview, t]);

  /** Excel: write a cell value. */
  const handleSetCell = useCallback(async () => {
    const metis = window.metis;
    if (!metis?.officeCliSet || !filePath || !cellValue.trim()) return;
    setLoading(true);
    try {
      const row = Math.max(1, parseInt(cellRow, 10) || 1);
      const col = Math.max(1, parseInt(cellCol, 10) || 1);
      const result = await metis.officeCliSet({ filePath, path: `/sheet[1]/row[${row}]/cell[${col}]`, props: { value: cellValue.trim() } });
      if (result.success) {
        setCellValue('');
        await refreshPreview(filePath);
      } else {
        setError(result.error ?? t('office.errorWatchFailed'));
      }
    } finally { setLoading(false); }
  }, [filePath, cellRow, cellCol, cellValue, refreshPreview, t]);

  /** PPT: set theme accent color. */
  const handleSetTheme = useCallback(async () => {    const metis = window.metis;
    if (!metis?.officeCliSetTheme || !filePath) return;
    setLoading(true);
    try {
      const hex = themeColor.replace('#', '').toUpperCase();
      const result = await metis.officeCliSetTheme({ filePath, props: { 'theme.color.accent1': `#${hex}`, 'theme.color.accent2': `#${hex}` } });
      if (result.success) {
        await refreshPreview(filePath);
      } else {
        setError(result.error ?? t('office.errorWatchFailed'));
      }
    } finally { setLoading(false); }
  }, [filePath, themeColor, refreshPreview, t]);

  /** Insert a heading/paragraph/table directly via OfficeCli. */
  const applyQuickEdit = useCallback(async () => {    const metis = window.metis;
    if (!metis || !filePath) return;
    setLoading(true);
    setError(null);
    try {
      let result: { success: boolean; error?: string };
      if (editMode === 'heading') {
        if (!headingText.trim()) return;
        result = await metis.officeCliAdd!({ filePath, parent: '/', type: 'paragraph', props: { text: headingText.trim(), style: 'Heading1' } });
      } else if (editMode === 'paragraph') {
        if (!paragraphText.trim()) return;
        result = await metis.officeCliAdd!({ filePath, parent: '/', type: 'paragraph', props: { text: paragraphText.trim() } });
      } else {
        const rows = String(Math.max(1, parseInt(tableRows, 10) || 1));
        const cols = String(Math.max(1, parseInt(tableCols, 10) || 1));
        result = await metis.officeCliAdd!({ filePath, parent: '/', type: 'table', props: { rows, cols } });
      }
      if (!result.success) setError(result.error ?? t('office.errorWatchFailed'));
      // Refresh the preview after the edit lands on disk.
      else {
        setHeadingText('');
        setParagraphText('');
        await refreshPreview(filePath);
      }
    } finally {
      setLoading(false);
    }
  }, [editMode, filePath, headingText, paragraphText, refreshPreview, tableRows, tableCols, t]);

  /**
   * AI natural-language edit: ask the provider to translate the instruction
   * into one or more OfficeCli operations, then run them. For the MVP we let
   * the provider return a JSON array of {op, parent, type, path, props} and
   * execute each in order.
   */
  const applyAiEdit = useCallback(async () => {
    const metis = window.metis;
    if (!metis?.officeCliAiEdit || !filePath || !aiInstruction.trim() || aiRunning) return;
    setAiRunning(true);
    setError(null);
    try {
      const ext = filePath.split('.').pop()?.toLowerCase() ?? 'docx';
      const docType = ext === 'pptx' ? 'pptx' : ext === 'xlsx' ? 'xlsx' : 'docx';
      const result = await metis.officeCliAiEdit({ instruction: aiInstruction.trim(), docType });
      if (!result.ok) {
        setError(result.error ?? t('office.aiEditFailed'));
        return;
      }
      const plan = result.plan;
      for (const step of plan) {
        const op = step.op;
        if (op === 'add') {
          await metis.officeCliAdd!({
            filePath,
            parent: typeof step.parent === 'string' ? step.parent : '/body',
            type: typeof step.type === 'string' ? step.type : 'paragraph',
            props: (step.props && typeof step.props === 'object' ? step.props : {}) as Record<string, string>,
          });
        } else if (op === 'set') {
          await metis.officeCliSet!({
            filePath,
            path: typeof step.path === 'string' ? step.path : '/',
            props: (step.props && typeof step.props === 'object' ? step.props : {}) as Record<string, string>,
          });
        }
      }
      setAiInstruction('');
      await refreshPreview(filePath);
    } catch {
      setError(t('office.aiEditFailed'));
    } finally {
      setAiRunning(false);
    }
  }, [aiInstruction, aiRunning, filePath, refreshPreview, t]);

  // Cleanup on unmount: tear down the live document.
  useEffect(() => {
    return () => {
      const target = cleanupRef.current;
      if (target) {
        cleanupRef.current = null;
        void closeDocument(target);
      }
    };
  }, [closeDocument]);

  const ready = status?.available === true;
  const docName = filePath ? filePath.split(/[\\/]/).pop() : '';

  return (
    <div className="office-page">
      <div className="office-toolbar">
        <h2>{t('office.pageTitle')}</h2>
        <div className="office-status">
          {status === null ? (
            <span className="office-status__checking">{t('office.checking')}</span>
          ) : ready ? (
            <span className="office-status__ok" data-testid="office-status-ok">
              {t('office.installed', { version: status.version ?? '' })}
            </span>
          ) : (
            <span className="office-status__missing" data-testid="office-status-missing">
              {t('office.notInstalled')}
            </span>
          )}
        </div>
        <div className="office-actions">
          <button className="btn-primary btn-sm" data-testid="office-new-docx" disabled={!ready || loading} onClick={() => void openOrCreate('new', 'docx')}>
            {t('office.newWord')}
          </button>
          <button className="btn-primary btn-sm" data-testid="office-new-pptx" disabled={!ready || loading} onClick={() => void openOrCreate('new', 'pptx')}>
            {t('office.newPpt')}
          </button>
          <button className="btn-primary btn-sm" data-testid="office-new-xlsx" disabled={!ready || loading} onClick={() => void openOrCreate('new', 'xlsx')}>
            {t('office.newExcel')}
          </button>
          <button className="btn-secondary btn-sm" disabled={!ready || loading} onClick={() => void openFromFile()}>
            {t('office.open')}
          </button>
          {filePath && (
            <>
              <button className="btn-secondary btn-sm" data-testid="office-reveal" disabled={loading} onClick={() => void window.metis?.officeCliRevealFile?.(filePath)}>
                {t('office.revealFile')}
              </button>
              <button className="btn-secondary btn-sm" data-testid="office-close" disabled={loading} onClick={() => void handleClose()}>
                {t('office.close')}
              </button>
            </>
          )}
        </div>
      </div>

      {docName && (
        <div className="office-docname" data-testid="office-docname" title={filePath ?? ''}>{docName}</div>
      )}

      {filePath && (
        <div className="office-edit-panel" data-testid="office-edit-panel">
          <OfficeFormatToolbar disabled={loading || aiRunning} onSetProps={handleFormatProps} />
          <div className="office-edit-row" style={{ marginTop: 4 }}>
            <select
              className="settings-input"
              data-testid="office-paragraph-select"
              value={selectedPath}
              onChange={(e) => setSelectedPath(e.target.value)}
              style={{ flex: 1, fontSize: 12 }}
            >
              <option value="">格式作用于：最后一段</option>
              {paragraphPaths.map((p) => (
                <option key={p.path} value={p.path}>{p.label}</option>
              ))}
            </select>
          </div>
          <div className="office-edit-tabs">
            <button className={`btn-sm ${editMode === 'paragraph' ? 'btn-primary' : 'btn-secondary'}`} data-testid="office-edit-paragraph" onClick={() => setEditMode('paragraph')}>{t('office.addParagraph')}</button>
            <button className={`btn-sm ${editMode === 'heading' ? 'btn-primary' : 'btn-secondary'}`} data-testid="office-edit-heading" onClick={() => setEditMode('heading')}>{t('office.addHeading')}</button>
            <button className={`btn-sm ${editMode === 'table' ? 'btn-primary' : 'btn-secondary'}`} data-testid="office-edit-table" onClick={() => setEditMode('table')}>{t('office.addTable')}</button>
          </div>
          {editMode === 'paragraph' && (
            <div className="office-edit-row">
              <input className="settings-input" data-testid="office-paragraph-input" value={paragraphText} onChange={(e) => setParagraphText(e.target.value)} placeholder={t('office.paragraphText')} style={{ flex: 1 }} />
            </div>
          )}
          {editMode === 'heading' && (
            <div className="office-edit-row">
              <input className="settings-input" data-testid="office-heading-input" value={headingText} onChange={(e) => setHeadingText(e.target.value)} placeholder={t('office.headingText')} style={{ flex: 1 }} />
            </div>
          )}
          {editMode === 'table' && (
            <div className="office-edit-row">
              <label>{t('office.tableRows')}<input className="settings-input" data-testid="office-table-rows" type="number" min={1} value={tableRows} onChange={(e) => setTableRows(e.target.value)} style={{ width: 70 }} /></label>
              <label>{t('office.tableCols')}<input className="settings-input" data-testid="office-table-cols" type="number" min={1} value={tableCols} onChange={(e) => setTableCols(e.target.value)} style={{ width: 70 }} /></label>
            </div>
          )}
          <div className="office-edit-row">
            <button className="btn-primary btn-sm" data-testid="office-apply-quick" disabled={loading} onClick={() => void applyQuickEdit()}>{t('office.add')}</button>
          </div>

          {/* PPT-specific panel (only shown for .pptx documents) */}
          {filePath.endsWith('.pptx') && (
            <div className="office-ppt-panel" data-testid="office-ppt-panel">
              <div className="office-edit-row" style={{ marginTop: 4 }}>
                <input className="settings-input" data-testid="ppt-slide-title" value={slideTitle} onChange={(e) => setSlideTitle(e.target.value)} placeholder="幻灯片标题" style={{ flex: 1 }} />
              </div>
              <div className="office-edit-row">
                <input className="settings-input" data-testid="ppt-slide-text" value={slideText} onChange={(e) => setSlideText(e.target.value)} placeholder="幻灯片内容" style={{ flex: 1 }} />
                <button className="btn-primary btn-sm" data-testid="ppt-add-slide" disabled={loading} onClick={() => void handleAddSlide()}>加幻灯片</button>
              </div>
              <div className="office-edit-row">
                <input className="settings-input" data-testid="ppt-shape-text" value={shapeText} onChange={(e) => setShapeText(e.target.value)} placeholder="文本框内容（自动避开重叠）" style={{ flex: 1 }} />
                <button className="btn-secondary btn-sm" data-testid="ppt-add-shape" disabled={loading || !shapeText.trim()} onClick={() => void handleAddShape()}>加文本框</button>
              </div>
              <div className="office-edit-row">
                <label style={{ fontSize: 12 }}>主题色</label>
                <input type="color" data-testid="ppt-theme-color" value={themeColor} onChange={(e) => setThemeColor(e.target.value)} style={{ width: 40, height: 28 }} />
                <button className="btn-secondary btn-sm" data-testid="ppt-apply-theme" disabled={loading} onClick={() => void handleSetTheme()}>应用主题</button>
              </div>
            </div>
          )}

          {/* Excel-specific panel */}
          {filePath.endsWith('.xlsx') && (
            <div className="office-ppt-panel" data-testid="office-xlsx-panel">
              <div className="office-edit-row" style={{ marginTop: 4 }}>
                <label style={{ fontSize: 12 }}>行<input className="settings-input" data-testid="xlsx-row" type="number" min={1} value={cellRow} onChange={(e) => setCellRow(e.target.value)} style={{ width: 60 }} /></label>
                <label style={{ fontSize: 12 }}>列<input className="settings-input" data-testid="xlsx-col" type="number" min={1} value={cellCol} onChange={(e) => setCellCol(e.target.value)} style={{ width: 60 }} /></label>
                <input className="settings-input" data-testid="xlsx-value" value={cellValue} onChange={(e) => setCellValue(e.target.value)} placeholder="单元格值" style={{ flex: 1 }} />
                <button className="btn-primary btn-sm" data-testid="xlsx-set-cell" disabled={loading || !cellValue.trim()} onClick={() => void handleSetCell()}>写入</button>
              </div>
            </div>
          )}

          <div className="office-ai-edit">
            <span className="office-ai-edit__title">{t('office.aiEditTitle')}</span>
            <div className="office-edit-row">
              <input className="settings-input" data-testid="office-ai-instruction" value={aiInstruction} onChange={(e) => setAiInstruction(e.target.value)} placeholder={t('office.aiEditPlaceholder')} style={{ flex: 1 }} />
              <button className="btn-primary btn-sm" data-testid="office-ai-apply" disabled={aiRunning || !aiInstruction.trim()} onClick={() => void applyAiEdit()}>
                {aiRunning ? t('office.aiEditRunning') : t('office.aiEditRun')}
              </button>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="office-error" role="alert" data-testid="office-error">{error}</div>
      )}

      <div className="office-canvas" data-testid="office-canvas">
        {!ready && status ? (
          <div className="office-empty">
            <h3>{t('office.notInstalledTitle')}</h3>
            <p>{t('office.notInstalledHint')}</p>
            <a href="https://github.com/iOfficeAI/OfficeCli" target="_blank" rel="noreferrer">OfficeCli</a>
          </div>
        ) : previewHtml ? (
          <iframe
            title="office-preview"
            srcDoc={previewHtml}
            className="office-preview-iframe"
            data-testid="office-preview"
            sandbox="allow-same-origin"
          />
        ) : (
          <div className="office-empty">
            <h3>{t('office.emptyTitle')}</h3>
            <p>{t('office.emptyHint')}</p>
          </div>
        )}
      </div>
    </div>
  );
}
