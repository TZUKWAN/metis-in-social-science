/**
 * OutcomeWorkbenchPanel — 成果工作台右侧面板（任务书 Phase 13，T13.05–T13.10 的落地）。
 *
 * 固定 Tabs：协作 | 论证 | 审查 | 证据 | 历史（T13.05）。Tab 偏好按 Outcome 持久化。
 *  - 协作（T07.01/07.02/07.03）：成果记忆（手工编辑 + revision 并发检查）+ AI 记忆提议（接受/拒绝）。
 *  - 论证（T10.02/10.03）：Argument Graph 分层结构视图（无伪精确分数；AI inferred 显式标注）。
 *  - 审查（T08）：审查模式选择 + 结构化 Issue 列表（severity 分组；resolved/ignored 显式操作）。
 *  - 证据（T11.04/T11.05）：Claim–Evidence 投影（权威数据只读，附来源定位信息）。
 *  - 历史（T13.10）：修改建议（Revision Sets）+ 快照（恢复到草稿）。
 * 正式版本仍在下方「版本」面板——快照/修订/版本三组分列（T13.10）。
 */
import { useCallback, useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';

type TabKey = 'collaboration' | 'argument' | 'review' | 'evidence' | 'history';

const TAB_LABELS: Record<TabKey, string> = {
  collaboration: '协作', argument: '论证', review: '审查', evidence: '证据', history: '历史',
};
const VERIFICATION_LABELS: Record<string, string> = {
  verified: '已验证', supported: '有支持', unverified: '未验证', rejected: '已否决',
};
const ISSUE_STATUS_LABELS: Record<string, string> = {
  open: '待处理', in_progress: '处理中', resolved: '已解决', ignored: '已忽略', stale: '已过期',
};
const REVIEW_MODES: Array<{ key: string; label: string }> = [
  { key: 'full', label: '完整审查' }, { key: 'argument', label: '论证逻辑' },
  { key: 'evidence', label: '证据与引用' }, { key: 'theory', label: '理论框架' },
  { key: 'method', label: '方法' }, { key: 'structure', label: '结构' },
  { key: 'language', label: '语言' }, { key: 'submission_check', label: '投稿前检查' },
];

interface MemoryShape {
  goal: string; audience: string; venueTarget: string;
  coreJudgments: string[]; terminology: Array<{ preferred: string; avoid?: string[]; note?: string }>;
  writingRules: string[]; confirmedDecisions: string[]; rejectedApproaches: string[]; unresolvedIssues: string[];
  revision: number;
}
interface MemoryProposalShape {
  id: string; field: string; value: unknown; reason: string; status: string; createdAt: number;
}
interface RevisionSetShape { id: string; instruction: string; createdBy: string; status: string; createdAt: number }
interface IssueShape {
  id: string; category: string; severity: string; title: string; explanation: string;
  anchor: { kind: string; blockId?: string; pageId?: string } | null;
  status: string; baseDraftHash: string;
}
interface ArgumentProjection {
  layers: Array<{ layer: number; nodes: Array<{ id: string; kind: string; label: string; verificationStatus: string; provenance: string; description?: string }> }>;
  edges: Array<{ id: string; sourceNodeId: string; targetNodeId: string; relation: string; verificationStatus: string; provenance: string }>;
  unverifiedCount: number;
}
interface ClaimEvidenceProjection {
  claims: Array<{ id: string; statement: string; claimType: string; status: string; supports: number; contradicts: number; qualifies: number }>;
  evidences: Array<{ id: string; snippet: string; sourceTitle: string | null; anchorType: string; pageNumber: number | null }>;
  links: Array<{ id: string; claimId: string; evidenceId: string; relation: string }>;
}

const tabStorageKey = (outcomeId: string): string => `metis:outcomes2-tab:${outcomeId}`;

export function OutcomeWorkbenchPanel({ projectId, outcomeId, onNotice, onDraftUpdated }: {
  projectId: string;
  outcomeId: string;
  onNotice?: (notice: string) => void;
  /** 接受修订后通知宿主刷新草稿内容。 */
  onDraftUpdated?: () => void;
}) {
  const [tab, setTab] = useState<TabKey>(() => {
    try { const saved = window.localStorage.getItem(tabStorageKey(outcomeId)); if (saved && ['collaboration', 'argument', 'review', 'evidence', 'history'].includes(saved)) return saved as TabKey; } catch { /* ignore */ }
    return 'collaboration';
  });
  const selectTab = useCallback((next: TabKey) => {
    setTab(next);
    try { window.localStorage.setItem(tabStorageKey(outcomeId), next); } catch { /* best-effort */ }
  }, [outcomeId]);

  return (
    <section className="workbench-panel" data-testid="workbench-panel" aria-label="成果工作台面板">
      <nav className="workbench-panel__tabs" role="tablist" aria-label="工作台面板">
        {(Object.keys(TAB_LABELS) as TabKey[]).map((key) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key}
            className={tab === key ? 'workbench-panel__tab active' : 'workbench-panel__tab'}
            onClick={() => selectTab(key)}>
            {TAB_LABELS[key]}
          </button>
        ))}
      </nav>
      {tab === 'collaboration' && <MemoryPanel projectId={projectId} outcomeId={outcomeId} onNotice={onNotice} />}
      {tab === 'argument' && <ArgumentGraphView projectId={projectId} />}
      {tab === 'review' && <ReviewPanel projectId={projectId} outcomeId={outcomeId} onNotice={onNotice} />}
      {tab === 'evidence' && <ClaimEvidenceView projectId={projectId} />}
      {tab === 'history' && <HistoryPanel projectId={projectId} outcomeId={outcomeId} onNotice={onNotice} onDraftUpdated={onDraftUpdated} />}
    </section>
  );
}

