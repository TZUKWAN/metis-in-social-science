/**
 * SubmissionsPage — 投稿驾驶舱（P0）。
 *
 * 三区：左栏投稿事务列表（按项目过滤 + 搜索 + 状态过滤）；
 * 中栏当前 Submission Case 详情（生命周期阶段、成果链接、状态推进、Timeline）；
 * 新建投稿弹窗（从成果出发：匹配期刊 / 指定期刊）。
 * 所有数据来自 submission:* IPC（SQLite 持久化），状态变更走持久状态机。
 * 页面只保留数据加载与编排；区块子组件拆分在 ./submissions/
 * （期刊研究、投稿检查与材料、最终提交确认、投稿通信、投稿门户、返修工作台、新建弹窗）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from '../i18n';
import { useResearchWorkspaceStore } from '../research/researchWorkspaceStore';
import {
  SUBMISSION_STATUS_TRANSITIONS,
  submissionLifecycleStage,
  type SubmissionCase,
  type SubmissionStatus,
  type SubmissionVenueCategory,
} from '../../engine/submission/SubmissionRuntimeContract.js';
import type { JournalCandidate } from '../../engine/submission/JournalTargeting.js';
import { CreateCaseDialog } from './submissions/CreateCaseDialog';
import { JournalResearchSection } from './submissions/JournalResearchSection';
import { SubmissionCorrespondenceSection } from './submissions/SubmissionCorrespondenceSection';
import { SubmissionPackageSection } from './submissions/SubmissionPackageSection';
import { SubmissionPortalSection } from './submissions/SubmissionPortalSection';
import { SubmissionRevisionSection } from './submissions/SubmissionRevisionSection';
import './SubmissionsPage.css';

const STAGE_ORDER = ['targeting', 'profiling', 'diagnosis', 'optimization', 'precheck', 'materials', 'submitting', 'tracking', 'revision', 'accepted'] as const;

export default function SubmissionsPage({ onNavigateToOutcomes }: { onNavigateToOutcomes?: () => void } = {}) {
  const { t, locale } = useTranslation();
  const projectId = useResearchWorkspaceStore((s) => s.activeProjectId);
  const [cases, setCases] = useState<SubmissionCase[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [events, setEvents] = useState<Array<{ id: string; type: string; description: string; source: string; createdAt: number }>>([]);
  const [filter, setFilter] = useState<'all' | 'active' | 'closed'>('active');
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  // CASE C 换刊：从被拒 Case 一键进入选刊流程（沿用同一 Submission Series）。
  const [createIntent, setCreateIntent] = useState<{ mode: 'match' | 'specify'; seriesId: string | null }>({ mode: 'specify', seriesId: null });
  const [matchState, setMatchState] = useState<{ caseId: string; status: 'idle' | 'loading' | 'done' | 'failed'; candidates: JournalCandidate[]; disclaimer: string }>({ caseId: '', status: 'idle', candidates: [], disclaimer: '' });

  const selected = useMemo(() => cases.find((item) => item.id === selectedId) ?? null, [cases, selectedId]);

  const loadCases = useCallback(async () => {
    const rows = projectId && window.metis?.listSubmissionCases
      ? await window.metis.listSubmissionCases({ projectId, query, includeClosed: filter !== 'active' })
      : [];
    setCases(rows);
    setSelectedId((current) => (rows.some((row) => row.id === current) ? current : rows[0]?.id ?? null));
  }, [projectId, filter, query]);

  const loadEvents = useCallback(async () => {
    const rows = projectId && selectedId && window.metis?.listSubmissionEvents
      ? await window.metis.listSubmissionEvents({ projectId, caseId: selectedId })
      : [];
    setEvents(rows);
  }, [projectId, selectedId]);

  const refresh = useCallback(async () => { await loadCases(); await loadEvents(); }, [loadCases, loadEvents]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const rows = projectId && window.metis?.listSubmissionCases
        ? await window.metis.listSubmissionCases({ projectId, query, includeClosed: filter !== 'active' })
        : [];
      if (!alive) return;
      setCases(rows);
      setSelectedId((current) => (rows.some((row) => row.id === current) ? current : rows[0]?.id ?? null));
    })();
    return () => { alive = false; };
  }, [projectId, filter, query]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const rows = projectId && selectedId && window.metis?.listSubmissionEvents
        ? await window.metis.listSubmissionEvents({ projectId, caseId: selectedId })
        : [];
      if (alive) setEvents(rows);
    })();
    return () => { alive = false; };
  }, [projectId, selectedId]);

  // 后台邮件监听推送：新编辑来信到达时刷新列表与事件（决定信类由通知里带分类）。
  useEffect(() => {
    const unsubscribe = window.metis?.onSubmissionMailChanged?.(() => {
      setNotice(t('submissionHub.mailWatcherArrived'));
      void refresh();
    });
    return () => { unsubscribe?.(); };
    // refresh 随 projectId/filter/query 变化重建，订阅保持不变（闭包经 refresh ref 更新）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  // 备注/下一状态草稿按选中 Case 派生（渲染期调整，避免同步 setState effect）。
  const [notesDraftState, setNotesDraftState] = useState<{ id: string; value: string }>({ id: '', value: '' });
  const [nextStatusState, setNextStatusState] = useState<{ id: string; value: string }>({ id: '', value: '' });
  const notesDraft = selected && notesDraftState.id === selected.id ? notesDraftState.value : selected?.notes ?? '';
  const nextStatus = selected && nextStatusState.id === selected.id ? nextStatusState.value : '';

  async function advanceStatus(): Promise<void> {
    if (!projectId || !selected || !nextStatus || !window.metis?.changeSubmissionStatus) return;
    const result = await window.metis.changeSubmissionStatus({
      projectId,
      change: { caseId: selected.id, to: nextStatus, reason: '', source: 'human' },
    });
    if (result && 'ok' in result && result.ok === false && result.code === 'illegal_transition') {
      setNotice(t('submissionHub.illegalTransition'));
      return;
    }
    setNextStatusState({ id: '', value: '' });
    await refresh();
  }

  async function saveNotes(): Promise<void> {
    if (!projectId || !selected || !window.metis?.updateSubmissionCase) return;
    const updated = await window.metis.updateSubmissionCase({ projectId, patch: { caseId: selected.id, notes: notesDraft } });
    if (updated) { setNotice(t('submissionHub.updated')); await loadCases(); }
  }

  async function runMatch(): Promise<void> {
    if (!projectId || !selected || !window.metis?.matchSubmissionJournals) return;
    const criteria = selected.targetingCriteria ?? { categories: ['en_general' as SubmissionVenueCategory], language: 'any' as const, notes: '' };
    setMatchState({ caseId: selected.id, status: 'loading', candidates: [], disclaimer: '' });
    const result = await window.metis.matchSubmissionJournals({
      projectId,
      caseId: selected.id,
      query: selected.title,
      // 匹配查询词改为从源成果正文提取（标题常是工作流名，不是论文主题）
      outcomeId: selected.sourceOutcomeId ?? undefined,
      criteria,
    });
    if (!result || result.ok === false) {
      setMatchState({ caseId: selected.id, status: 'failed', candidates: [], disclaimer: '' });
      return;
    }
    setMatchState({ caseId: selected.id, status: 'done', candidates: result.candidates, disclaimer: result.disclaimer });
    await loadEvents();
  }

  async function selectJournal(candidateName: string): Promise<void> {
    if (!projectId || !selected || !window.metis?.updateSubmissionCase || !window.metis?.changeSubmissionStatus) return;
    const updated = await window.metis.updateSubmissionCase({ projectId, patch: { caseId: selected.id, targetJournalName: candidateName } });
    if (!updated) return;
    setNotice(t('submissionHub.selectedJournal'));
    if (selected.status === 'TARGETING') {
      const changed = await window.metis.changeSubmissionStatus({ projectId, change: { caseId: selected.id, to: 'JOURNAL_SELECTED', reason: `选定期刊：${candidateName}`, source: 'human' } });
      if (changed && 'ok' in changed && changed.ok === false) setNotice(t('submissionHub.illegalTransition'));
    }
    await refresh();
  }

  const stage = selected ? submissionLifecycleStage(selected.status as SubmissionStatus) : null;
  const stageIndex = stage && stage !== 'closed' ? STAGE_ORDER.indexOf(stage) : -1;
  const stageLabels = t('submissionHub.stages').split('|');
  const allowedNext = selected ? SUBMISSION_STATUS_TRANSITIONS[selected.status as SubmissionStatus] ?? [] : [];
  // 期刊研究区：已选期刊（JOURNAL_SELECTED，profiling 阶段）及之后各阶段均可展开查看。
  const showJournalResearch = Boolean(selected && stage && stage !== 'targeting' && stage !== 'closed');
  const showPackageSection = Boolean(selected && stage && ['precheck', 'materials', 'submitting', 'tracking', 'revision', 'accepted'].includes(stage));
  // 投稿通信（邮件）：材料准备起至录用全程可见。
  const showMailSection = Boolean(selected && stage && ['materials', 'submitting', 'tracking', 'revision', 'accepted'].includes(stage));
  // 投稿门户（半自动填单）：仅投稿执行窗口期可见。
  const showPortalSection = Boolean(selected && stage && ['materials', 'submitting', 'tracking'].includes(stage));

  return (
    <div className="submissions-page" role="region" aria-label={t('submissionHub.title')}>
      <aside className="submissions-list" aria-label={t('submissionHub.listTitle')}>
        <header className="submissions-list__header">
          <h2>{t('submissionHub.title')}</h2>
          <button type="button" className="submissions-new" data-testid="submissions-new" onClick={() => setCreateOpen(true)}>{t('submissionHub.newCase')}</button>
        </header>
        <div className="submissions-list__filters">
          <div className="submissions-filter" role="tablist">
            {(['active', 'all', 'closed'] as const).map((mode) => (
              <button key={mode} type="button" role="tab" aria-selected={filter === mode}
                className={filter === mode ? 'active' : ''}
                onClick={() => setFilter(mode)}>{t(`submissionHub.filter${mode === 'active' ? 'Active' : mode === 'all' ? 'All' : 'Closed'}`)}</button>
            ))}
          </div>
          <input className="submissions-search" value={query} placeholder={t('submissionHub.searchPlaceholder')}
            aria-label={t('submissionHub.searchPlaceholder')}
            onChange={(event) => setQuery(event.target.value)} />
        </div>
        <div className="submissions-list__scroll">
          {cases.length === 0 && <p className="submissions-empty">{t('submissionHub.empty')}</p>}
          {cases.map((item) => (
            <button key={item.id} type="button"
              className={`submissions-case-item ${item.id === selectedId ? 'selected' : ''}`}
              data-testid="submissions-case-item"
              onClick={() => setSelectedId(item.id)}>
              <strong>{item.title || t('submissionHub.noJournal')}</strong>
              <span>{item.targetJournalName || t('submissionHub.noJournal')}</span>
              <small>{t(`submissionHub.statusLabels.${item.status}`)} · {new Date(item.updatedAt).toLocaleString()}</small>
            </button>
          ))}
        </div>
      </aside>

      <section className="submissions-detail" aria-label={t('submissionHub.caseTitle')}>
        {!selected ? (
          <div className="submissions-empty-state"><p>{t('submissionHub.empty')}</p>
            {onNavigateToOutcomes && <button type="button" className="submissions-primary" onClick={onNavigateToOutcomes}>{t('nav.outcomes')}</button>}
          </div>
        ) : (
          <>
            {notice && <p className="submissions-notice" role="status">{notice}</p>}
            <header className="submissions-detail__head">
              <div>
                <h2>{selected.title || t('submissionHub.noJournal')}</h2>
                <p>{selected.targetJournalName || t('submissionHub.noJournal')} · {t(`submissionHub.statusLabels.${selected.status}`)}</p>
              </div>
            </header>

            <div className="submissions-stages" aria-label={t('submissionHub.stage')}>
              {STAGE_ORDER.map((name, index) => (
                <span key={name}
                  className={`submissions-stage ${stage === 'closed' ? '' : index <= stageIndex ? 'done' : ''} ${stage === name ? 'current' : ''}`}>
                  {stageLabels[index] ?? name}
                </span>
              ))}
              {stage === 'closed' && <span className="submissions-stage current">{t('submissionHub.stageClosed')}</span>}
            </div>

            <dl className="submissions-facts">
              <div><dt>{t('submissionHub.journal')}</dt><dd>{selected.targetJournalName || t('submissionHub.noJournal')}</dd></div>
              <div><dt>{t('submissionHub.status')}</dt><dd>{t(`submissionHub.statusLabels.${selected.status}`)}</dd></div>
              <div><dt>{t('submissionHub.sourceOutcome')}</dt><dd>{selected.sourceOutcomeId ? `${selected.sourceOutcomeId.slice(0, 18)}… v${selected.sourceOutcomeVersion ?? '?'}` : t('submissionHub.notSet')}</dd></div>
              <div><dt>{t('submissionHub.workingOutcome')}</dt><dd>{selected.workingOutcomeId ? `${selected.workingOutcomeId.slice(0, 18)}… v${selected.workingOutcomeVersion ?? '?'}` : t('submissionHub.notSet')}</dd></div>
              <div><dt>{t('submissionHub.submittedVersion')}</dt><dd>{selected.submittedOutcomeVersion ? `v${selected.submittedOutcomeVersion}` : t('submissionHub.notSet')}</dd></div>
              <div><dt>{t('submissionHub.createArticleType')}</dt><dd>{selected.articleType ? t(`submissionHub.articleTypes.${selected.articleType}`) : t('submissionHub.articleTypes.none')}</dd></div>
            </dl>

            {selected.status === 'TARGETING' && (
              <div className="submissions-targeting" data-testid="submissions-targeting">
                <h3>{t('submissionHub.targetingTitle')}</h3>
                <div className="submissions-criteria">
                  {(selected.targetingCriteria?.categories ?? []).map((category) => (
                    <span key={category} className="submissions-tier">{t(`submissionHub.venueCategories.${category}`)}</span>
                  ))}
                  {!selected.targetingCriteria && <span className="submissions-tier">{t('submissionHub.notSet')}</span>}
                </div>
                <button type="button" className="submissions-primary" disabled={matchState.caseId === selected.id && matchState.status === 'loading'}
                  onClick={() => void runMatch()}>
                  {matchState.caseId === selected.id && matchState.status === 'loading' ? t('submissionHub.matching') : t('submissionHub.startMatch')}
                </button>
                {matchState.caseId === selected.id && matchState.status === 'failed' && <p className="submissions-notice" role="alert">{t('submissionHub.matchFailed')}</p>}
                {matchState.caseId === selected.id && matchState.status === 'done' && (
                  <div className="submissions-candidates">
                    {matchState.disclaimer && <p className="submissions-disclaimer">{matchState.disclaimer}</p>}
                    {matchState.candidates.length === 0 && <p className="submissions-empty">{t('submissionHub.matchEmpty')}</p>}
                    {matchState.candidates.map((candidate) => (
                      <div key={candidate.name} className="submissions-candidate" data-testid="submissions-candidate">
                        <div className="submissions-candidate__head">
                          <strong>{candidate.name}</strong>
                          <span className={`submissions-tier ${candidate.meetsCriteria === true ? 'ok' : candidate.meetsCriteria === false ? 'bad' : ''}`}>
                            {candidate.meetsCriteria === true ? t('submissionHub.meetsYes') : candidate.meetsCriteria === false ? t('submissionHub.meetsNo') : t('submissionHub.meetsUnknown')}
                          </span>
                        </div>
                        <div className="submissions-candidate__tiers">
                          {candidate.verifiedTiers.length > 0
                            ? candidate.verifiedTiers.map((tier) => <span key={tier} className="submissions-tier ok">{tier}</span>)
                            : <span className="submissions-tier">{candidate.criteriaNote}</span>}
                        </div>
                        <div className="submissions-candidate__evidence">
                          <small>{t('submissionHub.recentPapers')} × {candidate.recentPaperCount}（{candidate.latestYear}）</small>
                          <ul>{candidate.evidence.map((item, index) => (
                            <li key={index}><span>{item.title}（{item.year}，{item.source}）</span></li>
                          ))}</ul>
                        </div>
                        <button type="button" className="submissions-secondary" onClick={() => void selectJournal(candidate.name)}>{t('submissionHub.selectJournal')}</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {showJournalResearch && projectId && selected && (
              <JournalResearchSection
                projectId={projectId}
                caseItem={selected}
                onRefresh={refresh}
              />
            )}

            {showPackageSection && projectId && selected && (
              <SubmissionPackageSection
                key={selected.id}
                projectId={projectId}
                caseItem={selected}
                onRefresh={refresh}
              />
            )}

            {showMailSection && projectId && selected && (
              <SubmissionCorrespondenceSection
                key={`mail-${selected.id}`}
                projectId={projectId}
                caseItem={selected}
                onRefresh={refresh}
              />
            )}

            {showPortalSection && projectId && selected && (
              <SubmissionPortalSection
                key={`portal-${selected.id}`}
                projectId={projectId}
                caseItem={selected}
                onRefresh={refresh}
              />
            )}

            {projectId && selected && stage === 'revision' && (
              <SubmissionRevisionSection
                key={`rev-${selected.id}`}
                projectId={projectId}
                caseItem={selected}
                onRefresh={refresh}
              />
            )}

            <div className="submissions-advance">
              <label>
                <span>{t('submissionHub.chooseNextStatus')}</span>
                <select value={nextStatus} aria-label={t('submissionHub.chooseNextStatus')}
                  onChange={(event) => setNextStatusState({ id: selected.id, value: event.target.value })}>
                  <option value="">—</option>
                  {allowedNext.filter((status) => status !== selected.status).map((status) => (
                    <option key={status} value={status}>{t(`submissionHub.statusLabels.${status}`)}</option>
                  ))}
                </select>
              </label>
              <button type="button" className="submissions-primary" disabled={!nextStatus}
                onClick={() => void advanceStatus()}>{t('submissionHub.confirmAdvance')}</button>
            </div>

            <label className="submissions-notes">
              <span>{t('submissionHub.notes')}</span>
              <textarea value={notesDraft} rows={3} aria-label={t('submissionHub.notes')}
                onChange={(event) => setNotesDraftState({ id: selected.id, value: event.target.value })} />
            </label>
            <button type="button" className="submissions-secondary" onClick={() => void saveNotes()}>{t('submissionHub.saveNotes')}</button>

            {(selected.status === 'REJECTED' || selected.status === 'DESK_REJECTED') && (
              <div className="submissions-retarget">
                <p><small>{t('submissionHub.retargetHint')}</small></p>
                <button type="button" className="submissions-primary" data-testid="submissions-retarget"
                  onClick={() => { setCreateIntent({ mode: 'match', seriesId: selected.seriesId }); setCreateOpen(true); }}>
                  {t('submissionHub.retargetNewJournal')}
                </button>
              </div>
            )}

            <h3 className="submissions-events-title">{t('submissionHub.events')}</h3>            <ol className="submissions-timeline" aria-label={t('submissionHub.timeline')}>
              {events.length === 0 && <li className="submissions-empty">{t('submissionHub.noEvents')}</li>}
              {events.map((item) => (
                <li key={item.id}>
                  <span className="submissions-timeline__time">{new Date(item.createdAt).toLocaleString()}</span>
                  <span className="submissions-timeline__desc">{item.description || item.type}</span>
                  <span className="submissions-timeline__source">{item.source}</span>
                </li>
              ))}
            </ol>
          </>
        )}
      </section>

      {createOpen && (
        <CreateCaseDialog
          projectId={projectId}
          initialMode={createIntent.mode}
          seriesId={createIntent.seriesId}
          onClose={() => { setCreateOpen(false); setCreateIntent({ mode: 'specify', seriesId: null }); }}
          onCreated={async (caseId) => {
            setCreateOpen(false);
            setCreateIntent({ mode: 'specify', seriesId: null });
            setNotice(t('submissionHub.created'));
            await loadCases();
            setSelectedId(caseId);
          }}
        />
      )}
      <span className="submissions-locale" hidden>{locale}</span>
    </div>
  );
}
