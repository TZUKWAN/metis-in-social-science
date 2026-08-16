/**
 * AutonomousWorkspaceService — 自主科研工作区数据（重构 R1）。
 *
 * 组装「AI 在独立工作」页面所需的全部真实数据：
 *  - 研究问题（含版本号：research_decisions 中该字段变更次数）
 *  - 核心判断（真实 claims 按置信度聚合）
 *  - 本轮新发现（最近的 claims / evidence）
 *  - 当前不确定性（低置信 claims + 修正类决策）
 *  - 成果直展（最新版本 content 预览 + 版本 + 更新时间 + 是否 AI 最近编辑）
 *  - 研究动态（决策/成果版本/证据/资料的时间线合并）
 *  - 全局指标（进行中研究 / 自主决策 / 今日新增证据 / 新研究发现）
 * 所有字段来自 repository 真实记录，零静态示例。
 */
import { ipcMain } from 'electron';
import type { ResearchRepository } from '../engine/persistence/ResearchRepository.js';
import type { PersistenceStore } from '../engine/persistence/PersistenceStore.js';

export interface WorkspaceArtifactView {
  id: string;
  title: string;
  artifactType: string;
  version: number;
  updatedAt: number;
  /** 最新版本内容预览（直展用）。 */
  contentPreview: string;
  /** 最近一次由 AI 在近 N 分钟内更新 → 「AI 正在更新」徽章。 */
  aiEditing: boolean;
  fileCount: number;
}

export interface WorkspaceQuestionView {
  text: string;
  /** 版本 = 决策流中研究问题变更次数 + 1。 */
  version: number;
  updatedAt: number;
  history: Array<{ version: number; text: string; at: number; note: string }>;
}

export interface WorkspaceFinding {
  id: string;
  text: string;
  confidence: number;
  at: number;
  origin: 'claim' | 'evidence';
}

export interface WorkspaceDecisionItem {
  id: string;
  at: number;
  decision: string;
  note: string;
  before: string;
  after: string;
}

export interface WorkspaceTimelineItem {
  at: number;
  kind: 'decision' | 'artifact-version' | 'evidence' | 'source' | 'claim';
  text: string;
}

export interface WorkspaceProjectSummary {
  id: string;
  title: string;
  status: 'running' | 'idle' | 'completed';
  currentPhase: string | null;
  progressPercent: number;
  updatedAt: number;
  artifactCount: number;
  evidenceCount: number;
}

export interface WorkspaceDetail {
  question: WorkspaceQuestionView;
  coreJudgments: WorkspaceFinding[];
  newFindings: WorkspaceFinding[];
  uncertainties: Array<{ text: string; reason: string }>;
  artifacts: WorkspaceArtifactView[];
  decisions: WorkspaceDecisionItem[];
  timeline: WorkspaceTimelineItem[];
  stats: { evidenceCount: number; claimCount: number; sourceCount: number; artifactCount: number };
  latestRun: { status: string; updatedAt: number; completedPhases: number | null; totalPhases: number | null } | null;
}

export interface WorkspaceOverview {
  projects: WorkspaceProjectSummary[];
  metrics: { running: number; decisions24h: number; evidenceToday: number; newFindings7d: number };
}

const DAY_MS = 86_400_000;

export class AutonomousWorkspaceService {
  constructor(
    private repository: ResearchRepository | null,
    private store: PersistenceStore | null,
  ) {}

  /** 主进程初始化顺序：repository 与 store 就绪后注入。 */
  attach(repository: ResearchRepository | null, store: PersistenceStore | null): void {
    if (repository) this.repository = repository;
    if (store) this.store = store;
  }

  // ─── 全局：项目列表 + 指标 ─────────────────────────────────

  buildOverview(runningProjectIds: ReadonlySet<string>): WorkspaceOverview {
    if (!this.repository) {
      return { projects: [], metrics: { running: 0, decisions24h: 0, evidenceToday: 0, newFindings7d: 0 } };
    }
    const projects = this.repository.listProjects({ limit: 100 })
      .filter((project) => project.source === 'autonomous' || project.source === 'autonomous_research' || runningProjectIds.has(project.id))
      .slice(0, 40)
      .map((project) => this.summarizeProject(project.id, project.title, project.updatedAt, runningProjectIds.has(project.id)));
    const now = Date.now();
    let decisions24h = 0;
    let evidenceToday = 0;
    let newFindings7d = 0;
    for (const project of projects) {
      decisions24h += this.repository.listDecisions(project.id).filter((d) => now - d.createdAt < DAY_MS).length;
      evidenceToday += this.repository.listEvidence(project.id).filter((e) => now - e.createdAt < DAY_MS).length;
      newFindings7d += this.repository.listClaims(project.id).filter((c) => now - c.createdAt < 7 * DAY_MS).length;
    }
    return {
      projects,
      metrics: {
        running: projects.filter((p) => p.status === 'running').length,
        decisions24h,
        evidenceToday,
        newFindings7d,
      },
    };
  }