// ── 协作：成果记忆（T07.01/07.02/07.03） ────────────────────────────────
function MemoryPanel({ projectId, outcomeId, onNotice }: { projectId: string; outcomeId: string; onNotice?: (notice: string) => void }) {
  const [memory, setMemory] = useState<MemoryShape | null>(null);
  const [proposals, setProposals] = useState<MemoryProposalShape[]>([]);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftGoal, setDraftGoal] = useState('');
  const [draftRules, setDraftRules] = useState('');

  const load = useCallback(async () => {
    setMemory((await window.metis?.outcome2MemoryGet?.({ projectId, outcomeId })) as MemoryShape | null);
    setProposals(((await window.metis?.outcome2MemoryListProposals?.({ projectId, outcomeId, status: 'pending' })) ?? []) as MemoryProposalShape[]);
  }, [projectId, outcomeId]);
  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async () => {
    if (!memory) return;
    setBusy(true);
    try {
      const next: MemoryShape = {
        ...memory,
        goal: draftGoal,
        writingRules: draftRules.split('\n').map((line) => line.trim()).filter((line) => line.length > 0),
      };
      const result = await window.metis?.outcome2MemorySave?.({ ...next, projectId, outcomeId });
      if (result?.ok) { setMemory(result.value as MemoryShape); setEditing(false); onNotice?.('成果记忆已保存。'); }
      else { onNotice?.(result?.code === 'outcome_memory_revision_conflict' ? '记忆已被其他窗口更新，请刷新后再保存。' : '记忆保存失败。'); void load(); }
    } finally { setBusy(false); }
  }, [memory, draftGoal, draftRules, projectId, outcomeId, onNotice, load]);

  const decide = useCallback(async (proposalId: string, accept: boolean) => {
    setBusy(true);
    try {
      if (accept) {
        const result = await window.metis?.outcome2MemoryAcceptProposal?.({ projectId, proposalId });
        if (result?.ok) setMemory(result.value as MemoryShape);
      } else {
        await window.metis?.outcome2MemoryRejectProposal?.({ projectId, proposalId });
      }
      await load();
    } finally { setBusy(false); }
  }, [projectId, load]);

  return (
    <div className="workbench-memory" data-testid="memory-panel">
      <header className="workbench-panel__section-head">
        <strong>成果记忆</strong>
        {memory && !editing && <button type="button" className="workbench-panel__btn" onClick={() => { setEditing(true); setDraftGoal(memory.goal); setDraftRules(memory.writingRules.join('\n')); }}>编辑</button>}
        {memory && !editing && <span className="workbench-panel__meta">记忆版本 r{memory.revision}</span>}
      </header>
      {!memory && <p className="workbench-panel__empty">还没有成果记忆。编辑后保存，或在对话中让 AI 提议要记住的内容（需你确认）。</p>}
      {memory && !editing && (
        <dl className="workbench-memory__fields">
          <dt>成果目标</dt><dd>{memory.goal || '—'}</dd>
          <dt>目标读者</dt><dd>{memory.audience || '—'}</dd>
          <dt>目标期刊/场景</dt><dd>{memory.venueTarget || '—'}</dd>
          <dt>写作规范</dt>
          <dd>{memory.writingRules.length > 0 ? <ul>{memory.writingRules.map((rule) => <li key={rule}>{rule}</li>)}</ul> : '—'}</dd>
          <dt>关键术语</dt>
          <dd>{memory.terminology.length > 0 ? <ul>{memory.terminology.map((term) => <li key={term.preferred}>{term.preferred}{term.avoid && term.avoid.length > 0 ? `（避免：${term.avoid.join('、')}）` : ''}</li>)}</ul> : '—'}</dd>
        </dl>
      )}
      {memory && editing && (
        <div className="workbench-memory__editor">
          <label>成果目标<textarea rows={2} value={draftGoal} onChange={(event) => setDraftGoal(event.target.value)} /></label>
          <label>写作规范（每行一条）<textarea rows={4} value={draftRules} onChange={(event) => setDraftRules(event.target.value)} /></label>
          <div className="workbench-panel__actions">
            <button type="button" className="workbench-panel__btn workbench-panel__btn--primary" disabled={busy} onClick={() => void save()}>保存记忆</button>
            <button type="button" className="workbench-panel__btn" onClick={() => setEditing(false)}>取消</button>
          </div>
        </div>
      )}
      <header className="workbench-panel__section-head"><strong>AI 记忆提议</strong><span className="workbench-panel__meta">需你确认后才会写入</span></header>
      {proposals.length === 0 && <p className="workbench-panel__empty">暂无待确认提议。</p>}
      <ul className="workbench-memory__proposals">
        {proposals.map((proposal) => (
          <li key={proposal.id}>
            <div><code>{proposal.field}</code>：{typeof proposal.value === 'string' ? proposal.value : JSON.stringify(proposal.value)?.slice(0, 200)}</div>
            {proposal.reason && <small>原因：{proposal.reason}</small>}
            <div className="workbench-panel__actions">
              <button type="button" className="workbench-panel__btn workbench-panel__btn--primary" disabled={busy} onClick={() => void decide(proposal.id, true)}>接受</button>
              <button type="button" className="workbench-panel__btn" disabled={busy} onClick={() => void decide(proposal.id, false)}>拒绝</button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── 论证：分层结构视图（T10.02/T10.03） ────────────────────────────────
function ArgumentGraphView({ projectId }: { projectId: string }) {
  const [projection, setProjection] = useState<ArgumentProjection | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void window.metis?.outcome2GraphProjectArgument?.({ projectId }).then((value) => {
      if (alive) setProjection(value as ArgumentProjection | null);
    }).catch(() => { if (alive) setProjection(null); });
    return () => { alive = false; };
  }, [projectId]);
  if (!projection) return <p className="workbench-panel__empty">论证图谱尚未生成。可在正文中把关键判断标记为论断，或在对话中让 AI 提取论证结构。</p>;
  const nodeById = new Map(projection.layers.flatMap((layer) => layer.nodes).map((node) => [node.id, node]));
  return (
    <div className="workbench-argument" data-testid="argument-graph">
      {projection.unverifiedCount > 0 && (
        <p className="workbench-panel__meta">其中 {projection.unverifiedCount} 个节点为 AI 提取 · 未验证（确认后会标记为「有支持」）。</p>
      )}
      {projection.layers.map((layer) => (
        <section key={layer.layer} className="workbench-argument__layer">
          <header>{layer.layer === 0 ? '概念与理论' : layer.layer === 1 ? '论断与方法' : '结论层'}</header>
          <ul>
            {layer.nodes.map((node) => (
              <li key={node.id}>
                <button type="button" className={selected === node.id ? 'active' : ''} onClick={() => setSelected(node.id === selected ? null : node.id)}>
                  {node.label}
                  <span className={`workbench-panel__pill workbench-panel__pill--${node.verificationStatus}`}>
                    {VERIFICATION_LABELS[node.verificationStatus] ?? node.verificationStatus}
                    {node.provenance === 'ai_extracted' ? ' · AI' : ''}
                  </span>
                </button>
                {selected === node.id && (
                  <div className="workbench-argument__detail">
                    <small>类型：{node.kind} · 来源：{node.provenance === 'ai_extracted' ? 'AI 提取（未验证）' : node.provenance}</small>
                    {node.description && <p>{node.description}</p>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {projection.edges.length > 0 && (
        <section className="workbench-argument__edges">
          <header>关系（{projection.edges.length}）</header>
          <ul>
            {projection.edges.slice(0, 30).map((edge) => (
              <li key={edge.id}>
                {nodeById.get(edge.sourceNodeId)?.label ?? '…'} <b>{edge.relation}</b> {nodeById.get(edge.targetNodeId)?.label ?? '…'}
                <span className={`workbench-panel__pill workbench-panel__pill--${edge.verificationStatus}`}>{VERIFICATION_LABELS[edge.verificationStatus] ?? edge.verificationStatus}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ── 审查（T08.01/08.02/08.06/08.08） ───────────────────────────────────
function ReviewPanel({ projectId, outcomeId, onNotice }: { projectId: string; outcomeId: string; onNotice?: (notice: string) => void }) {
  const [mode, setMode] = useState('full');
  const [running, setRunning] = useState(false);
  const [issues, setIssues] = useState<IssueShape[]>([]);
  const [lastRun, setLastRun] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIssues(((await window.metis?.outcome2ReviewListIssues?.({ projectId, outcomeId })) ?? []) as IssueShape[]);
  }, [projectId, outcomeId]);
  useEffect(() => { void load(); }, [load]);

  const start = useCallback(async () => {
    setRunning(true);
    onNotice?.('审查进行中：按章节分段检查…');
    try {
      const result = await window.metis?.outcome2ReviewRun?.({ projectId, outcomeId, mode: mode as 'full' });
      if (result?.ok) {
        setLastRun(`本次审查：${result.segments} 个分段，${result.issues} 个问题。`);
      } else {
        setLastRun(null);
        onNotice?.(result?.code === 'unsupported_kind' ? '当前成果类型暂不支持自动分段审查。' : '审查未完成，请重试。');
      }
      await load();
    } finally { setRunning(false); }
  }, [projectId, outcomeId, mode, onNotice, load]);

  const updateStatus = useCallback(async (issueId: string, status: 'resolved' | 'ignored' | 'in_progress') => {
    await window.metis?.outcome2ReviewIssueUpdate?.({ projectId, issueId, status });
    await load();
  }, [projectId, load]);

  const open = issues.filter((issue) => issue.status === 'open' || issue.status === 'in_progress');
  const bySeverity = (severity: string) => open.filter((issue) => issue.severity === severity);

  return (
    <div className="workbench-review" data-testid="review-panel">
      <header className="workbench-panel__section-head">
        <select aria-label="审查模式" value={mode} onChange={(event) => setMode(event.target.value)}>
          {REVIEW_MODES.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
        </select>
        <button type="button" className="workbench-panel__btn workbench-panel__btn--primary" data-testid="review-start" disabled={running} onClick={() => void start()}>
          {running ? <LoaderCircle size={13} className="spin" /> : null} 审查成果
        </button>
      </header>
      {lastRun && <p className="workbench-panel__meta" role="status">{lastRun} 生成的是审查意见（判断），不是事实结论。</p>}
      <div className="workbench-review__summary">
        <span>严重 {bySeverity('critical').length}</span>
        <span>重要 {bySeverity('major').length}</span>
        <span>次要 {bySeverity('minor').length}</span>
      </div>
      <ul className="workbench-review__list">
        {open.map((issue) => (
          <li key={issue.id} className={`workbench-review__item workbench-review__item--${issue.severity}`}>
            <header>
              <b>{issue.title}</b>
              <span className="workbench-panel__pill">{issue.severity === 'critical' ? '严重' : issue.severity === 'major' ? '重要' : '次要'} · {issue.category}</span>
            </header>
            {issue.explanation && <p>{issue.explanation}</p>}
            <small>{issue.anchor ? `定位：${issue.anchor.blockId ?? issue.anchor.pageId ?? '—'}` : '全文级问题（无具体定位）'}</small>
            <div className="workbench-panel__actions">
              <button type="button" className="workbench-panel__btn" onClick={() => void updateStatus(issue.id, 'resolved')}>标记已解决</button>
              <button type="button" className="workbench-panel__btn" onClick={() => void updateStatus(issue.id, 'ignored')}>忽略</button>
            </div>
          </li>
        ))}
        {open.length === 0 && <li className="workbench-panel__empty">暂无待处理审查问题。</li>}
      </ul>
    </div>
  );
}

// ── 证据（T11.04/T11.05） ──────────────────────────────────────────────
function ClaimEvidenceView({ projectId }: { projectId: string }) {
  const [projection, setProjection] = useState<ClaimEvidenceProjection | null>(null);
  useEffect(() => {
    let alive = true;
    void window.metis?.outcome2GraphProjectClaimEvidence?.({ projectId }).then((value) => {
      if (alive) setProjection(value as ClaimEvidenceProjection | null);
    }).catch(() => { if (alive) setProjection(null); });
    return () => { alive = false; };
  }, [projectId]);
  if (!projection || projection.claims.length === 0) {
    return <p className="workbench-panel__empty">本项目还没有可展示的论断-证据关系。文献步骤产出的论断与证据会出现在这里。</p>;
  }
  const evidenceById = new Map(projection.evidences.map((evidence) => [evidence.id, evidence]));
  return (
    <div className="workbench-evidence" data-testid="claim-evidence-view">
      <ul>
        {projection.claims.map((claim) => {
          const related = projection.links.filter((link) => link.claimId === claim.id);
          return (
            <li key={claim.id} className="workbench-evidence__claim">
              <strong>{claim.statement}</strong>
              <small>{claim.claimType} · {claim.status} · 支持 {claim.supports} / 反证 {claim.contradicts} / 限定 {claim.qualifies}</small>
              <ul>
                {related.map((link) => {
                  const evidence = evidenceById.get(link.evidenceId);
                  return (
                    <li key={link.id}>
                      <span className={`workbench-panel__pill workbench-panel__pill--${link.relation === 'supports' ? 'accepted' : link.relation === 'contradicts' ? 'rejected' : ''}`}>
                        {link.relation === 'supports' ? '支持' : link.relation === 'contradicts' ? '反证' : '限定'}
                      </span>
                      {evidence ? `${evidence.snippet.slice(0, 120)}${evidence.sourceTitle ? `（${evidence.sourceTitle}${evidence.pageNumber ? ` 第 ${evidence.pageNumber} 页` : ''}）` : ''}` : link.evidenceId}
                    </li>
                  );
                })}
                {related.length === 0 && <li className="workbench-panel__empty">该论断还没有挂接证据。</li>}
              </ul>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── 历史（T13.10）：修改建议 + 快照（正式版本在下方版本面板） ────────────
function HistoryPanel({ projectId, outcomeId, onNotice, onDraftUpdated }: {
  projectId: string; outcomeId: string; onNotice?: (notice: string) => void; onDraftUpdated?: () => void;
}) {
  const [sets, setSets] = useState<RevisionSetShape[]>([]);
  const [snapshots, setSnapshots] = useState<Array<{ id: string; reason: string; createdAt: number }>>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setSets(((await window.metis?.outcome2RevisionListSets?.({ projectId, outcomeId })) ?? []) as RevisionSetShape[]);
    setSnapshots(((await window.metis?.outcome2SnapshotList?.({ projectId, outcomeId })) ?? []) as Array<{ id: string; reason: string; createdAt: number }>);
  }, [projectId, outcomeId]);
  useEffect(() => { void load(); }, [load]);

  const restore = useCallback(async (snapshotId: string) => {
    setBusyId(snapshotId);
    try {
      const result = await window.metis?.outcome2SnapshotRestore?.({ projectId, snapshotId });
      if (result?.ok) { onNotice?.('已从快照恢复到工作草稿；正式版本未变化。'); onDraftUpdated?.(); }
      else onNotice?.('快照恢复未完成。');
    } finally { setBusyId(null); }
  }, [projectId, onNotice, onDraftUpdated]);

  const STATUS: Record<string, string> = { pending: '待定', partially_accepted: '部分接受', accepted: '已接受', rejected: '已拒绝', stale: '已过期', cancelled: '已取消' };

  return (
    <div className="workbench-history" data-testid="workbench-history">
      <header className="workbench-panel__section-head"><strong>修改建议</strong><span className="workbench-panel__meta">{sets.length} 组</span></header>
      <ul className="workbench-history__sets">
        {sets.map((set) => (
          <li key={set.id}>
            <b>{STATUS[set.status] ?? set.status}</b>
            <span>{set.instruction?.slice(0, 60) || '（无指令）'}</span>
            <small>{new Date(set.createdAt).toLocaleString('zh-CN', { hour12: false })} · {set.createdBy === 'ai' ? 'AI' : set.createdBy === 'review_issue' ? '审查' : set.createdBy === 'conversation' ? '对话' : '手动'}</small>
          </li>
        ))}
        {sets.length === 0 && <li className="workbench-panel__empty">还没有修订提案。</li>}
      </ul>
      <header className="workbench-panel__section-head"><strong>快照</strong><span className="workbench-panel__meta">{snapshots.length} 个（自动保留最近 50）</span></header>
      <ul className="workbench-history__snapshots">
        {snapshots.slice(0, 20).map((snapshot) => (
          <li key={snapshot.id}>
            <span>{snapshot.reason === 'manual' ? '手动' : '自动'} · {new Date(snapshot.createdAt).toLocaleString('zh-CN', { hour12: false })}</span>
            <button type="button" className="workbench-panel__btn" disabled={busyId === snapshot.id} onClick={() => void restore(snapshot.id)}>恢复到草稿</button>
          </li>
        ))}
        {snapshots.length === 0 && <li className="workbench-panel__empty">还没有快照。</li>}
      </ul>
      <p className="workbench-panel__meta">正式版本见下方「版本」面板；快照恢复只写草稿，不产生版本。</p>
    </div>
  );
}
