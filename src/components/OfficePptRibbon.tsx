import { useState, type ReactNode } from 'react';
import { AlignCenter, AlignLeft, AlignRight, BarChart3, Copy, Eye, Image as ImageIcon, LayoutTemplate, Plus, Save, Square, Table2, Trash2, Type, X } from 'lucide-react';
import type { PptDocument } from '../../engine/runtime/OutcomeRuntimeContract';
import { addPptElement, deletePptPage, duplicatePptPage, pptDocumentStats, updatePptElementProps } from './OfficePptOperations';
import { OfficeRibbon, type OfficeRibbonTab } from './OfficeRibbon';

type PptElement = PptDocument['pages'][number]['elements'][number];
type PptElementType = PptElement['type'];

type Props = Readonly<{
  document: PptDocument;
  pageIndex: number;
  selectedElementId?: string;
  onChange: (document: PptDocument) => void;
  onSave: () => void;
  onSelectPage: (index: number, pageId?: string) => void;
  onSelectElement: (elementId?: string) => void;
  onNotice: (notice: string) => void;
}>;

interface GordenTemplate {
  slug: string;
  name: string;
  slideCount: number;
  roles: string[];
}

/**
 * Gorden 模板库对话框（2026-09-11 刘总要求：把 GordenPPTSkill 集成进
 * METIS Office 的 PPT）。选模板 → 填标题与要点 → 主进程执行技能构建 →
 * 产物转成 METIS PPT 文档载入当前 Office 画布（保存后即成成果版本）。
 */
function GordenTemplateDialog({ onClose, onApply, onNotice }: { onClose: () => void; onApply: (document: PptDocument, fileName: string) => void; onNotice: (notice: string) => void }) {
  const [templates, setTemplates] = useState<GordenTemplate[] | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [pointsText, setPointsText] = useState('');
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadTemplates = () => {
    void window.metis?.gordenPptListTemplates?.().then((result) => {
      if (result?.ok) {
        setTemplates(result.templates ?? []);
        if (result.cloned) onNotice('Gorden PPT 技能包首次下载完成。');
      } else {
        setError(result?.message ?? '模板清单加载失败。');
        setTemplates([]);
      }
    }).catch((loadError: unknown) => {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
      setTemplates([]);
    });
  };
  if (templates === null && !error) loadTemplates();

  const build = () => {
    if (!selectedSlug || !title.trim() || building) return;
    setBuilding(true);
    setError(null);
    const points = pointsText.split('\n').map((line) => line.trim()).filter(Boolean);
    void window.metis?.gordenPptBuildFromBrief?.({ slug: selectedSlug, title: title.trim(), points, maxSlides: 3 }).then((result) => {
      setBuilding(false);
      if (result?.ok && result.document) {
        onApply(result.document as PptDocument, result.fileName ?? 'gorden-deck.pptx');
        onClose();
      } else {
        setError(result?.message ?? '构建未完成。');
      }
    }).catch((buildError: unknown) => {
      setBuilding(false);
      setError(buildError instanceof Error ? buildError.message : String(buildError));
    });
  };

  return (
    <div className="mui-dialog-overlay modal-overlay" role="presentation" onClick={(event) => { if (event.target === event.currentTarget && !building) onClose(); }}>
      <div className="mui-dialog mui-dialog--lg" role="dialog" aria-modal="true" aria-label="Gorden 模板库">
        <div className="mui-dialog__header">
          <h2 id="mui-dialog-title" className="mui-dialog__title">Gorden 模板库（生成真实 .pptx 后载入 Office）</h2>
          <button type="button" className="mui-dialog__close" onClick={onClose} disabled={building} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="mui-dialog__body">
          {templates === null && !error && <p role="status">正在准备技能包与模板清单（首次使用需下载约 100MB，请稍候）…</p>}
          {error && <p role="alert" style={{ color: 'var(--status-failed)' }}>{error}</p>}
          {templates !== null && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 8, maxHeight: 260, overflowY: 'auto', marginBottom: 12 }}>
                {templates.map((template) => (
                  <button
                    key={template.slug}
                    type="button"
                    className={`office-ribbon__text-control${selectedSlug === template.slug ? ' is-active' : ''}`}
                    style={{ textAlign: 'left', border: '1px solid var(--border)', borderRadius: 6, padding: 8 }}
                    onClick={() => setSelectedSlug(template.slug)}
                    aria-pressed={selectedSlug === template.slug}
                  >
                    <strong style={{ display: 'block', fontSize: 13 }}>{template.name}</strong>
                    <small style={{ color: 'var(--text-secondary)' }}>{template.slug} · {template.slideCount} 页</small>
                  </button>
                ))}
              </div>
              <label style={{ display: 'block', marginBottom: 8 }}>演示文稿标题
                <input value={title} onChange={(event) => setTitle(event.target.value)} style={{ display: 'block', width: '100%', marginTop: 4 }} placeholder="例如：METIS 科研工作台介绍" />
              </label>
              <label style={{ display: 'block', marginBottom: 8 }}>要点（每行一条，将循环填充正文文本位）
                <textarea value={pointsText} onChange={(event) => setPointsText(event.target.value)} rows={4} style={{ display: 'block', width: '100%', marginTop: 4 }} placeholder={'可执行场景：工作流即代码\n真实文献检索：DOI 逐条核验\n成果与投稿：Office 编辑 + 参谋选刊'} />
              </label>
              <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0 }}>取模板前 3 页生成；产物为真实 .pptx（保留模板排版，只替换文字），载入后可在 Office 继续编辑，保存即创建成果版本。模板为第三方非商业授权。</p>
            </>
          )}
        </div>
        <div className="mui-dialog__footer">
          <button type="button" className="office-ribbon__text-control" onClick={onClose} disabled={building}>取消</button>
          <button type="button" className="office-ribbon__text-control" style={{ color: 'var(--accent)', borderColor: 'var(--accent)' }} disabled={building || !selectedSlug || !title.trim()} onClick={build}>
            {building ? '构建中…（首次需下载技能包）' : '生成并载入 Office'}
          </button>
        </div>
      </div>
    </div>
  );
}

