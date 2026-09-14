import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Copy, Image as ImageIcon, LoaderCircle, Maximize2,
  Minus, Move, Plus, Save, Sparkles, Table2, Trash2, Type, X,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  decodePptTemplateDefinition, type PptDocument, type PptGenerationApplied, type PptGenerationResult,
  type PptGenerationSkill, type PptPage, type PptTemplate,
} from '../../../engine/runtime/OutcomeRuntimeContract';
import { OfficePptRibbon } from '../../components/OfficePptRibbon';
import { useTranslation } from '../../i18n';
import { PromptDialog } from './OutcomeDialogs';
import { asRecord, type AssistantSelection, imageGenerationFailureNotice, isPristineFallbackPage, withoutPristineFallbackPages } from './shared';

type ApplicablePptTemplate = { ratio?: PptDocument['ratio']; theme?: Record<string, unknown>; pages?: PptPage[] };
const copyTemplatePages = (pages: PptPage[]): PptPage[] => pages.map((page) => ({ ...page, elements: page.elements.map((element) => ({ ...element, props: structuredClone(element.props) })) }));
const applicablePptTemplate = (template: PptTemplate, fallbackRatio: PptDocument['ratio']): { value?: ApplicablePptTemplate; message?: string } => {
  const definition = asRecord(template.definition);
  if (!definition) return { message: `模板「${template.name}」的数据结构无效，当前成果没有被修改。` };
  const decoded = decodePptTemplateDefinition(definition, fallbackRatio);
  if (!decoded) return { message: `模板「${template.name}」的比例、主题或页面布局数据无效，当前成果没有被修改。` };
  return { value: { ...decoded, ...(decoded.pages ? { pages: copyTemplatePages(decoded.pages) } : {}) } };
};
function mergeRowsById<T extends { id: string }>(current: T[], loaded: T[]): T[] { const rows = new Map(loaded.map((item) => [item.id, item])); current.forEach((item) => rows.set(item.id, item)); return [...rows.values()]; }

type PptEditorProps = { projectId: string; outcomeId: string; baseVersion: number; hasUnsavedChanges: boolean; document: PptDocument; initialPageId?: string; initialSelectedElementId?: string; onChange: (value: PptDocument) => void; onSave: (value: PptDocument) => void; onGenerationApplied: (value: PptGenerationApplied) => Promise<void>; onGenerationConflict: () => Promise<void>; onSelectionChange: (selection: AssistantSelection) => void; onNotice?: (notice: string) => void; controlledPageIndex?: number; controlledSelectedElementId?: string };

function PptStudioEditor(props: PptEditorProps) {
  const editorDocument: PptDocument = props.document.pages.length > 0 ? props.document : { ...props.document, pages: [{ id: 'slide-empty', title: '封面', pageType: 'cover', humanModified: false, status: 'draft', elements: [] }] };
  const initialPageIndex = props.initialPageId ? Math.max(0, editorDocument.pages.findIndex((page) => page.id === props.initialPageId)) : 0;
  const [pageIndex, setPageIndex] = useState(initialPageIndex);
  const [selectedElementId, setSelectedElementId] = useState<string | undefined>(props.initialSelectedElementId);
  const safePageIndex = Math.max(0, Math.min(pageIndex, Math.max(0, editorDocument.pages.length - 1)));
  const selectPage = (index: number, pageId = editorDocument.pages[index]?.id) => {
    setPageIndex(index);
    setSelectedElementId(undefined);
    if (pageId) props.onSelectionChange({ kind: 'ppt', pageId });
  };
  const selectElement = (elementId?: string) => {
    setSelectedElementId(elementId);
    const currentPage = editorDocument.pages[safePageIndex];
    if (currentPage) props.onSelectionChange({ kind: 'ppt', pageId: currentPage.id, ...(elementId ? { elementId } : {}) });
  };
  const saveDocument = () => props.onSave(withoutPristineFallbackPages(props.document));
  return <>
    <OfficePptRibbon document={editorDocument} pageIndex={safePageIndex} selectedElementId={selectedElementId} onChange={props.onChange} onSave={saveDocument} onSelectPage={selectPage} onSelectElement={selectElement} onNotice={(notice) => props.onNotice?.(notice)} />
    <LegacyPptStudioEditor {...props} document={editorDocument} controlledPageIndex={safePageIndex} controlledSelectedElementId={selectedElementId} onSelectionChange={(selection) => { if (selection?.kind === 'ppt') { const nextIndex = editorDocument.pages.findIndex((candidate) => candidate.id === selection.pageId); if (nextIndex >= 0) setPageIndex(nextIndex); setSelectedElementId(selection.elementId); } props.onSelectionChange(selection); }} />
  </>;
}

