/* eslint-disable react-hooks/refs -- editor selection and external Office callbacks require latest mutable handles. */
import { LoaderCircle, RotateCcw, Save, Send, Table2, Underline, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { type WordDocument } from '../../../engine/runtime/OutcomeRuntimeContract';
import { RevisionProposalCard } from '../../outcomes/RevisionProposalCard';
import { OutcomeWordFormattingPanel } from '../../components/OutcomeWordFormattingPanel';
import { OfficeWordRibbon } from '../../components/OfficeWordRibbon';
import { assistantBridge, type AssistantApplied, type AssistantResult, type AssistantSelection, requestSelection } from './shared';

const superNumber = (value: number) => String(value).split('').map((item) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(item)]).join('');

type WordEditorProps = { projectId: string; outcomeId: string; hasUnsavedChanges: boolean; document: WordDocument; onChange: (value: WordDocument) => void; onSave: (value: WordDocument, note: string) => Promise<boolean> | void; onSelectionChange: (selection: AssistantSelection) => void; onAssistantApplied: (value: AssistantApplied | undefined) => Promise<void>; onConversationChanged: () => void; onNotice?: (notice: string) => void };

function WordEditor(props: WordEditorProps) {
  const [activeBlockId, setActiveBlockId] = useState(props.document.blocks[0]?.id ?? '');
  const [history, setHistory] = useState({ entries: [props.document], index: 0 });
  const [citationRequest, setCitationRequest] = useState(0);
  const resolvedActiveBlockId = props.document.blocks.some((block) => block.id === activeBlockId) ? activeBlockId : props.document.blocks[0]?.id ?? '';
  const active = props.document.blocks.find((block) => block.id === resolvedActiveBlockId) ?? props.document.blocks[0];
  const activeKind = active?.kind === 'heading' || active?.kind === 'paragraph' ? active.kind : undefined;
  const update = (next: WordDocument) => {
    if (JSON.stringify(next) === JSON.stringify(props.document)) return;
    const entries = [...history.entries.slice(0, history.index + 1), next].slice(-80);
    setHistory({ entries, index: entries.length - 1 });
    props.onChange(next);
  };
  const restore = (direction: -1 | 1) => {
    const index = Math.max(0, Math.min(history.entries.length - 1, history.index + direction));
    if (index === history.index) return;
    setHistory({ ...history, index });
    props.onChange(history.entries[index]!);
  };
  return <>
     <OfficeWordRibbon document={props.document} activeBlockId={active?.id ?? ''} activeStyle={active?.style ?? {}} activeKind={activeKind} activeLevel={active?.level} historyState={{ index: history.index, length: history.entries.length }} onChange={update} onSave={() => props.onSave(props.document, '保存编辑')} onHistory={restore} onCitation={() => setCitationRequest((value) => value + 1)} onNotice={(notice) => props.onNotice?.(notice)} />
     <LegacyWordEditor {...props} onChange={update} citationRequest={citationRequest} onSelectionChange={(selection) => { if (selection?.kind === 'word') setActiveBlockId(selection.blockId); props.onSelectionChange(selection); }} />
  </>;
}

