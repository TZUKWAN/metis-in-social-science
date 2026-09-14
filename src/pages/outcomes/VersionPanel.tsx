import { RotateCcw } from 'lucide-react';
import { type OutcomeVersion } from '../../../engine/runtime/OutcomeRuntimeContract';

function VersionPanel({ versions, activeVersion, onOpen, onRestore }: { versions: OutcomeVersion[]; activeVersion: number; onOpen: (value: OutcomeVersion) => void; onRestore: (value: OutcomeVersion) => void }) {
  return <aside className="outcome-version-panel" aria-label="成果版本"><header><strong>版本</strong><span>{versions.length} 个</span></header><div>{versions.map((version) => <article key={version.version} className={version.version === activeVersion ? 'active' : ''}><button type="button" onClick={() => onOpen(version)}><b>v{version.version}</b><span>{version.note || '未填写说明'}</span><small>{version.createdBy === 'ai' ? 'AI 修改' : version.createdBy === 'restore' ? '恢复' : '人工修改'}</small></button>{version.version !== activeVersion && <button type="button" className="outcome-version-panel__restore" onClick={() => onRestore(version)} title={`恢复 v${version.version}`}><RotateCcw size={13} /></button>}</article>)}</div></aside>;
}

export { VersionPanel };
