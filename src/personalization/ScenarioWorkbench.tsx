/**
 * Scenario workbench: a focused editor backed by the durable personalization
 * repository.  Authoring stays simple while retries, checkpoints and recovery
 * remain runtime concerns rather than user-facing configuration.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, RotateCcw, Trash2, X } from 'lucide-react';
import type {
  ArchivedPersonalizationDefinition,
  DeliverableSpec,
  PersonalizationDefinition,
  ReferenceMaterial,
  ScenarioDefinition,
  WorkflowStepBinding,
} from '../../engine/runtime/PersonalizationRuntimeContract.js';
import { assessScenarioHarness, normalizeScenarioHarness } from '../../engine/personalization/ScenarioHarness.js';
import { cloneDefinition } from './personalizationLib.js';
import { setScenarioDirtyGuard } from '../lib/scenarioDirtyGuard.js';
import ScenarioConfigurationAssistant, { type ScenarioAssistantActionResult, type ScenarioAssistantIdentity } from './ScenarioConfigurationAssistant.js';
import ScenarioFocusedEditor from './ScenarioFocusedEditor.js';
import { ExtensionInstaller } from './ExtensionInstaller.js';
import MarketBrowserPanel from './MarketBrowserPanel.js';
import './scenarioWorkbench.css';

type AcquireMode = 'search' | 'package' | 'url';
type Acquisition = { kind: 'skill' | 'mcp'; stepId: string; mode: AcquireMode } | null;

export type WorkbenchTab = 'overview' | 'structure' | 'rules' | 'adapt' | 'capability';

function draftId(): string {
  return `step-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function nestedOrder(steps: readonly WorkflowStepBinding[], parentStepId: string | null = null): string[] {
  return steps
    .filter((step) => (step.parentStepId ?? null) === parentStepId)
    .flatMap((step) => [step.id, ...nestedOrder(steps, step.id)]);
}

/** A Scenario is deliberately serial: every authored step consumes prior work. */
function normalizeSerialWorkflow(scenario: ScenarioDefinition): void {
  const orderedIds = nestedOrder(scenario.workflow);
  const allIds = new Set(scenario.workflow.map((step) => step.id));
  const safeOrder = orderedIds.length === allIds.size
    ? orderedIds
    : scenario.workflow.map((step) => step.id);
  const position = new Map(safeOrder.map((id, index) => [id, index]));
  scenario.workflow = [...scenario.workflow]
    .sort((left, right) => (position.get(left.id) ?? 0) - (position.get(right.id) ?? 0))
    .map((step, index) => ({
      ...step,
      dependsOn: index === 0 ? [] : [safeOrder[index - 1]!],
    }));
}

function removeStepAndDescendants(scenario: ScenarioDefinition, stepId: string): void {
  const removed = new Set<string>([stepId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of scenario.workflow) {
      if (step.parentStepId && removed.has(step.parentStepId) && !removed.has(step.id)) {
        removed.add(step.id);
        changed = true;
      }
    }
  }
  scenario.workflow = scenario.workflow.filter((step) => !removed.has(step.id));
}

function ensureDeliverable(scenario: ScenarioDefinition): void {
  if (!scenario.deliverable) {
    scenario.deliverable = {
      type: 'custom',
      language: 'zh',
      globalLength: '',
      structurePolicy: { defaultSections: 1, suggestedMin: 1, suggestedMax: 1 },
      sections: [],
      secondarySections: { min: 3, max: 5 },
    } satisfies DeliverableSpec;
  }
  if (!scenario.output.plan) {
    scenario.output.plan = {
      primaryDeliverable: scenario.name.trim() || 'Scenario deliverable',
      supportingArtifacts: [],
      qualityCriteria: [],
    };
  }
}

function mutationMessage(code: string | undefined, zh: boolean): string {
  if (code === 'revision_conflict') return zh ? '保存冲突：已重新载入最新版本，请检查后重试。' : 'Save conflict: the latest version has been reloaded. Review and try again.';
  return zh ? '保存未完成，当前编辑仍保留。' : 'Save did not complete; the current edits are retained.';
}

const CATEGORY_PREFIX = 'category:';
const UNCATEGORIZED = '__uncategorized__';
const ALL_CATEGORIES = '__all__';

function scenarioCategory(scenario: ScenarioDefinition): string {
  const marker = scenario.tags.find((tag) => tag.startsWith(CATEGORY_PREFIX));
  return marker?.slice(CATEGORY_PREFIX.length).trim() ?? '';
}

