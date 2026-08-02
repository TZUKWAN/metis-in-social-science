/**
 * Knowledge Graph Page — interactive visualization of paper relationships.
 * Uses ReactFlow to display citation networks, co-authorship, and topic clustering.
 * All colors use CSS variables for light/dark theme support.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow, Background, Controls, MiniMap,
  useNodesState, useEdgesState,
  type Node, type Edge, type NodeTypes, MarkerType,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { useMetisStore, type PaperItem } from '../store';
import { useTranslation } from '../i18n';
import { getPaperRecommendations, recommendationToPlain } from '@engine/research/SemanticScholarClient.js';

const NODE_WIDTH = 200;

// Category colors: resolved from CSS variables at runtime for SVG compatibility
const CATEGORY_CSS_VARS: Record<string, string> = {
  'deep-learning': '--chart-1',
  'transformer': '--chart-2',
  'nlp': '--chart-3',
  'computer-vision': '--chart-4',
  'rl': '--chart-5',
  'optimization': '--chart-6',
  'generative': '--chart-7',
  'default': '--chart-8',
};

const CATEGORY_FALLBACKS: Record<string, string> = {
  'deep-learning': '#3b82f6', 'transformer': '#8b5cf6', 'nlp': '#06b6d4',
  'computer-vision': '#f59e0b', 'rl': '#ef4444', 'optimization': '#22c55e',
  'generative': '#ec4899', 'default': '#64748b',
};

function useCategoryColors(): Record<string, string> {
  const [colors, setColors] = useState<Record<string, string>>(CATEGORY_FALLBACKS);

  useEffect(() => {
    function readColors() {
      const s = getComputedStyle(document.documentElement);
      const resolved: Record<string, string> = {};
      for (const [key, cssVar] of Object.entries(CATEGORY_CSS_VARS)) {
        const v = s.getPropertyValue(cssVar).trim();
        resolved[key] = v || CATEGORY_FALLBACKS[key]!;
      }
      setColors(resolved);
    }
    readColors();
    const observer = new MutationObserver(readColors);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  return colors;
}

interface GraphData { nodes: Node[]; edges: Edge[]; }

function buildGraph(papers: PaperItem[], categoryColors: Record<string, string>, unknownAuthorLabel: string): GraphData {
  if (papers.length === 0) return { nodes: [], edges: [] };

  const nodes: Node[] = papers.map((paper, index) => {
    const primaryTag = paper.tags[0] ?? 'default';
    const color = categoryColors[primaryTag] ?? categoryColors['default']!;
    const angle = (2 * Math.PI * index) / papers.length;
    const radius = Math.max(200, papers.length * 30);
    return {
      id: paper.id, type: 'paperNode',
      position: { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius },
      data: { label: paper.title.length > 40 ? paper.title.slice(0, 40) + '...' : paper.title, authors: paper.authors[0] ?? unknownAuthorLabel, year: paper.year, tags: paper.tags, rating: paper.rating, readStatus: paper.readStatus, color },
      style: { width: NODE_WIDTH, background: `${color}15`, border: `2px solid ${color}`, borderRadius: 8, padding: 8, fontSize: 12 },
    };
  });

  const edges: Edge[] = [];
  for (let i = 0; i < papers.length; i++) {
    for (let j = i + 1; j < papers.length; j++) {
      const a = papers[i]!, b = papers[j]!;
      const sharedTags = a.tags.filter((tag) => b.tags.includes(tag));
      const sharedAuthors = a.authors.filter((author) => b.authors.some((au) => au.toLowerCase() === author.toLowerCase()));
      const strength = sharedTags.length + sharedAuthors.length * 2;
      if (strength === 0) continue;
      const color = categoryColors[sharedTags[0] ?? 'default'] ?? categoryColors['default']!;
      edges.push({
        id: `${a.id}-${b.id}`, source: a.id, target: b.id,
        label: sharedTags.length > 0 ? sharedTags.join(', ') : undefined,
        style: { stroke: color, strokeWidth: Math.min(strength * 1.5, 6), opacity: 0.6 },
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 15, height: 15 },
        animated: strength >= 3,
      });
    }
  }

  // Add citation-based edges (year ordering + DOI cross-reference)
  for (let i = 0; i < papers.length; i++) {
    for (let j = i + 1; j < papers.length; j++) {
      const earlier = papers[i]!.year <= papers[j]!.year ? papers[i]! : papers[j]!;
      const later = earlier === papers[i]! ? papers[j]! : papers[i]!;
      if (later.year <= earlier.year) continue;

      const hasDoiRef = (earlier.doi && later.abstract.toLowerCase().includes(earlier.doi.toLowerCase())) ||
        (later.doi && earlier.abstract.toLowerCase().includes(later.doi.toLowerCase()));
      const hasArxivRef = (earlier.arxivId && later.abstract.toLowerCase().includes(earlier.arxivId.toLowerCase())) ||
        (later.arxivId && earlier.abstract.toLowerCase().includes(later.arxivId.toLowerCase()));
      const hasTitleRef = later.abstract.toLowerCase().includes(earlier.title.toLowerCase().slice(0, 40));

      if (hasDoiRef || hasArxivRef || hasTitleRef) {
        const citeColor = categoryColors['default'] ?? '#64748b';
        edges.push({
          id: `cite-${earlier.id}-${later.id}`,
          source: later.id, target: earlier.id,
          label: 'cites',
          style: { stroke: citeColor, strokeWidth: 1.5, strokeDasharray: '5,5', opacity: 0.7 },
          animated: false,
        });
      }
    }
  }

  // Add explicit reference edges from paper.referenceIds
  const paperIdSet = new Set(papers.map((p) => p.id));
  for (const paper of papers) {
    for (const refId of paper.referenceIds) {
      if (!paperIdSet.has(refId)) continue;
      const citeColor = categoryColors['default'] ?? '#64748b';
      edges.push({
        id: `ref-${paper.id}-${refId}`,
        source: paper.id,
        target: refId,
        label: 'cites',
        style: { stroke: citeColor, strokeWidth: 1.5, opacity: 0.8 },
        markerEnd: { type: MarkerType.ArrowClosed, color: citeColor, width: 12, height: 12 },
        animated: false,
      });
    }
  }

  return { nodes, edges };
}

function PaperNode({ data }: { data: Node['data'] }) {
  const d = data as { label: string; authors: string; year: number; tags: string[]; rating: number; readStatus: string; color: string };
  const tagColors = useCategoryColors();
  return (
    <div style={{ background: `${d.color}10`, border: `2px solid ${d.color}`, borderRadius: 8, padding: '6px 10px', width: NODE_WIDTH, cursor: 'pointer' }}>
      <div style={{ fontWeight: 600, fontSize: 11, lineHeight: 1.3, color: 'var(--text-primary)' }}>{d.label}</div>
      <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 2 }}>{d.authors} · {d.year}</div>
      <div style={{ display: 'flex', gap: 3, marginTop: 3, flexWrap: 'wrap' }}>
        {d.tags.slice(0, 3).map((tag: string) => {
          const c = tagColors[tag] ?? tagColors['default']!;
          return (
            <span key={tag} style={{ fontSize: 9, padding: '1px 5px', borderRadius: 3, background: `${c}20`, color: c }}>{tag}</span>
          );
        })}
      </div>
      {d.rating > 0 && (
        <div className="rating-display" style={{ marginTop: 2 }}>
          {Array.from({ length: 5 }, (_, i) => (
            <span key={i} className={`rating-dot ${i < d.rating ? 'filled' : ''}`} />
          ))}
        </div>
      )}
    </div>
  );
}

const nodeTypes: NodeTypes = { paperNode: PaperNode };

export default function KnowledgeGraphPage() {
  const { papers, addPaperReference } = useMetisStore();
  const { t } = useTranslation();
  const [layoutMode, setLayoutMode] = useState<'circular' | 'tags'>('circular');
  const [loadingCitations, setLoadingCitations] = useState(false);
  const [citationNotice, setCitationNotice] = useState<string | null>(null);
  const categoryColors = useCategoryColors();
  const graphData = useMemo(() => buildGraph(papers, categoryColors, t('papers.unknownAuthor')), [papers, categoryColors, t]);
  const [nodes, setNodes, onNodesChange] = useNodesState(graphData.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(graphData.edges);

  useEffect(() => { setNodes(graphData.nodes); setEdges(graphData.edges); }, [graphData, setNodes, setEdges]);

  const applyTagLayout = useCallback(() => {
    const tagGroups = new Map<string, Node[]>();
    const updated = nodes.map((n) => ({ ...n }));
    for (const node of updated) {
      const tags = (node.data as { tags: string[] })?.tags ?? [];
      const primaryTag = tags[0] ?? 'default';
      if (!tagGroups.has(primaryTag)) tagGroups.set(primaryTag, []);
      tagGroups.get(primaryTag)!.push(node);
    }
    let groupIndex = 0;
    for (const [, groupNodes] of tagGroups) {
      const cx = Math.cos((2 * Math.PI * groupIndex) / tagGroups.size) * 300;
      const cy = Math.sin((2 * Math.PI * groupIndex) / tagGroups.size) * 300;
      groupNodes.forEach((node, i) => { node.position = { x: cx + Math.cos((2 * Math.PI * i) / groupNodes.length) * 100, y: cy + Math.sin((2 * Math.PI * i) / groupNodes.length) * 100 }; });
      groupIndex++;
    }
    setNodes(updated);
  }, [nodes, setNodes]);

  /** Fetch real citation edges from Semantic Scholar for every paper that has
   * a DOI or arXiv id, and persist discovered in-library references through the
   * store so buildGraph's reference-edge block renders them. This replaces the
   * heuristic abstract-string "cites" edges with authoritative data. */
  const loadRealCitations = useCallback(async () => {
    const normalizeDoi = (doi?: string) => doi ? doi.toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').trim() : '';
    const normalizeArxiv = (id?: string) => id ? id.toLowerCase().trim() : '';
    // Index library papers by normalized identifier for fast matching.
    const byDoi = new Map<string, PaperItem>();
    const byArxiv = new Map<string, PaperItem>();
    for (const paper of papers) {
      const doi = normalizeDoi(paper.doi);
      const arxiv = normalizeArxiv(paper.arxivId);
      if (doi) byDoi.set(doi, paper);
      if (arxiv) byArxiv.set(arxiv, paper);
    }

    setLoadingCitations(true);
    setCitationNotice(null);
    let added = 0;
    let checked = 0;
    try {
      for (const paper of papers) {
        if (!paper.doi && !paper.arxivId) continue;
        checked++;
        const paperId = paper.doi ? `DOI:${paper.doi}` : `ARXIV:${paper.arxivId}`;
        // type 'references' returns the papers THIS paper cites.
        const result = await getPaperRecommendations({ paperId, type: 'references', limit: 50 });
        for (const raw of result.data) {
          const plain = recommendationToPlain(raw);
          if (!plain) continue;
          const refDoi = normalizeDoi(plain.doi as string | undefined);
          const refArxiv = normalizeArxiv(plain.arxivId as string | undefined);
          const matched = (refDoi && byDoi.get(refDoi)) || (refArxiv && byArxiv.get(refArxiv));
          // Only record edges between papers already in the library, and skip
          // self-references. addPaperReference(source, target) = source cites target.
          if (matched && matched.id !== paper.id) {
            if (!paper.referenceIds.includes(matched.id)) {
              await addPaperReference(paper.id, matched.id);
              added++;
            }
          }
        }
      }
      setCitationNotice(t('graph.citationsLoaded', { added, checked }));
    } catch (err) {
      setCitationNotice(t('graph.citationsError', { error: String(err) }));
    } finally {
      setLoadingCitations(false);
    }
  }, [papers, addPaperReference, t]);

  return (
    <div className="graph-page">
      <div className="graph-toolbar">
        <h2>{t('graph.pageTitle')}</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            className="btn-toggle"
            onClick={loadRealCitations}
            disabled={loadingCitations || papers.length === 0}
            title={t('graph.loadCitationsTooltip')}
          >
            {loadingCitations ? t('graph.loadCitationsRunning') : t('graph.loadCitations')}
          </button>
          <button
            className={`btn-toggle ${layoutMode === 'circular' ? 'active' : ''}`}
            onClick={() => setLayoutMode('circular')}
          >{t('graph.layoutCircular')}</button>
          <button
            className={`btn-toggle ${layoutMode === 'tags' ? 'active' : ''}`}
            onClick={() => { setLayoutMode('tags'); applyTagLayout(); }}
          >{t('graph.layoutByTags')}</button>
        </div>
      </div>
      {citationNotice && (
        <div style={{ padding: '6px 16px', fontSize: 12, color: 'var(--text-secondary)', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border)' }}>
          {citationNotice}
        </div>
      )}
      {papers.length === 0 ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="empty-state">
            <h3>{t('graph.emptyTitle')}</h3>
            <p>{t('graph.emptyDescription')}</p>
          </div>
        </div>
      ) : (
        <div className="graph-canvas">
          <ReactFlow nodes={nodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} nodeTypes={nodeTypes} fitView attributionPosition="bottom-left">
            <Background /><Controls />
            <MiniMap nodeStrokeWidth={2} nodeColor={(node) => { const d = node.data as { color?: string }; return d?.color ?? categoryColors['default']!; }} />
          </ReactFlow>
        </div>
      )}
      <div className="graph-legend">
        {Object.entries(categoryColors).filter(([key]) => key !== 'default').map(([tag, color]) => (
          <div key={tag} className="legend-item">
            <div className="legend-dot" style={{ background: color }} />
            <span>{tag}</span>
          </div>
        ))}
        <div className="legend-stats">{t('graph.legendStats', { papers: papers.length, connections: graphData.edges.length })}</div>
      </div>
    </div>
  );
}
