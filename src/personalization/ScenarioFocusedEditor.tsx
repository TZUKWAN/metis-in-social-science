import React from 'react';
import { GripVertical, Plus, Trash2 } from 'lucide-react';
import type {
  DeliverableSection,
  PersonalizationDefinition,
  ScenarioDefinition,
  WorkflowStepBinding,
} from '../../engine/runtime/PersonalizationRuntimeContract.js';

type AcquireMode = 'search' | 'package' | 'url';

interface Props {
  zh: boolean;
  draft: ScenarioDefinition;
  definitions: readonly PersonalizationDefinition[];
  mutateDraft(mutator: (scenario: ScenarioDefinition) => void): void;
  ensureDeliverable(scenario: ScenarioDefinition): void;
  addStep(parentStepId?: string): void;
  removeStep(stepId: string): void;
  reorderSteps(sourceId: string, targetId: string): void;
  toggleStepResource(stepId: string, kind: 'skill' | 'mcp', definitionId: string): void;
  acquire(kind: 'skill' | 'mcp', stepId: string, mode: AcquireMode): void;
  /** Locks every draft-affecting control while the caller owns an in-flight mutation. */
  busy: boolean;
}

function lineValues(value: string): string[] {
  return value.split('\n').map((item) => item.trim()).filter(Boolean);
}

function nextId(prefix: string, index: number): string {
  return `${prefix}-${Date.now().toString(36)}-${index + 1}`;
}

function childSteps(workflow: readonly WorkflowStepBinding[], parentStepId: string | null): WorkflowStepBinding[] {
  return workflow.filter((step) => (step.parentStepId ?? null) === parentStepId);
}

function chapterSections(draft: ScenarioDefinition): DeliverableSection[] {
  return (draft.deliverable?.sections ?? []).filter((section) => section.kind === 'chapter');
}

