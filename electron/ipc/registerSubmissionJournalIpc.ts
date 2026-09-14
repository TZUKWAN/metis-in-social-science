/**
 * Submission journal domain IPC registrar — 从 main.ts 迁出（2026-09-15 解耦第二批）。
 *
 * 期刊匹配 / 档案 / 投稿要求 / 语料 / 范式 / 差距诊断（8 个 handler）与
 * 三个期刊上下文辅助函数。依赖经 DomainIpcContext 注入，
 * 服务快照在 registrar 入口一次性读取（与原模块级 let 读取语义一致）。
 */

import { aggregateVenueCandidates } from '../..//engine/submission/JournalTargeting.js';
import { TargetingCriteriaSchema } from '../..//engine/submission/SubmissionRuntimeContract.js';
import { JournalCorpusService } from '../JournalCorpusService.js';
import { JournalPatternService } from '../JournalPatternService.js';
import { JournalProfileService } from '../JournalProfileService.js';
import { SubmissionGapService, extractManuscriptPlainText } from '../SubmissionGapService.js';
import { buildVenueMatchQuery, filterRelevantPapers, outcomeContentToMatchText } from '../SubmissionVenueMatching.js';
import { z } from 'zod';
import type { DomainIpcContext } from './DomainIpcContext.js';