function LegacyWordEditor({ projectId, outcomeId, hasUnsavedChanges, document, onChange, onSave, onSelectionChange, onAssistantApplied, onConversationChanged, onNotice, citationRequest }: WordEditorProps & { citationRequest: number }) {
  const doc = document;
  useLayoutEffect(() => {
    const toolbars = Array.from(window.document.querySelectorAll<HTMLElement>('.word-studio > .word-toolbar'));
    toolbars.forEach((toolbar) => {
      toolbar.hidden = true;
      toolbar.setAttribute('aria-hidden', 'true');
      toolbar.querySelectorAll<HTMLElement>('[aria-label]').forEach((control) => control.removeAttribute('aria-label'));
      toolbar.querySelectorAll<HTMLElement>('[title]').forEach((control) => control.removeAttribute('title'));
    });
  }, []);
  const [activeBlockId, setActiveBlockId] = useState(document.blocks[0]?.id ?? '');
  const [caret, setCaret] = useState<{ id: string; offset: number } | null>(null);
  const [citation, setCitation] = useState('');
  const [citationOpen, setCitationOpen] = useState(false);
  useEffect(() => {
    if (!citationOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setCitationOpen(false); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [citationOpen]);
  useEffect(() => {
    if (citationRequest <= 0) return undefined;
    const timer = window.setTimeout(() => setCitationOpen(true), 0);
    return () => window.clearTimeout(timer);
  }, [citationRequest]);
  const [localSelection, setLocalSelection] = useState<Extract<AssistantSelection, { kind: 'word' }>>();
  const [crossSelection, setCrossSelection] = useState<Extract<AssistantSelection, { kind: 'word' }>>();
  const crossSelectionRef = useRef<Extract<AssistantSelection, { kind: 'word' }> | undefined>(undefined);
  crossSelectionRef.current = crossSelection;
  const localSelectionRef = useRef<Extract<AssistantSelection, { kind: 'word' }> | undefined>(undefined);
  localSelectionRef.current = localSelection;
  const [localAnchor, setLocalAnchor] = useState<{ left: number; top: number; bottom?: number }>({ left: 16, top: 16 });
  const historyRef = useRef({ entries: [document], index: 0 });
  const [historyState, setHistoryState] = useState({ index: 0, length: 1 });
  const update = (next: WordDocument) => {
    if (JSON.stringify(next) === JSON.stringify(doc)) return;
    const current = historyRef.current;
    const entries = [...current.entries.slice(0, current.index + 1), next].slice(-80);
    historyRef.current = { entries, index: entries.length - 1 };
    setHistoryState({ index: entries.length - 1, length: entries.length });
    onChange(next);
  };
  const restoreHistory = (direction: -1 | 1) => {
    const current = historyRef.current;
    const index = Math.max(0, Math.min(current.entries.length - 1, current.index + direction));
    if (index === current.index) return;
    historyRef.current = { ...current, index };
    setHistoryState({ index, length: current.entries.length });
    onChange(current.entries[index]!);
  };
  const splitParagraphAtCaret = (event: React.KeyboardEvent<HTMLElement>, block: WordBlock) => {
    if (block.kind !== 'paragraph' && block.kind !== 'heading' && block.kind !== 'figure_caption' && block.kind !== 'table_caption') return;
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (!range || !event.currentTarget.contains(range.startContainer) || !event.currentTarget.contains(range.endContainer)) return;
    const before = range.cloneRange();
    before.selectNodeContents(event.currentTarget);
    before.setEnd(range.startContainer, range.startOffset);
    const start = Math.max(0, Math.min((block.text ?? '').length, before.toString().length));
    const selectedLength = selection?.toString().length ?? 0;
    const sourceText = block.text ?? '';
    const left = sourceText.slice(0, start);
    const right = sourceText.slice(Math.min(sourceText.length, start + selectedLength));
    let index = doc.blocks.length + 1;
    let id = `paragraph-${index}`;
    while (doc.blocks.some((candidate) => candidate.id === id)) id = `paragraph-${++index}`;
    const nextBlock: WordBlock = { ...block, id, text: right };
    const blocks = doc.blocks.flatMap((candidate) => candidate.id === block.id ? [{ ...candidate, text: left }, nextBlock] : [candidate]);
    update({ ...doc, blocks });
  };
  const updateActive = (patch: Record<string, unknown>) => update({ ...doc, blocks: doc.blocks.map((block) => block.id === activeBlockId ? { ...block, style: { ...block.style, ...patch } } : block) });
  const setBlockKind = (kind: 'paragraph' | 'heading', level?: number) => update({ ...doc, blocks: doc.blocks.map((block) => block.id === activeBlockId ? { ...block, kind, ...(level ? { level } : {}) } : block) });
  const updateTableCell = (blockId: string, rowIndex: number, cellIndex: number, value: string) => update({ ...doc, blocks: doc.blocks.map((block) => {
    if (block.id !== blockId || block.kind !== 'table') return block;
    return { ...block, rows: (block.rows ?? []).map((row, currentRow) => currentRow === rowIndex ? row.map((cell, currentCell) => currentCell === cellIndex ? value : cell) : row) };
  }) });
  const nextBlockId = (prefix: string) => { let index = doc.blocks.length + 1; let id = `${prefix}-${index}`; while (doc.blocks.some((block) => block.id === id)) { index += 1; id = `${prefix}-${index}`; } return id; };
  const capture = (event: React.SyntheticEvent<HTMLElement>) => {
    const targetBlockId = String(event.currentTarget.dataset.block ?? '');
    if (targetBlockId) setActiveBlockId(targetBlockId);
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (!selection || !range) {
      // 没有 DOM range（jsdom 点击、点击非文本区）时仍必须上报激活块，
      // 否则局部 AI 请求会丢 blockId（2026-09-02 修复：回归点击即选中的契约）。
      setLocalSelection(undefined); setCrossSelection(undefined);
      if (targetBlockId) onSelectionChange({ kind: 'word', blockId: targetBlockId, text: '' });
      return;
    }
    const nodeToBlock = (node: Node | null): HTMLElement | null => {
      const element = node ? (node.nodeType === 1 ? node as Element : node.parentElement) : null;
      return element?.closest<HTMLElement>('[data-block]') ?? null;
    };
    const startEl = nodeToBlock(range.startContainer);
    const endEl = nodeToBlock(range.endContainer);
    const blockOf = (element: HTMLElement | null) => doc.blocks.find((item) => item.id === element?.dataset.block);
    if (!startEl || !endEl) return;
    const anchorRect = typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : startEl.getBoundingClientRect();
    const showPopover = (next: Extract<AssistantSelection, { kind: 'word' }>) => {
      const blockRect = startEl.getBoundingClientRect();
      const left = Math.min(Math.max(12, (anchorRect.left || blockRect.left) + 8), Math.max(12, window.innerWidth - 326));
      const top = Math.max(12, (anchorRect.top || blockRect.top) - 10);
      setLocalAnchor({ left, top, bottom: anchorRect.bottom || blockRect.bottom });
      setLocalSelection(next);
    };
    if (startEl === endEl) {
      const block = blockOf(startEl);
      if (!block) return;
      const contentLength = (block.text ?? '').length;
      if (!startEl.contains(range.startContainer) || !startEl.contains(range.endContainer)) {
        setLocalSelection(undefined); setCrossSelection(undefined);
        onSelectionChange({ kind: 'word', blockId: block.id, text: '' });
        return;
      }
      const before = range.cloneRange();
      before.selectNodeContents(startEl);
      before.setEnd(range.startContainer, range.startOffset);
      const selectedText = selection.toString() ?? '';
      const start = Math.min(contentLength, Math.max(0, before.toString().length));
      const end = Math.min(contentLength, start + selectedText.length);
      setCaret({ id: block.id, offset: start });
      const nextSelection: Extract<AssistantSelection, { kind: 'word' }> = { kind: 'word', blockId: block.id, text: selectedText, start, end };
      onSelectionChange(nextSelection);
      setCrossSelection(undefined);
      if (!selectedText || end <= start) { setLocalSelection(undefined); return; }
      showPopover(nextSelection);
      return;
    }
    // 跨段/跨页选区（2026-09-01 刘总要求）：浮窗照常弹出；发送时自动把所选
    // 段落合并为基线版本再交给局部 AI。AI 应用的锚定信息放在 cross 字段。
    const startBlock = blockOf(startEl);
    const endBlock = blockOf(endEl);
    if (!startBlock || !endBlock) return;
    const beforeStart = range.cloneRange();
    beforeStart.selectNodeContents(startEl);
    beforeStart.setEnd(range.startContainer, range.startOffset);
    const afterEnd = range.cloneRange();
    afterEnd.selectNodeContents(endEl);
    afterEnd.setStart(range.endContainer, range.endOffset);
    const startOffset = Math.min((startBlock.text ?? '').length, Math.max(0, beforeStart.toString().length));
    const endOffset = Math.max(0, (endBlock.text ?? '').length - Math.min((endBlock.text ?? '').length, afterEnd.toString().length));
    const selectedText = selection.toString() ?? '';
    if (!selectedText.trim()) { setLocalSelection(undefined); setCrossSelection(undefined); return; }
    const crossSelection: Extract<AssistantSelection, { kind: 'word' }> = {
      kind: 'word', blockId: startBlock.id, text: selectedText,
      start: startOffset, end: startOffset + selectedText.length,
      cross: { endBlockId: endBlock.id, endOffset },
    };
    onSelectionChange(crossSelection);
    setCrossSelection(crossSelection);
    showPopover(crossSelection);
  };
  const captureTableCell = (event: React.SyntheticEvent<HTMLElement>, blockId: string, rowIndex: number, cellIndex: number) => { setActiveBlockId(blockId); const block = doc.blocks.find((item) => item.id === blockId); const cellText = block?.rows?.[rowIndex]?.[cellIndex] ?? ''; const selection = window.getSelection(); const range = selection?.rangeCount ? selection.getRangeAt(0) : null; if (!range || !event.currentTarget.contains(range.startContainer) || !event.currentTarget.contains(range.endContainer)) { setLocalSelection(undefined); onSelectionChange({ kind: 'word', blockId, text: '' }); return; } const before = range.cloneRange(); before.selectNodeContents(event.currentTarget); before.setEnd(range.startContainer, range.startOffset); const selectedText = selection?.toString() ?? ''; const start = Math.min(cellText.length, Math.max(0, before.toString().length)); const end = Math.min(cellText.length, start + selectedText.length); const nextSelection = { kind: 'word' as const, blockId, text: selectedText, start, end, row: rowIndex, column: cellIndex }; onSelectionChange(nextSelection); if (!selectedText || end <= start) { setLocalSelection(undefined); return; } const rangeRect = typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : event.currentTarget.getBoundingClientRect(); const cellRect = event.currentTarget.getBoundingClientRect(); const left = Math.min(Math.max(12, (rangeRect.left || cellRect.left) + 8), Math.max(12, window.innerWidth - 326)); const top = Math.max(12, (rangeRect.top || cellRect.top) - 10); setLocalAnchor({ left, top, bottom: rangeRect.bottom || cellRect.bottom }); setLocalSelection(nextSelection); };
  const insertCitation = () => { if (!caret || !citation.trim()) return; const refs = doc.blocks.filter((block) => block.id.startsWith('reference-')); const number = refs.length + 1; const blocks = doc.blocks.map((block) => block.id === caret.id ? { ...block, text: `${(block.text ?? '').slice(0, caret.offset)}${superNumber(number)}${(block.text ?? '').slice(caret.offset)}` } : block); if (!blocks.some((block) => block.id === 'references-heading')) blocks.push({ id: 'references-heading', kind: 'heading', level: 1, text: '参考文献' }); blocks.push({ id: nextBlockId('reference'), kind: 'paragraph', text: `[${number}] ${citation.trim()}`, style: { reference: true } }); update({ ...doc, blocks }); setCitation(''); setCitationOpen(false); };
  const active = doc.blocks.find((block) => block.id === activeBlockId); const activeStyle = active?.style ?? {};
  const displayStyle = (style: Record<string, unknown> | undefined) => {
    const value = style ?? {}; const fontSize = typeof value.fontSizePt === 'number' ? value.fontSizePt : typeof value.fontSize === 'number' ? value.fontSize : undefined; const indent = typeof value.firstLineIndentChars === 'number' ? `${value.firstLineIndentChars}em` : typeof value.firstLineIndent === 'number' ? `${value.firstLineIndent}pt` : undefined;
    return { fontWeight: value.bold === true ? 700 : undefined, fontStyle: value.italic === true ? 'italic' : undefined, textDecoration: value.underline === true ? 'underline' : undefined, textAlign: typeof value.align === 'string' ? value.align as 'left' | 'center' | 'right' | 'justify' : undefined, fontFamily: typeof value.fontFamily === 'string' ? value.fontFamily : undefined, fontSize: fontSize ? `${fontSize}pt` : undefined, color: typeof value.color === 'string' ? value.color : undefined, lineHeight: typeof value.lineSpacing === 'number' ? value.lineSpacing : undefined, textIndent: indent, marginTop: typeof value.spaceBeforePt === 'number' ? `${value.spaceBeforePt}pt` : typeof value.spaceBefore === 'number' ? `${value.spaceBefore}pt` : undefined, marginBottom: typeof value.spaceAfterPt === 'number' ? `${value.spaceAfterPt}pt` : typeof value.spaceAfter === 'number' ? `${value.spaceAfter}pt` : undefined };
  };
  const finitePageNumber = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const pageValue = doc.page as Record<string, unknown>;
  const pageWidthTwips = finitePageNumber(pageValue.width) ?? (pageValue.paper === 'Letter' ? 12240 : 11906);
  const pageHeightTwips = finitePageNumber(pageValue.height) ?? (pageValue.paper === 'Letter' ? 15840 : 16838);
  const pageDimension = (twips: number) => `${Math.round(twips / 1440 * 96)}px`;
  const marginDimension = (cmKey: string, pointKey: string, fallback: number) => {
    const centimeters = finitePageNumber(pageValue[cmKey]);
    const points = centimeters !== undefined ? centimeters * 72 / 2.54 : finitePageNumber(pageValue[pointKey]) ?? fallback;
    return `${Math.max(0, Math.round(points / 72 * 96))}px`;
  };
  const wordPageStyle = {
    '--word-page-width': pageDimension(pageWidthTwips),
    '--word-page-height': pageDimension(pageHeightTwips),
    '--word-page-margin-top': marginDimension('marginTopCm', 'marginTop', 72),
    '--word-page-margin-right': marginDimension('marginRightCm', 'marginRight', 72),
    '--word-page-margin-bottom': marginDimension('marginBottomCm', 'marginBottom', 72),
    '--word-page-margin-left': marginDimension('marginLeftCm', 'marginLeft', 72),
  } as React.CSSProperties;
  const pageNumber = pageValue.pageNumber === true;
  // ── 实测分页（2026-08-24 刘总反馈：长文档溢出到页面外、没有分页）──
  // 隐藏测量页渲染全部内容块，按真实高度把块切分到多个 A4 页面；
  // 单个超高块（如整页大表格）独占一页，该页自然增高，不再溢出到空白处。
  // 测量依赖 ResizeObserver 跟踪尺寸变化；无 ResizeObserver 的环境（如 jsdom）
  // 不渲染测量页，保持单页渲染的原有行为。
  type WordBlock = WordDocument['blocks'][number];
  const measureRef = useRef<HTMLElement>(null);
  const [measureRevision, setMeasureRevision] = useState(0);
  const [pageStarts, setPageStarts] = useState<number[]>([0]);
  const pageHeightPx = Math.round(pageHeightTwips / 1440 * 96);
  const marginNumber = (cmKey: string, pointKey: string, fallback: number) => {
    const centimeters = finitePageNumber(pageValue[cmKey]);
    const points = centimeters !== undefined ? centimeters * 72 / 2.54 : finitePageNumber(pageValue[pointKey]) ?? fallback;
    return Math.max(0, Math.round(points / 72 * 96));
  };
  const marginTopPx = marginNumber('marginTopCm', 'marginTop', 72);
  const marginBottomPx = marginNumber('marginBottomCm', 'marginBottom', 72);
  const headerReserve = doc.header ? 40 : 0;
  const footerReserve = doc.footer || pageNumber ? 48 : 0;
  const pageCapacity = Math.max(120, pageHeightPx - marginTopPx - marginBottomPx - headerReserve - footerReserve);
  useLayoutEffect(() => {
    const measure = measureRef.current;
    const body = measure?.querySelector('.word-page__body');
    if (!body) return;
    const heights = Array.from(body.children).map((element) => {
      const style = window.getComputedStyle(element);
      return (element as HTMLElement).offsetHeight + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
    });
    const starts = [0];
    let used = 0;
    heights.forEach((height, index) => {
      if (index === 0) { used = height; return; }
      if (used > 0 && used + height > pageCapacity) { starts.push(index); used = height; } else { used += height; }
    });
    setPageStarts((prev) => prev.length === starts.length && prev.every((value, index) => value === starts[index]) ? prev : starts);
  }, [doc.blocks, pageCapacity, measureRevision]);
  useLayoutEffect(() => {
    const measure = measureRef.current;
    if (!measure || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => setMeasureRevision((value) => value + 1));
    observer.observe(measure);
    return () => observer.disconnect();
  }, []);
  // 自由跨段编辑（2026-09-01 刘总要求）：正文区是单一编辑宿主，段落不再各自
  // 为独立编辑器——原生选区可跨段选中/删除。输入后以 DOM 为准回写模型：
  // 改写对应块文本，浏览器原生删并/删空段落时同步增删模型块。
  const reconcileBodyInput = (event: React.FormEvent<HTMLElement>) => {
    const body = event.currentTarget;
    const nodes = Array.from(body.querySelectorAll<HTMLElement>('[data-block]'));
    const domIds = new Set(nodes.map((node) => node.dataset.block ?? ''));
    const textual = new Set(['paragraph', 'heading', 'figure_caption', 'table_caption']);
    let changed = false;
    const nextBlocks = doc.blocks.flatMap((block) => {
      if (!textual.has(block.kind)) return [block];
      if (!domIds.has(block.id)) { changed = true; return []; }
      const node = nodes.find((candidate) => candidate.dataset.block === block.id);
      const text = node?.textContent ?? '';
      if (text === block.text) return [block];
      changed = true;
      return [{ ...block, text }];
    });
    if (!changed) return;
    update({ ...doc, blocks: nextBlocks });
  };
  // 粘贴统一降为纯文本（多段落粘贴的自动分段下一版再补）；回车仍可分段。
  const handleBodyPaste = (event: React.ClipboardEvent<HTMLElement>) => {
    const text = event.clipboardData.getData('text/plain');
    if (!text) return;
    event.preventDefault();
    const flattened = text.replace(/\r\n?/gu, '\n').replace(/\n+/gu, ' ').replace(/[^\S\r\n]+/gu, ' ').trim();
    window.document.execCommand('insertText', false, flattened);
  };
  // 跨段局部 AI 的发送前准备（2026-09-01 刘总要求）：把所选段落按选区边界
  // 合并为一个基线版本保存（版本面板可恢复），AI 在该单段上做局部修改。
  const prepareCrossSelection = async (): Promise<{ selection: Extract<AssistantSelection, { kind: 'word' }> } | { error: string }> => {
    const cross = crossSelectionRef.current;
    if (!cross?.cross) {
      // 单块/表格选区：直接使用打开浮窗时的真实选区。此前这里返回空 blockId
      // 的兜底对象，导致局部 AI 请求丢失选区（2026-09-02 修复）。
      const current = localSelectionRef.current;
      if (!current) return { error: '所选内容已变化，请重新选择后再发送。' };
      return { selection: current };
    }
    const startIndex = doc.blocks.findIndex((block) => block.id === cross.blockId);
    const crossTarget = cross.cross;
    const endIndex = doc.blocks.findIndex((block) => block.id === crossTarget.endBlockId);
    if (startIndex < 0 || endIndex < startIndex) return { error: '所选内容已变化，请重新选择后再发送。' };
    const startBlock = doc.blocks[startIndex]!;
    const endBlock = doc.blocks[endIndex]!;
    const startOffset = cross.start ?? 0;
    const endOffset = crossTarget.endOffset;
    const mergedText = (startBlock.text ?? '').slice(0, startOffset) + cross.text + (endBlock.text ?? '').slice(endOffset);
    const mergedBlock: WordBlock = { ...startBlock, text: mergedText };
    const next: WordDocument = { ...doc, blocks: [...doc.blocks.slice(0, startIndex), mergedBlock, ...doc.blocks.slice(endIndex + 1)] };
    onNotice?.('已合并所选段落并保存基线版本，正在发送局部 AI…');
    const saved = await onSave(next, '跨段局部编辑基线（合并所选段落）');
    if (saved === false) return { error: '基线版本保存未完成，AI 请求未发送；原文未被改动。' };
    setCrossSelection(undefined);
    return { selection: { kind: 'word', blockId: cross.blockId, text: cross.text, start: startOffset, end: startOffset + cross.text.length } };
  };
  const renderBlock = (block: WordBlock, measure: boolean) => {
    if (block.kind === 'table') {
      return <div key={`${measure ? 'm-' : ''}${block.id}`} contentEditable={false} style={{ display: 'flow-root' }}><table><tbody>{block.rows?.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => measure
        ? <td key={cellIndex}>{cell}</td>
        : <td key={cellIndex} contentEditable suppressContentEditableWarning onInput={(event) => { updateTableCell(block.id, rowIndex, cellIndex, event.currentTarget.textContent ?? ''); captureTableCell(event, block.id, rowIndex, cellIndex); }} onClick={(event) => captureTableCell(event, block.id, rowIndex, cellIndex)} onKeyUp={(event) => captureTableCell(event, block.id, rowIndex, cellIndex)}>{cell}</td>)}</tr>)}</tbody></table></div>;
    }
    if (block.kind === 'image') return <div key={`${measure ? 'm-' : ''}${block.id}`} contentEditable={false}><WordManagedImagePreview projectId={projectId} outcomeId={outcomeId} blockId={block.id} mediaId={block.imageRef} mediaType={block.mediaType} displayName={block.displayName} /></div>;
    if (measure) return <div key={`m-${block.id}`} className={`word-block ${block.kind} ${block.style?.list ? `word-block--${block.style.list}` : ''}`} style={displayStyle(block.style)}>{block.text}</div>;
     return <div key={block.id} data-block={block.id} className={`word-block ${block.kind} ${block.style?.list ? `word-block--${block.style.list}` : ''} ${block.id === activeBlockId ? 'is-active' : ''}`} style={displayStyle(block.style)} onClick={capture} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); splitParagraphAtCaret(event, block); } }} onKeyUp={capture}>{block.text}</div>;
  };
  const pages = pageStarts.map((start, index) => doc.blocks.slice(start, pageStarts[index + 1] ?? doc.blocks.length));
  return <div className="word-studio"><div className="word-toolbar" aria-label="Word 编辑工具栏"><select aria-label="段落样式" value={active?.kind === 'heading' ? `h${active.level ?? 1}` : 'p'} onChange={(event) => { const value = event.target.value; if (value === 'p') setBlockKind('paragraph'); else setBlockKind('heading', Number(value.slice(1))); }}><option value="p">正文</option><option value="h1">一级标题</option><option value="h2">二级标题</option><option value="h3">三级标题</option></select><input aria-label="字体" value={typeof activeStyle.fontFamily === 'string' ? activeStyle.fontFamily : ''} placeholder="字体" onChange={(event) => updateActive({ fontFamily: event.target.value })} /><input aria-label="字号" type="number" min="6" max="96" value={typeof activeStyle.fontSizePt === 'number' ? activeStyle.fontSizePt : typeof activeStyle.fontSize === 'number' ? activeStyle.fontSize : 12} onChange={(event) => updateActive({ fontSizePt: Number(event.target.value) || 12 })} /><input aria-label="文字颜色" type="color" value={typeof activeStyle.color === 'string' && /^#[0-9a-f]{6}$/iu.test(activeStyle.color) ? activeStyle.color : '#17243A'} onChange={(event) => updateActive({ color: event.target.value })} /><button type="button" className={activeStyle.bold === true ? 'active' : ''} onClick={() => updateActive({ bold: activeStyle.bold !== true })} title="加粗"><strong>B</strong></button><button type="button" className={activeStyle.italic === true ? 'active' : ''} onClick={() => updateActive({ italic: activeStyle.italic !== true })} title="斜体"><em>I</em></button><button type="button" className={activeStyle.underline === true ? 'active' : ''} onClick={() => updateActive({ underline: activeStyle.underline !== true })} title="下划线"><Underline size={15} /></button><select aria-label="段落对齐" value={typeof activeStyle.align === 'string' ? activeStyle.align : 'left'} onChange={(event) => updateActive({ align: event.target.value })}><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option><option value="justify">两端对齐</option></select><button type="button" onClick={() => updateActive({ list: activeStyle.list === 'bullet' ? undefined : 'bullet' })}>• 列表</button><button type="button" onClick={() => updateActive({ list: activeStyle.list === 'numbered' ? undefined : 'numbered' })}>1. 列表</button><button type="button" onClick={() => update({ ...doc, blocks: [...doc.blocks, { id: nextBlockId('table'), kind: 'table', rows: [['表头 1', '表头 2'], ['内容', '内容']] }] })} title="插入表格"><Table2 size={15} /></button><OutcomeWordFormattingPanel document={doc} onApply={(next) => update(next)} /><button type="button" onClick={() => restoreHistory(-1)} disabled={historyState.index === 0} title="撤销"><RotateCcw size={15} /></button><button type="button" onClick={() => restoreHistory(1)} disabled={historyState.index >= historyState.length - 1} title="重做"><RotateCcw size={15} className="word-toolbar__redo" /></button><span className="word-toolbar__spacer" /><button type="button" onClick={() => setCitationOpen(true)} disabled={!caret}>⁽¹⁾ 引文</button><button type="button" onClick={() => onSave(doc, '保存 Word 文档')}><Save size={15} />保存</button></div>{typeof ResizeObserver === 'undefined' ? null : <article ref={measureRef} className="word-page word-page--measure" style={wordPageStyle} aria-hidden="true"><div className="word-page__body">{doc.blocks.map((block) => renderBlock(block, true))}</div></article>}{<div className="word-pages-host" contentEditable suppressContentEditableWarning onInput={reconcileBodyInput} onPaste={handleBodyPaste} onMouseUp={capture}>{pages.map((pageBlocks, pageIndex) => <article key={pageIndex} className="word-page" style={wordPageStyle} aria-label={pageIndex === 0 ? 'Word 页面预览' : `Word 页面预览 第 ${pageIndex + 1} 页`}>{doc.header && <div className="word-page__header" contentEditable={false} data-testid={pageIndex === 0 ? 'word-page-header' : undefined}>{doc.header}</div>}<div className="word-page__body">{pageBlocks.map((block) => renderBlock(block, false))}{pageIndex === pages.length - 1 && <button className="word-add-block" type="button" contentEditable={false} onClick={() => update({ ...doc, blocks: [...doc.blocks, { id: nextBlockId('p'), kind: 'paragraph', text: '' }] })}>+ 添加段落</button>}</div>{(doc.footer || pageNumber) && <div className="word-page__footer" contentEditable={false} data-testid={pageIndex === 0 ? 'word-page-footer' : undefined}>{doc.footer && <span>{doc.footer}</span>}{pageNumber && <span className="word-page__number" aria-label="页码">{pageIndex + 1}</span>}</div>}</article>)}</div>}{localSelection && <LocalWordAssistantPopover projectId={projectId} outcomeId={outcomeId} selection={localSelection} anchor={localAnchor} hasUnsavedChanges={hasUnsavedChanges} close={() => { setLocalSelection(undefined); setCrossSelection(undefined); }} onApplied={onAssistantApplied} onConversationChanged={onConversationChanged} prepareSend={prepareCrossSelection} onNotice={onNotice} onDraftUpdated={(content) => { if (content) update(content as WordDocument); }} />}{citationOpen && <div className="citation-panel" role="dialog" aria-modal="true"><header><strong>插入引文</strong><button type="button" onClick={() => setCitationOpen(false)} aria-label="关闭"><X size={15} /></button></header><p>在当前光标处插入上角标，并在文末建立“参考文献”一级标题与编号条目。</p><textarea value={citation} onChange={(event) => setCitation(event.target.value)} placeholder="直接输入标准参考文献格式" /><footer><button type="button" onClick={() => setCitationOpen(false)}>取消</button><button className="primary" type="button" onClick={insertCitation}>插入</button></footer></div>}</div>;
}

