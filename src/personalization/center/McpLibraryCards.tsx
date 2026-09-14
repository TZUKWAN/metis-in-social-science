import type { PersonalizationDefinition } from '../../../engine/runtime/PersonalizationRuntimeContract.js';
import McpCredentialPanel from '../McpCredentialPanel';
import { missingMcpSecrets, type PersonalizationSecretVaultHandle } from '../mcpCredentialVault.js';

/** MCP 库卡片网格：凭据缺失标记、凭据录入入口、对话优化、副本/删除操作。 */
export function McpLibraryCards({
  zh,
  definitions,
  selectedId,
  draftIds,
  vault,
  secretsEditorId,
  onSelect,
  onToggleSecrets,
  onOptimizeViaChat,
  onFork,
  onArchive,
}: {
  zh: boolean;
  definitions: readonly PersonalizationDefinition[];
  selectedId: string | null;
  draftIds: ReadonlySet<string>;
  vault: PersonalizationSecretVaultHandle;
  secretsEditorId: string | null;
  onSelect: (definitionId: string) => void;
  onToggleSecrets: (definitionId: string) => void;
  onOptimizeViaChat: (definition: PersonalizationDefinition) => void;
  onFork: (definition: PersonalizationDefinition) => void;
  onArchive: (definition: PersonalizationDefinition) => void;
}) {
  return (
    <div className="personalization-cards">
      {definitions.map((definition, index) => {
        // 卡片序号跨分组连续，保证 data-testid 稳定（当前仅 MCP 平铺一组，序号即列表位置）。
        // 刘总反馈（2026-10）：已启用且声明了凭据但凭据库缺失的 MCP，条目上打「凭据未配置」标记。
        const mcpMissing = definition.kind === 'mcp' ? missingMcpSecrets(definition, vault.secretNames) : [];
        const isBuiltin = definition.provenance.origin === 'builtin';
        return <article key={definition.id} className={`personalization-card ${selectedId === definition.id ? 'selected' : ''}`}>
            <button className="personalization-card__select" data-definition-id={definition.id} onClick={() => onSelect(definition.id)}>
              <span className="personalization-card__meta"><b>{isBuiltin ? (zh ? '内置' : 'Built-in') : (zh ? '自定义' : 'Custom')}</b><span>r{definition.revision}</span></span>
              <strong>{definition.name}</strong>
              <span>{definition.description || (zh ? '暂无说明' : 'No description')}</span>
            </button>
            <div className="personalization-card__actions">
              {draftIds.has(definition.id) && <span className="personalization-card__draft">{zh ? '草稿已保留' : 'Draft preserved'}</span>}
              {mcpMissing.length > 0 && (
                <span className="personalization-card__secrets-missing" data-testid={`personalization-mcp-secrets-missing-${index}`}>
                  {zh ? `凭据未配置（${mcpMissing.join('、')}）` : `Credentials missing (${mcpMissing.join(', ')})`}
                </span>
              )}
              {definition.kind === 'mcp' && (
                <button
                  type="button"
                  data-testid={`personalization-mcp-secrets-${index}`}
                  aria-expanded={secretsEditorId === definition.id}
                  onClick={() => onToggleSecrets(definition.id)}
                >
                  {zh ? '凭据' : 'Credentials'}
                </button>
              )}
              <button
                type="button"
                data-testid={`personalization-studio-optimize-${index}`}
                onClick={() => {
                  if (definition.kind === 'mcp') onOptimizeViaChat(definition);
                }}
              >
                {zh ? '对话优化' : 'Improve via chat'}
              </button>
              {isBuiltin
                ? <button onClick={() => onFork(definition)}>{zh ? '创建可编辑副本' : 'Create editable copy'}</button>
                : <button onClick={() => onArchive(definition)}>{zh ? '删除' : 'Delete'}</button>}
            </div>
            {definition.kind === 'mcp' && secretsEditorId === definition.id && (
              <McpCredentialPanel definition={definition} vault={vault} testId={`personalization-mcp-secrets-panel-${index}`} />
            )}
        </article>;
        })}
    </div>
  );
}
