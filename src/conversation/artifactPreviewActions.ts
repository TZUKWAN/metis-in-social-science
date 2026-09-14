/**
 * 生成物预览动作（2026-09-13 拆分）。
 *
 * 从 ChatPage 迁出：预览内容/标题/来源生成物状态、openPreview、
 * handleArtifactClick（项目成果与会话生成物两条打开路径）、
 * outcomeDocumentToPreviewMarkdown（结构化成果文档 → 预览 Markdown）
 * 以及 ArtifactPreviewPane 的 onChartAdjust / onExportDocx 接线。
 * 会话代际校验与生成物列表刷新等宿主回调通过 deps 显式注入，
 * 纯移动，行为语义不变。
 */
import { useCallback, useState, type RefObject } from 'react';
import type { RightPanelTab } from '../components/RightPanel';

type Locale = 'zh' | 'en';

/** Session-owned artifact backing the current preview; required for durable chart revisions. */
export interface PreviewArtifactRef {
  sessionId: string;
  artifactId: string;
}

/**
 * 结构化成果文档 → 可内嵌预览的 Markdown（2026-08-28 刘总要求：生成物点击
 * 即刻预览）。Word/PPT 提取文本；PDF/表格等二进制文档返回 null，交给
 * Metis Office 打开。
 */
export function outcomeDocumentToPreviewMarkdown(content: unknown, locale: Locale): string | null {
  if (!content || typeof content !== 'object') return null;
  const doc = content as { type?: string };
  if (doc.type === 'word') {
    const word = content as {
      type: 'word';
      blocks?: Array<{ kind?: string; text?: string; level?: number; rows?: string[][] }>;
      header?: string;
      footer?: string;
    };
    const lines: string[] = [];
    for (const block of word.blocks ?? []) {
      if (block.kind === 'table' && Array.isArray(block.rows)) {
        const [head, ...rest] = block.rows;
        if (head?.length) {
          lines.push(`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`);
          for (const row of rest) lines.push(`| ${(row ?? []).join(' | ')} |`);
        }
        continue;
      }
      const text = (block.text ?? '').trim();
      if (!text) continue;
      if (block.kind === 'heading') lines.push(`${'#'.repeat(Math.min(6, Math.max(1, block.level ?? 1)))} ${text}`);
      else lines.push(text);
    }
    return lines.length > 0 ? lines.join('\n\n') : null;
  }
  if (doc.type === 'ppt') {
    const ppt = content as {
      type: 'ppt';
      pages?: Array<{ title?: string; elements?: Array<{ type?: string; props?: Record<string, unknown> }> }>;
    };
    const lines: string[] = [];
    (ppt.pages ?? []).forEach((page, index) => {
      const title = (page.title ?? '').trim();
      lines.push(`## ${index + 1}. ${title || (locale === 'zh' ? '未命名页' : 'Untitled page')}`);
      for (const element of page.elements ?? []) {
        if (element.type !== 'text') continue;
        const text = String(element.props?.text ?? '').trim();
        if (text) lines.push(text);
      }
    });
    return lines.length > 0 ? lines.join('\n\n') : null;
  }
  return null;
}

export interface ArtifactPreviewDeps {
  locale: Locale;
  activeSessionIdRef: RefObject<string>;
  sessionGenerationRef: RefObject<number>;
  activeResearchProjectId: string | null;
  isCurrentSessionGeneration: (sessionId: string, generation: number) => boolean;
  /** run 结算/图表重做后刷新生成物列表（宿主持有 artifacts 列表状态）。 */
  refreshArtifactsForSession: (sessionId: string, generation: number) => Promise<void>;
  /** 错误条状态由宿主持有（生成物列表刷新同样写它）。 */
  setArtifactError: (error: string) => void;
  setActiveRightPanelTab: (tab: RightPanelTab) => void;
}

