import type { PersonalizationDefinition } from '../../../engine/runtime/PersonalizationRuntimeContract.js';
import type { Kind } from './shared.js';

export function DefinitionReferencePicker({
  label,
  help,
  kind,
  definitions,
  selectedIds,
  onChange,
  filter,
  emptyLabel,
  compact = false,
  onCreate,
  createLabel,
}: {
  label: string;
  help: string;
  kind: Kind;
  definitions: readonly PersonalizationDefinition[];
  selectedIds: readonly string[];
  onChange: (ids: string[]) => void;
  filter?: (definition: PersonalizationDefinition) => boolean;
  emptyLabel: string;
  compact?: boolean;
  onCreate?: () => void;
  createLabel?: string;
}) {
  const candidates = definitions.filter((definition) => (
    definition.kind === kind
    && (definition.enabled || selectedIds.includes(definition.id))
    && (!filter || filter(definition) || selectedIds.includes(definition.id))
  ));
  const selected = new Set(selectedIds);
  return <fieldset className={`personalization-reference-picker${compact ? ' is-compact' : ''}`}>
    <legend>{label}</legend>
    <p>{help}</p>
    {candidates.length === 0
      ? <div className="personalization-reference-picker__empty">
          <span>{emptyLabel}</span>
          {onCreate && <button type="button" className="btn-sm btn-secondary" onClick={onCreate} data-testid={`quick-create-${kind}`}>{createLabel ?? (kind === 'agent' ? '新建智能体' : kind === 'skill' ? '新建技能' : kind === 'mcp' ? '新建 MCP' : '新建 Metis.md')}</button>}
        </div>
      : <div className="personalization-reference-picker__options">
          {candidates.map((definition) => <label key={definition.id} data-definition-id={definition.id}>
            <input
              type="checkbox"
              checked={selected.has(definition.id)}
              onChange={(event) => {
                const next = event.target.checked
                  ? [...selectedIds, definition.id]
                  : selectedIds.filter((id) => id !== definition.id);
                onChange([...new Set(next)]);
              }}
            />
            <span>
              <strong>{definition.name}</strong>
              <small>{definition.provenance.origin === 'builtin' ? 'Metis' : (definition.description || definition.id)}</small>
            </span>
          </label>)}
        </div>}
  </fieldset>;
}
