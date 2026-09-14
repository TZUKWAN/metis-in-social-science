import type { PersonalizationIntegrityIssue } from '../../../engine/runtime/PersonalizationRuntimeContract.js';

/** 完整性恢复面板：展示被隔离的保存异常，并支持从已验证历史版本恢复。 */
export function IntegrityRecoveryNotice({
  zh,
  issues,
  recoveringIssueId,
  onRecover,
}: {
  zh: boolean;
  issues: readonly PersonalizationIntegrityIssue[];
  recoveringIssueId: string | null;
  onRecover: (issue: PersonalizationIntegrityIssue) => void;
}) {
  return <section className="personalization-integrity-notice" role="alert" aria-label={zh ? '场景完整性恢复' : 'Personalization integrity recovery'}>
    <strong>{zh ? '发现已隔离的保存异常' : 'Quarantined saved items detected'}</strong>
    <p>{zh ? '这些定义没有通过版本完整性校验，因此不会被执行或静默当作不存在。可以仅从已验证历史版本恢复；异常快照会保留用于审计。' : 'These definitions failed version-integrity verification, so they are not executed or silently treated as absent. Recovery only uses verified history and retains the quarantined snapshot.'}</p>
    <div>
      {issues.map((issue) => <article key={issue.id}>
        <span><strong>{issue.id}</strong><small>{zh ? `当前 r${issue.currentRevision}：${issue.code}` : `current r${issue.currentRevision}: ${issue.code}`}</small></span>
        {issue.latestVerifiedRevision === null
          ? <em>{zh ? '没有可验证历史版本；保持隔离。' : 'No verified history; remains quarantined.'}</em>
          : <button type="button" disabled={recoveringIssueId === issue.id} onClick={() => onRecover(issue)}>{recoveringIssueId === issue.id ? (zh ? '恢复中…' : 'Recovering…') : (zh ? `从可信 r${issue.latestVerifiedRevision} 恢复` : `Recover from trusted r${issue.latestVerifiedRevision}`)}</button>}
      </article>)}
    </div>
  </section>;
}
