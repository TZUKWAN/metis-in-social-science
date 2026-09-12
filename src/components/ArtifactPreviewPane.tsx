/**
 * ArtifactPreviewPane — 生成物预览栏（2026-08-31 刘总布局重构）。
 *
 * 在科研项目页最右侧以整列呈现生成物内容：完整 Markdown 排版 + Prism
 * 代码高亮 + 全高度滚动，替代右栏里 max-height 400px 的内联小卡片。
 * 布局联动（项目清单收缩、聊天区减半）由 ProjectsPage 负责，本组件只管
 * 内容呈现与关闭。
 */
import { useState } from 'react';
import { useTranslation } from '../i18n';
import { presentArtifactName } from '../presentation/executionPresentation';
import { SafeMarkdown, type SafeMarkdownMode } from '../presentation/SafeMarkdown';
import { CodeBlock } from './CodeBlock';

export interface ArtifactPreviewPaneProps {
  title: string;
  content: string;
  uiMode: SafeMarkdownMode;
  locale: 'en' | 'zh';
  onClose: () => void;
  /** 把当前预览内容（Markdown）导出为 DOCX；由宿主接 IPC。 */
  onExportDocx?: () => Promise<{ ok: boolean; fileName?: string; message?: string }>;
  /** 2.9 图表自然语言调整：把选中的图表块、调整指令与用户确认的原始数据发回 AI 重做。 */
  onChartAdjust?: (chartSource: string, chartLanguage: string, instruction: string, sourceData: string) => Promise<{ ok: boolean; content?: string; message?: string }>;
  /** 图表随成果保存的原始数据，缺失时用户可在调整面板粘贴确认。 */
  sourceData?: string;
}