function LegacyPptStudioEditor({ projectId, outcomeId, baseVersion, hasUnsavedChanges, document, onChange, onSave, onGenerationApplied, onGenerationConflict, onSelectionChange, controlledPageIndex, controlledSelectedElementId }: PptEditorProps) {
  const { t } = useTranslation();
  useLayoutEffect(() => {
    const toolbar = window.document.querySelector<HTMLElement>('.ppt-studio > .ppt-toolbar');
    if (!toolbar) return undefined;
    toolbar.hidden = true;
    toolbar.setAttribute('aria-hidden', 'true');
    return () => { toolbar.hidden = false; toolbar.removeAttribute('aria-hidden'); };
  }, []);
  type PptPage = PptDocument['pages'][number];
  type PptElement = PptPage['elements'][number];
  type PptElementType = PptElement['type'];
  type DragState = { elementId: string; mode: 'move' | 'resize'; startX: number; startY: number; originX: number; originY: number; originWidth: number; originHeight: number };
  const elementOptions: Array<{ type: PptElementType; label: string; text: string }> = [
    { type: 'text', label: '文本', text: '输入文本' }, { type: 'rect', label: '矩形', text: '矩形' }, { type: 'roundRect', label: '圆角矩形', text: '圆角矩形' }, { type: 'ellipse', label: '椭圆', text: '椭圆' },
    { type: 'triangle', label: '三角', text: '三角' }, { type: 'line', label: '线', text: '线' }, { type: 'arrow', label: '箭头', text: '箭头' }, { type: 'table', label: '表格', text: '表格' },
    { type: 'chart', label: '图表', text: '图表占位' }, { type: 'image', label: '图片占位', text: '图片占位' },
  ];
  const emptyPage: PptPage = { id: 'slide-empty', title: '封面', pageType: 'cover', humanModified: false, status: 'draft', elements: [] };
  const doc: PptDocument = document.pages.length > 0 ? document : { ...document, pages: [emptyPage] };
  const [legacyPageIndex, setPageIndex] = useState(0);
  const [legacySelectedElementId, setSelectedElementId] = useState<string>();
  const pageIndex = controlledPageIndex ?? legacyPageIndex;
  const selectedElementId = controlledSelectedElementId ?? legacySelectedElementId;
  const [templates, setTemplates] = useState<PptTemplate[]>([]);
  const [defaultTemplateId, setDefaultTemplateId] = useState<string | null>(null);
  const [pendingDeleteTemplateId, setPendingDeleteTemplateId] = useState<string | null>(null);
  const [generationSkills, setGenerationSkills] = useState<PptGenerationSkill[]>([]);
  const [studioNotice, setStudioNotice] = useState('');
  const [generationInstruction, setGenerationInstruction] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [imageGenerationPrompt, setImageGenerationPrompt] = useState('');
  const [imageGenerationQuality, setImageGenerationQuality] = useState<'standard' | 'hd' | 'low' | 'medium' | 'high'>('standard');
  const [isImageGenerating, setIsImageGenerating] = useState(false);
  const [skillEditorOpen, setSkillEditorOpen] = useState(false);
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false);
  const [templateNameDraft, setTemplateNameDraft] = useState('');
  const [skillDraft, setSkillDraft] = useState<Omit<PptGenerationSkill, 'id'>>({ name: '', narrative: 'argument_evidence', contentDensity: 'balanced', audience: '', instructions: '', layoutEngine: 'zone', themeProfileId: 'academic-blue' });
  const [drag, setDrag] = useState<DragState>();
  const stageRef = useRef<HTMLDivElement>(null);
  const imageGenerationInFlight = useRef(false);
  const latestDocument = useRef(document);
  const idRef = useRef(0);
  useEffect(() => { latestDocument.current = document; }, [document]);
  useEffect(() => {
    let current = true;
    const bridge = window.metis;
    if (!bridge) return () => { current = false; };
    void Promise.all([
      bridge.listOutcomeTemplates ? bridge.listOutcomeTemplates({ kind: 'ppt' }) : bridge.listPptTemplates(),
      bridge.listPptGenerationSkills(),
      bridge.getDefaultOutcomeTemplate?.({ kind: 'ppt' }),
    ]).then(([templateRows, skillRows, defaultRow]) => {
      if (!current) return;
      setTemplates((currentRows) => mergeRowsById(currentRows, Array.isArray(templateRows) ? templateRows as PptTemplate[] : []));
      setDefaultTemplateId(defaultRow && typeof defaultRow === 'object' && 'id' in defaultRow ? String((defaultRow as { id: unknown }).id) : null);
      setGenerationSkills((currentRows) => mergeRowsById(currentRows, Array.isArray(skillRows) ? skillRows as PptGenerationSkill[] : []));
    }).catch(() => { if (current) setStudioNotice('模板或生成技能列表暂不可用；当前成果编辑不受影响。'); });
    return () => { current = false; };
  }, []);
  const safePageIndex = Math.max(0, Math.min(pageIndex, doc.pages.length - 1));
  const page = doc.pages[safePageIndex]!;
  const grid = doc.ratio === '16:9' ? { w: 32, h: 18 } : { w: 24, h: 18 };
  const update = (next: PptDocument) => onChange(next);
  const mutatePage = (mutator: (current: PptPage) => PptPage) => update({ ...doc, pages: doc.pages.map((candidate, index) => index === safePageIndex ? mutator(candidate) : candidate) });
  const selectElement = (elementId?: string, pageId = page.id) => { setSelectedElementId(elementId); onSelectionChange({ kind: 'ppt', pageId, ...(elementId ? { elementId } : {}) }); };
  const clampElement = (element: PptElement, x = element.x, y = element.y, width = element.width, height = element.height): PptElement => {
    const boundedWidth = Math.max(1, Math.min(grid.w, Math.round(width)));
    const boundedHeight = Math.max(1, Math.min(grid.h, Math.round(height)));
    const boundedX = Math.max(0, Math.min(grid.w - boundedWidth, Math.round(x)));
    const boundedY = Math.max(0, Math.min(grid.h - boundedHeight, Math.round(y)));
    return { ...element, x: boundedX, y: boundedY, width: boundedWidth, height: boundedHeight };
  };
  const markChanged = (mutator: (current: PptPage) => PptPage) => mutatePage((current) => ({ ...mutator(current), humanModified: true }));
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const textElements = page.elements.filter((element) => element.type === 'text');
    const nodes = Array.from(stage.querySelectorAll<HTMLElement>('.ppt-element--text'));
    const cleanups = nodes.map((node, index) => {
      const target = textElements[index];
      if (!target) return () => undefined;
      node.contentEditable = target.locked ? 'false' : 'true';
      node.setAttribute('contenteditable', target.locked ? 'false' : 'true');
      if (target.locked) return () => undefined;
      const onInput = () => {
        const nextText = node.textContent ?? '';
        markChanged((current) => ({
          ...current,
          elements: current.elements.map((element) => element.id === target.id
            ? { ...element, props: { ...element.props, text: nextText } }
            : element),
        }));
      };
      node.addEventListener('input', onInput);
      return () => node.removeEventListener('input', onInput);
    });
    return () => cleanups.forEach((cleanup) => cleanup());
  // The DOM listener is intentionally attached after React commits the canvas;
  // the editor model is re-read on every render so direct text edits cannot
  // write against an outdated page snapshot.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, page.elements, safePageIndex]);
  const createId = (prefix: string) => {
    let id = '';
    do { idRef.current += 1; id = `${prefix}-${idRef.current}`; }
    while (doc.pages.some((candidate) => candidate.id === id || candidate.elements.some((element) => element.id === id)));
    return id;
  };
  const selectedElement = page.elements.find((element) => element.id === selectedElementId);
  const elementLabel = (type: PptElementType) => elementOptions.find((option) => option.type === type)?.label ?? type;
  const addElement = (type: PptElementType) => {
    const option = elementOptions.find((item) => item.type === type);
    const id = createId(type);
    const isLine = type === 'line' || type === 'arrow';
    const element: PptElement = { id, type, x: 3, y: 3, width: isLine ? 8 : 10, height: isLine ? 1 : 3, locked: false, props: { text: option?.text ?? type, zIndex: page.elements.length + 1 } };
    markChanged((current) => ({ ...current, elements: [...current.elements, clampElement(element)] }));
    selectElement(id);
  };
  const selectPage = (index: number) => { const candidate = doc.pages[index]; if (!candidate) return; setPageIndex(index); selectElement(undefined, candidate.id); };
  const updateSelected = (mutator: (element: PptElement) => PptElement) => { if (!selectedElement || selectedElement.locked) return; markChanged((current) => ({ ...current, elements: current.elements.map((element) => element.id === selectedElement.id ? mutator(element) : element) })); };
  const colorValue = (value: unknown, fallback: string) => typeof value === 'string' && /^#[0-9a-f]{6}$/iu.test(value) ? value : fallback;
  const themeRoles = [
    { key: 'primary', label: '主色', fallback: '#236c91' }, { key: 'accent', label: '强调', fallback: '#b66c2e' },
    { key: 'surface', label: '画布', fallback: '#ffffff' }, { key: 'text', label: '正文', fallback: '#183b59' },
  ] as const;
  const themeColor = (key: typeof themeRoles[number]['key'], fallback: string) => colorValue(doc.theme[key], fallback);
  const updateThemeColor = (key: typeof themeRoles[number]['key'], color: string) => update({ ...doc, theme: { ...doc.theme, [key]: color } });
  const updateSelectedProps = (patch: Record<string, unknown>) => updateSelected((element) => ({ ...element, props: { ...element.props, ...patch } }));
  type ImageCropPart = 'left' | 'top' | 'right' | 'bottom';
  const readImageCrop = (value: unknown): Record<ImageCropPart, number> => {
    const crop = asRecord(value);
    const parts = {
      left: typeof crop?.left === 'number' && Number.isFinite(crop.left) ? crop.left : 0,
      top: typeof crop?.top === 'number' && Number.isFinite(crop.top) ? crop.top : 0,
      right: typeof crop?.right === 'number' && Number.isFinite(crop.right) ? crop.right : 0,
      bottom: typeof crop?.bottom === 'number' && Number.isFinite(crop.bottom) ? crop.bottom : 0,
    };
    return parts.left >= 0 && parts.top >= 0 && parts.right >= 0 && parts.bottom >= 0 && parts.left < 1 && parts.top < 1 && parts.right < 1 && parts.bottom < 1 && parts.left + parts.right < 1 && parts.top + parts.bottom < 1 ? parts : { left: 0, top: 0, right: 0, bottom: 0 };
  };
  const updateImageCrop = (part: ImageCropPart, percent: string) => {
    if (!selectedElement || selectedElement.type !== 'image') return;
    const current = readImageCrop(selectedElement.props.crop);
    const opposite = part === 'left' ? current.right : part === 'right' ? current.left : part === 'top' ? current.bottom : current.top;
    const next = Math.max(0, Math.min(0.99 - opposite, (Number(percent) || 0) / 100));
    updateSelectedProps({ crop: { ...current, [part]: next } });
  };
  const updateImageOpacity = (percent: string) => updateSelectedProps({ opacity: Math.max(0, Math.min(1, (Number(percent) || 0) / 100)) });
  const openImageGeneration = () => { if (!selectedElement || selectedElement.type !== 'image') { setStudioNotice('请先选择一个图片占位元素，再生成并关联真实图片媒体。'); return; } setStudioNotice('请在右侧“AI 图片生成”面板输入提示词。生成结果会先写入当前草稿，保存后才成为版本。'); };
  const generateSelectedImage = async () => {
    if (imageGenerationInFlight.current || isImageGenerating) return;
    if (!selectedElement || selectedElement.type !== 'image') { setStudioNotice('请先选择一个图片占位元素，再生成图片。'); return; }
    if (hasUnsavedChanges) { setStudioNotice('当前 PPT 有未保存的编辑。请先保存为新版本，再生成图片，避免覆盖本地草稿。'); return; }
    if (!imageGenerationPrompt.trim()) { setStudioNotice('请输入图片生成提示词。'); return; }
    const generateImage = window.metis?.generateOutcomeImage;
    if (!generateImage) { setStudioNotice('图片生成运行服务尚未就绪；本次没有生成图片。'); return; }
    const targetId = selectedElement.id; const baseDocument = JSON.stringify(doc);
    const visualContext = JSON.stringify({ ratio: doc.ratio, grid, theme: doc.theme, themeColors: Object.fromEntries(themeRoles.map((role) => [role.key, themeColor(role.key, role.fallback)])), imageElement: { id: targetId, width: selectedElement.width, height: selectedElement.height, x: selectedElement.x, y: selectedElement.y, props: selectedElement.props } });
    imageGenerationInFlight.current = true; setIsImageGenerating(true); setStudioNotice('正在请求图片生成服务；返回前不会修改当前 PPT 版本。');
    try {
      const result = await generateImage({ projectId, outcomeId, prompt: imageGenerationPrompt.trim(), visualContext, quality: imageGenerationQuality });
      if (!result.ok) { setStudioNotice(imageGenerationFailureNotice(result.code)); return; }
      if (JSON.stringify(latestDocument.current) !== baseDocument) { setStudioNotice(`图片「${result.media.displayName}」已由主进程持久化，但当前 PPT 草稿已变化，未自动插入，避免覆盖编辑。`); return; }
      updateSelectedProps({ mediaId: result.media.id, mediaType: result.media.mediaType, displayName: result.media.displayName }); setImageGenerationPrompt('');
      setStudioNotice(`已将真实持久化图片「${result.media.displayName}」关联到当前图片占位。点击“保存”才会创建人工 PPT 版本；已保存且授权通过的 PNG/JPEG 会嵌入 PPTX，不支持或未持久化的图片会诚实降级为占位并提示。`);
    } catch { setStudioNotice('图片生成请求没有完成，当前 PPT 没有被修改。'); }
    finally { imageGenerationInFlight.current = false; setIsImageGenerating(false); }
  };
  const elementStyle = (element: PptElement): React.CSSProperties => {
    const props = element.props;
    const borderWidth = typeof props.borderWidth === 'number' && Number.isFinite(props.borderWidth) ? Math.max(0, Math.min(12, props.borderWidth)) : undefined;
    const fontSize = typeof props.fontSize === 'number' && Number.isFinite(props.fontSize) ? Math.max(6, Math.min(120, props.fontSize)) : undefined;
    const rotation = typeof props.rotationDeg === 'number' && Number.isFinite(props.rotationDeg) ? props.rotationDeg % 360 : undefined;
    const opacity = typeof props.opacity === 'number' && Number.isFinite(props.opacity) ? Math.max(0, Math.min(1, props.opacity)) : undefined;
    const flip = `${props.flipH === true ? ' scaleX(-1)' : ''}${props.flipV === true ? ' scaleY(-1)' : ''}`;
    const transform = rotation === undefined && !flip ? undefined : `rotate(${rotation ?? 0}deg)${flip}`;
    const mask = props.mask === 'ellipse' ? { borderRadius: '50%' } : props.mask === 'roundRect' ? { borderRadius: '12%' } : props.mask === 'triangle' ? { clipPath: 'polygon(50% 0, 100% 100%, 0 100%)' } : {};
    return {
      left: `${element.x / grid.w * 100}%`, top: `${element.y / grid.h * 100}%`, width: `${element.width / grid.w * 100}%`, height: `${element.height / grid.h * 100}%`, zIndex: Number(props.zIndex ?? 1),
      ...(typeof props.fillColor === 'string' ? { backgroundColor: colorValue(props.fillColor, themeColor('primary', '#236c91')) } : {}),
      ...(typeof props.borderColor === 'string' ? { borderColor: colorValue(props.borderColor, '#7d96a7') } : {}),
      ...(borderWidth !== undefined ? { borderWidth } : {}),
      color: colorValue(props.textColor, themeColor('text', '#183b59')),
      ...(fontSize !== undefined ? { fontSize } : {}),
      ...(typeof props.fontFamily === 'string' && props.fontFamily.trim() ? { fontFamily: props.fontFamily } : {}),
      ...(transform ? { transform } : {}),
      ...(opacity !== undefined ? { opacity } : {}),
      ...mask,
    };
  };
  const nudge = (x: number, y: number) => updateSelected((element) => clampElement(element, element.x + x, element.y + y));
  const resize = (width: number, height: number) => updateSelected((element) => clampElement(element, element.x, element.y, element.width + width, element.height + height));
  const deleteSelected = () => { if (!selectedElement || selectedElement.locked) return; markChanged((current) => ({ ...current, elements: current.elements.filter((element) => element.id !== selectedElement.id) })); selectElement(); };
  const duplicateSelected = () => { if (!selectedElement || selectedElement.locked) return; const copy = clampElement({ ...selectedElement, id: createId(selectedElement.type), x: selectedElement.x + 1, y: selectedElement.y + 1, props: { ...selectedElement.props, zIndex: Number(selectedElement.props.zIndex ?? 1) + 1 } }); markChanged((current) => ({ ...current, elements: [...current.elements, copy] })); selectElement(copy.id); };
  const setLayer = (position: 'front' | 'back') => updateSelected((element) => { const layers = page.elements.filter((item) => item.id !== element.id).map((item) => Number(item.props.zIndex ?? 1)); const nextLayer = position === 'front' ? Math.max(0, ...layers) + 1 : Math.max(1, Math.min(1, ...layers) - 1); return { ...element, props: { ...element.props, zIndex: nextLayer } }; });
  const toggleLock = () => { if (!selectedElement) return; markChanged((current) => ({ ...current, elements: current.elements.map((element) => element.id === selectedElement.id ? { ...element, locked: !element.locked } : element) })); };
  const updateContent = (content: string) => updateSelected((element) => ({ ...element, props: { ...element.props, text: content } }));
  const beginDrag = (event: React.PointerEvent<HTMLElement>, element: PptElement, mode: 'move' | 'resize') => { if (element.locked) return; event.stopPropagation(); event.currentTarget.setPointerCapture?.(event.pointerId); selectElement(element.id); setDrag({ elementId: element.id, mode, startX: event.clientX, startY: event.clientY, originX: element.x, originY: element.y, originWidth: element.width, originHeight: element.height }); };
  const moveDrag = (event: React.PointerEvent<HTMLElement>, element: PptElement) => { if (!drag || drag.elementId !== element.id || element.locked) return; const bounds = stageRef.current?.getBoundingClientRect(); if (!bounds || !bounds.width || !bounds.height) return; const deltaX = Math.round((event.clientX - drag.startX) / bounds.width * grid.w); const deltaY = Math.round((event.clientY - drag.startY) / bounds.height * grid.h); if (drag.mode === 'move') updateSelected((current) => clampElement(current, drag.originX + deltaX, drag.originY + deltaY)); else updateSelected((current) => clampElement(current, drag.originX, drag.originY, drag.originWidth + deltaX, drag.originHeight + deltaY)); };
  const stopDrag = (event: React.PointerEvent<HTMLElement>) => { if (drag) event.currentTarget.releasePointerCapture?.(event.pointerId); setDrag(undefined); };
  const setRatio = (ratio: PptDocument['ratio']) => { if (ratio === doc.ratio) return; const targetGrid = ratio === '16:9' ? { w: 32, h: 18 } : { w: 24, h: 18 }; update({ ...doc, ratio, pages: doc.pages.map((candidate) => ({ ...candidate, humanModified: candidate.humanModified || !isPristineFallbackPage(candidate), elements: candidate.elements.map((element) => { const width = Math.max(1, Math.min(targetGrid.w, element.width)); const height = Math.max(1, Math.min(targetGrid.h, element.height)); return { ...element, x: Math.max(0, Math.min(targetGrid.w - width, element.x)), y: Math.max(0, Math.min(targetGrid.h - height, element.y)), width, height }; }) })) }); };
  const changeTemplate = (id: string) => { const template = templates.find((item) => item.id === id); if (!template) { update({ ...doc, templateId: null }); setStudioNotice('已取消模板关联；当前页面与主题没有被改动。'); return; } update({ ...doc, templateId: template.id }); setStudioNotice(`已关联真实模板「${template.name}」，但尚未应用其比例、主题或页面布局。请先保存关联，再点击“应用模板内容”。`); };
  const applyTemplate = () => {
    if (hasUnsavedChanges) { setStudioNotice('当前 PPT 有未保存的编辑或模板关联。请先保存为新版本，再应用模板内容，避免覆盖本地草稿。'); return; }
    const template = templates.find((item) => item.id === doc.templateId);
    if (!template) { setStudioNotice(doc.templateId ? '当前关联的模板已不可用或尚未加载，当前成果没有被修改。' : '请先选择一个真实模板，再应用模板内容。'); return; }
    const parsed = applicablePptTemplate(template, doc.ratio);
    if (!parsed.value) { setStudioNotice(parsed.message ?? '模板无法应用，当前成果没有被修改。'); return; }
    const next = { ...doc, templateId: template.id, ...(parsed.value.ratio ? { ratio: parsed.value.ratio } : {}), ...(parsed.value.theme ? { theme: structuredClone(parsed.value.theme) } : {}), ...(parsed.value.pages ? { pages: copyTemplatePages(parsed.value.pages) } : {}) };
    update(next); setPageIndex(0); setSelectedElementId(undefined); onSelectionChange({ kind: 'ppt', pageId: next.pages[0]?.id ?? page.id });
    const parts = [parsed.value.ratio ? '比例' : '', parsed.value.theme ? '主题' : '', parsed.value.pages ? '页面布局' : ''].filter(Boolean).join('、');
    setStudioNotice(`已将模板「${template.name}」的${parts}应用到当前草稿；现在可继续编辑。点击“保存”才会创建人工版本。`);
  };
  const documentForSave = (): PptDocument => withoutPristineFallbackPages(doc);
  const templateDefinitionFromDoc = (): { ratio: PptDocument['ratio']; theme: Record<string, unknown>; pages?: PptPage[] } => {
    const pages = doc.pages.filter((candidate) => !isPristineFallbackPage(candidate));
    return { ratio: doc.ratio, theme: doc.theme, ...(pages.length > 0 ? { pages: copyTemplatePages(pages) } : {}) };
  };
  const persistTemplate = async (name: string) => {
    const bridge = window.metis;
    if (!bridge) return;
    try {
      const definition = templateDefinitionFromDoc();
      const saved = bridge.saveOutcomeTemplate
        ? await bridge.saveOutcomeTemplate({ kind: 'ppt', name, definition })
        : bridge.savePptTemplate ? await bridge.savePptTemplate({ name, definition }) : null;
      if (!saved) { setStudioNotice('模板未保存，当前成果内容没有被改变。'); return; }
      const template = saved as PptTemplate;
      setTemplates((rows) => [...rows.filter((item) => item.id !== template.id), template]);
      update({ ...doc, templateId: template.id });
      setStudioNotice(`模板「${template.name}」已保存并关联当前成果；当前页面没有被模板覆盖。请保存成果版本以持久化关联。`);
    } catch { setStudioNotice('模板保存请求未完成，当前成果内容没有被改变。'); }
  };
  const saveTemplate = async (rawName: string) => { const name = rawName.trim(); if (!name) return; setSaveTemplateOpen(false); await persistTemplate(name); };
  const renamePptTemplate = async () => {
    const name = templateNameDraft.trim();
    if (!doc.templateId || !name || !window.metis?.updateOutcomeTemplate) return;
    try {
      const saved = await window.metis.updateOutcomeTemplate({ id: doc.templateId, kind: 'ppt', name });
      if (!saved) { setStudioNotice('PPT 模板重命名未完成。'); return; }
      setTemplates((rows) => rows.map((item) => item.id === doc.templateId ? saved as PptTemplate : item)); setTemplateNameDraft(''); setStudioNotice(`PPT 模板已重命名为「${(saved as PptTemplate).name}」。`);
    } catch { setStudioNotice('PPT 模板重命名请求未完成。'); }
  };
  const updatePptTemplate = async () => {
    if (!doc.templateId || !window.metis?.updateOutcomeTemplate) return;
    try {
      const saved = await window.metis.updateOutcomeTemplate({ id: doc.templateId, kind: 'ppt', definition: templateDefinitionFromDoc() });
      if (!saved) { setStudioNotice('PPT 模板更新未完成。'); return; }
      setTemplates((rows) => rows.map((item) => item.id === doc.templateId ? saved as PptTemplate : item)); setStudioNotice(`PPT 模板「${(saved as PptTemplate).name}」已更新为当前样式。`);
    } catch { setStudioNotice('PPT 模板更新请求未完成。'); }
  };
  const deletePptTemplate = async () => {
    const id = pendingDeleteTemplateId;
    if (!id || !window.metis?.deleteOutcomeTemplate) return;
    try {
      if (!await window.metis.deleteOutcomeTemplate({ id, kind: 'ppt' })) { setStudioNotice('PPT 模板删除未完成。'); return; }
      setTemplates((rows) => rows.filter((item) => item.id !== id));
      if (defaultTemplateId === id) setDefaultTemplateId(null);
      if (doc.templateId === id) update({ ...doc, templateId: null });
      setPendingDeleteTemplateId(null); setStudioNotice('PPT 模板已删除，当前成果内容未被修改。');
    } catch { setStudioNotice('PPT 模板删除请求未完成。'); }
  };
  const setPptDefaultTemplate = async () => {
    if (!doc.templateId || !window.metis?.setDefaultOutcomeTemplate) return;
    try {
      if (await window.metis.setDefaultOutcomeTemplate({ kind: 'ppt', templateId: doc.templateId })) { setDefaultTemplateId(doc.templateId); setStudioNotice('已设为 PPT 新建成果默认模板。'); } else setStudioNotice('PPT 默认模板设置未完成。');
    } catch { setStudioNotice('PPT 默认模板设置请求未完成。'); }
  };
  const clearPptDefaultTemplate = async () => {
    if (!defaultTemplateId || !window.metis?.setDefaultOutcomeTemplate) return;
    try {
      if (await window.metis.setDefaultOutcomeTemplate({ kind: 'ppt', templateId: null })) { setDefaultTemplateId(null); setStudioNotice('已取消 PPT 新建成果默认模板。'); } else setStudioNotice('PPT 默认模板取消未完成。');
    } catch { setStudioNotice('PPT 默认模板取消请求未完成。'); }
  };
  const saveGenerationSkill = async () => {
    if (!skillDraft.name.trim()) { setStudioNotice('请填写生成技能名称。'); return; }
    if (!window.metis?.savePptGenerationSkill) { setStudioNotice('PPT Generation Skill 保存服务尚未就绪，未创建技能。'); return; }
    try {
      const saved = await window.metis.savePptGenerationSkill({ ...skillDraft, name: skillDraft.name.trim(), audience: skillDraft.audience.trim(), instructions: skillDraft.instructions.trim() });
      if (!saved) { setStudioNotice('生成技能未保存，当前成果内容没有被改变。'); return; }
      const skill = saved as PptGenerationSkill;
      setGenerationSkills((rows) => [skill, ...rows.filter((item) => item.id !== skill.id)]);
      update({ ...doc, generationSkillId: skill.id }); setSkillEditorOpen(false);
      setStudioNotice(`已创建并选择真实生成技能「${skill.name}」。请保存当前成果版本后再运行。`);
    } catch { setStudioNotice('生成技能保存请求未完成，当前成果内容没有被改变。'); }
  };
  const executeGeneration = async () => {
    if (isGenerating) return;
    if (hasUnsavedChanges) { setStudioNotice('当前 PPT 有未保存的编辑。请先保存为新版本，再运行 Generation Skill，避免覆盖本地草稿。'); return; }
    if (!doc.generationSkillId) { setStudioNotice('请先选择一个 PPT 生成技能并保存当前成果版本。'); return; }
    if (!generationInstruction.trim()) { setStudioNotice('请输入本次 PPT 生成指令。'); return; }
    const execute = window.metis?.executeOutcomePptGeneration;
    if (!execute) { setStudioNotice('PPT Generation Skill 运行服务尚未就绪；本次没有生成或修改成果。'); return; }
    setIsGenerating(true); setStudioNotice('正在调用已选 Generation Skill；完成前不会修改本地草稿。');
    try {
      const result: PptGenerationResult = await execute({ projectId, outcomeId, baseVersion, generationSkillId: doc.generationSkillId, templateId: doc.templateId, instruction: generationInstruction.trim() });
      if (result.status === 'completed') { setGenerationInstruction(''); await onGenerationApplied(result.applied); return; }
      if (result.code === 'outcome_version_conflict') { await onGenerationConflict(); return; }
      setStudioNotice(result.message || `PPT 生成未完成：${result.code}`);
    } catch { setStudioNotice('PPT Generation Skill 请求没有完成，当前成果没有被修改。'); }
    finally { setIsGenerating(false); }
  };
  return <div className="ppt-studio">
    <div className="ppt-toolbar" aria-label="PPT 编辑工具栏"><span>{doc.ratio} · {grid.w} × {grid.h} Grid</span><div className="ppt-toolbar__ratio" role="group" aria-label="页面比例"><button type="button" className={doc.ratio === '16:9' ? 'active' : ''} onClick={() => setRatio('16:9')}>16:9</button><button type="button" className={doc.ratio === '4:3' ? 'active' : ''} onClick={() => setRatio('4:3')}>4:3</button></div><select aria-label="添加 PPT 元素" defaultValue="" onChange={(event) => { if (event.target.value) { addElement(event.target.value as PptElementType); event.currentTarget.value = ''; } }}><option value="" disabled>添加元素</option>{elementOptions.map((option) => <option key={option.type} value={option.type}>{option.label}</option>)}</select><button type="button" onClick={() => addElement('text')}><Type size={15} />文本</button><button type="button" onClick={() => addElement('rect')}><Plus size={15} />矩形</button><button type="button" onClick={() => addElement('table')}><Table2 size={15} />表格</button><button type="button" onClick={openImageGeneration} disabled={isImageGenerating}><ImageIcon size={15} />AI 图片</button><button type="button" onClick={() => onSave(documentForSave())}><Save size={15} />保存</button></div>
    <div className="ppt-template-strip" aria-label="PPT 模板与生成技能"><label>{t('outcomePptTemplates.fieldLabel')}<select aria-label="选择 PPT 模板" value={doc.templateId ?? ''} onChange={(event) => changeTemplate(event.target.value)}><option value="">{t('outcomePptTemplates.selectNone')}</option>{templates.map((template) => <option key={template.id} value={template.id}>{template.name}{template.id === defaultTemplateId ? t('outcomePptTemplates.defaultSuffix') : ''}</option>)}</select></label><button type="button" onClick={() => setSaveTemplateOpen(true)} disabled={!window.metis?.saveOutcomeTemplate && !window.metis?.savePptTemplate}>{t('outcomePptTemplates.saveAs')}</button><button className="ppt-template-apply" type="button" onClick={applyTemplate} disabled={!doc.templateId} title="将所选模板的可用比例、主题和页面布局写入当前草稿">{t('outcomePptTemplates.apply')}</button><input aria-label={t('outcomePptTemplates.nameLabel')} value={templateNameDraft} onChange={(event) => setTemplateNameDraft(event.target.value)} placeholder={t('outcomePptTemplates.namePlaceholder')} /><button type="button" onClick={() => void renamePptTemplate()} disabled={!doc.templateId || !templateNameDraft.trim()}>{t('outcomePptTemplates.rename')}</button><button type="button" onClick={() => void updatePptTemplate()} disabled={!doc.templateId}>{t('outcomePptTemplates.updateCurrent')}</button><button type="button" onClick={() => void setPptDefaultTemplate()} disabled={!doc.templateId}>{t('outcomePptTemplates.setDefault')}</button><button type="button" onClick={() => void clearPptDefaultTemplate()} disabled={!defaultTemplateId}>{t('outcomePptTemplates.clearDefault')}</button><button type="button" onClick={() => setPendingDeleteTemplateId(doc.templateId)} disabled={!doc.templateId}>{t('outcomePptTemplates.delete')}</button>{pendingDeleteTemplateId && <div className="ppt-template-confirm" role="alert"><span>{t('outcomePptTemplates.confirmDelete', { name: templates.find((item) => item.id === pendingDeleteTemplateId)?.name ?? pendingDeleteTemplateId })}</span><button type="button" onClick={() => void deletePptTemplate()}>{t('outcomePptTemplates.confirm')}</button><button type="button" onClick={() => setPendingDeleteTemplateId(null)}>{t('outcomePptTemplates.cancel')}</button></div>}<small className="ppt-template-association" role="status">{hasUnsavedChanges ? '当前有未保存编辑或模板关联；先保存版本后才可应用，避免覆盖草稿。' : doc.templateId ? '当前仅关联模板，尚未覆盖页面；点击“应用模板内容”后仍需手动保存。' : '选择模板只建立关联，不会覆盖当前页面。'}</small><label>生成技能<select aria-label="选择 PPT 生成技能" value={doc.generationSkillId ?? ''} onChange={(event) => update({ ...doc, generationSkillId: event.target.value || null })}><option value="">不关联生成技能</option>{generationSkills.map((skill) => <option key={skill.id} value={skill.id}>{skill.name}</option>)}</select></label><button type="button" onClick={() => setSkillEditorOpen(true)} disabled={!window.metis?.savePptGenerationSkill}>新建技能</button><input className="ppt-generation-instruction" aria-label="PPT 生成指令" value={generationInstruction} onChange={(event) => setGenerationInstruction(event.target.value)} placeholder="例如：把本页扩展为答辩逻辑" disabled={isGenerating} /><button className="ppt-generation-action" type="button" onClick={() => void executeGeneration()} disabled={isGenerating || hasUnsavedChanges || !doc.generationSkillId || !generationInstruction.trim()}>{isGenerating ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />}运行生成</button><small>{hasUnsavedChanges ? '当前有未保存编辑；保存为新版本后才能运行。' : doc.generationSkillId ? '运行前会核验当前版本；仅服务端成功保存的新版本才会显示。' : '选择或新建生成技能并保存当前成果版本后，才能运行。'}</small></div>
    {studioNotice && <p className="ppt-studio__notice" role="status">{studioNotice}</p>}
    {skillEditorOpen && <section className="ppt-skill-editor" role="dialog" aria-label="新建 PPT 生成技能"><header><div><strong>新建生成技能</strong><small>保存后会真实写入技能库，并自动选中。</small></div><button type="button" aria-label="关闭新建生成技能" onClick={() => setSkillEditorOpen(false)}><X size={15} /></button></header><label>名称<input aria-label="生成技能名称" value={skillDraft.name} onChange={(event) => setSkillDraft((current) => ({ ...current, name: event.target.value }))} autoFocus /></label><div className="ppt-skill-editor__row"><label>叙事<select aria-label="生成技能叙事" value={skillDraft.narrative} onChange={(event) => setSkillDraft((current) => ({ ...current, narrative: event.target.value as PptGenerationSkill['narrative'] }))}><option value="argument_evidence">论点与证据</option><option value="problem_solution">问题与方案</option><option value="timeline">时间线</option><option value="comparison">比较</option><option value="minimal_report">极简汇报</option></select></label><label>信息密度<select aria-label="生成技能信息密度" value={skillDraft.contentDensity} onChange={(event) => setSkillDraft((current) => ({ ...current, contentDensity: event.target.value as PptGenerationSkill['contentDensity'] }))}><option value="sparse">精简</option><option value="balanced">均衡</option><option value="dense">详实</option></select></label><label>版式引擎<select aria-label="版式引擎" value={skillDraft.layoutEngine ?? 'zone'} onChange={(event) => setSkillDraft((current) => ({ ...current, layoutEngine: event.target.value as PptGenerationSkill['layoutEngine'] }))}><option value="zone">zone 版式引擎（推荐）</option><option value="legacy">传统（模型直出）</option></select></label><label>主题风格<select aria-label="主题风格" value={skillDraft.themeProfileId ?? 'academic-blue'} onChange={(event) => setSkillDraft((current) => ({ ...current, themeProfileId: event.target.value }))}><option value="academic-blue">学术蓝（通用）</option><option value="gov-red">政务红（通用）</option><option value="tech-slate">科技深空（通用）</option><option value="minimal-mono">极简黑白（通用）</option><option value="wut">武汉理工（校徽蓝三件套）</option></select></label></div><label>受众<input aria-label="生成技能受众" value={skillDraft.audience} placeholder="例如：项目评审专家" onChange={(event) => setSkillDraft((current) => ({ ...current, audience: event.target.value }))} /></label><label>说明<textarea aria-label="生成技能说明" value={skillDraft.instructions} placeholder="说明所需结构、证据和表达约束" onChange={(event) => setSkillDraft((current) => ({ ...current, instructions: event.target.value }))} /></label><footer><button type="button" onClick={() => setSkillEditorOpen(false)}>取消</button><button className="primary" type="button" onClick={() => void saveGenerationSkill()}>保存技能</button></footer></section>}
    {saveTemplateOpen && <PromptDialog title="保存为 PPT 模板" fieldLabel="模板名称" confirmLabel="保存模板" close={() => setSaveTemplateOpen(false)} submit={(value) => void saveTemplate(value)} />}
    <div className="ppt-editor-body"><nav className="ppt-slides" aria-label="幻灯片列表">{doc.pages.map((candidate, index) => <button key={candidate.id} type="button" className={index === safePageIndex ? 'selected' : ''} onClick={() => selectPage(index)}><small>{String(index + 1).padStart(2, '0')}</small><strong>{candidate.title}</strong><span>{candidate.humanModified ? '人工修改' : candidate.status === 'draft' ? '草稿' : '完成'}</span></button>)}<button type="button" className="ppt-slides__add" onClick={() => { const id = createId('slide'); update({ ...doc, pages: [...doc.pages, { id, title: `第 ${doc.pages.length + 1} 页`, pageType: 'content', humanModified: true, status: 'draft', elements: [] }] }); setPageIndex(doc.pages.length); selectElement(undefined, id); }}><Plus size={14} />新建页</button></nav>
      <div className="ppt-canvas-wrap"><div ref={stageRef} className="ppt-stage" style={{ aspectRatio: doc.ratio.replace(':', ' / '), '--ppt-primary': themeColor('primary', '#236c91'), '--ppt-accent': themeColor('accent', '#b66c2e'), '--ppt-surface': themeColor('surface', '#ffffff'), '--ppt-text': themeColor('text', '#183b59') } as React.CSSProperties} onClick={() => selectElement()}>{Array.from({ length: grid.w * grid.h }).map((_, index) => <i key={index} style={{ left: `${(index % grid.w) / grid.w * 100}%`, top: `${Math.floor(index / grid.w) / grid.h * 100}%` }} />)}{page.elements.map((element) => <div key={element.id} role="button" tabIndex={0} aria-label={`选择${elementLabel(element.type)}`} className={`ppt-element ppt-element--${element.type} ${selectedElementId === element.id ? 'selected' : ''} ${element.locked ? 'locked' : ''}`} onClick={(event) => { event.stopPropagation(); selectElement(element.id); }} onPointerDown={(event) => beginDrag(event, element, 'move')} onPointerMove={(event) => moveDrag(event, element)} onPointerUp={stopDrag} onKeyDown={(event) => { if (event.key === 'Delete') { event.preventDefault(); selectElement(element.id); deleteSelected(); } if (event.key === 'ArrowLeft') { event.preventDefault(); selectElement(element.id); nudge(-1, 0); } if (event.key === 'ArrowRight') { event.preventDefault(); selectElement(element.id); nudge(1, 0); } if (event.key === 'ArrowUp') { event.preventDefault(); selectElement(element.id); nudge(0, -1); } if (event.key === 'ArrowDown') { event.preventDefault(); selectElement(element.id); nudge(0, 1); } }} style={elementStyle(element)}>{element.type === 'image' && typeof element.props.mediaId === 'string' ? <PptManagedImagePreview projectId={projectId} outcomeId={outcomeId} mediaId={element.props.mediaId} displayName={typeof element.props.displayName === 'string' ? element.props.displayName : '已生成图片'} crop={readImageCrop(element.props.crop)} /> : <span>{String(element.props.text ?? elementLabel(element.type))}</span>}{selectedElementId === element.id && !element.locked && <button type="button" className="ppt-element__resize" aria-label="拖动调整大小" onPointerDown={(event) => beginDrag(event, element, 'resize')} />}</div>)}</div></div>
      <aside className="ppt-properties" aria-label="PPT 元素属性">{selectedElement ? <><header><div><small>已选中</small><strong>{elementLabel(selectedElement.type)}{selectedElement.locked ? ' · 已锁定' : ''}</strong></div><button type="button" onClick={deleteSelected} disabled={selectedElement.locked} title="删除元素" aria-label="删除元素"><Trash2 size={15} /></button></header><section><label>内容 / 说明<input aria-label="元素内容" value={String(selectedElement.props.text ?? '')} disabled={selectedElement.locked} onChange={(event) => updateContent(event.target.value)} /></label></section>{selectedElement.type === 'image' && <section className="ppt-properties__image"><span>图片交互属性</span><div className="ppt-properties__image-grid"><label>旋转（度）<input aria-label="图片旋转角度" type="number" min="-360" max="360" step="1" value={typeof selectedElement.props.rotationDeg === 'number' && Number.isFinite(selectedElement.props.rotationDeg) ? selectedElement.props.rotationDeg : 0} disabled={selectedElement.locked} onChange={(event) => updateSelectedProps({ rotationDeg: Math.max(-360, Math.min(360, Number(event.target.value) || 0)) })} /></label><label>透明度（%）<input aria-label="图片透明度" type="number" min="0" max="100" step="1" value={typeof selectedElement.props.opacity === 'number' && Number.isFinite(selectedElement.props.opacity) ? Math.round(Math.max(0, Math.min(1, selectedElement.props.opacity)) * 100) : 100} disabled={selectedElement.locked} onChange={(event) => updateImageOpacity(event.target.value)} /></label><label>蒙版<select aria-label="图片蒙版" value={selectedElement.props.mask === 'roundRect' || selectedElement.props.mask === 'ellipse' || selectedElement.props.mask === 'triangle' ? selectedElement.props.mask : 'rect'} disabled={selectedElement.locked} onChange={(event) => updateSelectedProps({ mask: event.target.value })}><option value="rect">矩形</option><option value="roundRect">圆角矩形</option><option value="ellipse">椭圆</option><option value="triangle">三角形</option></select></label></div><div className="ppt-properties__image-flips"><label><input aria-label="水平翻转" type="checkbox" checked={selectedElement.props.flipH === true} disabled={selectedElement.locked} onChange={(event) => updateSelectedProps({ flipH: event.target.checked })} />水平翻转</label><label><input aria-label="垂直翻转" type="checkbox" checked={selectedElement.props.flipV === true} disabled={selectedElement.locked} onChange={(event) => updateSelectedProps({ flipV: event.target.checked })} />垂直翻转</label></div><div className="ppt-properties__crop"><span>裁切（图片边缘百分比）</span>{(['left', 'top', 'right', 'bottom'] as const).map((part) => <label key={part}>{part === 'left' ? '左' : part === 'top' ? '上' : part === 'right' ? '右' : '下'}<input aria-label={`图片裁切${part === 'left' ? '左' : part === 'top' ? '上' : part === 'right' ? '右' : '下'}`} type="number" min="0" max="99" step="1" value={Math.round(readImageCrop(selectedElement.props.crop)[part] * 100)} disabled={selectedElement.locked} onChange={(event) => updateImageCrop(part, event.target.value)} /></label>)}</div><p className="ppt-properties__draft-status" role="status">{hasUnsavedChanges ? '图片属性已写入当前 PPT 草稿；点击“保存”创建新版本。' : '图片属性已保存到当前版本。'}</p></section>}<section className="ppt-properties__colors"><span>元素样式</span><div><label>填充色<input aria-label="填充色" type="color" value={colorValue(selectedElement.props.fillColor, themeColor('primary', '#236c91'))} disabled={selectedElement.locked} onChange={(event) => updateSelectedProps({ fillColor: event.target.value })} /></label><label>边框颜色<input aria-label="边框颜色" type="color" value={colorValue(selectedElement.props.borderColor, '#7d96a7')} disabled={selectedElement.locked} onChange={(event) => updateSelectedProps({ borderColor: event.target.value })} /></label><label>边框宽度<input aria-label="边框宽度" type="number" min="0" max="12" value={typeof selectedElement.props.borderWidth === 'number' ? selectedElement.props.borderWidth : 1} disabled={selectedElement.locked} onChange={(event) => updateSelectedProps({ borderWidth: Math.max(0, Math.min(12, Number(event.target.value) || 0)) })} /></label><label>文字颜色<input aria-label="文字颜色" type="color" value={colorValue(selectedElement.props.textColor, themeColor('text', '#183b59'))} disabled={selectedElement.locked} onChange={(event) => updateSelectedProps({ textColor: event.target.value })} /></label><label>字号<input aria-label="PPT 字号" type="number" min="6" max="120" value={typeof selectedElement.props.fontSize === 'number' ? selectedElement.props.fontSize : 14} disabled={selectedElement.locked} onChange={(event) => updateSelectedProps({ fontSize: Math.max(6, Math.min(120, Number(event.target.value) || 14)) })} /></label><label>字体<input aria-label="PPT 字体" value={typeof selectedElement.props.fontFamily === 'string' ? selectedElement.props.fontFamily : ''} placeholder="继承主题" disabled={selectedElement.locked} onChange={(event) => updateSelectedProps({ fontFamily: event.target.value })} /></label></div></section><section className="ppt-properties__palette"><span>主题色板</span><div>{themeRoles.map((role) => <button key={role.key} type="button" aria-label={`应用主题${role.label}为填充色`} title={`用主题${role.label}作为填充色`} disabled={selectedElement.locked} style={{ backgroundColor: themeColor(role.key, role.fallback) }} onClick={() => updateSelectedProps({ fillColor: themeColor(role.key, role.fallback) })} />)}</div></section><section className="ppt-properties__theme"><span>文稿主题</span><div>{themeRoles.map((role) => <label key={role.key}>{role.label}<input aria-label={`主题${role.label}`} type="color" value={themeColor(role.key, role.fallback)} onChange={(event) => updateThemeColor(role.key, event.target.value)} /></label>)}</div></section><section><span>位置（Grid）</span><div className="ppt-nudge"><button type="button" aria-label="向上移动 1 Grid" disabled={selectedElement.locked} onClick={() => nudge(0, -1)}><ArrowUp size={14} /></button><button type="button" aria-label="向左移动 1 Grid" disabled={selectedElement.locked} onClick={() => nudge(-1, 0)}><ArrowLeft size={14} /></button><button type="button" aria-label="向右移动 1 Grid" disabled={selectedElement.locked} onClick={() => nudge(1, 0)}><ArrowRight size={14} /></button><button type="button" aria-label="向下移动 1 Grid" disabled={selectedElement.locked} onClick={() => nudge(0, 1)}><ArrowDown size={14} /></button></div></section><section><span>尺寸（Grid）</span><div className="ppt-size"><button type="button" aria-label="宽度减 1 Grid" disabled={selectedElement.locked} onClick={() => resize(-1, 0)}><Minus size={14} /></button><b>{selectedElement.width} × {selectedElement.height}</b><button type="button" aria-label="宽度加 1 Grid" disabled={selectedElement.locked} onClick={() => resize(1, 0)}><Plus size={14} /></button><button type="button" aria-label="高度加 1 Grid" disabled={selectedElement.locked} onClick={() => resize(0, 1)}><Maximize2 size={14} /></button></div></section><section className="ppt-properties__actions"><button type="button" disabled={selectedElement.locked} onClick={duplicateSelected}><Copy size={14} />复制</button><button type="button" disabled={selectedElement.locked} onClick={() => setLayer('front')}>置于顶层</button><button type="button" disabled={selectedElement.locked} onClick={() => setLayer('back')}>置于底层</button><button type="button" onClick={toggleLock}>{selectedElement.locked ? '解除锁定' : '锁定'}</button></section><p className="ppt-properties__unsupported">渐变、多选分组和复杂矢量编辑暂不支持；图片媒体仅接受当前 codec 可验证的 PNG/JPEG 与安全 SVG，GIF/WebP 会明确降级为占位；安全 SVG 只作为媒体处理，不提供矢量编辑。</p></> : <div className="ppt-properties__empty"><Move size={20} /><p>选择一个元素后，可用鼠标拖拽、右下角缩放或按 Grid 精确编辑。</p></div>}</aside>
    </div>
    {selectedElement?.type === 'image' && <section className="ppt-image-generator" aria-label="AI 图片生成"><header><div><strong>AI 图片生成</strong><small>目标：{selectedElement.width} × {selectedElement.height} Grid。生成后先关联当前草稿，保存才创建版本。</small></div></header><label>图片提示词<textarea aria-label="PPT 图片生成提示词" value={imageGenerationPrompt} onChange={(event) => setImageGenerationPrompt(event.target.value)} placeholder="例如：与当前研究主题一致的克制信息图插图" disabled={isImageGenerating || hasUnsavedChanges || selectedElement.locked} /></label><label>质量<select aria-label="PPT 图片生成质量" value={imageGenerationQuality} onChange={(event) => setImageGenerationQuality(event.target.value as typeof imageGenerationQuality)} disabled={isImageGenerating || hasUnsavedChanges || selectedElement.locked}><option value="standard">标准</option><option value="hd">高清</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label><button className="primary" type="button" onClick={() => void generateSelectedImage()} disabled={isImageGenerating || hasUnsavedChanges || selectedElement.locked || !imageGenerationPrompt.trim()}>{isImageGenerating ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}生成并关联图片</button>{hasUnsavedChanges && <p role="status">当前 PPT 有未保存编辑；先保存版本后才能生成图片。</p>}{selectedElement.locked && <p role="status">当前图片元素已锁定；解除锁定后才能关联新媒体。</p>}{isImageGenerating && <p role="status">生成中。当前桥接未提供取消请求能力，不能伪称已取消。</p>}<p className="ppt-image-generator__export-boundary">PPTX 导出仅对已持久化且通过校验的 PNG/JPEG 与安全 SVG 生成真实图片；GIF/WebP 会明确降级为占位，SVG 不提供矢量编辑。</p></section>}
  </div>;
}

