/**
 * 投稿检查与材料区（P2）：预检清单（通过/提醒/必须处理三级）→ 投稿材料包
 * （组装/挂接成果/校验/导出/冻结，冻结后不可改）→ Cover Letter 生成。
 * 冻结前置条件是预检无必须处理项；事实性内容一律标注「需要研究者确认」。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from '../../i18n';
import {
  SUBMISSION_PACKAGE_FILE_TYPES,
  type SubmissionPackage,
  type SubmissionPackageFile,
  type SubmissionPackageFileType,
  type SubmissionPreflightCheck,
  type SubmissionPreflightRun,
} from '../../../engine/submission/SubmissionPackageContract.js';
import type { SubmissionCase } from '../../../engine/submission/SubmissionRuntimeContract.js';
import { journalApi } from './shared';
import { FinalSubmitConfirm } from './FinalSubmitConfirm';

const PREFLIGHT_GROUP_OF: Record<string, 'manuscript' | 'blind' | 'statement' | 'files' | 'other'> = {
  word_count: 'manuscript', abstract: 'manuscript', keywords: 'manuscript', section_structure: 'manuscript',
  reference_style: 'manuscript', figures_tables: 'manuscript', ai_policy: 'manuscript', other: 'other',
  blind_author_names: 'blind', blind_affiliation: 'blind', blind_acknowledgement: 'blind',
  statement_funding: 'statement', statement_coi: 'statement', statement_ethics: 'statement', statement_data_availability: 'statement',
  file_main_manuscript: 'files', file_title_page: 'files', file_cover_letter: 'files', file_supplementary: 'files',
};

export function SubmissionPackageSection({ projectId, caseItem, onRefresh }: {
  projectId: string;
  caseItem: SubmissionCase;
  onRefresh: () => Promise<void> | void;
}) {
  const { t, locale } = useTranslation();
  const zh = locale === 'zh';
  const api = journalApi();
  const [busy, setBusy] = useState<'' | 'preflight' | 'assemble' | 'export' | 'freeze' | 'validate' | 'letter'>('');
  const [message, setMessage] = useState('');
  const [preflight, setPreflight] = useState<{ run: SubmissionPreflightRun; checks: SubmissionPreflightCheck[] } | null>(null);
  const [pkg, setPkg] = useState<{ package: SubmissionPackage; files: SubmissionPackageFile[] } | null>(null);
  const [outcomes, setOutcomes] = useState<Array<{ id: string; title: string; currentVersion: number }>>([]);
  const [attachOutcomeId, setAttachOutcomeId] = useState('');
  const [attachType, setAttachType] = useState<SubmissionPackageFileType>('title_page');
  const [letter, setLetter] = useState<{ title: string; version: number; needsConfirmation: string[]; extraction: 'llm' | 'template' } | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!api) return;
      const pf = await api.getSubmissionPreflight?.({ projectId, caseId: caseItem.id });
      if (alive && pf) setPreflight(pf);
      const latest = await api.getSubmissionPackage?.({ projectId, caseId: caseItem.id });
      if (alive && latest) setPkg(latest);
      if (alive && window.metis?.listOutcomes) {
        const rows = await window.metis.listOutcomes({ projectId, query: '' });
        if (alive) setOutcomes(rows.map((row: { id: string; title: string; currentVersion: number }) => ({ id: row.id, title: row.title, currentVersion: row.currentVersion })));
      }
    })();
    return () => { alive = false; };
  }, [projectId, caseItem.id, api]);

  async function runPreflight(): Promise<void> {
    if (!api?.runSubmissionPreflight || busy) return;
    setBusy('preflight'); setMessage('');
    const result = await api.runSubmissionPreflight({ projectId, caseId: caseItem.id });
    if (result.ok) setPreflight({ run: result.run, checks: result.checks });
    else setMessage(t('submissionHub.journalActionFailed', { code: result.code }));
    setBusy('');
  }

  async function advanceToReady(): Promise<void> {
    if (!window.metis?.changeSubmissionStatus || busy) return;
    setBusy('preflight'); setMessage('');
    const changed = await window.metis.changeSubmissionStatus({
      projectId, change: { caseId: caseItem.id, to: 'READY_TO_SUBMIT', reason: '投稿检查通过', source: 'human' },
    });
    if (changed && !('ok' in changed)) await onRefresh();
    else setMessage(t('submissionHub.journalActionFailed', { code: 'illegal_transition' }));
    setBusy('');
  }

  async function assemble(): Promise<void> {
    if (!api?.assembleSubmissionPackage || busy) return;
    setBusy('assemble'); setMessage('');
    const result = await api.assembleSubmissionPackage({ projectId, caseId: caseItem.id });
    if (result.ok) setPkg({ package: result.package, files: result.files });
    else setMessage(t('submissionHub.journalActionFailed', { code: result.code }));
    setBusy('');
  }

  async function attachOutcomeFile(): Promise<void> {
    if (!api?.attachSubmissionPackageOutcome || !pkg || !attachOutcomeId || busy) return;
    setBusy('assemble'); setMessage('');
    const result = await api.attachSubmissionPackageOutcome({ projectId, packageId: pkg.package.id, outcomeId: attachOutcomeId, type: attachType, required: false });
    if (result?.ok) setPkg({ package: pkg.package, files: [...pkg.files.filter((file) => file.id !== result.file.id), result.file] });
    else setMessage(t('submissionHub.journalActionFailed', { code: result && 'code' in result ? result.code : 'failed' }));
    setBusy('');
  }

  async function removeFile(fileId: string): Promise<void> {
    if (!api?.removeSubmissionPackageFile || !pkg || pkg.package.status === 'frozen') return;
    const okRemoved = await api.removeSubmissionPackageFile({ projectId, packageId: pkg.package.id, fileId });
    if (okRemoved) setPkg({ package: pkg.package, files: pkg.files.filter((file) => file.id !== fileId) });
  }

  async function exportPackage(): Promise<void> {
    if (!api?.exportSubmissionPackage || !pkg || busy) return;
    setBusy('export'); setMessage('');
    const result = await api.exportSubmissionPackage({ projectId, packageId: pkg.package.id });
    if (result?.ok) {
      const parts = [t('submissionHub.exportDone', { count: result.exported.length, dir: result.dir })];
      if (result.failures.length > 0) parts.push(t('submissionHub.exportFailed', { count: result.failures.length }));
      setMessage(parts.join(' '));
    } else setMessage(t('submissionHub.journalActionFailed', { code: result && 'code' in result ? result.code : 'failed' }));
    setBusy('');
  }

  async function validatePackage(): Promise<void> {
    if (!api?.validateSubmissionPackage || !pkg || busy) return;
    setBusy('validate'); setMessage('');
    const result = await api.validateSubmissionPackage({ projectId, packageId: pkg.package.id });
    if (result?.ok) {
      const byId = new Map(result.results.map((row) => [row.fileId, row.validationStatus]));
      setPkg({ package: pkg.package, files: pkg.files.map((file) => ({ ...file, validationStatus: byId.get(file.id) ?? file.validationStatus }) as SubmissionPackageFile) });
    } else setMessage(t('submissionHub.journalActionFailed', { code: result && 'code' in result ? result.code : 'failed' }));
    setBusy('');
  }

  async function freeze(): Promise<void> {
    if (!api?.freezeSubmissionPackage || !pkg || busy) return;
    setBusy('freeze'); setMessage('');
    const result = await api.freezeSubmissionPackage({ projectId, packageId: pkg.package.id });
    if (result?.ok) setPkg({ package: result.package, files: pkg.files });
    else if (result && 'blockers' in result) setMessage(t('submissionHub.freezeBlocked'));
    else setMessage(t('submissionHub.journalActionFailed', { code: result && 'code' in result ? result.code : 'failed' }));
    setBusy('');
  }

  async function generateLetter(): Promise<void> {
    if (!api?.generateSubmissionCoverLetter || busy) return;
    setBusy('letter'); setMessage('');
    const result = await api.generateSubmissionCoverLetter({ projectId, caseId: caseItem.id });
    if (result.ok) {
      const target = outcomes.find((row) => row.id === result.outcomeId);
      setLetter({ title: target?.title ?? `Cover Letter｜${caseItem.targetJournalName}`, version: result.version, needsConfirmation: result.needsConfirmation, extraction: result.extraction });
      await onRefresh();
    } else setMessage(t('submissionHub.journalActionFailed', { code: result.code }));
    setBusy('');
  }

  /**
   * 邮箱一键投稿（刘总 2026-09）：用本机邮件客户端打开预填的投稿邮件
   * （收件人=期刊投稿邮箱，主题=论文标题，正文=投稿信/案例信息）。
   * mailto 无法携带附件，附件需在邮件客户端手动添加——界面上如实说明。
   */
  function openMailSubmission(): void {
    const journalName = caseItem.targetJournalName || 'Target Journal';
    const remembered = (() => {
      try { return window.localStorage.getItem(`metis:sub-email:${journalName}`) ?? ''; } catch { return ''; }
    })();
    const raw = window.prompt(locale === 'zh' ? `${journalName} 的投稿邮箱：` : `Submission email for ${journalName}:`, remembered);
    if (raw === null) return;
    const email = raw.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
      setMessage(locale === 'zh' ? '邮箱格式不正确，未打开邮件客户端。' : 'That email address is not valid; the mail client was not opened.');
      return;
    }
    try { window.localStorage.setItem(`metis:sub-email:${journalName}`, email); } catch { /* best-effort */ }
    const NL = String.fromCharCode(10);
    const subject = `${locale === 'zh' ? '投稿' : 'Submission'}: ${caseItem.title || (locale === 'zh' ? '未命名稿件' : 'Untitled manuscript')}`.trim();
    const bodyLines = [
      `${locale === 'zh' ? '尊敬的编辑部' : 'Dear Editors'},`,
      '',
      zh
        ? `您好！现投稿论文《${caseItem.title || ''}》，拟投贵刊 ${journalName}。投稿材料（正文与附件）见本邮件附件。`
        : `Please find our manuscript "${caseItem.title || ''}" submitted for consideration at ${journalName}. The manuscript and supplementary files are attached.`,
      '',
      `${locale === 'zh' ? '稿件类型' : 'Article type'}: ${caseItem.articleType ?? (locale === 'zh' ? '未指定' : 'unspecified')}`,
      '',
      letter?.extraction ? String(letter.extraction).slice(0, 2_000) : '',
      '',
      locale === 'zh' ? '（此邮件由 METIS 投稿工作台预填生成。）' : '(Prefilled by the METIS submission workbench.)',
    ];
    const mailto = `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(bodyLines.filter((line) => line !== '').join(NL.repeat(2)))}`;
    window.location.href = mailto;
    setMessage(locale === 'zh' ? '已打开邮件客户端；请在发送前手动添加正文与附件文件。' : 'The mail client is open; attach the manuscript and files before sending.');
  }

  const frozen = pkg?.package.status === 'frozen';
  const preflightGroups: Array<{ key: 'manuscript' | 'blind' | 'statement' | 'files' | 'other'; items: SubmissionPreflightCheck[] }> = [];
  if (preflight) {
    for (const group of ['manuscript', 'blind', 'statement', 'files', 'other'] as const) {
      const items = preflight.checks.filter((check) => (PREFLIGHT_GROUP_OF[check.checkKey] ?? 'other') === group);
      if (items.length > 0) preflightGroups.push({ key: group, items });
    }
  }
  const blockedCount = preflight?.run.blockCount ?? 0;

  return (
    <div className="submissions-journal submissions-package" data-testid="submission-package-section">
      <h3>{t('submissionHub.preflightTitle')}</h3>
      <button type="button" className="submissions-secondary" disabled={busy !== ''} onClick={() => void runPreflight()}>
        {busy === 'preflight' && preflight === null ? t('submissionHub.runningPreflight') : t('submissionHub.runPreflight')}
      </button>
      {!preflight && <p className="submissions-empty">{t('submissionHub.preflightNone')}</p>}
      {preflight && (
        <div className="submissions-preflight">
          <p className={blockedCount > 0 ? 'submissions-badge warn' : 'submissions-badge'}>
            {blockedCount > 0
              ? t('submissionHub.preflightSummary', { block: blockedCount, warn: preflight.run.warnCount })
              : t('submissionHub.preflightPassed')}
          </p>
          {blockedCount > 0 && <p className="submissions-gap__problem">{t('submissionHub.preflightBlockedHint')}</p>}
          {preflightGroups.map((group) => (
            <div key={group.key} className="submissions-requirements-group">
              <strong>{t(`submissionHub.preflightGroups.${group.key}`)}</strong>
              <ul>
                {group.items.map((check) => (
                  <li key={check.id} className={`submissions-preflight__item level-${check.level}`}>
                    <span className={`submissions-tier ${check.level === 'pass' ? 'ok' : check.level === 'block' ? 'bad' : 'warn'}`}>
                      {t(`submissionHub.checkLevel.${check.level}`)}
                    </span>
                    <span>{check.label}</span>
                    <small>{check.detail}</small>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <button type="button" className="submissions-primary" disabled={blockedCount > 0 || busy !== ''}
            onClick={() => void advanceToReady()}>{t('submissionHub.readyToSubmit')}</button>
          <button type="button" className="submissions-secondary" disabled={busy !== ''} data-testid="submission-mailto"
            onClick={openMailSubmission}>{zh ? '邮箱一键投稿' : 'Submit via email'}</button>
        </div>
      )}

      <h3>{t('submissionHub.packageTitle')}</h3>
      <button type="button" className="submissions-secondary" disabled={busy !== ''} onClick={() => void assemble()}>
        {busy === 'assemble' ? t('submissionHub.assembling') : t('submissionHub.assemblePackage')}
      </button>
      {!pkg && <p className="submissions-empty">{t('submissionHub.packageNone')}</p>}
      {pkg && (
        <div className="submissions-package__body">
          {frozen && <p className="submissions-badge ok">{t('submissionHub.frozenBadge', { round: pkg.package.round })}</p>}
          <ul className="submissions-package-files">
            {pkg.files.map((file) => (
              <li key={file.id}>
                <span className="submissions-tier">{t(`submissionHub.fileTypeLabels.${file.type}`)}</span>
                <span>{file.filename}</span>
                {file.required && <span className="submissions-badge warn">{t('submissionHub.requiredFile')}</span>}
                <span className={`submissions-tier ${file.validationStatus === 'valid' ? 'ok' : file.validationStatus === 'invalid' ? 'bad' : ''}`}>
                  {t(`submissionHub.validationLabels.${file.validationStatus}`)}
                </span>
                {!frozen && <button type="button" className="submissions-secondary" onClick={() => void removeFile(file.id)}>{t('submissionHub.removeFile')}</button>}
              </li>
            ))}
          </ul>
          {!frozen && (
            <div className="submissions-package-attach">
              <label>
                <span>{t('submissionHub.attachTypeLabel')}</span>
                <select value={attachType} onChange={(event) => setAttachType(event.target.value as SubmissionPackageFileType)}>
                  {SUBMISSION_PACKAGE_FILE_TYPES.filter((type) => type !== 'main_manuscript').map((type) => (
                    <option key={type} value={type}>{t(`submissionHub.fileTypeLabels.${type}`)}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>{t('submissionHub.attachOutcome')}</span>
                <select value={attachOutcomeId} onChange={(event) => setAttachOutcomeId(event.target.value)}>
                  <option value="">{t('submissionHub.attachOutcomePlaceholder')}</option>
                  {outcomes.map((outcome) => (
                    <option key={outcome.id} value={outcome.id}>{outcome.title}</option>
                  ))}
                </select>
              </label>
              <button type="button" className="submissions-secondary" disabled={!attachOutcomeId || busy !== ''}
                onClick={() => void attachOutcomeFile()}>{t('submissionHub.attachOutcome')}</button>
            </div>
          )}
          <div className="submissions-package-actions">
            <button type="button" className="submissions-secondary" disabled={busy !== ''} onClick={() => void validatePackage()}>{t('submissionHub.validatePackage')}</button>
            <button type="button" className="submissions-secondary" disabled={busy !== ''} onClick={() => void exportPackage()}>
              {busy === 'export' ? t('submissionHub.exporting') : t('submissionHub.exportPackage')}
            </button>
            {!frozen && (
              <button type="button" className="submissions-primary" disabled={busy !== ''} onClick={() => void freeze()}>
                {busy === 'freeze' ? t('submissionHub.freezing') : t('submissionHub.freezePackage')}
              </button>
            )}
          </div>
        </div>
      )}

      <h3>{t('submissionHub.coverLetterTitle')}</h3>
      <button type="button" className="submissions-secondary" disabled={busy !== ''} onClick={() => void generateLetter()}>
        {busy === 'letter' ? t('submissionHub.generatingLetter') : letter ? t('submissionHub.regenerateCoverLetter') : t('submissionHub.generateCoverLetter')}
      </button>
      {letter && (
        <div className="submissions-cover-letter">
          <p className="submissions-notice">{t('submissionHub.coverLetterDone', { title: letter.title, version: letter.version })}</p>
          {letter.extraction === 'template' && <p><small>{t('submissionHub.coverLetterTemplateNote')}</small></p>}
          {letter.needsConfirmation.length > 0 && (
            <div className="submissions-badge warn">
              <span>{t('submissionHub.coverLetterNeedsConfirmation')}</span>
              <ul>{letter.needsConfirmation.map((item, index) => <li key={index}>{item}</li>)}</ul>
            </div>
          )}
        </div>
      )}

      {(caseItem.status === 'READY_TO_SUBMIT' || caseItem.status === 'READY_TO_RESUBMIT') && pkg?.package.status === 'frozen' && (
        <FinalSubmitConfirm projectId={projectId} caseItem={caseItem} preflightPassed={(preflight?.run.passed ?? false)} onRefresh={onRefresh} />
      )}

      {message && <p className="submissions-notice" role="status">{message}</p>}
    </div>
  );
}
