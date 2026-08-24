/**
 * Seed an example research project on first run (O10, "引导即内容").
 *
 * Instead of a bare onboarding tour, METIS pre-populates one example project
 * with real public-domain content (a well-known arXiv paper + a starter note)
 * so new users can see what a live project looks like. The whole bundle is
 * deletable — deleting it is the natural "done with onboarding" signal.
 *
 * The seed runs once per profile (guarded by a localStorage flag) and is
 * non-blocking: failures are swallowed so onboarding never breaks.
 */

import { useMetisStore } from '../store';
import { researchWorkspaceStore } from '../research/researchWorkspaceStore';

const SEED_FLAG_KEY = 'metis-example-seeded';

export function shouldSeedExample(): boolean {
  try {
    return !localStorage.getItem(SEED_FLAG_KEY);
  } catch {
    return false;
  }
}

export function markExampleSeeded(): void {
  try { localStorage.setItem(SEED_FLAG_KEY, '1'); } catch { /* best-effort */ }
}

/** The public-domain example paper (Vaswani et al. 2017 — widely known). */
const EXAMPLE_PAPER = {
  id: 'example-paper-attention',
  title: 'Attention Is All You Need',
  authors: ['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar', 'Jakob Uszkoreit'],
  year: 2017,
  venue: 'NeurIPS 2017',
  abstract:
    'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder. The best performing models also connect the encoder and decoder through an attention mechanism. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms...',
  doi: '10.48550/arXiv.1706.03762',
  tags: ['example', 'transformer', 'attention'],
  notes: '',
  readStatus: 'unread' as const,
  rating: 0,
  pdfUrl: 'https://arxiv.org/pdf/1706.03762.pdf',
  referenceIds: [] as string[],
  addedAt: 0,
};

const EXAMPLE_NOTE = {
  id: 'example-note-transformer',
  title: '示例：阅读笔记 — Transformer 要点',
  content: `# 示例笔记：Transformer 核心思想

这是 METIS 预置的示例笔记，演示如何把文献、笔记和项目组织在一起。

## 关键点
- 纯注意力机制替代 RNN/CNN 做序列转导
- Self-Attention 捕捉长程依赖，可并行计算
- 多头注意力（Multi-Head Attention）在不同子空间同时学习

## 下一步
- 读附录的复杂度分析
- 对比 LSTM 在长序列任务上的表现

*你可以随时删除这个示例项目。*`,
  tags: ['example'],
  linkedPaperIds: ['example-paper-attention'],
  linkedNoteIds: [] as string[],
  updatedAt: 0,
};

/** Seed one example project + paper + note. Idempotent (guarded by flag). */
export async function seedExampleProject(): Promise<{ ok: boolean; skipped: boolean }> {
  if (!shouldSeedExample()) return { ok: true, skipped: true };
  try {
    const store = researchWorkspaceStore.getState();
    const created = await store.createProject({
      projectId: 'example-project-transformer',
      title: '示例：注意力机制文献研究',
      originalIntent: '演示一个研究项目如何组织文献、笔记和成果',
      researchQuestion: 'Transformer 如何替代循环网络做序列建模？',
      discipline: '机器学习',
    });
    if (!created.success) return { ok: false, skipped: false };

    const now = Date.now();
    const metis = useMetisStore.getState();
    await metis.addPaper({ ...EXAMPLE_PAPER, addedAt: now });
    await metis.addNote({ ...EXAMPLE_NOTE, updatedAt: now });

    markExampleSeeded();
    return { ok: true, skipped: false };
  } catch {
    // Never break onboarding on seed failure.
    return { ok: false, skipped: false };
  }
}