export default function ArtifactPreviewPane({ title, content, uiMode, locale, onClose, onExportDocx, onChartAdjust, sourceData }: ArtifactPreviewPaneProps) {
  const { t } = useTranslation();
  const [exporting, setExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState('');
  // 2.9 图表调整：点击图表块选中 → 弹输入框 → AI 基于原始数据重做。
  const [selectedChart, setSelectedChart] = useState<{ source: string; lang: string } | null>(null);
  const [adjustInstruction, setAdjustInstruction] = useState('');
  const [adjustSourceData, setAdjustSourceData] = useState(sourceData ?? '');
  const [adjusting, setAdjusting] = useState(false);
  const [adjustNotice, setAdjustNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const CHART_LANGS = new Set(['mermaid', 'chart', 'vega', 'vega-lite', 'echarts']);

  const handleChartCode = (lang: string) => CHART_LANGS.has(lang);

  const applyChartAdjust = async () => {
    if (!onChartAdjust || !selectedChart || !adjustInstruction.trim() || adjusting) return;
    setAdjusting(true);
    setAdjustNotice(null);
    try {
      if (!adjustSourceData.trim()) {
        setAdjustNotice({ ok: false, text: locale === 'zh' ? '请先粘贴或确认该图表的原始数据，不能从图像猜测数据。' : 'Paste or confirm the chart source data first; chart data is never inferred from pixels.' });
        return;
      }
      const result = await onChartAdjust(selectedChart.source, selectedChart.lang, adjustInstruction.trim(), adjustSourceData);
      if (result.ok && result.content) {
        setAdjustNotice({ ok: true, text: locale === 'zh' ? '图表已基于原始数据重做，并已保存为新的可追溯生成物。' : 'Chart regenerated from source data and saved as a traceable new artifact.' });
        setSelectedChart(null);
        setAdjustInstruction('');
      } else {
        setAdjustNotice({ ok: false, text: result.message || (locale === 'zh' ? '调整失败：AI 未返回可用的新图表。' : 'Adjustment failed.') });
      }
    } finally {
      setAdjusting(false);
    }
  };

  const handleExport = async () => {
    if (!onExportDocx || exporting) return;
    setExporting(true);
    setExportNotice('');
    try {
      const result = await onExportDocx();
      setExportNotice(result.ok
        ? t('previewPane.exportSuccess', { fileName: result.fileName ?? '' })
        : (result.message || t('previewPane.exportFailed', { message: 'unknown' })));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="artifact-preview-pane" data-testid="artifact-preview-pane">
      <div className="artifact-preview-pane__header">
        <span className="artifact-preview-pane__title" title={title}>
          {presentArtifactName(title, locale)}
        </span>
        {onExportDocx && (
          <button
            type="button"
            className="artifact-preview-pane__export"
            onClick={() => void handleExport()}
            disabled={exporting}
            data-testid="artifact-preview-export-docx"
          >
            {exporting ? t('previewPane.exporting') : t('previewPane.exportWord')}
          </button>
        )}
        <button
          type="button"
          className="artifact-preview-pane__close"
          onClick={onClose}
          aria-label={t('browserOverlay.close')}
          data-testid="artifact-preview-close"
        >
          ✕
        </button>
      </div>
      {exportNotice && (
        <div className="artifact-preview-pane__notice" data-testid="artifact-preview-notice">{exportNotice}</div>
      )}
      {selectedChart && onChartAdjust && (
        <div className="artifact-chart-adjust" data-testid="artifact-chart-adjust">
          <p className="artifact-chart-adjust__title">{locale === 'zh' ? '调整选中的图表（基于原始数据重做）' : 'Adjust the selected chart'}</p>
          <input
            value={adjustInstruction}
            placeholder={locale === 'zh' ? '例如：配色换成学术蓝、横纵坐标互换、图例放右侧…' : 'e.g. academic blue, swap axes…'}
            onChange={(event) => setAdjustInstruction(event.target.value)}
            data-testid="artifact-chart-adjust-input"
          />
          <textarea
            value={adjustSourceData}
            placeholder={locale === 'zh' ? '该图表的原始数据（CSV、JSON 或表格文本；必填）' : 'Raw chart data (CSV, JSON, or table text; required)'}
            onChange={(event) => setAdjustSourceData(event.target.value)}
            data-testid="artifact-chart-source-data-input"
            aria-label={locale === 'zh' ? '图表原始数据' : 'Chart source data'}
          />
          <button type="button" className="btn-sm btn-primary" disabled={!adjustInstruction.trim() || !adjustSourceData.trim() || adjusting} data-testid="artifact-chart-adjust-apply" onClick={() => void applyChartAdjust()}>
            {adjusting ? (locale === 'zh' ? '重做中…' : 'Regenerating…') : (locale === 'zh' ? '重做图表' : 'Regenerate')}
          </button>
          <button type="button" className="btn-sm btn-secondary" data-testid="artifact-chart-adjust-cancel" onClick={() => { setSelectedChart(null); setAdjustInstruction(''); setAdjustSourceData(sourceData ?? ''); }}>{locale === 'zh' ? '取消' : 'Cancel'}</button>
          {adjustNotice && <span className={adjustNotice.ok ? 'artifact-chart-adjust__ok' : 'artifact-chart-adjust__err'} role="status">{adjustNotice.text}</span>}
        </div>
      )}
      <div className="artifact-preview-pane__body">
        <SafeMarkdown
          content={content}
          uiMode={uiMode}
          locale={locale}
          codeComponent={({ className, children, ...props }) => {
            const match = /language-([\w-]+)/.exec(className || '');
            const code = String(children).replace(/\n$/, '');
            if (match && match[1]) {
              // 2.9 图表块：可点选并基于原始数据自然语言重做。
              const selectable = handleChartCode(match[1]) && Boolean(onChartAdjust);
              const chartLang = match[1];
              return (
                <div
                  className={`artifact-chart-block${selectedChart?.source === code ? ' selected' : ''}`}
                  data-testid="artifact-chart-block"
                  role="button"
                  tabIndex={0}
                  onClick={selectable ? () => setSelectedChart({ source: code, lang: chartLang }) : undefined}
                  onKeyDown={selectable ? (event) => { if (event.key === 'Enter') setSelectedChart({ source: code, lang: chartLang }); } : undefined}
                  title={selectable ? (locale === 'zh' ? '点击选中此图表，然后用自然语言调整' : 'Click to select, then adjust with natural language') : undefined}
                >
                  {selectable && <span className="artifact-chart-block__badge">{locale === 'zh' ? '图表 · 点击选中可调整' : 'Chart · click to adjust'}</span>}
                  <CodeBlock language={chartLang} code={code} />
                </div>
              );
            }
            return <code className="inline-code" {...props}>{children}</code>;
          }}
        />
      </div>
    </div>
  );
}