function WordManagedImagePreview({ projectId, outcomeId, blockId, mediaId, mediaType, displayName }: { projectId: string; outcomeId: string; blockId: string; mediaId?: string; mediaType?: 'image/png' | 'image/jpeg'; displayName?: string }) {
  const [preview, setPreview] = useState<{ mediaId: string; url: string | null } | null>(null);
  const safeMediaId = mediaId && !mediaId.startsWith('docx-import-image-') ? mediaId : undefined;
  useEffect(() => {
    let current = true;
    if (!safeMediaId || !window.metis?.readOutcomeMedia) return () => { current = false; };
    void window.metis.readOutcomeMedia({ projectId, outcomeId, mediaId: safeMediaId }).then((value) => {
      if (current) setPreview({ mediaId: safeMediaId, url: typeof value === 'string' ? value : null });
    }).catch(() => { if (current) setPreview({ mediaId: safeMediaId, url: null }); });
    return () => { current = false; };
  }, [outcomeId, projectId, safeMediaId]);
  const url = safeMediaId && preview?.mediaId === safeMediaId ? preview.url : null;
  if (!mediaId || !mediaType || !displayName) return <figure className="word-image-block word-image-block--unsupported" data-block={blockId}><div>图片引用不完整，已安全降级为占位。</div></figure>;
  return <figure className="word-image-block" data-block={blockId}>{url ? <img src={url} alt={displayName} /> : <div className="word-image-block__placeholder">{safeMediaId ? `${displayName}（预览加载中或完整性校验未通过）` : `${displayName}（导入预览；保存时提交媒体）`}</div>}<figcaption>{displayName} · {mediaType}</figcaption></figure>;
}