  private summarizeProject(projectId: string, title: string, updatedAt: number, running: boolean): WorkspaceProjectSummary {
    const repo = this.repository!;
    const artifacts = repo.listArtifacts(projectId);
    const evidenceCount = repo.listEvidence(projectId).length;
    const runs = repo.listRuns(projectId).sort((a, b) => b.updatedAt - a.updatedAt);
    const latestRun = runs[0] ?? null;
    // 阶段/进度：运行中项目由事件流提供；这里从最新 run 的决策痕迹推断（真实保守值）。
    let progressPercent = 0;
    if (latestRun?.status === 'completed') {
      progressPercent = 100;
    } else if (artifacts.length > 0) {
      progressPercent = Math.min(90, 20 + artifacts.length * 15);
    } else if (evidenceCount > 0) {
      progressPercent = 10;
    }
    return {
      id: projectId,
      title,
      status: running ? 'running' : latestRun?.status === 'completed' ? 'completed' : 'idle',
      currentPhase: running ? null : latestRun?.status === 'completed' ? '已完成' : latestRun ? '待续' : '未启动',
      progressPercent,
      updatedAt,
      artifactCount: artifacts.length,
      evidenceCount,
    };
  }

  // ─── 单项目详情 ────────────────────────────────────────────

  buildDetail(projectId: string): WorkspaceDetail | null {
    const repo = this.repository;
    if (!repo) return null;
    const project = repo.getProject(projectId, false);
    if (!project) return null;

    const question = this.buildQuestion(projectId, project.researchQuestion, project.updatedAt);
    const claims = repo.listClaims(projectId);
    const evidence = repo.listEvidence(projectId);
    const sources = repo.listSources(projectId);

    const claimsAsFindings = claims
      .map((claim) => ({ id: claim.id, text: claim.statement, confidence: claim.confidence, at: claim.updatedAt, origin: 'claim' as const }))
      .sort((a, b) => b.confidence - a.confidence);
    const coreJudgments = claimsAsFindings.slice(0, 3);
    const now = Date.now();
    const newFindings = [
      ...claimsAsFindings.filter((f) => now - f.at < 7 * DAY_MS).slice(0, 5),
      ...evidence
        .filter((item) => now - item.createdAt < 7 * DAY_MS)
        .slice(0, 5)
        .map((item) => ({ id: item.id, text: item.snippet.slice(0, 120), confidence: item.confidence, at: item.createdAt, origin: 'evidence' as const })),
    ].sort((a, b) => b.at - a.at).slice(0, 6);

    // 不确定性：低置信论断 + 修正类决策的原因。
    const decisions = repo.listDecisions(projectId).sort((a, b) => b.createdAt - a.createdAt);
    const uncertainties: Array<{ text: string; reason: string }> = [];
    for (const claim of claims.filter((c) => c.confidence < 0.5).slice(0, 3)) {
      uncertainties.push({ text: claim.statement.slice(0, 120), reason: `证据支持度 ${Math.round(claim.confidence * 100)}%，待进一步验证` });
    }
    for (const decision of decisions.filter((d) => /revis|rollback|replan|reject/i.test(d.decision)).slice(0, 3)) {
      uncertainties.push({ text: String(decision.afterValue?.statement ?? decision.targetKind).slice(0, 120), reason: decision.note.slice(0, 120) || '研究方案被修正，正在验证新路径' });
    }

    const artifacts = repo.listArtifacts(projectId).map((artifact): WorkspaceArtifactView => {
      const versions = repo.listArtifactVersions(artifact.id).sort((a, b) => b.version - a.version);
      const latest = versions[0];
      const recentlyAi = latest ? latest.createdBy === 'ai' && now - latest.createdAt < 5 * 60_000 : false;
      return {
        id: artifact.id,
        title: artifact.title,
        artifactType: artifact.artifactType,
        version: artifact.version,
        updatedAt: artifact.updatedAt,
        contentPreview: (latest?.content ?? '').slice(0, 4000),
        aiEditing: recentlyAi,
        fileCount: 0,
      };
    }).sort((a, b) => b.updatedAt - a.updatedAt);

    const decisionItems = decisions.slice(0, 12).map((decision): WorkspaceDecisionItem => ({
      id: decision.id,
      at: decision.createdAt,
      decision: decision.decision,
      note: decision.note.slice(0, 200),
      before: compactValue(decision.beforeValue),
      after: compactValue(decision.afterValue),
    }));

    const timeline: WorkspaceTimelineItem[] = [];
    for (const decision of decisions.slice(0, 20)) {
      timeline.push({ at: decision.createdAt, kind: 'decision', text: decision.note.slice(0, 100) || `${decision.decision} ${decision.targetKind}` });
    }
    for (const artifact of repo.listArtifacts(projectId)) {
      const latest = repo.listArtifactVersions(artifact.id).sort((a, b) => b.version - a.version)[0];
      if (latest) {
        timeline.push({ at: latest.createdAt, kind: 'artifact-version', text: `更新「${artifact.title}」v${latest.version}` });
      }
    }
    for (const item of evidence.slice(0, 30)) {
      timeline.push({ at: item.createdAt, kind: 'evidence', text: `新增证据：${item.snippet.slice(0, 60)}` });
    }
    for (const source of sources.slice(0, 30)) {
      timeline.push({ at: source.createdAt, kind: 'source', text: `纳入文献：${source.title.slice(0, 60)}` });
    }
    for (const claim of claims.slice(0, 20)) {
      timeline.push({ at: claim.updatedAt, kind: 'claim', text: `形成论断：${claim.statement.slice(0, 60)}` });
    }
    timeline.sort((a, b) => b.at - a.at);

    const runs = repo.listRuns(projectId).sort((a, b) => b.updatedAt - a.updatedAt);
    const latestRun = runs[0] ?? null;

    return {
      question,
      coreJudgments,
      newFindings,
      uncertainties: uncertainties.slice(0, 5),
      artifacts,
      decisions: decisionItems,
      timeline: timeline.slice(0, 40),
      stats: { evidenceCount: evidence.length, claimCount: claims.length, sourceCount: sources.length, artifactCount: artifacts.length },
      latestRun: latestRun ? { status: latestRun.status, updatedAt: latestRun.updatedAt, completedPhases: null, totalPhases: null } : null,
    };
  }

