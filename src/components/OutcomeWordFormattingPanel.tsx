import { useEffect, useState } from 'react';
import { LayoutPanelTop, SlidersHorizontal, X } from 'lucide-react';
import type { WordDocument } from '../../engine/runtime/OutcomeRuntimeContract';
import {
  applyWordFormatting,
  parseWordFormattingInstruction,
  type WordFormattingConfig,
} from '../../engine/outcomes/WordDocumentFormatting';
import './OutcomeWordFormattingPanel.css';

type Props = Readonly<{
  document: WordDocument;
  onApply: (document: WordDocument, note: string) => void;
}>;

type BodyConfig = NonNullable<WordFormattingConfig['body']>;
type PageConfig = NonNullable<WordFormattingConfig['page']>;

const initialBody: BodyConfig = Object.freeze({
  fontFamily: '宋体', fontSizePt: 12, align: 'justify', firstLineIndentChars: 2,
  lineSpacing: 1.5, spaceBeforePt: 0, spaceAfterPt: 6,
});
function numberValue(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function centimetersFromPage(page: Record<string, unknown>, cmKey: keyof PageConfig, pointKey: string, fallback: number): number {
  const centimeters = finiteNumber(page[cmKey]);
  if (centimeters !== undefined) return centimeters;
  const points = finiteNumber(page[pointKey]);
  return points === undefined ? fallback : Math.round((points / 72 * 2.54) * 100) / 100;
}

function pageConfigFromDocument(document: WordDocument): PageConfig {
  const source = document.page as Record<string, unknown>;
  const paper: PageConfig['paper'] = source.paper === 'Letter' || source.paper === 'custom' ? source.paper : 'A4';
  return {
    paper,
    marginTopCm: centimetersFromPage(source, 'marginTopCm', 'marginTop', paper === 'A4' ? 2.54 : 2.54),
    marginBottomCm: centimetersFromPage(source, 'marginBottomCm', 'marginBottom', paper === 'A4' ? 2.54 : 2.54),
    marginLeftCm: centimetersFromPage(source, 'marginLeftCm', 'marginLeft', paper === 'A4' ? 3.17 : 2.54),
    marginRightCm: centimetersFromPage(source, 'marginRightCm', 'marginRight', paper === 'A4' ? 3.17 : 2.54),
  };
}

function bodyConfigFromDocument(document: WordDocument): BodyConfig {
  const source = (document.blocks.find((block) => block.kind !== 'table' && block.kind !== 'image')?.style ?? {}) as Record<string, unknown>;
  return {
    fontFamily: typeof source.fontFamily === 'string' ? source.fontFamily : initialBody.fontFamily,
    fontSizePt: finiteNumber(source.fontSizePt) ?? finiteNumber(source.fontSize) ?? initialBody.fontSizePt,
    align: source.align === 'left' || source.align === 'center' || source.align === 'right' || source.align === 'justify' ? source.align : initialBody.align,
    firstLineIndentChars: finiteNumber(source.firstLineIndentChars) ?? (finiteNumber(source.firstLineIndent) !== undefined && (finiteNumber(source.fontSizePt) ?? finiteNumber(source.fontSize) ?? 12) > 0 ? Math.round((finiteNumber(source.firstLineIndent) as number / (finiteNumber(source.fontSizePt) ?? finiteNumber(source.fontSize) ?? 12)) * 100) / 100 : initialBody.firstLineIndentChars),
    lineSpacing: finiteNumber(source.lineSpacing) ?? initialBody.lineSpacing,
    spaceBeforePt: finiteNumber(source.spaceBeforePt) ?? finiteNumber(source.spaceBefore) ?? initialBody.spaceBeforePt,
    spaceAfterPt: finiteNumber(source.spaceAfterPt) ?? finiteNumber(source.spaceAfter) ?? initialBody.spaceAfterPt,
  };
}

/** A local layout panel: it writes the document model, never just preview CSS. */
export function OutcomeWordFormattingPanel({ document, onApply }: Props) {
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [body, setBody] = useState<BodyConfig>(() => bodyConfigFromDocument(document));
  const [page, setPage] = useState<PageConfig>(() => pageConfigFromDocument(document));
  const [header, setHeader] = useState(document.header);
  const [footer, setFooter] = useState(document.footer);
  const [pageNumber, setPageNumber] = useState(document.page.pageNumber === true);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    // The selected document is an external prop; rehydrate the local controls when it changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBody(bodyConfigFromDocument(document));
    setPage(pageConfigFromDocument(document));
    setHeader(document.header);
    setFooter(document.footer);
    setPageNumber(document.page.pageNumber === true);
    setNotice('');
  }, [document]);

  const apply = (config: WordFormattingConfig, note: string) => {
    const result = applyWordFormatting(document, config);
    onApply({ ...result.document, header, footer, page: { ...result.document.page, pageNumber } }, note);
    setNotice(result.summary);
  };

  const applyStructured = () => apply({
    page,
    body,
    headings: {
      1: { fontFamily: '黑体', fontSizePt: 16, align: 'center', spaceBeforePt: 12, spaceAfterPt: 6 },
      2: { fontFamily: '黑体', fontSizePt: 14, spaceBeforePt: 10, spaceAfterPt: 5 },
      3: { fontFamily: body.fontFamily, fontSizePt: body.fontSizePt, spaceBeforePt: 8, spaceAfterPt: 4 },
      4: {}, 5: {}, 6: {},
    },
    captions: { fontFamily: body.fontFamily, fontSizePt: Math.max(8, (body.fontSizePt ?? 12) - 1), align: 'center' },
  }, '应用 Word 排版设置');

  const applyInstruction = () => {
    const parsed = parseWordFormattingInstruction(instruction);
    if (parsed.recognized.length === 0) { setNotice(parsed.unsupported[0] ?? '未识别到可执行的排版字段。'); return; }
    const nextBody = { ...body, ...(parsed.config.body ?? {}) };
    const nextPage = { ...page, ...(parsed.config.page ?? {}) };
    setBody(nextBody); setPage(nextPage);
    // Natural language must be additive: only fields the deterministic parser
    // actually recognized may change the document. The merged values above are
    // solely for keeping the structured controls in sync with the instruction.
    apply(parsed.config, `按自然语言排版：${parsed.recognized.join('、')}`);
  };

  return <>
    <button className="word-toolbar__format" type="button" onClick={() => setOpen(true)} title="打开排版设置">
      <SlidersHorizontal size={15} />排版
    </button>
    {open && <div className="outcome-word-format-backdrop" role="presentation">
      <section className="outcome-word-format-panel" role="dialog" aria-modal="true" aria-label="Word 排版设置">
        <header>
          <div><span><LayoutPanelTop size={17} /></span><div><strong>Word 排版</strong><small>设置会写入当前成果；请保存版本后导出。</small></div></div>
          <button type="button" onClick={() => setOpen(false)} aria-label="关闭排版设置"><X size={16} /></button>
        </header>
        <section className="outcome-word-format-panel__instruction">
          <label htmlFor="word-format-instruction">自然语言要求</label>
          <div><input id="word-format-instruction" value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="例如：宋体，小四，1.5 倍行距，首行缩进 2 字符" /><button type="button" onClick={applyInstruction}>解析并应用</button></div>
          <p>仅执行可明确识别的纸张、字体、字号、对齐、行距、缩进和页边距；其余要求会保留给你继续设置。</p>
        </section>
        <div className="outcome-word-format-panel__grid">
          <fieldset><legend>页面</legend>
            <label>纸张<select value={page.paper ?? 'A4'} onChange={(event) => setPage({ ...page, paper: event.target.value as PageConfig['paper'] })}><option value="A4">A4</option><option value="Letter">Letter</option><option value="custom">自定义（保留导入尺寸）</option></select></label>
            <label>上/下边距（cm）<input aria-label="上边距" type="number" min="0" max="10" step="0.01" value={page.marginTopCm ?? 2.54} onChange={(event) => { const value = numberValue(event.target.value, 2.54); setPage({ ...page, marginTopCm: value, marginBottomCm: value }); }} /></label>
            <label>左/右边距（cm）<input aria-label="左边距" type="number" min="0" max="10" step="0.01" value={page.marginLeftCm ?? 3.17} onChange={(event) => { const value = numberValue(event.target.value, 3.17); setPage({ ...page, marginLeftCm: value, marginRightCm: value }); }} /></label>
            <label className="outcome-word-format-panel__checkbox"><input aria-label="页码" type="checkbox" checked={pageNumber} onChange={(event) => setPageNumber(event.target.checked)} />页脚显示页码</label>
          </fieldset>
          <fieldset><legend>正文</legend>
            <label>字体<input aria-label="正文字体" value={body.fontFamily ?? ''} onChange={(event) => setBody({ ...body, fontFamily: event.target.value })} /></label>
            <label>字号（pt）<input aria-label="正文字号" type="number" min="6" max="96" step="0.5" value={body.fontSizePt ?? 12} onChange={(event) => setBody({ ...body, fontSizePt: numberValue(event.target.value, 12) })} /></label>
            <label>对齐<select aria-label="正文对齐" value={body.align ?? 'justify'} onChange={(event) => setBody({ ...body, align: event.target.value as BodyConfig['align'] })}><option value="justify">两端对齐</option><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option></select></label>
            <label>行距<input aria-label="正文行距" type="number" min="0.5" max="4" step="0.1" value={body.lineSpacing ?? 1.5} onChange={(event) => setBody({ ...body, lineSpacing: numberValue(event.target.value, 1.5) })} /></label>
            <label>首行缩进（字）<input aria-label="首行缩进" type="number" min="0" max="16" step="0.5" value={body.firstLineIndentChars ?? 2} onChange={(event) => setBody({ ...body, firstLineIndentChars: numberValue(event.target.value, 2) })} /></label>
          </fieldset>
        </div>
        <section className="outcome-word-format-panel__page-furniture"><label>页眉<input aria-label="页眉" value={header} onChange={(event) => setHeader(event.target.value)} placeholder="例如：研究报告" /></label><label>页脚<input aria-label="页脚" value={footer} onChange={(event) => setFooter(event.target.value)} placeholder="例如：METIS · 草稿" /></label></section>
        {notice && <p className="outcome-word-format-panel__notice" role="status">{notice}</p>}
        <footer><button type="button" onClick={() => setOpen(false)}>返回编辑</button><button className="primary" type="button" onClick={applyStructured}>应用结构化排版</button></footer>
      </section>
    </div>}
  </>;
}