export function registerSubmissionJournalIpc(ctx: DomainIpcContext): () => void {
  const dom = ctx.registry.domain('submission-journal', ['submission:']);

  // 服务快照（provider 重启会重建实例，accessor 保持动态读取的语义由
  // ctx 每次 invoke 前重新进入本 registrar 保证——本文件 handler 均在
  // 单次调用内同步使用，快照窗口安全）。
  const submissionRepository = ctx.submissionRepository();
  const journalProfileRepository = ctx.journalProfileRepository();
  const literatureSearchService = ctx.literatureSearchService();
  const outcomeRepository = ctx.outcomeRepository();
  const store = ctx.store();
  const resolveProjectOutcomeProvider = ctx.resolveProjectOutcomeProvider;

  // ── Submission P1: 期刊档案 / 投稿要求 / 语料 / 范式 / 差距诊断 / 优化方案 ──
  // agentLoop 接线照 OutcomeAssistantService：每次调用按当前项目 provider 运行时解析；
  // provider 未配置时可降级的通道自动退化为确定性路径，plan:apply 返回 provider_not_configured。
  const submissionJournalProfileForCase = (projectId: string, caseId: string) => {
    const submissionCase = submissionRepository?.getCase(projectId, caseId);
    if (!submissionCase?.targetJournalId) return null;
    return journalProfileRepository?.getProfile(projectId, submissionCase.targetJournalId) ?? null;
  };
  const submissionManuscriptAbstract = (text: string): string => {
    const match = /(?:^|\n)\s*(?:abstract|摘\s*要)\s*[:：]?\s*/iu.exec(text);
    if (!match) return '';
    const rest = text.slice(match.index + match[0].length, match.index + match[0].length + 3000);
    const end = rest.search(/\n\s*(?:keywords?|key words|关键词|关键字|introduction|引\s*言)\s*[:：]?\s*/iu);
    return (end > 50 ? rest.slice(0, end) : rest).trim().slice(0, 2000);
  };
  const submissionManuscriptKeywords = (text: string): string[] => {
    const match = /(?:^|\n)\s*(?:keywords?|key words|关键词|关键字)\s*[:：]?\s*/iu.exec(text);
    if (!match) return [];
    const line = text.slice(match.index + match[0].length).split('\n')[0] ?? '';
    return line.split(/[,;，；、|]/u).map((item) => item.trim()).filter(Boolean).slice(0, 12);
  };


  dom.handle('submission:matchJournals', async (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.object({
        projectId: z.string().min(1),
        caseId: z.string().min(1).optional(),
        query: z.string().min(2).max(200),
        outcomeId: z.string().min(1).optional(),
        criteria: TargetingCriteriaSchema,
      }).safeParse(raw);
      if (!p.success || !literatureSearchService) return null;
      const { criteria } = p.data;
      // 匹配策略修正（2026-09-01 刘总报告：匹配结果与论文毫无关系）：
      // ①查询词从论文正文关键词构造（标题只是兜底，且剥离“交付物/工作流”等
      //   元信息噪声）——成果标题是工作流名，不是论文主题；
      // ②搜到的每篇论文标题必须与关键词集合有实质重叠才进入聚合，
      //   零相关的候选宁可返回空，也不再拿不相干论文凑数。
      let contentText = '';
      if (p.data.outcomeId && outcomeRepository) {
        try {
          const detail = outcomeRepository.get(p.data.projectId, p.data.outcomeId);
          if (detail) contentText = outcomeContentToMatchText(detail.version.content);
        } catch { /* 成果读取失败退回标题查询 */ }
      }
      const { query, keywords } = buildVenueMatchQuery(contentText, p.data.query);
      if (!query.trim()) {
        return { ok: true as const, candidates: [], warnings: [], disclaimer: '论文内容里没有提取到可用的主题关键词，无法匹配；请在稿件里补充主题内容，或改用“指定期刊”模式。' };
      }
      const wantsChinese = criteria.categories.some((c) => ['cssci', 'cscd', 'pku_core', 'cn_general'].includes(c));
      const sources = wantsChinese ? ['ncpssd' as const, 'openalex' as const] : ['openalex' as const];
      const search = await literatureSearchService.search({ query, sources, pageSize: 25, coreOnly: false });
      if (!search.ok) return { ok: false as const, code: search.code, candidates: [], warnings: [] };
      const relevant = filterRelevantPapers(search.results.map((item) => ({ title: item.title, year: item.year, venue: item.venue, doi: item.doi, issn: item.issn, source: item.source })), keywords);
      const candidates = aggregateVenueCandidates({
        papers: relevant.map((item) => ({ title: item.title, year: item.year, venue: item.venue, doi: item.doi, issn: item.issn, source: item.source })),
        criteria,
        limit: 20,
      });
      // 留痕：匹配完成写事件（仅摘要计数，不塞全文）。
      if (p.data.caseId && submissionRepository) {
        try {
          submissionRepository.addEvent(p.data.projectId, {
            caseId: p.data.caseId, type: 'note_added', source: 'agent', actor: 'journal-matcher',
            description: `期刊匹配完成：候选 ${candidates.length} 个（满足条件 ${candidates.filter((item) => item.meetsCriteria === true).length} 个）`,
            metadata: { top: candidates.slice(0, 5).map((item) => ({ name: item.name, meets: item.meetsCriteria, count: item.recentPaperCount })) },
          });
        } catch { /* 留痕失败不影响匹配结果 */ }
      }
      return {
        ok: true as const,
        candidates,
        warnings: search.warnings,
        disclaimer: keywords.length > 0
          ? `候选按论文主题（关键词：${keywords.slice(0, 5).join('、')}）过滤——仅保留标题与之相关的近期论文（${relevant.length}/${search.results.length} 篇）；索引层级由本地白名单核验。`
          : '候选基于近期主题相关论文的发表期刊聚合；索引层级由本地白名单核验。',
      };
    } catch (error) {
      console.warn('[Submission] journal match failed:', (error as Error)?.message);
      return null;
    }
  });

  dom.handle('submission:journal:identify', async (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.object({
        projectId: z.string().min(1),
        caseId: z.string().min(1).optional(),
        name: z.string().max(300).optional(),
        issn: z.string().max(20).optional(),
      }).safeParse(raw);
      if (!p.success || !journalProfileRepository) return null;
      const result = await new JournalProfileService({ repository: journalProfileRepository })
        .identifyJournal({ projectId: p.data.projectId, name: p.data.name, issn: p.data.issn });
      // 核验成功且带 caseId：把档案写回 case 并留痕（不改变状态机状态）。
      if (result.ok && p.data.caseId && submissionRepository) {
        try {
          submissionRepository.updateCase(p.data.projectId, {
            caseId: p.data.caseId,
            targetJournalId: result.profile.id,
            targetJournalName: result.profile.canonicalName,
          }, 'system');
          submissionRepository.addEvent(p.data.projectId, {
            caseId: p.data.caseId, type: 'journal_identified', source: 'system', actor: 'journal-profile',
            description: `期刊身份核验完成：${result.profile.canonicalName}${result.profile.issn ? `（ISSN ${result.profile.issn}）` : ''}`,
            metadata: { profileId: result.profile.id, issn: result.profile.issn },
          });
        } catch { /* 写回/留痕失败不影响核验结果 */ }
      }
      return result;
    } catch { return null; }
  });

  dom.handle('submission:journal:fetchGuidelines', async (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), caseId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !journalProfileRepository || !submissionRepository) return null;
      const profile = submissionJournalProfileForCase(p.data.projectId, p.data.caseId);
      if (!profile) return { ok: false as const, code: 'journal_profile_not_found' as const, message: '该投稿案件尚未关联已核验的期刊档案，请先完成期刊核验。' };
      const runtime = resolveProjectOutcomeProvider(p.data.projectId);
      const result = await new JournalProfileService({
        repository: journalProfileRepository,
        ...(runtime.status === 'ready' ? { agentLoop: runtime.agentLoop, providerProfileBinding: runtime.binding } : {}),
      }).fetchGuidelines({ projectId: p.data.projectId, profileId: profile.id, caseId: p.data.caseId });
      // 成功后留痕；状态推进留给 UI 显式调用 submission:changeStatus。
      if (result.ok) {
        try {
          submissionRepository.addEvent(p.data.projectId, {
            caseId: p.data.caseId, type: 'profile_completed', source: 'system', actor: 'journal-profile',
            description: `期刊官方投稿要求抓取完成：${result.requirements.length} 条要求（${result.extraction === 'llm' ? '模型抽取' : '确定性抽取'}）。`,
            metadata: { profileId: profile.id, snapshotId: result.snapshot.id, requirementCount: result.requirements.length, extraction: result.extraction },
          });
        } catch { /* 留痕失败不影响结果 */ }
      }
      return result;
    } catch { return null; }
  });

  dom.handle('submission:journal:profile', (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), caseId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !journalProfileRepository) return null;
      const profile = submissionJournalProfileForCase(p.data.projectId, p.data.caseId);
      if (!profile) return null;
      const snapshot = journalProfileRepository.latestSnapshot(profile.id) ?? null;
      return {
        profile,
        snapshot,
        requirements: snapshot ? journalProfileRepository.listRequirements(snapshot.id) : null,
        observations: snapshot ? journalProfileRepository.listPatternObservations(snapshot.id) : null,
        corpus: journalProfileRepository.listCorpusItems(profile.id),
      };
    } catch { return null; }
  });

  dom.handle('submission:journal:buildCorpus', async (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), caseId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !journalProfileRepository || !submissionRepository || !outcomeRepository) return null;
      const profile = submissionJournalProfileForCase(p.data.projectId, p.data.caseId);
      if (!profile) return { ok: false as const, code: 'journal_profile_not_found' as const, message: '该投稿案件尚未关联已核验的期刊档案，请先完成期刊核验。' };
      const submissionCase = submissionRepository.getCase(p.data.projectId, p.data.caseId)!;
      const outcomeId = submissionCase.workingOutcomeId ?? submissionCase.sourceOutcomeId;
      const detail = outcomeId ? outcomeRepository.get(p.data.projectId, outcomeId) : undefined;
      if (!detail) return { ok: false as const, code: 'manuscript_not_found' as const, message: '投稿案件没有可用的稿件成果（工作稿/源成果均缺失）。' };
      const text = extractManuscriptPlainText(detail.version.content);
      const abstract = submissionManuscriptAbstract(text);
      const keywords = submissionManuscriptKeywords(text);
      const snapshot = journalProfileRepository.latestSnapshot(profile.id) ?? null;
      const result = await new JournalCorpusService({ repository: journalProfileRepository, literatureSearch: literatureSearchService! })
        .buildCorpus({
          projectId: p.data.projectId,
          profileId: profile.id,
          snapshotId: snapshot?.id ?? null,
          manuscript: {
            title: detail.outcome.title,
            ...(abstract ? { abstract } : {}),
            ...(keywords.length > 0 ? { keywords } : {}),
          },
        });
      if (result.ok) {
        try {
          submissionRepository.addEvent(p.data.projectId, {
            caseId: p.data.caseId, type: 'corpus_built', source: 'system', actor: 'journal-corpus',
            description: `期刊写作范式语料构建完成：新增 ${result.items.length} 篇。`,
            metadata: { profileId: profile.id, count: result.items.length },
          });
        } catch { /* 留痕失败不影响结果 */ }
      }
      return result;
    } catch { return null; }
  });

  dom.handle('submission:journal:analyzePatterns', async (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), caseId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !journalProfileRepository || !submissionRepository) return null;
      const profile = submissionJournalProfileForCase(p.data.projectId, p.data.caseId);
      if (!profile) return { ok: false as const, code: 'journal_profile_not_found' as const, message: '该投稿案件尚未关联已核验的期刊档案，请先完成期刊核验。' };
      const snapshot = journalProfileRepository.latestSnapshot(profile.id);
      if (!snapshot) return { ok: false as const, code: 'journal_snapshot_not_found' as const, message: '该期刊档案尚无研究快照，请先抓取投稿要求。' };
      const runtime = resolveProjectOutcomeProvider(p.data.projectId);
      const result = await new JournalPatternService({
        repository: journalProfileRepository,
        ...(runtime.status === 'ready' ? { agentLoop: runtime.agentLoop, providerProfileBinding: runtime.binding } : {}),
      }).analyzePatterns({ projectId: p.data.projectId, snapshotId: snapshot.id });
      if (result.ok) {
        try {
          submissionRepository.addEvent(p.data.projectId, {
            caseId: p.data.caseId, type: 'patterns_analyzed', source: 'system', actor: 'journal-pattern',
            description: `期刊写作范式分析完成：${result.observations.length} 条观察（语料 ${result.corpusSize} 篇）。`,
            metadata: { profileId: profile.id, snapshotId: snapshot.id, observationCount: result.observations.length, corpusSize: result.corpusSize },
          });
        } catch { /* 留痕失败不影响结果 */ }
      }
      return result;
    } catch { return null; }
  });

  dom.handle('submission:journal:diffSnapshots', (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), caseId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !journalProfileRepository || !store) return null;
      const profile = submissionJournalProfileForCase(p.data.projectId, p.data.caseId);
      if (!profile) return null;
      const rows = store.raw.prepare(
        'SELECT id FROM journal_profile_snapshots WHERE profile_id = ? ORDER BY retrieved_at DESC, created_at DESC LIMIT 2',
      ).all(profile.id) as Array<{ id: string }>;
      if (rows.length < 2) return null;
      return new JournalProfileService({ repository: journalProfileRepository }).diffSnapshots(rows[1]!.id, rows[0]!.id);
    } catch { return null; }
  });

  dom.handle('submission:diagnose', async (event, raw: unknown) => {
    try {
      ctx.requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), caseId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !journalProfileRepository || !submissionRepository || !outcomeRepository) return null;
      const runtime = resolveProjectOutcomeProvider(p.data.projectId);
      return await new SubmissionGapService({
        submissionRepository,
        journalRepository: journalProfileRepository,
        outcomeRepository,
        ...(runtime.status === 'ready' ? { agentLoop: runtime.agentLoop } : {}),
      }).diagnose(p.data);
    } catch { return null; }
  });

  return () => dom.dispose();
}