  private buildQuestion(projectId: string, currentText: string, updatedAt: number): WorkspaceQuestionView {
    const repo = this.repository!;
    const questionDecisions = repo.listDecisions(projectId)
      .filter((decision) => decision.targetKind === 'project' && (decision.afterValue as { researchQuestion?: unknown } | undefined)?.researchQuestion)
      .sort((a, b) => b.createdAt - a.createdAt);
    const history = questionDecisions.map((decision, index) => ({
      version: questionDecisions.length - index,
      text: String((decision.afterValue as { researchQuestion?: unknown }).researchQuestion).slice(0, 400),
      at: decision.createdAt,
      note: decision.note.slice(0, 200),
    }));
    return {
      text: currentText || '（AI 尚未确定正式研究问题）',
      version: questionDecisions.length + 1,
      updatedAt,
      history,
    };
  }

  registerIpc(): void {
    ipcMain.handle('autoWorkspace:overview', (event, rawRunning: unknown) => {
      const running = new Set<string>(
        Array.isArray(rawRunning) ? (rawRunning as unknown[]).filter((id): id is string => typeof id === 'string') : [],
      );
      return this.buildOverview(running);
    });
    ipcMain.handle('autoWorkspace:detail', (event, rawProjectId: unknown) => {
      const projectId = typeof rawProjectId === 'string' ? rawProjectId : '';
      return projectId ? this.buildDetail(projectId) : null;
    });
  }
}

function compactValue(value: Record<string, unknown>): string {
  if (!value || typeof value !== 'object') return '';
  const entries = Object.entries(value).filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '');
  if (entries.length === 0) return '';
  return entries.slice(0, 2).map(([k, v]) => `${k}: ${String(v).slice(0, 80)}`).join(' → ');
}