function controlButton(label: string, onClick: () => void, disabled = false, active = false, icon?: ReactNode) {
  return <button type="button" className={`office-ribbon__control${active ? ' is-active' : ''}`} aria-label={label} title={label} onClick={onClick} disabled={disabled}>{icon ?? label}</button>;
}

export function OfficePptRibbon({ document, pageIndex, selectedElementId, onChange, onSave, onSelectPage, onSelectElement, onNotice }: Props) {
  const [activeTab, setActiveTab] = useState('home');
  const [gordenDialogOpen, setGordenDialogOpen] = useState(false);
  const page = document.pages[pageIndex] ?? document.pages[0];
  const selected = page?.elements.find((element) => element.id === selectedElementId);
  const stats = pptDocumentStats(document);
  const addElement = (type: PptElementType) => {
    const next = addPptElement(document, pageIndex, type);
    const added = next.pages[pageIndex]?.elements.at(-1);
    onChange(next);
    onSelectElement(added?.id);
  };
  const addSlide = () => {
    let index = document.pages.length + 1;
    let id = `slide-${index}`;
    while (document.pages.some((candidate) => candidate.id === id)) id = `slide-${++index}`;
    const nextPage: PptDocument['pages'][number] = { id, title: `第 ${document.pages.length + 1} 页`, pageType: 'content', humanModified: true, status: 'draft', elements: [] };
    const next = { ...document, pages: [...document.pages, nextPage] };
    onChange(next);
    onSelectPage(next.pages.length - 1, nextPage.id);
  };
  const updateSelected = (patch: Record<string, unknown>) => {
    if (!selected) return;
    onChange(updatePptElementProps(document, pageIndex, selected.id, patch));
  };
  const updateTheme = (key: 'primary' | 'accent' | 'surface' | 'text', color: string) => onChange({ ...document, theme: { ...document.theme, [key]: color } });
  const tabs: OfficeRibbonTab[] = [
    {
      id: 'home', label: '开始', groups: [
         { id: 'slides', label: '幻灯片', content: <div className="office-ribbon__controls"><button type="button" className="office-ribbon__text-control" onClick={addSlide}><Plus size={16} />新建幻灯片</button><button type="button" className="office-ribbon__text-control" onClick={() => { const next = duplicatePptPage(document, pageIndex); onChange(next); onSelectPage(pageIndex + 1, next.pages[pageIndex + 1]?.id); }}><Copy size={16} />复制幻灯片</button>{controlButton('删除幻灯片', () => { const next = deletePptPage(document, pageIndex); const nextIndex = Math.max(0, pageIndex - 1); onChange(next); onSelectPage(nextIndex, next.pages[nextIndex]?.id); }, document.pages.length <= 1, false, <Trash2 size={16} />)}</div> },
        { id: 'editing', label: '编辑', content: <div className="office-ribbon__controls"><button type="button" className="office-ribbon__text-control" onClick={() => addElement('text')}><Type size={16} />文本</button><button type="button" className="office-ribbon__text-control" onClick={() => addElement('rect')}><Square size={16} />矩形</button><button type="button" className="office-ribbon__text-control" onClick={() => addElement('table')}><Table2 size={16} />表格</button><button type="button" className="office-ribbon__text-control" onClick={() => onNotice(selected?.type === 'image' ? '请在右侧“AI 图片生成”面板输入提示词。' : '请先选择一个图片占位元素，再生成图片。')}><ImageIcon size={16} />AI 图片</button>{controlButton('保存', onSave, false, false, <Save size={16} />)}<button type="button" className={`office-ribbon__control${document.ratio === '16:9' ? ' is-active' : ''}`} onClick={() => onChange({ ...document, ratio: '16:9' })}>16:9</button><button type="button" className={`office-ribbon__control${document.ratio === '4:3' ? ' is-active' : ''}`} onClick={() => onChange({ ...document, ratio: '4:3' })}>4:3</button><span className="office-ribbon__hint">{document.ratio} · {page?.elements.length ?? 0} 个元素</span></div> },
      ],
    },
    {
      id: 'insert', label: '插入', groups: [
        { id: 'text', label: '文本', content: <div className="office-ribbon__controls"><button type="button" className="office-ribbon__text-control" onClick={() => addElement('text')}><Type size={16} />文本</button><button type="button" className="office-ribbon__text-control" onClick={() => addElement('table')}><Table2 size={16} />表格</button></div> },
        { id: 'shapes', label: '形状与媒体', content: <div className="office-ribbon__controls"><button type="button" className="office-ribbon__text-control" onClick={() => addElement('rect')}><Square size={16} />矩形</button><button type="button" className="office-ribbon__text-control" onClick={() => addElement('image')}><ImageIcon size={16} />图片占位</button><button type="button" className="office-ribbon__text-control" onClick={() => addElement('chart')}><BarChart3 size={16} />图表</button></div> },
      ],
    },
    {
      id: 'design', label: '设计', groups: [
        { id: 'ratio', label: '页面设置', content: <div className="office-ribbon__controls"><button type="button" className={`office-ribbon__control${document.ratio === '16:9' ? ' is-active' : ''}`} onClick={() => onChange({ ...document, ratio: '16:9' })}>16:9</button><button type="button" className={`office-ribbon__control${document.ratio === '4:3' ? ' is-active' : ''}`} onClick={() => onChange({ ...document, ratio: '4:3' })}>4:3</button></div> },
        { id: 'gorden', label: 'Gorden 模板', content: <div className="office-ribbon__controls"><button type="button" className="office-ribbon__text-control" onClick={() => setGordenDialogOpen(true)} data-testid="office-gorden-template"><LayoutTemplate size={16} />Gorden 模板库</button><span className="office-ribbon__hint">用 21 套中文模板生成真实 .pptx 并载入编辑</span></div> },
        { id: 'theme', label: '主题颜色', content: <div className="office-ribbon__controls office-ribbon__controls--font">{(['primary', 'accent', 'surface', 'text'] as const).map((key) => <label key={key} className="office-ribbon__color-control"><span>{key === 'primary' ? '主色' : key === 'accent' ? '强调' : key === 'surface' ? '画布' : '正文'}</span><input aria-label={`主题${key}`} type="color" value={typeof document.theme[key] === 'string' ? String(document.theme[key]) : '#236c91'} onChange={(event) => updateTheme(key, event.target.value)} /></label>)}</div> },
      ],
    },
    {
      id: 'transitions', label: '切换', groups: [
        { id: 'transition-status', label: '幻灯片切换', content: <div className="office-ribbon__status-card"><strong>结构化切换</strong><span>切换参数将在真实演示导出能力可用后写入。</span></div> },
      ],
    },
    {
      id: 'animations', label: '动画', groups: [
        { id: 'animation-status', label: '对象动画', content: <div className="office-ribbon__status-card"><strong>{selected ? '已选中对象' : '未选中对象'}</strong><span>当前编辑器保留对象与层级，不伪造未支持的动画效果。</span><button type="button" className="office-ribbon__text-control" onClick={() => onNotice('当前 PPT 编辑器暂不写入动画效果；本次没有修改成果。')}>查看支持边界</button></div> },
      ],
    },
    {
      id: 'review', label: '审阅', groups: [
        { id: 'review-status', label: '校验', content: <div className="office-ribbon__status-card"><strong>METIS 版本治理</strong><span>保存后才创建人工 PPT 版本，生成服务仍走主进程。</span></div> },
      ],
    },
    {
      id: 'view', label: '视图', groups: [
        { id: 'statistics', label: '演示文稿统计', content: <div className="office-ribbon__status-card"><strong>{stats.slides} 页 · {stats.elements} 个对象</strong><span>{stats.text} 文本 · {stats.images} 图片 · {stats.charts} 图表</span></div> },
        { id: 'selected', label: '选中对象', content: <div className="office-ribbon__status-card"><Eye size={16} /><span>{selected ? `${selected.type} · ${selected.id}` : '未选中对象'}</span></div> },
      ],
    },
  ];
  const tabsWithSelection: OfficeRibbonTab[] = selected
    ? tabs.map((tab) => tab.id === 'home' ? { ...tab, groups: [...tab.groups, { id: 'format', label: '对象格式', content: <div className="office-ribbon__controls office-ribbon__controls--font"><input aria-label="对象字号" type="number" min="6" max="120" value={typeof selected.props.fontSize === 'number' ? selected.props.fontSize : 18} onChange={(event) => updateSelected({ fontSize: Number(event.target.value) || 18 })} />{controlButton('左对齐', () => updateSelected({ align: 'left' }), false, selected.props.align === 'left', <AlignLeft size={15} />)}{controlButton('居中对齐', () => updateSelected({ align: 'center' }), false, selected.props.align === 'center', <AlignCenter size={15} />)}{controlButton('右对齐', () => updateSelected({ align: 'right' }), false, selected.props.align === 'right', <AlignRight size={15} />)}</div> }] } : tab)
    : tabs;
  return <>
    <OfficeRibbon tabs={tabsWithSelection} activeTab={activeTab} onTabChange={setActiveTab} />
    {gordenDialogOpen && (
      <GordenTemplateDialog
        onClose={() => setGordenDialogOpen(false)}
        onApply={(document, fileName) => { onChange(document); onNotice(`Gorden 模板「${fileName}」已载入 Office 画布，保存即创建成果版本。`); }}
        onNotice={onNotice}
      />
    )}
  </>;
}
