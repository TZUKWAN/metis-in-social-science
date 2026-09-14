import { RotateCcw } from 'lucide-react';
import type { ArchivedPersonalizationDefinition } from '../../../engine/runtime/PersonalizationRuntimeContract.js';

/** 回收站条目的剩余保留天数（向上取整，永不低于 0）。 */
function remainingTrashDays(expiresAt: number): number {
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / (24 * 60 * 60 * 1000)));
}

/** 库面板回收站视图（技能/MCP/Metis.md 共用）：恢复 / 两步彻底删除。 */
export function LibraryTrashPanel({
  zh,
  items,
  isEmpty,
  trashDeleteId,
  onRequestPurge,
  onCancelPurge,
  onPurge,
  onRestore,
}: {
  zh: boolean;
  items: readonly ArchivedPersonalizationDefinition[];
  isEmpty: boolean;
  trashDeleteId: string | null;
  onRequestPurge: (definitionId: string) => void;
  onCancelPurge: () => void;
  onPurge: (item: ArchivedPersonalizationDefinition) => void;
  onRestore: (item: ArchivedPersonalizationDefinition) => void;
}) {
  return <>
    {isEmpty && (
      <p>{zh
        ? '回收站为空。已删除内容保留 7 天，到期自动清理；也可在此恢复或彻底删除。'
        : 'Trash is empty. Deleted items are kept for 7 days, then cleaned up automatically; restore or purge them here.'}</p>
    )}
    <div className="personalization-cards">
      {items.map((item, index) => (
        <article key={item.definition.id} className="personalization-card personalization-card--trashed">
          <div className="personalization-card__select personalization-card__select--static" data-testid={`personalization-trash-item-${index}`}>
            <span className="personalization-card__meta"><b>{item.definition.provenance.origin === 'url' ? (zh ? 'URL 安装' : 'URL install') : (zh ? '自定义' : 'Custom')}</b><span>r{item.definition.revision}</span></span>
            <strong>{item.definition.name}</strong>
            <span>{zh
              ? `剩余 ${remainingTrashDays(item.expiresAt)} 天后自动清理`
              : `${remainingTrashDays(item.expiresAt)} day(s) until automatic cleanup`}</span>
          </div>
          <div className="personalization-card__actions">
            {trashDeleteId === item.definition.id ? (
              <span className="personalization-card__delete-confirm">
                {zh ? '彻底删除？不可恢复' : 'Purge forever? Irreversible'}
                <button
                  className="personalization-card__delete personalization-card__delete--armed"
                  data-testid={`personalization-trash-purge-confirm-${index}`}
                  onClick={() => onPurge(item)}
                >
                  {zh ? '确认彻底删除' : 'Confirm purge'}
                </button>
                <button onClick={onCancelPurge}>{zh ? '取消' : 'Cancel'}</button>
              </span>
            ) : (
              <>
                <button data-testid={`personalization-trash-restore-${index}`} onClick={() => onRestore(item)}>
                  <RotateCcw size={12} />{zh ? '恢复' : 'Restore'}
                </button>
                <button
                  className="personalization-card__delete"
                  data-testid={`personalization-trash-purge-${index}`}
                  title={zh ? '永久删除该内容及其全部版本历史' : 'Permanently delete this item and its version history'}
                  onClick={() => onRequestPurge(item.definition.id)}
                >
                  {zh ? '彻底删除' : 'Purge'}
                </button>
              </>
            )}
          </div>
        </article>
      ))}
    </div>
  </>;
}
