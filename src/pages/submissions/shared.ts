/**
 * SubmissionsPage 子组件共享的 preload API 访问层。
 * 仅类型声明与 `journalApi()` 取值函数，不含 UI；
 * 被期刊研究区、投稿检查区、最终提交确认、返修工作台共同使用。
 */
import type {
  JournalCorpusItem,
  JournalPatternObservation,
  JournalProfile,
  JournalProfileSnapshot,
  JournalRequirement,
  SubmissionGapItem,
  SubmissionOptimizationItem,
  SubmissionOptimizationPlan,
} from '../../../engine/submission/JournalProfileContract.js';
import type {
  SubmissionPackage,
  SubmissionPackageFile,
  SubmissionPackageFileType,
  SubmissionPreflightCheck,
  SubmissionPreflightRun,
} from '../../../engine/submission/SubmissionPackageContract.js';
import type { ReviewRound, ReviewerComment } from '../../../engine/submission/SubmissionReviewContract.js';
import type { SubmissionCase } from '../../../engine/submission/SubmissionRuntimeContract.js';

/**
 * P1 期刊研究 preload API 的渲染端视图。
 * 由 electron/preload.ts 提供；window.metis 的权威类型来自 preload 导出，
 * 此处以结构化方式声明签名，preload 落地前后均可通过类型检查。
 */
