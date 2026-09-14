/**
 * 期刊研究区（P1）：期刊身份卡、官方投稿要求、规范更新检查、
 * 近期论文语料、写作范式观察，以及其后的稿件诊断与优化方案。
 * 官方要求（硬约束）与语料归纳的经验范式（软范式）在 UI 上严格分区、标注证据等级。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from '../../i18n';
import {
  submissionLifecycleStage,
  type SubmissionCase,
  type SubmissionStatus,
} from '../../../engine/submission/SubmissionRuntimeContract.js';
import type {
  JournalCorpusItem,
  JournalPatternObservation,
  JournalProfile,
  JournalRequirement,
  SubmissionGapItem,
  SubmissionOptimizationItem,
  SubmissionOptimizationPlan,
} from '../../../engine/submission/JournalProfileContract.js';
import { journalApi } from './shared';

const GAP_SEVERITY_ORDER = ['must_fix', 'strongly_recommended', 'optional'] as const;

type BusyAction = '' | 'fetch' | 'diff' | 'corpus' | 'patterns' | 'diagnose' | 'plan' | 'apply' | 'verify';

interface SnapshotDiff {
  added: JournalRequirement[];
  removed: JournalRequirement[];
  changed: Array<{ ruleKey: string; before: JournalRequirement | null; after: JournalRequirement | null }>;
}

export function JournalResearchSection({ projectId, caseItem, onRefresh }: {
  projectId: string;
  caseItem: SubmissionCase;
  onRefresh: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [profile, setProfile] = useState<JournalProfile | null>(null);
  const [requirements, setRequirements] = useState<JournalRequirement[]>([]);
  const [observations, setObservations] = useState<JournalPatternObservation[]>([]);
  const [corpus, setCorpus] = useState<JournalCorpusItem[]>([]);
  const [gapItems, setGapItems] = useState<SubmissionGapItem[]>([]);
  const [plan, setPlan] = useState<SubmissionOptimizationPlan | null>(null);
  const [planItems, setPlanItems] = useState<SubmissionOptimizationItem[]>([]);
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);
  const [busy, setBusy] = useState<BusyAction>('');
  const [info, setInfo] = useState('');
  const [error, setError] = useState('');
  const [diff, setDiff] = useState<SnapshotDiff | null>(null);
  const [diffChecked, setDiffChecked] = useState(false);
  const [applySummary, setApplySummary] = useState<{ applied: number; skipped: number; failed: number } | null>(null);
  const [verifyMessage, setVerifyMessage] = useState('');

  const stage = submissionLifecycleStage(caseItem.status as SubmissionStatus);

  const errorText = useCallback((code: string): string => {
    const key = `submissionHub.journalErrors.${code}`;
    const value = t(key);
    return value === key ? t('submissionHub.journalActionFailed', { code }) : value;
  }, [t]);

  const loadAll = useCallback(async () => {
    const api = journalApi();
    if (!api) return;
    if (api.getSubmissionJournalProfile) {
      let data = await api.getSubmissionJournalProfile({ projectId, caseId: caseItem.id });
      if (!data && api.identifySubmissionJournal && caseItem.targetJournalName) {
        const identified = await api.identifySubmissionJournal({ projectId, caseId: caseItem.id, name: caseItem.targetJournalName });
        if (identified && 'ok' in identified && identified.ok) {
          data = await api.getSubmissionJournalProfile({ projectId, caseId: caseItem.id });
        }
      }
      if (data) {
        setProfile(data.profile ?? null);
        setRequirements(data.requirements ?? []);
        setObservations(data.observations ?? []);
        setCorpus(data.corpus ?? []);
      }
    }
    if (api.getSubmissionOptimizationPlan) {
      const planData = await api.getSubmissionOptimizationPlan({ projectId, caseId: caseItem.id });
      setPlan(planData?.plan ?? null);
      setPlanItems(planData?.items ?? []);
    }
  }, [projectId, caseItem.id, caseItem.targetJournalName]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const api = journalApi();
      if (!api) return;
      if (api.getSubmissionJournalProfile) {
        let data = await api.getSubmissionJournalProfile({ projectId, caseId: caseItem.id });
        if (!data && api.identifySubmissionJournal && caseItem.targetJournalName) {
          const identified = await api.identifySubmissionJournal({ projectId, caseId: caseItem.id, name: caseItem.targetJournalName });
          if (identified && 'ok' in identified && identified.ok) {
            data = await api.getSubmissionJournalProfile({ projectId, caseId: caseItem.id });
          }
        }
        if (!alive) return;
        if (data) {
          setProfile(data.profile ?? null);
          setRequirements(data.requirements ?? []);
          setObservations(data.observations ?? []);
          setCorpus(data.corpus ?? []);
        }
      }
      if (api.getSubmissionOptimizationPlan) {
        const planData = await api.getSubmissionOptimizationPlan({ projectId, caseId: caseItem.id });
        if (!alive) return;
        setPlan(planData?.plan ?? null);
        setPlanItems(planData?.items ?? []);
      }
    })();
    return () => { alive = false; };
  }, [projectId, caseItem.id, caseItem.targetJournalName]);

  const groupedRequirements = useMemo(() => {
    const map = new Map<string, JournalRequirement[]>();
    for (const requirement of requirements) {
      const list = map.get(requirement.ruleKey) ?? [];
      list.push(requirement);
      map.set(requirement.ruleKey, list);
    }
    return [...map.entries()];
  }, [requirements]);

  const visibleGapItems = useMemo(() => gapItems.filter((item) => item.status !== 'dismissed'), [gapItems]);
  const showDiagnosis = stage !== 'profiling' || gapItems.length > 0;

  async function fetchGuidelines(): Promise<void> {
    const api = journalApi();
    if (!api?.fetchSubmissionJournalGuidelines || busy) return;
    setBusy('fetch'); setError(''); setInfo('');
    const result = await api.fetchSubmissionJournalGuidelines({ projectId, caseId: caseItem.id });
    if (result && 'ok' in result && result.ok) {
      setRequirements(result.requirements);
      const extraction = result.extraction === 'llm' ? t('submissionHub.extractionLlm') : t('submissionHub.extractionDeterministic');
      setInfo(`${t('submissionHub.guidelinesFetched', { count: result.requirements.length })}（${extraction}）`);
      await loadAll();
    } else {
      setError(errorText(result && 'code' in result ? result.code : 'unknown'));
    }
    setBusy('');
  }

  async function checkUpdates(): Promise<void> {
    const api = journalApi();
    if (!api?.diffSubmissionJournalSnapshots || busy) return;
    setBusy('diff'); setError('');
    const result = await api.diffSubmissionJournalSnapshots({ projectId, caseId: caseItem.id });
    setDiff(result ?? null);
    setDiffChecked(true);
    setBusy('');
  }

  async function buildCorpus(): Promise<void> {
    const api = journalApi();
    if (!api?.buildSubmissionJournalCorpus || busy) return;
    setBusy('corpus'); setError('');
    const result = await api.buildSubmissionJournalCorpus({ projectId, caseId: caseItem.id });
    if (result && 'ok' in result && result.ok) setCorpus(result.items);
    else setError(errorText(result && 'code' in result ? result.code : 'unknown'));
    setBusy('');
  }

  async function analyzePatterns(): Promise<void> {
    const api = journalApi();
    if (!api?.analyzeSubmissionJournalPatterns || busy) return;
    setBusy('patterns'); setError('');
    const result = await api.analyzeSubmissionJournalPatterns({ projectId, caseId: caseItem.id });
    if (result && 'ok' in result && result.ok) setObservations(result.observations);
    else setError(errorText(result && 'code' in result ? result.code : 'unknown'));
    setBusy('');
  }

  async function runDiagnosis(): Promise<void> {
    const api = journalApi();
    if (!api?.diagnoseSubmissionCase || busy) return;
    setBusy('diagnose'); setError('');
    const result = await api.diagnoseSubmissionCase({ projectId, caseId: caseItem.id });
    if (result && 'ok' in result && result.ok) setGapItems(result.items);
    else setError(errorText(result && 'code' in result ? result.code : 'unknown'));
    setBusy('');
  }

  async function dismissGap(itemId: string): Promise<void> {
    const api = journalApi();
    if (!api?.updateSubmissionGapItem) return;
    await api.updateSubmissionGapItem({ projectId, caseId: caseItem.id, itemId, patch: { status: 'dismissed' } });
    setGapItems((current) => current.map((item) => (item.id === itemId ? { ...item, status: 'dismissed' } : item)));
  }

  async function createPlan(): Promise<void> {
    const api = journalApi();
    if (!api?.createSubmissionOptimizationPlan || busy) return;
    setBusy('plan'); setError('');
    const gapItemIds = visibleGapItems.map((item) => item.id);
    const result = await api.createSubmissionOptimizationPlan({ projectId, caseId: caseItem.id, ...(gapItemIds.length > 0 ? { gapItemIds } : {}) });
    if (result && 'ok' in result && result.ok) {
      setPlan(result.plan);
      setPlanItems(result.items);
      setSelectedItemIds([]);
    } else {
      setError(errorText(result && 'code' in result ? result.code : 'unknown'));
    }
    setBusy('');
  }

  async function approveAndApply(): Promise<void> {
    const api = journalApi();
    if (!api?.approveSubmissionOptimizationPlan || !api.applySubmissionOptimizationPlan || !plan || busy) return;
    setBusy('apply'); setError(''); setApplySummary(null); setVerifyMessage('');
    const approved = await api.approveSubmissionOptimizationPlan({ projectId, planId: plan.id, selectedItemIds });
    if (approved && 'ok' in approved && approved.ok === false) {
      setError(errorText(approved.code));
      setBusy('');
      return;
    }
    const applied = await api.applySubmissionOptimizationPlan({ projectId, planId: plan.id, caseId: caseItem.id });
    if (applied && 'ok' in applied && applied.ok === false) {
      setError(errorText(applied.code));
      setBusy('');
      return;
    }
    if (api.getSubmissionOptimizationPlan) {
      const planData = await api.getSubmissionOptimizationPlan({ projectId, caseId: caseItem.id });
      if (planData) {
        setPlan(planData.plan);
        setPlanItems(planData.items);
        setApplySummary({
          applied: planData.items.filter((item) => item.status === 'applied').length,
          skipped: planData.items.filter((item) => item.status === 'skipped').length,
          failed: planData.items.filter((item) => item.status === 'failed').length,
        });
      }
    }
    setBusy('');
  }

  async function reverify(): Promise<void> {
    const api = journalApi();
    if (!api?.verifySubmissionOptimizationPlan || !plan || busy) return;
    setBusy('verify'); setError(''); setVerifyMessage('');
    const result = await api.verifySubmissionOptimizationPlan({ projectId, planId: plan.id });
    if (result && 'ok' in result && result.ok) {
      const remaining = result.remaining ?? [];
      setVerifyMessage(result.passed === true || remaining.length === 0
        ? t('submissionHub.verifyPassed')
        : t('submissionHub.verifyRemaining', { count: remaining.length }));
    } else {
      setError(errorText(result && 'code' in result ? result.code : 'unknown'));
    }
    setBusy('');
  }

  async function quickAdvance(to: SubmissionStatus): Promise<void> {
    if (!window.metis?.changeSubmissionStatus || busy) return;
    const result = await window.metis.changeSubmissionStatus({
      projectId,
      change: { caseId: caseItem.id, to, reason: '', source: 'human' },
    });
    if (result && 'ok' in result && result.ok === false) {
      setError(t('submissionHub.illegalTransition'));
      return;
    }
    await onRefresh();
  }

  const diffChangeCount = diff ? diff.added.length + diff.removed.length + diff.changed.length : 0;
  const planApprovable = plan && (plan.status === 'draft' || plan.status === 'approved');
  const planApplied = plan && (plan.status === 'applied' || plan.status === 'verified');

  return (
    <div className="submissions-journal" data-testid="submissions-journal-research">
      <details open={stage === 'profiling'}>
        <summary><h3>{t('submissionHub.journalResearchTitle')}</h3></summary>

        {error && <p className="submissions-notice" role="alert">{error}</p>}
        {info && <p className="submissions-notice" role="status">{info}</p>}

        <dl className="submissions-facts" aria-label={t('submissionHub.journalIdentity')}>
          <div><dt>{t('submissionHub.journal')}</dt><dd>{profile?.canonicalName || caseItem.targetJournalName || t('submissionHub.noJournal')}</dd></div>
          <div><dt>{t('submissionHub.issn')}</dt><dd>{profile?.issn || t('submissionHub.notSet')}</dd></div>
          <div><dt>{t('submissionHub.publisher')}</dt><dd>{profile?.publisher || t('submissionHub.notSet')}</dd></div>
          <div><dt>{t('submissionHub.homepage')}</dt><dd>
            {profile?.homepageUrl
              ? <a href={profile.homepageUrl} target="_blank" rel="noreferrer">{profile.homepageUrl}</a>
              : t('submissionHub.notSet')}
          </dd></div>
          <div><dt>{t('submissionHub.journalPortal')}</dt><dd>
            {profile?.submissionPortalUrl
              ? <a href={profile.submissionPortalUrl} target="_blank" rel="noreferrer">{t(`submissionHub.platformLabels.${profile.platform}`)}</a>
              : t(`submissionHub.platformLabels.${profile?.platform ?? 'unknown'}`)}
          </dd></div>
        </dl>

        <div className="submissions-journal__actions">
          {caseItem.status === 'JOURNAL_SELECTED' && (
            <button type="button" className="submissions-primary" disabled={busy !== ''}
              onClick={() => void quickAdvance('PROFILING')}>{t('submissionHub.advanceToProfiling')}</button>
          )}
          {caseItem.status === 'PROFILING' && (
            <button type="button" className="submissions-primary" disabled={busy !== ''}
              onClick={() => void quickAdvance('PROFILE_READY')}>{t('submissionHub.profilingDone')}</button>
          )}
          <button type="button" className="submissions-secondary" disabled={busy !== ''}
            onClick={() => void fetchGuidelines()}>
            {busy === 'fetch' ? t('submissionHub.fetchingGuidelines') : t('submissionHub.fetchGuidelines')}
          </button>
          <button type="button" className="submissions-secondary" disabled={busy !== ''}
            onClick={() => void checkUpdates()}>
            {busy === 'diff' ? t('submissionHub.checkingUpdates') : t('submissionHub.checkUpdates')}
          </button>
          <button type="button" className="submissions-secondary" disabled={busy !== ''}
            onClick={() => void buildCorpus()}>
            {busy === 'corpus' ? t('submissionHub.findingPapers') : t('submissionHub.findRecentPapers')}
          </button>
          <button type="button" className="submissions-secondary" disabled={busy !== ''}
            onClick={() => void analyzePatterns()}>
            {busy === 'patterns' ? t('submissionHub.analyzingPatterns') : t('submissionHub.analyzePatterns')}
          </button>
        </div>

        {diffChecked && (
          <div className="submissions-journal__diff" data-testid="submissions-journal-diff">
            {diffChangeCount === 0
              ? <p className="submissions-empty">{t('submissionHub.noChanges')}</p>
              : (
                <>
                  <p><strong>{t('submissionHub.changesFound', { count: diffChangeCount })}</strong></p>
                  <ul>
                    {diff?.added.map((item) => (
                      <li key={`added-${item.id}`}><span className="submissions-tier ok">{t('submissionHub.changeAdded')}</span> {t(`submissionHub.ruleKeys.${item.ruleKey}`)}：{item.valueText}</li>
                    ))}
                    {diff?.removed.map((item) => (
                      <li key={`removed-${item.id}`}><span className="submissions-tier bad">{t('submissionHub.changeRemoved')}</span> {t(`submissionHub.ruleKeys.${item.ruleKey}`)}：{item.valueText}</li>
                    ))}
                    {diff?.changed.map((item, index) => (
                      <li key={`changed-${item.ruleKey}-${index}`}><span className="submissions-tier">{t('submissionHub.changeChanged')}</span> {t(`submissionHub.ruleKeys.${item.ruleKey}`)}：{item.before?.valueText ?? ''} → {item.after?.valueText ?? ''}</li>
                    ))}
                  </ul>
                </>
              )}
          </div>
        )}

        <div className="submissions-journal__requirements">
          {requirements.length === 0 && <p className="submissions-empty">{t('submissionHub.guidelinesEmpty')}</p>}
          {groupedRequirements.map(([ruleKey, items]) => (
            <section key={ruleKey} className="submissions-journal__group">
              <h4>{t(`submissionHub.ruleKeys.${ruleKey}`)}</h4>
              {items.map((item) => (
                <article key={item.id} className="submissions-journal__item" data-testid="submissions-requirement">
                  <p>{item.valueText}</p>
                  <div className="submissions-journal__meta">
                    {item.sourceUrl && (
                      <span>{t('submissionHub.requirementSource')}：<a href={item.sourceUrl} target="_blank" rel="noreferrer">{item.sourceTitle || item.sourceUrl}</a></span>
                    )}
                    <span>{t('submissionHub.confidence')}：{t(`submissionHub.confidenceLevels.${item.confidence}`)}</span>
                    <span>{t('submissionHub.retrievedAt')}：{new Date(item.retrievedAt).toLocaleString()}</span>
                  </div>
                  {item.evidenceSnippet && (
                    <details className="submissions-journal__evidence">
                      <summary>{t('submissionHub.evidenceSnippet')}</summary>
                      <blockquote>{item.evidenceSnippet}</blockquote>
                    </details>
                  )}
                </article>
              ))}
            </section>
          ))}
        </div>

        <div className="submissions-journal__corpus">
          {corpus.length === 0
            ? <p className="submissions-empty">{t('submissionHub.corpusEmpty')}</p>
            : (
              <ul>
                {corpus.map((item) => (
                  <li key={item.id} data-testid="submissions-corpus-item">
                    <span>
                      {item.url ? <a href={item.url} target="_blank" rel="noreferrer">{item.title}</a> : item.title}
                      {item.year != null && `（${item.year}）`}
                    </span>
                    <small>
                      {item.source}
                      {item.similarityScore != null && ` · ${t('submissionHub.corpusSimilarity', { score: Math.round(item.similarityScore * 100) })}`}
                    </small>
                    {item.fulltextAvailable && <span className="submissions-tier ok">{t('submissionHub.fulltextYes')}</span>}
                  </li>
                ))}
              </ul>
            )}
        </div>

        <div className="submissions-journal__patterns">
          {observations.length === 0
            ? <p className="submissions-empty">{t('submissionHub.patternsEmpty')}</p>
            : observations.map((item) => (
              <article key={item.id} className="submissions-journal__item" data-testid="submissions-pattern">
                <div className="submissions-journal__meta">
                  <strong className="submissions-badge">{t('submissionHub.patternDisclaimer')}</strong>
                  <span className="submissions-tier">{t(`submissionHub.patternKeys.${item.patternKey}`)}</span>
                </div>
                <p>{item.observation}</p>
                <div className="submissions-journal__meta">
                  <span>{t('submissionHub.sampleSize', { count: item.sampleSize })}</span>
                  <span>{t(`submissionHub.patternEvidenceLevels.${item.evidenceLevel}`)}</span>
                  <span>{t('submissionHub.confidence')}：{t(`submissionHub.confidenceLevels.${item.confidence}`)}</span>
                </div>
              </article>
            ))}
        </div>
      </details>

      {showDiagnosis && (
        <section className="submissions-diagnosis" data-testid="submissions-diagnosis">
          <h3>{t('submissionHub.diagnosisTitle')}</h3>
          <div className="submissions-journal__actions">
            {caseItem.status === 'PROFILE_READY' && (
              <button type="button" className="submissions-primary" disabled={busy !== ''}
                onClick={() => void quickAdvance('DIAGNOSING')}>{t('submissionHub.startDiagnosis')}</button>
            )}
            {caseItem.status !== 'PROFILE_READY' && (
              <button type="button" className="submissions-primary" disabled={busy !== ''}
                onClick={() => void runDiagnosis()}>
                {busy === 'diagnose' ? t('submissionHub.diagnosing') : t('submissionHub.startDiagnosis')}
              </button>
            )}
            {visibleGapItems.length > 0 && (
              <button type="button" className="submissions-secondary" disabled={busy !== ''}
                onClick={() => void createPlan()}>
                {busy === 'plan' ? t('submissionHub.creatingPlan') : t('submissionHub.createPlan')}
              </button>
            )}
          </div>
          {visibleGapItems.length === 0 && <p className="submissions-empty">{t('submissionHub.gapEmpty')}</p>}
          {GAP_SEVERITY_ORDER.map((severity) => {
            const items = visibleGapItems.filter((item) => item.severity === severity);
            if (items.length === 0) return null;
            return (
              <section key={severity} className="submissions-journal__group">
                <h4>{t(`submissionHub.severityLabels.${severity}`)}</h4>
                {items.map((item) => (
                  <article key={item.id} className="submissions-journal__item" data-testid="submissions-gap-item">
                    <div className="submissions-journal__meta">
                      <strong>{item.title}</strong>
                      {item.requiresResearcherJudgment && <span className="submissions-badge warn">{t('submissionHub.requiresJudgment')}</span>}
                    </div>
                    <p>{item.problem}</p>
                    {item.evidence && <p><small>{t('submissionHub.gapEvidence')}：{item.evidence}</small></p>}
                    {item.affectedLocation && <p><small>{t('submissionHub.gapLocation')}：{item.affectedLocation}</small></p>}
                    {item.recommendedAction && <p><small>{t('submissionHub.gapAction')}：{item.recommendedAction}</small></p>}
                    <button type="button" className="submissions-secondary" onClick={() => void dismissGap(item.id)}>{t('submissionHub.dismissGap')}</button>
                  </article>
                ))}
              </section>
            );
          })}
        </section>
      )}

      {plan && (
        <section className="submissions-plan" data-testid="submissions-plan">
          <h3>{t('submissionHub.planTitle')}</h3>
          {planItems.map((item) => (
            <article key={item.id} className="submissions-journal__item" data-testid="submissions-plan-item">
              <label className="submissions-plan__select">
                <input type="checkbox" checked={selectedItemIds.includes(item.id)}
                  disabled={item.status === 'applied' || item.status === 'skipped'}
                  onChange={(event) => setSelectedItemIds((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} />
                <strong>{item.title}</strong>
              </label>
              <div className="submissions-journal__meta">
                <span className="submissions-tier">{t(`submissionHub.planItemStatus.${item.status}`)}</span>
                {item.involvesResearcherJudgment && <span className="submissions-badge warn">{t('submissionHub.involvesJudgment')}</span>}
              </div>
              {item.action && <p>{item.action}</p>}
              {item.risk && <p><small>{t('submissionHub.planItemRisk')}：{item.risk}</small></p>}
            </article>
          ))}
          <div className="submissions-journal__actions">
            {planApprovable && (
              <button type="button" className="submissions-primary" disabled={busy !== ''}
                onClick={() => void approveAndApply()}>
                {busy === 'apply' ? t('submissionHub.applyingPlan') : t('submissionHub.approveAndApply')}
              </button>
            )}
            {planApplied && (
              <button type="button" className="submissions-secondary" disabled={busy !== ''}
                onClick={() => void reverify()}>
                {busy === 'verify' ? t('submissionHub.verifying') : t('submissionHub.reverify')}
              </button>
            )}
          </div>
          {applySummary && (
            <p className="submissions-notice" role="status">
              {t('submissionHub.applyResult', applySummary)}
            </p>
          )}
          {verifyMessage && <p className="submissions-notice" role="status">{verifyMessage}</p>}
        </section>
      )}
    </div>
  );
}