function StepCard({
  step,
  depth,
  props,
  onDragStart,
  onDrop,
}: {
  step: WorkflowStepBinding;
  depth: number;
  props: Props;
  onDragStart(stepId: string): void;
  onDrop(targetStepId: string): void;
}) {
  const { zh, draft, definitions, mutateDraft, toggleStepResource, acquire, addStep, removeStep, busy } = props;
  const skills = definitions.filter((item) => item.kind === 'skill' && item.enabled);
  const mcps = definitions.filter((item) => item.kind === 'mcp' && item.enabled);
  const children = childSteps(draft.workflow, step.id);
  const update = (patch: Partial<WorkflowStepBinding>) => mutateDraft((scenario) => {
    scenario.workflow = scenario.workflow.map((candidate) => candidate.id === step.id ? { ...candidate, ...patch } : candidate);
  });

  return (
    <li className="scenario-focus-step" style={{ '--scenario-step-depth': depth } as React.CSSProperties} data-testid="sw-workflow-step">
      <article
        className="scenario-focus-step__card"
        draggable={!busy}
        onDragStart={busy ? undefined : () => onDragStart(step.id)}
        onDragOver={busy ? undefined : (event) => event.preventDefault()}
        onDrop={busy ? undefined : (event) => { event.preventDefault(); onDrop(step.id); }}
      >
        <header className="scenario-focus-step__head">
          <span className="scenario-focus-step__drag" aria-label={zh ? '拖动排序' : 'Drag to reorder'} aria-disabled={busy}><GripVertical size={15} /></span>
          <strong>{zh ? `步骤 ${depth === 0 ? '' : '子'}${step.name ? '' : ''}` : 'Step'}</strong>
          <input
            value={step.name}
            aria-label={zh ? `步骤 ${step.id} 名称` : `Step ${step.id} name`}
            onChange={(event) => update({ name: event.target.value })}
            disabled={busy}
          />
          <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => addStep(step.id)} data-testid={`sw-add-substep-${step.id}`}>
            <Plus size={13} /> {zh ? '子步骤' : 'Sub-step'}
          </button>
          <button type="button" className="scenario-focus-step__remove" disabled={busy} aria-label={zh ? '删除步骤' : 'Remove step'} onClick={() => removeStep(step.id)}>
            <Trash2 size={14} />
          </button>
        </header>
        <label>
          <span>{zh ? '专属 Prompt' : 'Dedicated prompt'}</span>
          <textarea rows={4} value={step.prompt ?? ''} onChange={(event) => update({ prompt: event.target.value })} disabled={busy} data-testid="sw-step-prompt" />
        </label>
        <label>
          <span>{zh ? '完成标准（每行一条）' : 'Completion criteria (one per line)'}</span>
          <textarea
            rows={3}
            value={(step.completionCriteria ?? []).join('\n')}
            onChange={(event) => update({ completionCriteria: lineValues(event.target.value) })}
            disabled={busy}
            data-testid="sw-step-criteria"
          />
        </label>
        <section className="scenario-focus-step__resources" aria-label={zh ? '步骤资源' : 'Step resources'}>
          <div>
            <strong>Skill</strong>
            <span className="scenario-focus-step__resource-actions">
              <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => acquire('skill', step.id, 'package')} data-testid={`sw-step-import-package-${step.id}`}>{zh ? '本地导入' : 'Import local'}</button>
              <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => acquire('skill', step.id, 'url')} data-testid={`sw-step-url-skill-${step.id}`}>URL</button>
              <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => acquire('skill', step.id, 'search')} data-testid={`sw-step-search-skill-${step.id}`}>{zh ? '在线搜索' : 'Search online'}</button>
            </span>
            <div className="scenario-focus-step__resource-list">
              {skills.map((skill) => <label key={skill.id}><input type="checkbox" checked={step.skillIds.includes(skill.id)} disabled={busy} onChange={() => toggleStepResource(step.id, 'skill', skill.id)} />{skill.name}</label>)}
              {skills.length === 0 && <small>{zh ? '暂无已安装 Skill，可从上方导入或搜索。' : 'No installed Skills yet.'}</small>}
            </div>
          </div>
          <div>
            <strong>MCP</strong>
            <span className="scenario-focus-step__resource-actions">
              <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => acquire('mcp', step.id, 'package')} data-testid={`sw-step-import-mcp-${step.id}`}>{zh ? '本地导入' : 'Import local'}</button>
              <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => acquire('mcp', step.id, 'url')} data-testid={`sw-step-url-mcp-${step.id}`}>URL</button>
              <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => acquire('mcp', step.id, 'search')} data-testid={`sw-step-search-mcp-${step.id}`}>{zh ? '在线搜索' : 'Search online'}</button>
            </span>
            <div className="scenario-focus-step__resource-list">
              {mcps.map((mcp) => <label key={mcp.id}><input type="checkbox" checked={step.mcpIds.includes(mcp.id)} disabled={busy} onChange={() => toggleStepResource(step.id, 'mcp', mcp.id)} />{mcp.name}</label>)}
              {mcps.length === 0 && <small>{zh ? '暂无已安装 MCP，可从上方导入或搜索。' : 'No installed MCPs yet.'}</small>}
            </div>
          </div>
        </section>
      </article>
      {children.length > 0 && <ol className="scenario-focus-step__children">{children.map((child) => <StepCard key={child.id} step={child} depth={depth + 1} props={props} onDragStart={onDragStart} onDrop={onDrop} />)}</ol>}
    </li>
  );
}