function PptManagedImagePreview({ projectId, outcomeId, mediaId, displayName, crop }: { projectId: string; outcomeId: string; mediaId: string; displayName: string; crop: { left: number; top: number; right: number; bottom: number } }) {
  const [preview, setPreview] = useState<{ mediaId: string; url: string | null } | null>(null); const url = preview?.mediaId === mediaId ? preview.url : null;
  useEffect(() => { let current = true; if (!window.metis?.readOutcomeMedia) return () => { current = false; }; void window.metis.readOutcomeMedia({ projectId, outcomeId, mediaId }).then((value) => { if (current) setPreview({ mediaId, url: typeof value === 'string' ? value : null }); }).catch(() => { if (current) setPreview({ mediaId, url: null }); }); return () => { current = false; }; }, [mediaId, outcomeId, projectId]);
  const visibleWidth = Math.max(0.01, 1 - crop.left - crop.right);
  const visibleHeight = Math.max(0.01, 1 - crop.top - crop.bottom);
  const imageStyle: React.CSSProperties = { width: `${100 / visibleWidth}%`, height: `${100 / visibleHeight}%`, maxWidth: 'none', maxHeight: 'none', position: 'relative', left: `${-crop.left / visibleWidth * 100}%`, top: `${-crop.top / visibleHeight * 100}%` };
  return url ? <img className="ppt-element__managed-image" style={imageStyle} src={url} alt={displayName} /> : <span>{displayName}（预览加载中）</span>;
}

export { PptStudioEditor };
