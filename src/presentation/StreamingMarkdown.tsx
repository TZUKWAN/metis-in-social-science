/**
 * StreamingMarkdown — incremental markdown rendering for live-streamed
 * assistant output, adapted from deepseek-harness's IncrementalMarkdownParser
 * (dsh `packages/client/ui-primitives/src/markdown/incremental.ts`, MIT).
 *
 * Strategy:
 *  - Split the accumulated text into top-level markdown blocks using the real
 *    remark parser (remark-parse + remark-gfm, already transitive deps of
 *    react-markdown), so fenced code blocks, tables, lists and blockquotes are
 *    never split apart — correctness over a heuristic line splitter.
 *  - Each block renders through a memoized SafeMarkdown wrapper keyed by its
 *    absolute source start offset. React reconciles by key (no remount) and
 *    the memo compares the block's source by value, so a block re-renders only
 *    while its own text is still growing. This subsumes dsh's
 *    UNSTABLE_TAIL_BLOCKS = 2 freeze window: every block whose text stopped
 *    changing is effectively frozen, and in practice only the trailing 1–2
 *    blocks re-render per frame.
 *  - Non-append updates (e.g. settle replacing the draft) need no explicit
 *    cache reset: block keys are offsets and memoization is by content, so
 *    changed blocks re-render and unchanged ones stay frozen automatically.
 *  - When `streaming` flips false, the whole document renders once through
 *    the plain SafeMarkdown path so reference-style links/footnotes resolve
 *    exactly like the historical settled renderer.
 *
 * Sanitization, allowedElements and the custom link/image/code renderers all
 * stay inside SafeMarkdown — nothing is forked here.
 */
import { memo, useMemo } from 'react';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { SafeMarkdown, type SafeMarkdownMode, type SafeMarkdownProps } from './SafeMarkdown';
import type { PresentationLocale } from './executionPresentation';

interface MdastPositionShape {
  start: { offset?: number };
  end: { offset?: number };
}

interface MdastNodeShape {
  position?: MdastPositionShape;
  children?: MdastNodeShape[];
}

export interface MarkdownBlockRange {
  /** Absolute source offset where the block starts — used as the React key. */
  start: number;
  end: number;
}

// Module-level processor: the parser configuration never changes.
const blockSplitProcessor = unified().use(remarkParse).use(remarkGfm);

/**
 * Split `text` into top-level markdown block ranges with absolute offsets.
 * Any parse anomaly degrades to a single whole-document block — the output is
 * then identical to the non-incremental path.
 */
export function splitMarkdownBlocks(text: string): MarkdownBlockRange[] {
  if (!text) return [];
  try {
    const tree = blockSplitProcessor.parse(text) as unknown as MdastNodeShape;
    const ranges: MarkdownBlockRange[] = [];
    for (const node of tree.children ?? []) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (typeof start !== 'number' || typeof end !== 'number') {
        return [{ start: 0, end: text.length }];
      }
      ranges.push({ start, end });
    }
    return ranges.length > 0 ? ranges : [{ start: 0, end: text.length }];
  } catch {
    return [{ start: 0, end: text.length }];
  }
}

/**
 * One frozen-or-live block. `React.memo` compares `content` by value, so an
 * already-frozen block never re-parses even though the parent re-renders on
 * every animation frame while tokens arrive.
 */
const StreamingBlock = memo(function StreamingBlock({
  content,
  uiMode,
  locale,
  codeComponent,
  onOpenPaper,
}: {
  content: string;
  uiMode?: SafeMarkdownMode;
  locale: PresentationLocale;
  codeComponent?: SafeMarkdownProps['codeComponent'];
  onOpenPaper?: (doi: string) => void;
}) {
  return (
    <SafeMarkdown
      content={content}
      uiMode={uiMode}
      locale={locale}
      codeComponent={codeComponent}
      onOpenPaper={onOpenPaper}
    />
  );
});

export interface StreamingMarkdownProps {
  text: string;
  streaming: boolean;
  uiMode?: SafeMarkdownMode;
  locale: PresentationLocale;
  codeComponent?: SafeMarkdownProps['codeComponent'];
  onOpenPaper?: (doi: string) => void;
  /**
   * Source transform shared with the settled renderer (emoji strip + DOI
   * linkify). Applied to the whole accumulated text once per frame — a linear
   * regex pass, negligible next to the markdown parse it feeds — so streaming
   * output stays byte-identical to the settled output.
   */
  transform?: (text: string) => string;
}

const identityTransform = (value: string): string => value;

export function StreamingMarkdown({
  text,
  streaming,
  uiMode,
  locale,
  codeComponent,
  onOpenPaper,
  transform = identityTransform,
}: StreamingMarkdownProps) {
  const transformed = transform(text);
  const blocks = useMemo(() => splitMarkdownBlocks(transformed), [transformed]);

  if (!streaming) {
    return (
      <SafeMarkdown
        content={transformed}
        uiMode={uiMode}
        locale={locale}
        codeComponent={codeComponent}
        onOpenPaper={onOpenPaper}
      />
    );
  }

  return (
    <>
      {blocks.map((block) => (
        <StreamingBlock
          key={block.start}
          content={transformed.slice(block.start, block.end)}
          uiMode={uiMode}
          locale={locale}
          codeComponent={codeComponent}
          onOpenPaper={onOpenPaper}
        />
      ))}
      <span className="streaming-caret" data-testid="streaming-caret" aria-hidden="true" />
    </>
  );
}