export interface SubmissionJournalApi {
  identifySubmissionJournal?: (args: { projectId: string; caseId?: string; name?: string; issn?: string }) =>
    Promise<{ ok: true; profile: JournalProfile } | { ok: false; code: string }>;
  fetchSubmissionJournalGuidelines?: (args: { projectId: string; caseId: string }) =>
    Promise<{ ok: true; snapshot: JournalProfileSnapshot; requirements: JournalRequirement[]; extraction: 'llm' | 'deterministic' } | { ok: false; code: string }>;
  getSubmissionJournalProfile?: (args: { projectId: string; caseId: string }) =>
    Promise<{
      profile: JournalProfile | null; snapshot: JournalProfileSnapshot | null;
      requirements: JournalRequirement[] | null; observations: JournalPatternObservation[] | null; corpus: JournalCorpusItem[] | null;
    } | null>;
  buildSubmissionJournalCorpus?: (args: { projectId: string; caseId: string }) =>
    Promise<{ ok: true; items: JournalCorpusItem[] } | { ok: false; code: string }>;
  analyzeSubmissionJournalPatterns?: (args: { projectId: string; caseId: string }) =>
    Promise<{ ok: true; observations: JournalPatternObservation[] } | { ok: false; code: string }>;
  diffSubmissionJournalSnapshots?: (args: { projectId: string; caseId: string }) =>
    Promise<{
      added: JournalRequirement[]; removed: JournalRequirement[];
      changed: Array<{ ruleKey: string; before: JournalRequirement | null; after: JournalRequirement | null }>;
    } | null>;
  diagnoseSubmissionCase?: (args: { projectId: string; caseId: string }) =>
    Promise<{ ok: true; items: SubmissionGapItem[] } | { ok: false; code: string }>;
  createSubmissionOptimizationPlan?: (args: { projectId: string; caseId: string; gapItemIds?: string[] }) =>
    Promise<{ ok: true; plan: SubmissionOptimizationPlan; items: SubmissionOptimizationItem[] } | { ok: false; code: string }>;
  getSubmissionOptimizationPlan?: (args: { projectId: string; caseId: string }) =>
    Promise<{ plan: SubmissionOptimizationPlan; items: SubmissionOptimizationItem[] } | null>;
  approveSubmissionOptimizationPlan?: (args: { projectId: string; planId: string; selectedItemIds?: string[] }) =>
    Promise<{ ok: true } | { ok: false; code: string }>;
  applySubmissionOptimizationPlan?: (args: { projectId: string; planId: string; caseId: string }) =>
    Promise<{ ok: true } | { ok: false; code: string }>;
  verifySubmissionOptimizationPlan?: (args: { projectId: string; planId: string }) =>
    Promise<{ ok: true; passed?: boolean; remaining?: SubmissionGapItem[] } | { ok: false; code: string }>;
  updateSubmissionGapItem?: (args: { projectId: string; caseId: string; itemId: string; patch: { status: string } }) =>
    Promise<{ ok: true } | { ok: false; code: string } | null>;
  runSubmissionPreflight?: (args: { projectId: string; caseId: string }) =>
    Promise<{ ok: true; run: SubmissionPreflightRun; checks: SubmissionPreflightCheck[] } | { ok: false; code: string }>;
  getSubmissionPreflight?: (args: { projectId: string; caseId: string }) =>
    Promise<{ run: SubmissionPreflightRun; checks: SubmissionPreflightCheck[] } | null>;
  assembleSubmissionPackage?: (args: { projectId: string; caseId: string }) =>
    Promise<{ ok: true; package: SubmissionPackage; files: SubmissionPackageFile[] } | { ok: false; code: string }>;
  getSubmissionPackage?: (args: { projectId: string; caseId: string }) =>
    Promise<{ package: SubmissionPackage; files: SubmissionPackageFile[] } | null>;
  attachSubmissionPackageOutcome?: (args: { projectId: string; packageId: string; outcomeId: string; type: SubmissionPackageFileType; required?: boolean; note?: string }) =>
    Promise<{ ok: true; file: SubmissionPackageFile } | { ok: false; code: string } | null>;
  removeSubmissionPackageFile?: (args: { projectId: string; packageId: string; fileId: string }) => Promise<boolean>;
  exportSubmissionPackage?: (args: { projectId: string; packageId: string }) =>
    Promise<{ ok: true; dir: string; exported: Array<{ fileId: string; path: string; format: 'docx' | 'markdown' | 'copy' }>; failures: Array<{ fileId: string; code: string; message: string }> } | { ok: false; code: string } | null>;
  freezeSubmissionPackage?: (args: { projectId: string; packageId: string }) =>
    Promise<{ ok: true; package: SubmissionPackage } | { ok: false; code: string; blockers?: SubmissionPreflightCheck[] } | null>;
  validateSubmissionPackage?: (args: { projectId: string; packageId: string }) =>
    Promise<{ ok: true; results: Array<{ fileId: string; validationStatus: string }> } | { ok: false; code: string } | null>;
  generateSubmissionCoverLetter?: (args: { projectId: string; caseId: string }) =>
    Promise<{ ok: true; outcomeId: string; version: number; needsConfirmation: string[]; extraction: 'llm' | 'template' } | { ok: false; code: string }>;
  createSubmissionReviewRound?: (args: { projectId: string; caseId: string; decisionLetterText: string }) =>
    Promise<{ ok: true; roundId: string; parsed: { decision: string; deadline: number | null; reviewerComments: unknown[]; editorComments: unknown[] } } | { ok: false; code: string }>;
  listSubmissionReviewRounds?: (args: { projectId: string; caseId: string }) =>
    Promise<Array<ReviewRound & { comments: ReviewerComment[] }>>;
  updateSubmissionReviewComment?: (args: { projectId: string; commentId: string; patch: { status?: string; responseText?: string } }) =>
    Promise<ReviewerComment | null>;
  beginSubmissionRevision?: (args: { projectId: string; caseId: string }) =>
    Promise<{ ok: true } | { ok: false; code: string }>;
  generateSubmissionResponseLetter?: (args: { projectId: string; caseId: string }) =>
    Promise<{ ok: true; outcomeId: string; version: number; unresolvedCount: number } | { ok: false; code: string }>;
  confirmFinalSubmission?: (args: {
    projectId: string; caseId: string;
    submissionMethod: 'portal_web' | 'email' | 'offline_manual';
    portalUrl?: string; remoteSubmissionId?: string; notes?: string; confirmed: true;
  }) => Promise<{ ok: true; submissionCase: SubmissionCase } | { ok: false; code: string } | null>;
}

export function journalApi(): SubmissionJournalApi | undefined {
  return window.metis as unknown as SubmissionJournalApi | undefined;
}
