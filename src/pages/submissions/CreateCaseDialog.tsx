/**
 * 新建投稿弹窗（从成果出发）：指定期刊（specify）或匹配期刊（match，
 * 可勾选分层类别与语言，生成 TargetingCriteria）。
 * CASE C 换刊会以 match 模式打开并沿用同一 Submission Series。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from '../../i18n';
import {
  SUBMISSION_VENUE_CATEGORIES,
  type SubmissionCase,
  type SubmissionVenueCategory,
  type TargetingCriteria,
} from '../../../engine/submission/SubmissionRuntimeContract.js';

interface OutcomeSummaryLite { id: string; title: string; kind: string; currentVersion: number }

const VENUE_CATEGORY_KEYS: SubmissionVenueCategory[] = [...SUBMISSION_VENUE_CATEGORIES];

export function CreateCaseDialog({ projectId, initialMode = 'specify', seriesId = null, onClose, onCreated }: {
  projectId: string | null;
  /** CASE C 换刊入口会以 match 模式打开并沿用同一 Submission Series。 */
  initialMode?: 'match' | 'specify';
  seriesId?: string | null;
  onClose: () => void;
  onCreated: (caseId: string) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [outcomes, setOutcomes] = useState<OutcomeSummaryLite[]>([]);
  const [outcomeId, setOutcomeId] = useState('');
  const [mode, setMode] = useState<'match' | 'specify'>(initialMode);
  const [journal, setJournal] = useState('');
  const [articleType, setArticleType] = useState('');
  const [error, setError] = useState('');
  const [categories, setCategories] = useState<SubmissionVenueCategory[]>([]);
  const [language, setLanguage] = useState<'zh' | 'en' | 'any'>('any');
  const criteria: TargetingCriteria | null = mode === 'match' && categories.length > 0
    ? { categories, language, notes: '' }
    : null;

  useEffect(() => {
    void (async () => {
      if (!projectId || !window.metis?.listOutcomes) return;
      const rows = await window.metis.listOutcomes({ projectId, query: '' });
      setOutcomes(rows);
      if (rows.length > 0) setOutcomeId(rows[0]!.id);
    })();
  }, [projectId]);

  async function submit(): Promise<void> {
    if (!projectId || !window.metis?.createSubmissionCase || !outcomeId) return;
    const outcome = outcomes.find((item) => item.id === outcomeId);
    if (!outcome) return;
    if (mode === 'specify' && !journal.trim()) return;
    const result = await window.metis.createSubmissionCase({
      projectId,
      title: outcome.title,
      sourceOutcomeId: outcome.id,
      sourceOutcomeVersion: outcome.currentVersion,
      targetJournalName: mode === 'specify' ? journal.trim() : '',
      articleType: (articleType || null) as SubmissionCase['articleType'],
      initialStatus: mode === 'specify' ? 'JOURNAL_SELECTED' : 'TARGETING',
      targetingCriteria: criteria,
      seriesId,
    });
    if (result && 'ok' in result && result.ok === false && result.code === 'duplicate_active') {
      setError(`${t('submissionHub.duplicateActive')}（${t('submissionHub.duplicateActiveJournal')}: ${result.activeJournal || t('submissionHub.noJournal')}）. ${t('submissionHub.duplicateActiveHint')}`);
      return;
    }
    // createCase resolves with { series, submissionCase } (no `ok` flag); null means rejection.
    if (result && 'submissionCase' in result) {
      await onCreated(result.submissionCase.id);
    }
  }

  return (
    <div className="outcomes-modal-backdrop" role="presentation">
      <form className="outcomes-modal" role="dialog" aria-modal="true" aria-label={t('submissionHub.createTitle')}
        onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <header><strong>{t('submissionHub.createTitle')}</strong><button type="button" onClick={onClose} aria-label="关闭">×</button></header>
        <label>{t('submissionHub.createOutcome')}
          <select value={outcomeId} onChange={(event) => setOutcomeId(event.target.value)}>
            {outcomes.map((item) => <option key={item.id} value={item.id}>{item.title}（{item.kind}）</option>)}
          </select>
        </label>
        <fieldset className="submissions-create-mode">
          <label>
            <input type="radio" name="submission-mode" checked={mode === 'specify'} onChange={() => setMode('specify')} />
            {t('submissionHub.createModeSpecify')}
          </label>
          {mode === 'specify' && (
            <>
              <input className="settings-input" value={journal} placeholder={t('submissionHub.createJournalPlaceholder')}
                aria-label={t('submissionHub.createJournalPlaceholder')}
                onChange={(event) => setJournal(event.target.value)} />
              <label>{t('submissionHub.createArticleType')}
                <select value={articleType} aria-label={t('submissionHub.createArticleType')}
                  onChange={(event) => setArticleType(event.target.value)}>
                  <option value="">{t('submissionHub.articleTypes.none')}</option>
                  {['research_article', 'review', 'short_communication', 'letter', 'case_report', 'conference_paper', 'thesis_chapter', 'other'].map((kind) => (
                    <option key={kind} value={kind}>{t(`submissionHub.articleTypes.${kind}`)}</option>
                  ))}
                </select>
              </label>
            </>
          )}
          <label>
            <input type="radio" name="submission-mode" checked={mode === 'match'} onChange={() => setMode('match')} />
            {t('submissionHub.createModeMatch')}
          </label>
          {mode === 'match' && <>
            <p className="submissions-create-hint">{t('submissionHub.createModeMatchHint')}</p>
            <div className="submissions-criteria" role="group" aria-label={t('submissionHub.targetingTitle')}>
              {VENUE_CATEGORY_KEYS.map((category) => (
                <label key={category} className="submissions-criteria__item">
                  <input type="checkbox" checked={categories.includes(category)}
                    onChange={(event) => setCategories((current) => event.target.checked ? [...current, category] : current.filter((item) => item !== category))} />
                  {t(`submissionHub.venueCategories.${category}`)}
                </label>
              ))}
            </div>
            <label>{t('submissionHub.targetingLanguage')}
              <select value={language} aria-label={t('submissionHub.targetingLanguage')} onChange={(event) => setLanguage(event.target.value as 'zh' | 'en' | 'any')}>
                <option value="any">{t('submissionHub.languageAny')}</option>
                <option value="zh">{t('submissionHub.languageZh')}</option>
                <option value="en">{t('submissionHub.languageEn')}</option>
              </select>
            </label>
          </>}
        </fieldset>
        {error && <p className="submissions-notice" role="alert">{error}</p>}
        <footer>
          <button type="button" onClick={onClose}>{t('submissionHub.createCancel')}</button>
          <button className="primary" type="submit" disabled={mode === 'specify' && !journal.trim()}>{t('submissionHub.createConfirm')}</button>
        </footer>
      </form>
    </div>
  );
}