export function useArtifactPreview(deps: ArtifactPreviewDeps) {
  const {
    locale,
    activeSessionIdRef,
    sessionGenerationRef,
    activeResearchProjectId,
    isCurrentSessionGeneration,
    refreshArtifactsForSession,
    setArtifactError,
    setActiveRightPanelTab,
  } = deps;

  const [previewContent, setPreviewContent] = useState('');
  const [previewTitle, setPreviewTitle] = useState('');
  const [previewArtifact, setPreviewArtifact] = useState<PreviewArtifactRef | null>(null);

  const openPreview = useCallback((
    content: string,
    title = locale === 'zh' ? 'AI 生成预览' : 'AI-generated preview',
    artifact?: PreviewArtifactRef | null,
  ) => {
    setPreviewContent(content);
    setPreviewTitle(title);
    setPreviewArtifact(artifact ?? null);
    setArtifactError('');
    setActiveRightPanelTab('artifacts');
  }, [locale, setArtifactError, setActiveRightPanelTab]);

  /** 会话切换时清空全部预览状态（含宿主的错误条）。 */
  const resetPreview = useCallback(() => {
    setPreviewContent('');
    setPreviewTitle('');
    setPreviewArtifact(null);
    setArtifactError('');
  }, [setArtifactError]);

  /** 预览栏 × 按钮：只收起内容，保留来源记录为空。 */
  const closePreview = useCallback(() => {
    setPreviewContent('');
    setPreviewArtifact(null);
  }, []);

  async function handleArtifactClick(
    item: { id: string; name: string; contentAvailable: boolean },
  ) {
    const sessionId = activeSessionIdRef.current;
    const generation = sessionGenerationRef.current;
    // 项目成果：点击立即预览。文本型文档内嵌渲染；PDF/表格用 Metis Office 打开。
    if (item.id.startsWith('outcome:')) {
      const outcomeId = item.id.slice('outcome:'.length);
      const getOutcome = window.metis?.getOutcome;
      if (!activeResearchProjectId || !getOutcome) return;
      setArtifactError('');
      try {
        const detail = await getOutcome({ projectId: activeResearchProjectId, outcomeId });
        if (!detail) {
          setArtifactError(locale === 'zh' ? '无法打开这个成果，请稍后重试。' : 'This outcome could not be opened. Please try again.');
          return;
        }
        const content = (detail as { version?: { content?: unknown } }).version?.content;
        const markdown = outcomeDocumentToPreviewMarkdown(content, locale);
        if (markdown) {
          openPreview(markdown, item.name);
          return;
        }
        const openExternal = window.metis?.openOutcomeInGenoffice;
        if (openExternal) {
          const result = await openExternal({ projectId: activeResearchProjectId, outcomeId });
          if (result?.ok) return;
        }
        setArtifactError(locale === 'zh' ? '该成果类型暂不支持内嵌预览，Metis Office 也未能打开。' : 'This outcome type has no inline preview and Metis Office failed to open it.');
      } catch {
        setArtifactError(locale === 'zh' ? '无法打开这个成果，请稍后重试。' : 'This outcome could not be opened. Please try again.');
      }
      return;
    }
    if (!item.contentAvailable) return;
    const getArtifactContent = window.metis?.getArtifactContent;
    if (!sessionId || !getArtifactContent) return;
    setArtifactError('');
    try {
      const response = await getArtifactContent(sessionId, item.id);
      if (!isCurrentSessionGeneration(sessionId, generation)) return;
      if (!response.success || response.sessionId !== sessionId || response.id !== item.id) {
        setPreviewContent('');
        setPreviewTitle('');
        setArtifactError(locale === 'zh' ? '无法打开这个生成物，请重新选择或稍后重试。' : 'This artifact could not be opened. Please try again.');
        return;
      }
      openPreview(response.content, item.name, { sessionId, artifactId: item.id });
    } catch {
      if (!isCurrentSessionGeneration(sessionId, generation)) return;
      setPreviewContent('');
      setPreviewTitle('');
      setArtifactError(locale === 'zh' ? '无法打开这个生成物，请重新选择或稍后重试。' : 'This artifact could not be opened. Please try again.');
    }
  }

  // 图表重做仅在预览绑定会话生成物时可用（与迁出前的接线一致：
  // 没有来源生成物就不向 ArtifactPreviewPane 传该回调）。
  const onChartAdjust = previewArtifact
    ? async (chartSource: string, chartLanguage: string, instruction: string, sourceData: string): Promise<{ ok: boolean; content?: string; message?: string }> => {
      const result = await window.metis?.regenerateArtifactChart?.({
        sessionId: previewArtifact.sessionId,
        artifactId: previewArtifact.artifactId,
        chartSource,
        chartLanguage,
        instruction,
        sourceData,
      });
      if (!result?.success) {
        return {
          ok: false,
          message: result?.code === 'source_data_required'
            ? (locale === 'zh' ? '缺少原始数据，未执行图表重做。' : 'Source data is required; the chart was not regenerated.')
            : (result?.message || (locale === 'zh' ? '图表重做未完成，原生成物未改动。' : 'Chart regeneration did not complete; the original artifact is unchanged.')),
        };
      }
      // Backend stores a new session artifact + its dedicated source-data artifact
      // before returning. Only now switch the preview to the durable revision.
      setPreviewContent(result.content);
      setPreviewTitle(result.name);
      setPreviewArtifact({ sessionId: previewArtifact.sessionId, artifactId: result.artifactId });
      await refreshArtifactsForSession(previewArtifact.sessionId, sessionGenerationRef.current);
      return { ok: true, content: result.content };
    }
    : undefined;

  const onExportDocx = async (): Promise<{ ok: boolean; fileName?: string; message?: string }> => {
    const result = await window.metis?.exportMarkdownAsDocx?.({
      title: previewTitle || (locale === 'zh' ? '生成物' : 'Artifact'),
      markdown: previewContent,
    });
    return result ?? { ok: false, message: 'export unavailable' };
  };

  return {
    previewContent,
    previewTitle,
    previewArtifact,
    openPreview,
    handleArtifactClick,
    resetPreview,
    closePreview,
    onChartAdjust,
    onExportDocx,
  };
}