function updateScenarioCategory(scenario: ScenarioDefinition, category: string): void {
  const clean = category.trim().replace(/\s+/gu, ' ');
  scenario.tags = [
    ...scenario.tags.filter((tag) => !tag.startsWith(CATEGORY_PREFIX)),
    ...(clean ? [`${CATEGORY_PREFIX}${clean}`] : []),
  ];
}

export default function ScenarioWorkbench({
  zh, definitions, archivedScenarios = [], selectedId, onSelect, save, createScenario, onActivateScenario, onDeleteScenario, onRestoreScenario, reload, projectId = null,
}: {
  zh: boolean;
  /** 当前激活项目；用于把助手对话历史按项目+场景隔离持久化。 */
  projectId?: string | null;
  definitions: PersonalizationDefinition[];
  archivedScenarios?: ArchivedPersonalizationDefinition[];
  selectedId: string | null;
  onSelect(id: string | null): void;
  save(definition: PersonalizationDefinition, expectedRevision: number): Promise<{ ok: boolean; code?: string; definition?: PersonalizationDefinition }>;
  createScenario(): void;
  onActivateScenario(id: string): void | Promise<void>;
  onDeleteScenario(id: string): Promise<{ ok: boolean; message?: string } | void> | { ok: boolean; message?: string } | void;
  onRestoreScenario?(id: string): Promise<{ ok: boolean; message?: string } | void> | { ok: boolean; message?: string } | void;
  reload(): Promise<void>;
  onOpenTemplateRecognize?: () => void;
  initialTab?: WorkbenchTab;
}) {
  const scenarios = useMemo(() => definitions.filter((item): item is ScenarioDefinition => item.kind === 'scenario'), [definitions]);
  const selected = useMemo(() => scenarios.find((item) => item.id === selectedId) ?? null, [scenarios, selectedId]);
  const [draft, setDraft] = useState<ScenarioDefinition | null>(() => selected ? normalizeScenarioHarness(cloneDefinition(selected)) : null);
  const draftRef = useRef<ScenarioDefinition | null>(selected ? normalizeScenarioHarness(cloneDefinition(selected)) : null);
  const syncedRevisionRef = useRef<number | null>(null);
  // The selected-definition sync is intentionally deferred to avoid a
  // synchronous setState-in-effect update.  Any local authoring action must
  // invalidate that queued sync so it can never overwrite a newer draft (or
  // its completion notice) in the same render turn.
  const draftEpochRef = useRef(0);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [acquisition, setAcquisition] = useState<Acquisition>(null);
  const [aiUndoStack, setAiUndoStack] = useState<ScenarioDefinition[]>([]);
  const aiUndoStackRef = useRef<ScenarioDefinition[]>([]);
  const [categoryFilter, setCategoryFilter] = useState(ALL_CATEGORIES);
  const [libraryMode, setLibraryMode] = useState<'scenarios' | 'trash'>('scenarios');
  // Let a newly typed category become visible in the left library immediately;
  // it still reaches durable storage only through the normal Save action.
  const libraryScenarios = useMemo(() => scenarios.map((scenario) => (
    draft?.id === scenario.id ? draft : scenario
  )), [draft, scenarios]);
  const categories = useMemo(() => [...new Set(libraryScenarios.map(scenarioCategory).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, zh ? 'zh-CN' : 'en')), [libraryScenarios, zh]);
  const displayedScenarios = useMemo(() => libraryScenarios.filter((scenario) => (
    categoryFilter === ALL_CATEGORIES
      || (categoryFilter === UNCATEGORIZED ? !scenarioCategory(scenario) : scenarioCategory(scenario) === categoryFilter)
  )), [categoryFilter, libraryScenarios]);
  const trashScenarios = useMemo(() => archivedScenarios
    .filter((item): item is ArchivedPersonalizationDefinition & { definition: ScenarioDefinition } => item.definition.kind === 'scenario')
    .sort((left, right) => right.archivedAt - left.archivedAt), [archivedScenarios]);

  useEffect(() => {
    const apply = (next: ScenarioDefinition | null, revision: number | null) => {
      const epoch = draftEpochRef.current;
      const timer = window.setTimeout(() => {
        if (draftEpochRef.current !== epoch) return;
        draftRef.current = next;
        syncedRevisionRef.current = revision;
        setDraft(next);
        aiUndoStackRef.current = [];
        setAiUndoStack([]);
        setNotice('');
      }, 0);
      return () => window.clearTimeout(timer);
    };
    if (!selected) {
      return apply(null, null);
    }
    const current = draftRef.current;
    if (!current || current.id !== selected.id || (syncedRevisionRef.current !== selected.revision && current.revision === selected.revision)) {
      const next = normalizeScenarioHarness(cloneDefinition(selected));
      return apply(next, selected.revision);
    }
    return undefined;
  }, [selected]);

  const mutateDraft = useCallback((mutator: (scenario: ScenarioDefinition) => void) => {
    const current = draftRef.current;
    if (!current) return;
    const next = cloneDefinition(current);
    mutator(next);
    normalizeSerialWorkflow(next);
    draftEpochRef.current += 1;
    draftRef.current = next;
    setDraft(next);
  }, []);

  const saveDraft = useCallback(async (): Promise<ScenarioDefinition | null> => {
    const current = draftRef.current;
    if (!current) return null;
    const normalized = normalizeScenarioHarness(cloneDefinition(current));
    normalizeSerialWorkflow(normalized);
    // Repository writes are revision-bound.  The focused editor owns this
    // draft, so it must submit the next immutable revision just like every
    // other personalization editor; otherwise a real repository rejects the
    // save as a stale no-op even though the user just edited the scenario.
    normalized.revision = current.revision + 1;
    normalized.provenance = {
      ...normalized.provenance,
      locallyModified: true,
      updatedAt: Date.now(),
    };
    setBusy(true);
    try {
      const result = await save(normalized, current.revision);
      if (!result.ok || !result.definition || result.definition.kind !== 'scenario') {
        setNotice(mutationMessage(result.code, zh));
        if (result.code === 'revision_conflict') await reload();
        return null;
      }
      const saved = normalizeScenarioHarness(result.definition);
      draftEpochRef.current += 1;
      draftRef.current = saved;
      syncedRevisionRef.current = saved.revision;
      setDraft(saved);
      setNotice(zh ? '已保存。' : 'Saved.');
      await reload();
      return saved;
    } catch {
      setNotice(zh ? '保存服务暂时不可用，当前编辑仍保留。' : 'The save service is unavailable; current edits are retained.');
      return null;
    } finally {
      setBusy(false);
    }
  }, [reload, save, zh]);

  const addStep = useCallback((parentStepId?: string) => {
    mutateDraft((scenario) => {
      const parent = parentStepId ? scenario.workflow.find((step) => step.id === parentStepId) : undefined;
      scenario.workflow.push({
        id: draftId(),
        name: zh ? '新步骤' : 'New step',
        description: '',
        goal: '',
        prompt: '',
        inputs: [],
        outputs: [],
        completionCriteria: [],
        condition: null,
        agentId: parent?.agentId,
        skillIds: [],
        mcpIds: [],
        toolIds: [],
        dependsOn: [],
        maxTurns: 12,
        parentStepId: parentStepId ?? undefined,
      });
    });
  }, [mutateDraft, zh]);

  const reorderSteps = useCallback((sourceId: string, targetId: string) => {
    mutateDraft((scenario) => {
      const sourceIndex = scenario.workflow.findIndex((step) => step.id === sourceId);
      const targetIndex = scenario.workflow.findIndex((step) => step.id === targetId);
      if (sourceIndex < 0 || targetIndex < 0) return;
      const source = scenario.workflow[sourceIndex]!;
      const target = scenario.workflow[targetIndex]!;
      if ((source.parentStepId ?? null) !== (target.parentStepId ?? null)) {
        setNotice(zh ? '只能在同一层级内调整顺序。' : 'Steps can be reordered only within the same level.');
        return;
      }
      scenario.workflow.splice(sourceIndex, 1);
      scenario.workflow.splice(targetIndex, 0, source);
    });
  }, [mutateDraft, zh]);

  const toggleStepResource = useCallback((stepId: string, kind: 'skill' | 'mcp', definitionId: string) => {
    mutateDraft((scenario) => {
      scenario.workflow = scenario.workflow.map((step) => {
        if (step.id !== stepId) return step;
        const ids = kind === 'skill' ? step.skillIds : step.mcpIds;
        const nextIds = ids.includes(definitionId) ? ids.filter((id) => id !== definitionId) : [...ids, definitionId];
        if (kind === 'skill') return { ...step, skillIds: nextIds };
        return { ...step, mcpIds: nextIds };
      });
      const aggregate = scenario.workflow.flatMap((step) => kind === 'skill' ? step.skillIds : step.mcpIds);
      if (kind === 'skill') scenario.skillIds = [...new Set(aggregate)];
      else scenario.mcpIds = [...new Set(aggregate)];
    });
  }, [mutateDraft]);

  const compile = useCallback(async (instruction: string, identity: ScenarioAssistantIdentity = {}): Promise<ScenarioAssistantActionResult> => {
    const current = draftRef.current;
    if (!current) return { ok: false, message: zh ? '当前没有可修改的场景草稿。' : 'There is no scenario draft to modify.' };
    if (!window.metis?.compileScenarioHarness) {
      const message = zh ? 'AI 场景编译服务不可用，当前草稿没有改变。' : 'The AI scenario compiler is unavailable; the current draft was not changed.';
      setNotice(message);
      return { ok: false, message };
    }
    setBusy(true);
    setNotice(zh ? '正在生成；现有草稿不会丢失。' : 'Generating; the current draft is retained.');
    // 增量可见（2026-08-23 刘总要求）：订阅主进程的逐步 patch 快照，
    // 模型每写完一个部分就立刻填进右侧编辑器；失败时移除订阅保持原状。
    const unsubscribeDraft = (() => {
      try {
        return window.metis.onScenarioDraftUpdated?.((update) => {
          if (!update?.scenario || update.scenario.id !== current.id) return;
          const incremental = normalizeScenarioHarness(cloneDefinition(update.scenario));
          draftEpochRef.current += 1;
          draftRef.current = incremental;
          setDraft(incremental);
        });
      } catch { return undefined; }
    })();
    try {
      // 会话身份由助手组件维护；仅在齐备时透传，主进程据此把本轮指令与摘要落库。
      const result = await window.metis.compileScenarioHarness({
        current,
        instruction,
        materialIds: current.materials?.map((material) => material.id) ?? [],
        ...(identity.projectId ? { projectId: identity.projectId } : {}),
        ...(identity.scenarioId ? { scenarioId: identity.scenarioId } : {}),
        ...(identity.conversationId ? { conversationId: identity.conversationId } : {}),
      });
      if (!result.ok || !result.scenario) {
        const message = zh ? `AI 未生成可保存的场景：${result.message ?? result.code ?? '未知原因'}。当前草稿没有改变。` : `AI did not return a saveable scenario: ${result.message ?? result.code ?? 'unknown reason'}. The current draft was not changed.`;
        setNotice(message);
        return { ok: false, message };
      }
      const next = normalizeScenarioHarness(result.scenario);
      normalizeSerialWorkflow(next);
      const previous = cloneDefinition(current);
      draftEpochRef.current += 1;
      draftRef.current = next;
      setDraft(next);
      const nextUndoStack = [...aiUndoStackRef.current.slice(-19), previous];
      aiUndoStackRef.current = nextUndoStack;
      setAiUndoStack(nextUndoStack);
      const message = result.summary || (zh ? 'AI 已更新场景草稿；右侧可继续核对和微调。' : 'AI updated the scenario draft; review and refine it on the right.');
      // 自动保存（2026-08-23 刘总要求）：AI 生成成功后立即持久化，
      // 避免用户忘记保存导致成果丢失；手动「保存」按钮仍然保留。
      // 全自动安装（2026-08-23 刘总授权）：编译中自动装了技能/MCP 时刷新目录。
      if (Array.isArray(result.installedDefinitions) && result.installedDefinitions.length > 0) {
        try { await reload(); } catch { /* 刷新失败不影响草稿应用 */ }
      }
      const saved = await saveDraft();
      setNotice(saved ? `${message}；已自动保存。` : message);
      return { ok: true, message };
    } catch {
      const message = zh ? 'AI 编译未完成，当前草稿没有改变。' : 'AI compilation did not finish; the current draft was not changed.';
      setNotice(message);
      return { ok: false, message };
    } finally {
      unsubscribeDraft?.();
      setBusy(false);
    }
  }, [reload, saveDraft, zh]);

  const uploadMaterials = useCallback(async (): Promise<ScenarioAssistantActionResult> => {
    const current = draftRef.current;
    if (!current || !window.metis?.openReferenceFileDialog || !window.metis?.importScenarioMaterials) {
      const message = zh ? '材料导入服务不可用，当前草稿没有改变。' : 'The material import service is unavailable; the current draft was not changed.';
      setNotice(message);
      return { ok: false, message };
    }
    try {
      const paths = await window.metis.openReferenceFileDialog();
      if (paths.length === 0) {
        const message = zh ? '没有选择材料，当前草稿没有改变。' : 'No material was selected; the current draft was not changed.';
        setNotice(message);
        return { ok: false, message };
      }
      setBusy(true);
      const result = await window.metis.importScenarioMaterials({ files: paths.map((path) => ({ path })) });
      const importedMaterials = result.materials;
      if (!result.ok || !importedMaterials?.length) {
        const message = zh ? `没有导入可用材料：${result.error ?? result.code ?? '未知原因'}。` : `No usable material was imported: ${result.error ?? result.code ?? 'unknown reason'}.`;
        setNotice(message);
        return { ok: false, message };
      }
      mutateDraft((scenario) => {
        const existing = new Set((scenario.materials ?? []).map((item) => item.id));
        scenario.materials = [...(scenario.materials ?? []), ...importedMaterials
          .filter((item) => !existing.has(item.id))
          .map((item) => ({ id: item.id, name: item.name, kind: item.kind as ReferenceMaterial['kind'], storageRef: item.storageRef, byteLength: item.charCount, analyzedAt: Date.now() }))];
      });
      const message = zh ? `已导入 ${importedMaterials.length} 份材料；下一轮对话会将它们作为当前场景的参考。` : `${importedMaterials.length} material(s) imported; the next conversation turn will use them for this scenario.`;
      setNotice(message);
      return { ok: true, message };
    } catch {
      const message = zh ? '材料导入未完成，当前草稿没有改变。' : 'Material import did not finish; the current draft was not changed.';
      setNotice(message);
      return { ok: false, message };
    } finally {
      setBusy(false);
    }
  }, [mutateDraft, zh]);

  const undoLastAiChange = useCallback(() => {
    const previous = aiUndoStackRef.current.at(-1);
    if (!previous) return;
    const restored = normalizeScenarioHarness(cloneDefinition(previous));
    normalizeSerialWorkflow(restored);
    draftEpochRef.current += 1;
    draftRef.current = restored;
    setDraft(restored);
    const nextUndoStack = aiUndoStackRef.current.slice(0, -1);
    aiUndoStackRef.current = nextUndoStack;
    setAiUndoStack(nextUndoStack);
    setNotice(zh ? '已撤销上一次 AI 对场景草稿的修改。' : 'The last AI change to the scenario draft was undone.');
  }, [zh]);

  const activateScenario = useCallback(async () => {
    const current = draftRef.current;
    if (!current) return;
    const readiness = assessScenarioHarness(current, definitions);
    if (readiness.blockingCount > 0) {
      setNotice(zh ? `尚不能启动：${readiness.issues.find((issue) => issue.severity === 'blocking')?.message ?? '请补全场景。'}` : `Not ready to start: ${readiness.issues.find((issue) => issue.severity === 'blocking')?.message ?? 'Complete the scenario first.'}`);
      return;
    }
    const saved = await saveDraft();
    if (saved) await onActivateScenario(saved.id);
  }, [definitions, onActivateScenario, saveDraft, zh]);

  const bindInstalled = useCallback(async (definitionId: string) => {
    const target = acquisition;
    if (!target) return;
    toggleStepResource(target.stepId, target.kind, definitionId);
    setAcquisition(null);
    setNotice(zh ? '已安装并绑定到当前步骤；请保存场景。' : 'Installed and bound to the current step; save the scenario.');
    await reload();
  }, [acquisition, reload, toggleStepResource, zh]);

  const moveToTrash = useCallback(async (scenario: ScenarioDefinition) => {
    setBusy(true);
    try {
      const result = await onDeleteScenario(scenario.id);
      if (result && !result.ok) {
        setNotice(result.message ?? (zh ? '未能移入回收站，场景仍保留。' : 'The scenario could not be moved to trash and remains available.'));
        return;
      }
      if (scenario.id === selectedId) onSelect(null);
      setNotice(result?.message ?? (zh ? '已移入回收站，可在 7 天内恢复。' : 'Moved to Trash. You can restore it within 7 days.'));
    } catch {
      setNotice(zh ? '未能移入回收站，场景仍保留。' : 'The scenario could not be moved to Trash and remains available.');
    } finally {
      setBusy(false);
    }
  }, [onDeleteScenario, onSelect, selectedId, zh]);

  const restoreFromTrash = useCallback(async (item: ArchivedPersonalizationDefinition) => {
    if (!onRestoreScenario) return;
    setBusy(true);
    try {
      const result = await onRestoreScenario(item.definition.id);
      if (result && !result.ok) {
        setNotice(result.message ?? (zh ? '恢复未完成，请重试。' : 'Restore did not complete. Try again.'));
        return;
      }
      setLibraryMode('scenarios');
      onSelect(item.definition.id);
      setNotice(result?.message ?? (zh ? '已恢复到场景列表。' : 'Restored to the scenario list.'));
    } catch {
      setNotice(zh ? '恢复未完成，请重试。' : 'Restore did not complete. Try again.');
    } finally {
      setBusy(false);
    }
  }, [onRestoreScenario, onSelect, zh]);

  const remainingTrashDays = useCallback((expiresAt: number) => (
    Math.max(0, Math.ceil((expiresAt - Date.now()) / (24 * 60 * 60 * 1000)))
  ), []);

  // 未保存守卫（2026-08-23 刘总要求）：草稿与最近一次同步的持久化版本不一致
  // 即视为有未保存编辑；离开工作台前弹确认框，可当场保存。
  const [unsavedDialogOpen, setUnsavedDialogOpen] = useState(false);
  const pendingLeaveRef = useRef<(() => void) | null>(null);
  const draftDirty = useMemo(() => {
    if (!draft || !selected) return false;
    if (draft.id !== selected.id) return false;
    return JSON.stringify(normalizeScenarioHarness(cloneDefinition(draft))) !== JSON.stringify(selected);
  }, [draft, selected]);

  useEffect(() => {
    setScenarioDirtyGuard((action) => {
      if (!draftDirty || busy) return true;
      // 暂存被拦截的导航动作，待用户在确认弹窗中做出选择后补执行。
      pendingLeaveRef.current = action;
      setUnsavedDialogOpen(true);
      return false;
    });
    return () => setScenarioDirtyGuard(null);
  }, [draftDirty, busy]);

  const leaveNow = useCallback((after?: () => void) => {
    setUnsavedDialogOpen(false);
    const action = pendingLeaveRef.current;
    pendingLeaveRef.current = null;
    action?.();
    after?.();
  }, []);

  const saveAndLeave = useCallback(async () => {
    const saved = await saveDraft();
    if (saved) leaveNow();
  }, [leaveNow, saveDraft]);

  return <div className="scenario-workbench" data-testid="scenario-workbench">
    <div className="scenario-workbench__canvas">
      <aside className={`scenario-library ${libraryMode === 'trash' ? 'scenario-library--trash' : ''}`} aria-label={zh ? '场景列表' : 'Scenario list'} data-testid="sw-scenario-library">
        <header className="scenario-library__header">
          <div className="scenario-library__title"><span>{libraryMode === 'trash' ? (zh ? '回收站' : 'Trash') : (zh ? '场景' : 'Scenarios')}</span><strong>{libraryMode === 'trash' ? trashScenarios.length : scenarios.length}</strong></div>
          <div className="scenario-library__actions">
            <button type="button" className={libraryMode === 'trash' ? 'active' : ''} onClick={() => setLibraryMode((mode) => mode === 'trash' ? 'scenarios' : 'trash')} aria-pressed={libraryMode === 'trash'} data-testid="sw-trash-toggle"><Trash2 size={13} />{zh ? '回收站' : 'Trash'}<small>{trashScenarios.length}</small></button>
            {libraryMode === 'scenarios' && <button type="button" className="btn-primary btn-sm" onClick={createScenario} disabled={busy} data-testid="sw-new-scenario"><Plus size={14} />{zh ? '新建' : 'New'}</button>}
          </div>
        </header>
        {libraryMode === 'scenarios' && <section className="scenario-library__categories" aria-label={zh ? '场景分类' : 'Scenario categories'}><span>{zh ? '分类' : 'Categories'}</span><div><button type="button" className={categoryFilter === ALL_CATEGORIES ? 'active' : ''} onClick={() => setCategoryFilter(ALL_CATEGORIES)}>{zh ? '全部' : 'All'}<small>{libraryScenarios.length}</small></button><button type="button" className={categoryFilter === UNCATEGORIZED ? 'active' : ''} onClick={() => setCategoryFilter(UNCATEGORIZED)}>{zh ? '未分类' : 'Uncategorized'}<small>{libraryScenarios.filter((scenario) => !scenarioCategory(scenario)).length}</small></button>{categories.map((category) => <button type="button" key={category} className={categoryFilter === category ? 'active' : ''} onClick={() => setCategoryFilter(category)}>{category}<small>{libraryScenarios.filter((scenario) => scenarioCategory(scenario) === category).length}</small></button>)}</div></section>}
        <div className="scenario-library__list">
          {libraryMode === 'scenarios' ? <>
            {displayedScenarios.map((scenario) => <article key={scenario.id} className={scenario.id === selectedId ? 'selected' : ''}><button type="button" className="scenario-library__select" aria-label={scenario.name || (zh ? '未命名场景' : 'Untitled scenario')} onClick={() => onSelect(scenario.id)}><strong>{scenario.name || (zh ? '未命名场景' : 'Untitled scenario')}</strong><span>{scenarioCategory(scenario) || (zh ? '未分类' : 'Uncategorized')} · {scenario.workflow.length}{zh ? ' 步' : ' steps'}</span></button><button type="button" className="scenario-workbench__delete" disabled={busy} aria-label={zh ? `删除场景 ${scenario.name}` : `Delete scenario ${scenario.name}`} title={zh ? '移入回收站' : 'Move to Trash'} onClick={() => void moveToTrash(scenario)}><Trash2 size={14} /></button></article>)}
            {displayedScenarios.length === 0 && <p className="scenario-library__none">{zh ? '这个分类中还没有场景。' : 'There are no scenarios in this category.'}</p>}
          </> : <>
            {trashScenarios.map((item) => <article key={item.definition.id} className="scenario-library__trash-item"><div className="scenario-library__select"><strong>{item.definition.name || (zh ? '未命名场景' : 'Untitled scenario')}</strong><span>{zh ? `剩余 ${remainingTrashDays(item.expiresAt)} 天后永久删除` : `${remainingTrashDays(item.expiresAt)} day(s) until permanent deletion`}</span></div><button type="button" className="scenario-library__restore" disabled={busy || !onRestoreScenario} aria-label={zh ? `恢复场景 ${item.definition.name}` : `Restore scenario ${item.definition.name}`} onClick={() => void restoreFromTrash(item)}><RotateCcw size={14} />{zh ? '恢复' : 'Restore'}</button></article>)}
            {trashScenarios.length === 0 && <p className="scenario-library__none">{zh ? '回收站为空。已删除场景会保留 7 天。' : 'Trash is empty. Deleted scenarios remain here for 7 days.'}</p>}
          </>}
        </div>
        {libraryMode === 'scenarios' && draft && <label className="scenario-library__category-editor"><span>{zh ? '当前场景分类' : 'Current scenario category'}</span><input value={scenarioCategory(draft)} list="scenario-category-options" placeholder={zh ? '输入或选择分类' : 'Enter or choose a category'} onChange={(event) => mutateDraft((scenario) => updateScenarioCategory(scenario, event.target.value))} /><datalist id="scenario-category-options">{categories.map((category) => <option key={category} value={category} />)}</datalist><button type="button" onClick={() => mutateDraft((scenario) => updateScenarioCategory(scenario, ''))} disabled={!scenarioCategory(draft)}>{zh ? '移出分类' : 'Remove category'}</button></label>}
      </aside>
      <section className="scenario-workbench__editor" aria-label={zh ? '场景定义' : 'Scenario definition'}>
        {libraryMode === 'trash' ? <div className="scenario-workbench__trash-panel" data-testid="sw-trash-panel"><span>{zh ? '场景回收站' : 'Scenario Trash'}</span><h2>{zh ? '删除后有 7 天恢复期' : 'Deleted scenarios have a 7-day recovery window'}</h2><p>{zh ? '这里的场景尚未永久删除。点击左侧「恢复」后会原样回到场景列表；到期后由 METIS 持久化层自动永久清理。' : 'Items here have not been permanently deleted. Restore from the left to return an unchanged scenario; METIS permanently removes it after expiry.'}</p></div> : <><div className="scenario-workbench__editor-heading"><div className="scenario-workbench__editor-heading-main"><span>{zh ? '场景定义' : 'Scenario definition'}</span><h2>{draft?.name || (zh ? '请选择或新建场景' : 'Select or create a scenario')}</h2></div>{draft && <div className="scenario-workbench__editor-actions"><button type="button" className="btn-secondary" disabled={busy} onClick={() => void saveDraft()}>{busy ? (zh ? '处理中…' : 'Working…') : (zh ? '保存' : 'Save')}</button><button type="button" className="btn-primary" disabled={busy} onClick={() => void activateScenario()} data-testid="sw-use">{zh ? '使用场景' : 'Use scenario'}</button></div>}<p>{draft ? (zh ? 'AI 与手动编辑作用于同一份草稿；保存后才成为可运行版本。' : 'AI and manual edits share one draft; save it to make the runnable version.') : (zh ? '从左侧选择已有场景，或新建一个场景后开始配置。' : 'Select an existing scenario on the left, or create one to begin configuration.')}</p></div><div className="scenario-workbench__notice" aria-live="polite">{notice}</div>{draft ? <div className="scenario-workbench__editor-scroll"><ScenarioFocusedEditor zh={zh} draft={draft} definitions={definitions} mutateDraft={mutateDraft} ensureDeliverable={ensureDeliverable} addStep={addStep} removeStep={(id) => mutateDraft((scenario) => removeStepAndDescendants(scenario, id))} reorderSteps={reorderSteps} toggleStepResource={toggleStepResource} acquire={(kind, stepId, mode) => setAcquisition({ kind, stepId, mode })} /></div> : <div className="scenario-workbench__editor-empty" data-testid="sw-empty"><h3>{zh ? '还没有打开场景' : 'No scenario is open'}</h3><p>{zh ? '场景列表和配置助手始终保留在这一页；点击左侧「新建」即可从对话开始构建。' : 'The list and configuration assistant remain on this page. Click “New” on the left to start building in conversation.'}</p></div>}</>}
      </section>
      {libraryMode === 'trash' ? <aside className="scenario-assistant scenario-assistant--empty" aria-label={zh ? '回收站说明' : 'Trash details'}><header className="scenario-assistant__header"><span className="scenario-assistant__mark"><Trash2 size={15} /></span><div><h2>{zh ? '安全删除' : 'Safe deletion'}</h2><p>{zh ? '先归档，后清理' : 'Archive first, clean up later'}</p></div></header><div className="scenario-assistant__empty"><h3>{zh ? '不会一键不可逆' : 'Never one-click irreversible'}</h3><p>{zh ? '删除场景只会移入这里。恢复不会改动任何 Workflow、材料或配置；超过 7 天未恢复才会永久删除。' : 'Deleting a scenario only moves it here. Restore does not alter its workflow, materials, or configuration; deletion is permanent only after 7 days.'}</p></div></aside> : draft ? <ScenarioConfigurationAssistant key={draft.id} zh={zh} scenarioName={draft.name} materialNames={(draft.materials ?? []).map((material) => material.name)} busy={busy} canUndo={aiUndoStack.length > 0} projectId={projectId} scenarioId={draft.id} onSubmitInstruction={compile} onUploadMaterials={uploadMaterials} onUndo={undoLastAiChange} /> : <aside className="scenario-assistant scenario-assistant--empty" aria-label={zh ? '场景配置助手' : 'Scenario configuration assistant'}><header className="scenario-assistant__header"><span className="scenario-assistant__mark"><Plus size={15} /></span><div><h2>{zh ? '场景配置助手' : 'Scenario assistant'}</h2><p>{zh ? '对话构建，右侧同步成型' : 'Build in conversation, review in the middle'}</p></div></header><div className="scenario-assistant__empty"><h3>{zh ? '从一个场景开始' : 'Start with a scenario'}</h3><p>{zh ? '先在左侧选择或新建场景。场景打开后，你可以在这里通过自然语言、材料文件和连续对话完成定义。' : 'Select or create a scenario on the left. Once open, use natural language, material files, and continuous conversation here to build it.'}</p></div></aside>}
    </div>
    {acquisition && <div className="scenario-workbench__modal" role="dialog" aria-modal="true" aria-label={zh ? '获取步骤能力' : 'Acquire step capability'}><section><button type="button" className="scenario-workbench__modal-close" aria-label={zh ? '关闭' : 'Close'} onClick={() => setAcquisition(null)}><X size={18} /></button>{acquisition.mode === 'search' ? <MarketBrowserPanel kind={acquisition.kind} zh={zh} definitions={definitions} onInstalled={(id) => void bindInstalled(id)} /> : <ExtensionInstaller kind={acquisition.kind} definitions={definitions} initialMode={acquisition.mode === 'package' ? acquisition.kind === 'mcp' ? 'mcp_package' : 'skill_package' : acquisition.kind === 'skill' ? 'skill_url' : 'mcp_url'} onInstalled={(id) => bindInstalled(id)} onRefresh={reload} />}</section></div>}
    {unsavedDialogOpen && <div className="scenario-workbench__modal" role="dialog" aria-modal="true" aria-label={zh ? '未保存的场景编辑' : 'Unsaved scenario edits'} data-testid="sw-unsaved-dialog"><section>
      <h3 style={{ margin: '0 0 8px', fontSize: 14 }}>{zh ? '当前场景有未保存的编辑' : 'Unsaved scenario edits'}</h3>
      <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--text-secondary)' }}>{zh ? '离开前要保存「' + (draft?.name || '') + '」的修改吗？不保存将丢失这些编辑。' : `Save your edits to “${draft?.name || ''}” before leaving? Unsaved edits will be lost.`}</p>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" className="btn-secondary btn-sm" onClick={() => setUnsavedDialogOpen(false)}>{zh ? '留在本页' : 'Stay'}</button>
        <button type="button" className="btn-secondary btn-sm" onClick={() => leaveNow()} data-testid="sw-unsaved-discard">{zh ? '不保存并离开' : 'Discard & leave'}</button>
        <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={() => void saveAndLeave()} data-testid="sw-unsaved-save">{busy ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存并离开' : 'Save & leave')}</button>
      </div>
    </section></div>}
  </div>;
}