export default function ScenarioFocusedEditor(props: Props) {
  const { zh, draft, mutateDraft, ensureDeliverable, addStep, reorderSteps, busy } = props;
  const [draggedStepId, setDraggedStepId] = React.useState<string | null>(null);
  const chapters = chapterSections(draft);
  const chapterCount = chapters.length;
  const secondary = draft.deliverable?.secondarySections ?? { min: 3, max: 5 };
  const rootSteps = childSteps(draft.workflow, null);

  const updateChapterCount = (raw: string) => {
    const requested = Math.max(0, Math.min(24, Number(raw) || 0));
    mutateDraft((scenario) => {
      ensureDeliverable(scenario);
      const current = scenario.deliverable!.sections ?? [];
      const chaptersOnly = current.filter((section) => section.kind === 'chapter');
      const other = current.filter((section) => section.kind !== 'chapter');
      const next = [...chaptersOnly];
      while (next.length < requested) {
        const ordinal = next.length + 1;
        next.push({ id: nextId('chapter', ordinal), title: zh ? `第${ordinal}章` : `Chapter ${ordinal}`, kind: 'chapter', status: 'required', children: [] });
      }
      scenario.deliverable!.sections = [...next.slice(0, requested), ...other];
      scenario.deliverable!.structurePolicy = {
        defaultSections: Math.max(1, requested || 1),
        suggestedMin: Math.max(1, requested || 1),
        suggestedMax: Math.max(1, requested || 1),
      };
    });
  };

  const updateSecondaryRange = (field: 'min' | 'max', raw: string) => {
    const value = Math.max(0, Math.min(24, Number(raw) || 0));
    mutateDraft((scenario) => {
      ensureDeliverable(scenario);
      const current = scenario.deliverable!.secondarySections ?? { min: 3, max: 5 };
      scenario.deliverable!.secondarySections = field === 'min'
        ? { min: Math.min(value, current.max), max: current.max }
        : { min: current.min, max: Math.max(current.min, value) };
    });
  };

  const updateChapter = (chapterId: string, patch: Partial<DeliverableSection>) => mutateDraft((scenario) => {
    ensureDeliverable(scenario);
    scenario.deliverable!.sections = (scenario.deliverable!.sections ?? []).map((section) => section.id === chapterId ? { ...section, ...patch } : section);
  });

  const updateChildCount = (chapter: DeliverableSection, raw: string) => {
    const target = Math.max(0, Math.min(24, Number(raw) || 0));
    const children = [...(chapter.children ?? [])];
    while (children.length < target) {
      const ordinal = children.length + 1;
      children.push({ id: nextId(`${chapter.id}-section`, ordinal), title: zh ? `${chapter.title}·${ordinal}` : `${chapter.title} ${ordinal}`, kind: 'section', status: 'required' });
    }
    updateChapter(chapter.id, { children: children.slice(0, target) });
  };

  return (
    <div className="scenario-focus" data-testid="sw-focused-editor">
      <section className="scenario-focus__section" data-testid="sw-page-basics">
        <header><span>01</span><div><h3>{zh ? '场景基本信息' : 'Scenario basics'}</h3><p>{zh ? '只定义如何称呼和触发这个场景。' : 'Name the scenario and the phrases that should invoke it.'}</p></div></header>
        <div className="scenario-focus__grid scenario-focus__grid--basic">
          <label><span>{zh ? '场景名称' : 'Scenario name'}</span><input value={draft.name} onChange={(event) => mutateDraft((scenario) => { scenario.name = event.target.value; })} disabled={busy} data-testid="sw-config-name" /></label>
          <label><span>{zh ? '触发短语（每行一条）' : 'Trigger phrases (one per line)'}</span><textarea rows={3} value={draft.triggerPhrases.join('\n')} onChange={(event) => mutateDraft((scenario) => { scenario.triggerPhrases = lineValues(event.target.value); })} disabled={busy} /></label>
        </div>
      </section>

      <section className="scenario-focus__section" data-testid="sw-page-structure">
        <header><span>02</span><div><h3>{zh ? '交付物' : 'Deliverable'}</h3><p>{zh ? '在左侧描述目标或约束后，这里呈现并允许核对、微调完整结构。' : 'Describe the objective or constraints on the left; review and fine-tune the complete structure here.'}</p></div></header>
        <div className="scenario-focus__grid scenario-focus__grid--four">
          <label><span>{zh ? '总篇幅' : 'Total length'}</span><input value={draft.deliverable?.globalLength ?? ''} placeholder={zh ? '例如 12000 字' : 'e.g. 12,000 words'} onChange={(event) => mutateDraft((scenario) => { ensureDeliverable(scenario); scenario.deliverable!.globalLength = event.target.value || undefined; })} disabled={busy} data-testid="sw-config-length" /></label>
          <label><span>{zh ? '一级章节数量' : 'Top-level chapters'}</span><input type="number" min={0} max={24} value={chapterCount} onChange={(event) => updateChapterCount(event.target.value)} disabled={busy} data-testid="sw-chapter-count" /></label>
          <label><span>{zh ? '二级章节（每章最少）' : 'Second-level minimum'}</span><input type="number" min={0} max={24} value={secondary.min} onChange={(event) => updateSecondaryRange('min', event.target.value)} disabled={busy} data-testid="sw-secondary-min" /></label>
          <label><span>{zh ? '二级章节（每章最多）' : 'Second-level maximum'}</span><input type="number" min={0} max={24} value={secondary.max} onChange={(event) => updateSecondaryRange('max', event.target.value)} disabled={busy} data-testid="sw-secondary-max" /></label>
          <label><span>{zh ? '语言' : 'Language'}</span><select value={draft.deliverable?.language ?? 'zh'} onChange={(event) => mutateDraft((scenario) => { ensureDeliverable(scenario); scenario.deliverable!.language = event.target.value === 'en' ? 'en' : 'zh'; })} disabled={busy}><option value="zh">{zh ? '中文' : 'Chinese'}</option><option value="en">{zh ? '英文' : 'English'}</option></select></label>
        </div>
        <div className="scenario-focus__outline" aria-label={zh ? '当前结构预览' : 'Current structure preview'}>
          <strong>{zh ? '当前结构预览（可直接编辑；每章可单独覆盖二级章节数）' : 'Current structure preview (editable; each chapter can override the child count)'}</strong>
          {chapters.length === 0 && <p>{zh ? '暂未生成章节结构。' : 'No chapter structure yet.'}</p>}
          {chapters.map((chapter, index) => <div key={chapter.id} className="scenario-focus__chapter"><label><span>{zh ? `第 ${index + 1} 章` : `Chapter ${index + 1}`}</span><input value={chapter.title} onChange={(event) => updateChapter(chapter.id, { title: event.target.value })} disabled={busy} /></label><label><span>{zh ? '二级章节数' : 'Sections'}</span><input type="number" min={0} max={24} value={(chapter.children ?? []).length} onChange={(event) => updateChildCount(chapter, event.target.value)} disabled={busy} /></label><ol>{(chapter.children ?? []).map((child) => <li key={child.id}><input value={child.title} onChange={(event) => updateChapter(chapter.id, { children: (chapter.children ?? []).map((item) => item.id === child.id ? { ...item, title: event.target.value } : item) })} disabled={busy} /></li>)}</ol></div>)}
        </div>
      </section>

      <section className="scenario-focus__section scenario-focus__section--workflow" data-testid="sw-page-capability">
        <header><span>03</span><div><h3>Workflow</h3><p>{zh ? '启动一次后，METIS 会按顺序持续推进；每步完成标准是实际放行条件。' : 'One start runs the full workflow; each completion criterion is an actual progression gate.'}</p></div></header>
        <label className="scenario-focus__workflow-prompt"><span>{zh ? '工作流总 Prompt' : 'Workflow prompt'}</span><textarea rows={5} value={draft.workflowPrompt ?? ''} onChange={(event) => mutateDraft((scenario) => { scenario.workflowPrompt = event.target.value; })} disabled={busy} placeholder={zh ? '例如：前一步成果必须成为后一步的输入；只有达到完成标准才能推进；最终形成全部交付物。' : 'For example: carry forward prior results, require completion before progression, and finish all deliverables.'} data-testid="sw-workflow-prompt" /></label>
        <div className="scenario-focus__workflow-actions"><button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => addStep()} data-testid="sw-workflow-add"><Plus size={13} />{zh ? '新增步骤' : 'Add step'}</button><small>{zh ? '拖动步骤或子步骤调整执行顺序。' : 'Drag steps or sub-steps to reorder execution.'}</small></div>
        <ol className="scenario-focus__steps" data-testid="sw-workflow-list">{rootSteps.map((step) => <StepCard key={step.id} step={step} depth={0} props={props} onDragStart={busy ? () => undefined : setDraggedStepId} onDrop={(targetId) => { if (!busy && draggedStepId && draggedStepId !== targetId) reorderSteps(draggedStepId, targetId); setDraggedStepId(null); }} />)}{rootSteps.length === 0 && <li className="scenario-focus__empty">{zh ? '尚未配置工作流。可以新增步骤，或在左侧对话中描述期望流程。' : 'No workflow yet. Add a step or describe the desired flow in the conversation on the left.'}</li>}</ol>
      </section>

      <section className="scenario-focus__section" data-testid="sw-page-rules">
        <header><span>04</span><div><h3>Scenario Metis.md</h3><p>{zh ? 'Global Metis.md → Scenario Metis.md → Project Metis.md；材料上传与 AI 修改都统一在左侧助手中完成。' : 'Global Metis.md → Scenario Metis.md → Project Metis.md; materials and AI changes are unified in the assistant on the left.'}</p></div></header>
        <textarea className="scenario-focus__metis" rows={16} value={draft.scenarioMetis?.markdown ?? ''} onChange={(event) => mutateDraft((scenario) => { const current = scenario.scenarioMetis ?? { purpose: '', roleBoundaries: '', researchRules: '', writingRules: '', toolRules: '', qualityGates: '', failureRecovery: '', inheritanceOrder: ['global', 'scenario', 'project'] as const, markdown: '' }; scenario.scenarioMetis = { ...current, markdown: event.target.value }; })} disabled={busy} placeholder={zh ? '# Scenario Metis.md\n\n在这里写入研究规范、引用规则、写作风格、禁止事项和其他硬约束。' : '# Scenario Metis.md\n\nWrite the research rules, citation requirements, style, prohibitions, and other hard constraints here.'} data-testid="sw-scenario-metis-markdown" />
      </section>
    </div>
  );
}