function LocalWordAssistantPopover({ projectId, outcomeId, selection, anchor, hasUnsavedChanges, close, onApplied, onConversationChanged, prepareSend, onNotice, onDraftUpdated }: { projectId: string; outcomeId: string; selection: Extract<AssistantSelection, { kind: 'word' }>; anchor: { left: number; top: number; bottom?: number }; hasUnsavedChanges: boolean; close: () => void; onApplied: (value: AssistantApplied | undefined) => Promise<void>; onConversationChanged: () => void; prepareSend?: () => Promise<{ selection: Extract<AssistantSelection, { kind: 'word' }> } | { error: string }>; onNotice?: (notice: string) => void; onDraftUpdated?: (content: unknown) => void }) {
  const [instruction, setInstruction] = useState(''); const [notice, setNotice] = useState(''); const [isSending, setIsSending] = useState(false);
  const [proposedBundle, setProposedBundle] = useState<{ set: { id: string; instruction: string; createdBy: string; status: 'pending' | 'partially_accepted' | 'accepted' | 'rejected' | 'stale' | 'cancelled' }; revisions: never[] } | undefined>(undefined);
  // T05.05：AI 回答加入成果的插入位置选择。
  const popoverRef = useRef<HTMLElement>(null);
  const [placement, setPlacement] = useState({ left: anchor.left, top: anchor.top });
  useEffect(() => {
    const node = popoverRef.current;
    const rect = node?.getBoundingClientRect();
    const height = rect && rect.height > 0 ? rect.height : node?.offsetHeight ?? 0;
    const margin = 12;
    const maxTop = Math.max(margin, window.innerHeight - height - margin);
    let top = Math.min(anchor.top, maxTop);
    if (anchor.bottom !== undefined && top + height > anchor.bottom && anchor.bottom + margin <= maxTop) top = Math.min(anchor.bottom + margin, maxTop);
    setPlacement({ left: anchor.left, top: Math.max(margin, Math.min(top, maxTop)) });
  }, [anchor]);
  useEffect(() => {
    const dismiss = (event: Event) => { if (popoverRef.current && event.target instanceof Node && popoverRef.current.contains(event.target)) return; close(); };
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => { window.removeEventListener('scroll', dismiss, true); window.removeEventListener('resize', dismiss); };
  }, [close]);
  useEffect(() => { const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); }; window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape); }, [close]);
  const send = async (value: string) => {
    const trimmed = value.trim(); if (!trimmed || isSending) return;
    if (hasUnsavedChanges) { setNotice('当前草稿未保存。请先保存版本，再使用局部 AI。'); return; }
    const chat = assistantBridge()?.chatOutcomeAssistant;
    if (!chat) { setNotice('成果 AI 运行服务尚未就绪，未发送也未创建任何修改。'); return; }
    setIsSending(true); setNotice('');
    let effective = selection;
    if (prepareSend) {
      const prepared = await prepareSend();
      if ('error' in prepared) { setNotice(prepared.error); setIsSending(false); return; }
      effective = prepared.selection;
    }
    try {
      const result: AssistantResult = await chat({ projectId, outcomeId, instruction: trimmed, selection: requestSelection(effective) });
      setInstruction(''); onConversationChanged();
      if (result.status === 'completed') {
        // Outcomes 2.0（T03.01）：默认路径返回修订提案——展示 before/after，由用户逐条接受或拒绝。
        if (result.proposed) {
          const bundle = result.proposed as { set: { id: string; instruction: string; createdBy: string; status: 'pending' | 'partially_accepted' | 'accepted' | 'rejected' | 'stale' | 'cancelled' }; revisions: never[] };
          setProposedBundle(bundle);
          setNotice('AI 已生成修改建议（未改动正文，也未创建版本）。请核对后逐条接受或拒绝。');
          return;
        }
        if (result.applied) { await onApplied(result.applied); setNotice('AI 已将局部修改保存为新版本；右侧协作历史已同步。'); return; }
        setNotice(result.answer || result.assistantMessage?.content || 'AI 已回复。本轮没有生成可安全应用的结构化修改，因此成果内容未被改动。'); return;
      }
      const failed = result as unknown as { status: 'error' | 'cancelled'; code?: string; message?: string };
      const failText = failed.message || `本次局部协同未完成：${failed.code || failed.status}`;
      setNotice(failText);
    } catch {
      setNotice('局部 AI 请求没有完成，成果内容没有被修改。');
    } finally { setIsSending(false); }
  };
  // 任务5(2026-09-05):四个局部动作的指令可被 Office Profile slot 覆盖
  // (word.selection.rewrite/compress/expand/format);解析失败回退出厂默认。
  const [resolvedActions, setResolvedActions] = useState<Array<{ label: string; prompt: string }> | null>(null);
  useEffect(() => {
    let alive = true;
    const defaults: Array<{ label: string; slotId: string; prompt: string }> = [
      { label: '改写', slotId: 'word.selection.rewrite', prompt: '请在不改变含义的前提下改写所选文本，使其更清晰、准确。' },
      { label: '压缩', slotId: 'word.selection.compress', prompt: '请压缩所选文本，保留事实、论点与必要限定。' },
      { label: '扩写', slotId: 'word.selection.expand', prompt: '请在不虚构事实的前提下扩写所选文本，补足衔接与论证。' },
      { label: '格式', slotId: 'word.selection.format', prompt: '请优化所选文本的段落格式与表达层次。' },
    ];
    void (async () => {
      const resolved = await Promise.all(defaults.map(async (item) => {
        try {
          const response = await window.metis?.officePromptResolveSlot?.({ officeKind: 'word', outcomeId, slotId: item.slotId });
          return { label: item.label, prompt: response?.content?.trim() ? response.content : item.prompt };
        } catch { return { label: item.label, prompt: item.prompt }; }
      }));
      if (alive) setResolvedActions(resolved);
    })();
    return () => { alive = false; };
  }, [outcomeId]);
  const actions = (resolvedActions ?? [
    { label: '改写', prompt: '请在不改变含义的前提下改写所选文本，使其更清晰、准确。' },
    { label: '压缩', prompt: '请压缩所选文本，保留事实、论点与必要限定。' },
    { label: '扩写', prompt: '请在不虚构事实的前提下扩写所选文本，补足衔接与论证。' },
    { label: '润色', prompt: '请优化所选文本的表达层次与衔接，使论述更连贯、学术。' },
  ]).map((item) => [item.label, item.prompt] as const);
  return <section ref={popoverRef} className="word-local-ai" role="dialog" aria-label="所选文本 AI 操作" style={{ left: placement.left, top: placement.top }}><header><div><strong>AI 局部编辑</strong><small>已选 {selection.text.length} 个字符</small></div><button type="button" onClick={close} aria-label="关闭局部 AI 操作" title="关闭（Esc）"><X size={14} /></button></header>{proposedBundle && onDraftUpdated && <RevisionProposalCard projectId={projectId} set={proposedBundle.set} revisions={proposedBundle.revisions} compact onDraftUpdated={(content) => { onDraftUpdated(content); }} onNotice={onNotice} />}<div className="word-local-ai__actions">{actions.map(([label, prompt]) => <button key={label} type="button" onClick={() => void send(prompt)} disabled={hasUnsavedChanges || isSending}>{label}</button>)}</div><label className="word-local-ai__instruction">补充指令<textarea aria-label="局部 AI 指令" value={instruction} onChange={(event) => setInstruction(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void send(instruction); } }} placeholder="例如：保留术语，语气更严谨" disabled={hasUnsavedChanges || isSending} /></label>{hasUnsavedChanges && <p className="word-local-ai__notice" role="status">当前草稿未保存。请先保存版本，再使用局部 AI。</p>}{notice && <p className="word-local-ai__notice" role="status">{notice}</p>}<footer><span>Ctrl / ⌘ + Enter 发送</span><button className="primary" type="button" onClick={() => void send(instruction)} disabled={hasUnsavedChanges || isSending || !instruction.trim()}>{isSending ? <LoaderCircle size={14} className="spin" /> : <Send size={14} />}发送</button></footer></section>;
}

export { WordEditor };
