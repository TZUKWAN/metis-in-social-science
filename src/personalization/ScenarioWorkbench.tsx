/**
 * ScenarioWorkbench — 场景工作台（场景重构 P2）。
 *
 * 三栏：左场景库（分类树 + AI 创建入口）/ 中场景详情（总览·成果结构·
 * 规则与方法·自适应·能力与运行）/ 右上下文编辑器（点选对象 + AI 帮我配置）。
 * 全部编辑落到 ScenarioDefinition 草稿，保存走版本化 savePersonalization。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDown, ArrowUp, ChevronDown, ChevronRight, Circle, Diamond, Lock, Plus, Sparkles, Star, Trash2, Unlock, X,
} from 'lucide-react';
import type {
  DeliverableSection,
  PersonalizationDefinition,
  ScenarioDefinition,
} from '../../engine/runtime/PersonalizationRuntimeContract.js';
import { cloneDefinition } from './personalizationLib.js';
import './scenarioWorkbench.css';

type Section = DeliverableSection;

export type WorkbenchTab = 'overview' | 'structure' | 'rules' | 'adapt' | 'capability';

interface CategoryGroup {
  id: string;
  labelZh: string;
  labelEn: string;
  types: string[];
}

const CATEGORY_GROUPS: CategoryGroup[] = [
  { id: 'academic', labelZh: '学术论文', labelEn: 'Academic papers', types: ['theory_paper', 'empirical_paper', 'computational_paper', 'case_study', 'review_paper'] },
  { id: 'grant', labelZh: '项目申报', labelEn: 'Grant applications', types: ['grant_nssfc', 'grant_nsfc', 'grant_postdoc', 'grant_other'] },
  { id: 'report', labelZh: '研究报告', labelEn: 'Research reports', types: ['policy_report', 'survey_report', 'tech_report', 'industry_report'] },
  { id: 'other', labelZh: '其他', labelEn: 'Other', types: ['thesis', 'opening_report', 'completion_report', 'custom'] },
];

const DELIVERABLE_LABELS: Record<string, string> = {
  theory_paper: '纯理论论文', empirical_paper: '实证论文', computational_paper: '计算社会科学论文',
  case_study: '案例研究', review_paper: '综述论文',
  grant_nssfc: '国家社科基金', grant_nsfc: '国家自然科学基金', grant_postdoc: '博士后基金', grant_other: '其他项目申报',
  policy_report: '决策咨询报告', survey_report: '调研报告', tech_report: '技术报告', industry_report: '行业报告',
  thesis: '学位论文', opening_report: '开题报告', completion_report: '项目结项', custom: '自定义',
};

const SECTION_KIND_LABELS: Record<string, string> = {
  title: '题目', abstract: '摘要', keywords: '关键词', chapter: '章节', section: '小节',
  grant_column: '申报栏目', attachment: '附件', references: '参考文献', other: '其他',
};

const STATUS_LABELS: Record<string, { zh: string; en: string; Icon: React.ComponentType<{ size?: number | string }> }> = {
  locked: { zh: '锁定', en: 'Locked', Icon: Lock },
  required: { zh: '必选', en: 'Required', Icon: Circle },
  optional: { zh: '可选', en: 'Optional', Icon: Circle },
  conditional: { zh: '条件', en: 'Conditional', Icon: Diamond },
};

function StatusIcon({ status }: { status: string }) {
  const Icon = STATUS_LABELS[status]?.Icon;
  return Icon ? <Icon size={12} aria-hidden="true" /> : null;
}

const RECENT_KEY = 'metis-scenario-recent:v1';
const FAVORITES_KEY = 'metis-scenario-favorites:v1';
const CATEGORIES_KEY = 'metis-scenario-categories:v1';
const CATEGORY_MAP_KEY = 'metis-scenario-category-map:v1';

interface UserCategory { id: string; name: string; }

function readJsonMap(key: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as Record<string, number> : {};
  } catch {
    return {};
  }
}

function readFavorites(): string[] {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    return raw ? JSON.parse(raw) as string[] : [];
  } catch {
    return [];
  }
}

function readCategories(): UserCategory[] {
  try {
    const raw = localStorage.getItem(CATEGORIES_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : [];
    return Array.isArray(parsed)
      ? parsed.filter((item): item is UserCategory => Boolean(item) && typeof (item as UserCategory).id === 'string' && typeof (item as UserCategory).name === 'string')
      : [];
  } catch {
    return [];
  }
}

function writeCategories(list: UserCategory[]): void {
  try { localStorage.setItem(CATEGORIES_KEY, JSON.stringify(list)); } catch { /* 忽略 */ }
}

function readCategoryMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(CATEGORY_MAP_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : {};
    return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
}

function writeCategoryMap(map: Record<string, string>): void {
  try { localStorage.setItem(CATEGORY_MAP_KEY, JSON.stringify(map)); } catch { /* 忽略 */ }
}

/** 在章节树中定位：返回父数组、下标与路径深度。 */
function locate(sections: Section[], id: string): { parent: Section[]; index: number; section: Section } | null {
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index];
    if (!section) continue;
    if (section && section.id === id) return { parent: sections, index, section };
    if (section.children && section.children.length > 0) {
      const found = locate(section.children, id);
      if (found) return found;
    }
  }
  return null;
}

function mapSections(sections: Section[], transform: (section: Section) => Section): Section[] {
  return sections.map((section) => {
    const next = transform(section);
    return next.children && next.children.length > 0
      ? { ...next, children: mapSections(next.children, transform) }
      : next;
  });
}

function nextStatus(status: Section['status']): Section['status'] {
  if (status === 'required') return 'optional';
  if (status === 'optional') return 'conditional';
  if (status === 'conditional') return 'required';
  return 'required';
}

export default function ScenarioWorkbench({
  zh, definitions, selectedId, onSelect, save, createScenario, onActivateScenario, onDeleteScenario, reload, onOpenAiCreate, onOpenTemplateRecognize, initialTab,
}: {
  zh: boolean;
  definitions: PersonalizationDefinition[];
  selectedId: string | null;
  onSelect(id: string | null): void;
  save(definition: PersonalizationDefinition, expectedRevision: number): Promise<{ ok: boolean; code?: string; definition?: PersonalizationDefinition }>;
  createScenario(): void;
  onActivateScenario(id: string): void;
  onDeleteScenario(id: string): Promise<void> | void;
  reload(): Promise<void>;
  onOpenAiCreate(): void;
  onOpenTemplateRecognize?: () => void;
  initialTab?: WorkbenchTab;
}) {
  const scenarios = useMemo(() => definitions.filter((definition) => definition.kind === 'scenario') as ScenarioDefinition[], [definitions]);
  const selected = useMemo(() => scenarios.find((scenario) => scenario.id === selectedId) ?? null, [scenarios, selectedId]);
  const [draft, setDraft] = useState<ScenarioDefinition | null>(() => (selected ? cloneDefinition(selected) : null));
  const [tab, setTab] = useState<WorkbenchTab>(initialTab ?? 'overview');
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState('');
  const [useMenuOpen, setUseMenuOpen] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiInstruction, setAiInstruction] = useState('');
  const [aiNote, setAiNote] = useState('');

  const [lastSelectedId, setLastSelectedId] = useState(selectedId);
  // 选择变化（含 AI 创建后 definitions 异步刷新导致 selected 迟到）都必须重建草稿：
  // 仅当 selectedId 已变、或草稿为空但选中对象已可用时同步。
  if (lastSelectedId !== selectedId || (!draft && selected && selected.id === selectedId)) {
    setLastSelectedId(selectedId);
    setDraft(selected ? cloneDefinition(selected) : null);
    setSelectedSectionId(null);
    if (initialTab) setTab(initialTab);
  }
  const [lastInitialTab, setLastInitialTab] = useState(initialTab);
  if (lastInitialTab !== initialTab && initialTab) {
    setLastInitialTab(initialTab);
    setTab(initialTab);
  }

  useEffect(() => {
    if (!selectedId) return;
    const recent = readJsonMap(RECENT_KEY);
    recent[selectedId] = Date.now();
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(recent)); } catch { /* 忽略 */ }
  }, [selectedId]);

  const [favoritesVersion, setFavoritesVersion] = useState(0);
  const favorites = useMemo(() => readFavorites(), [favoritesVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  // 自定义分类：localStorage 持久化（与收藏/最近一致，见交接文档 §五.7）。
  const [categoriesVersion, setCategoriesVersion] = useState(0);
  const categories = useMemo(() => readCategories(), [categoriesVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const categoryMap = useMemo(() => readCategoryMap(), [categoriesVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  // 折叠状态用「已展开集合」表示：默认仅「全部」展开，其余分组默认收起，点箭头展开。
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['all']));
  const [newCategoryOpen, setNewCategoryOpen] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [deletingCategory, setDeletingCategory] = useState<UserCategory | null>(null);

  const toggleCollapse = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const createCategory = () => {
    const name = newCategoryName.trim();
    if (!name) return;
    const list = readCategories();
    list.push({ id: 'cat-' + Date.now().toString(36), name });
    writeCategories(list);
    setCategoriesVersion((version) => version + 1);
    setNewCategoryName('');
    setNewCategoryOpen(false);
  };

  // 指派场景到自定义分类；categoryId 为 null 时回到自动归类（按成果类型）。
  const assignCategory = (scenarioId: string, categoryId: string | null) => {
    const map = readCategoryMap();
    if (categoryId) map[scenarioId] = categoryId; else delete map[scenarioId];
    writeCategoryMap(map);
    setCategoriesVersion((version) => version + 1);
  };

  // 删除分类：deleteScenarios 为 true 时连同分类内场景一起删除，否则保留场景（回到全部/自动分组）。
  const deleteCategory = (category: UserCategory, deleteScenarios: boolean) => {
    const map = readCategoryMap();
    const sceneIds = scenarios.filter((s) => map[s.id] === category.id).map((s) => s.id);
    if (deleteScenarios) {
      for (const id of sceneIds) void onDeleteScenario(id);
      if (selectedId && sceneIds.includes(selectedId)) onSelect(null);
    }
    for (const id of sceneIds) delete map[id];
    writeCategoryMap(map);
    writeCategories(readCategories().filter((item) => item.id !== category.id));
    setCategoriesVersion((version) => version + 1);
    setDeletingCategory(null);
  };

  const toggleFavorite = (id: string) => {
    const current = readFavorites();
    const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
    try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(next)); } catch { /* 忽略 */ }
    setFavoritesVersion((version) => version + 1);
    onSelect(id);
  };

  // 删除：用户场景走 archive 软删除（内置原版 factory_protected，可删除的 workbench 定义均为用户定义）。
  const requestDeleteScenario = (scenario: ScenarioDefinition) => {
    const confirmed = typeof window !== 'undefined' && typeof window.confirm === 'function'
      ? window.confirm(zh
          ? '删除场景「' + scenario.name + '」？该场景将移入归档，列表中不再显示；引用它的项目/规则不受影响。'
          : 'Delete scenario "' + scenario.name + '"? It will be archived and hidden from the library; referencing projects/rules are unaffected.')
      : true;
    if (!confirmed) return;
    if (selectedId === scenario.id) onSelect(null);
    void onDeleteScenario(scenario.id);
  };

  const persistDraft = useCallback(async () => {
    if (!draft || !selected) return;
    setSaveState(zh ? '保存中…' : 'Saving…');
    // CAS 语义：提交版本 = 当前版本 + 1（与旧编辑器 editableCopy 一致）。
    const submission = cloneDefinition(draft);
    submission.revision = selected.revision + 1;
    submission.provenance = { ...submission.provenance, updatedAt: Date.now() };
    const result = await save(submission, selected.revision);
    if (result.ok) {
      setSaveState(zh ? '已保存' : 'Saved');
      await reload();
    } else {
      setSaveState(zh ? `保存失败（${result.code ?? 'unknown'}）` : `Save failed (${result.code ?? 'unknown'})`);
    }
  }, [draft, selected, save, reload, zh]);

  const mutateDraft = useCallback((mutator: (scenario: ScenarioDefinition) => void) => {
    setDraft((current) => {
      if (!current) return current;
      const next = cloneDefinition(current);
      mutator(next);
      return next;
    });
    setSaveState(zh ? '有未保存修改' : 'Unsaved changes');
  }, [zh]);

  const ensureDeliverable = (scenario: ScenarioDefinition): void => {
    if (!scenario.deliverable) {
      scenario.deliverable = { type: 'custom', sections: [] };
    }
    if (!scenario.deliverable.sections) scenario.deliverable.sections = [];
  };

  const updateSection = (id: string, patch: Partial<Section>) => {
    mutateDraft((scenario) => {
      ensureDeliverable(scenario);
      scenario.deliverable!.sections = mapSections(scenario.deliverable!.sections!, (section) => (
        section.id === id ? { ...section, ...patch } as Section : section
      ));
    });
  };

  const addSection = (parentId: string | null) => {
    const id = `sec-${Date.now().toString(36)}`;
    const section: Section = {
      id,
      title: zh ? '新部分' : 'New section',
      kind: parentId ? 'section' : 'chapter',
      status: 'required',
    };
    mutateDraft((scenario) => {
      ensureDeliverable(scenario);
      if (parentId) {
        scenario.deliverable!.sections = mapSections(scenario.deliverable!.sections!, (candidate) => (
          candidate.id === parentId
            ? { ...candidate, children: [...(candidate.children ?? []), section] } as Section
            : candidate
        ));
      } else {
        scenario.deliverable!.sections = [...scenario.deliverable!.sections!, section];
      }
    });
    setSelectedSectionId(id);
  };

  const removeSection = (id: string) => {
    const located = draft ? locate(draft.deliverable?.sections ?? [], id) : null;
    if (!located || located.section.status === 'locked') return;
    mutateDraft((scenario) => {
      const strip = (sections: Section[]): Section[] => sections
        .filter((section) => section.id !== id)
        .map((section) => (section.children ? { ...section, children: strip(section.children) } as Section : section));
      scenario.deliverable!.sections = strip(scenario.deliverable!.sections ?? []);
    });
    if (selectedSectionId === id) setSelectedSectionId(null);
  };

  const moveSection = (id: string, direction: -1 | 1) => {
    mutateDraft((scenario) => {
      const sections = scenario.deliverable?.sections ?? [];
      const located = locate(sections, id);
      if (!located) return;
      const target = located.index + direction;
      if (target < 0 || target >= located.parent.length) return;
      const next = [...located.parent];
      const moved = next[located.index];
      if (!moved) return;
      next.splice(located.index, 1);
      next.splice(target, 0, moved);
      // 写回：顶层直接替换；子层通过父节点重建。
      if (located.parent === sections) {
        scenario.deliverable!.sections = next;
      } else {
        scenario.deliverable!.sections = mapSections(sections, (section) => {
          if ((section.children ?? []).some((child) => child.id === id)) {
            const children = [...(section.children ?? [])];
            const childIndex = children.findIndex((child) => child.id === id);
            if (childIndex >= 0) {
              const child = children[childIndex];
              if (child) {
                children.splice(childIndex, 1);
                children.splice(childIndex + direction, 0, child);
              }
            }
            return { ...section, children } as Section;
          }
          return section;
        });
      }
    });
  };

  const cycleSectionStatus = (id: string) => {
    const located = draft ? locate(draft.deliverable?.sections ?? [], id) : null;
    if (!located || located.section.status === 'locked') return;
    const next = nextStatus(located.section.status);
    updateSection(id, next === 'conditional' ? { status: next, condition: located.section.condition ?? (zh ? '满足条件时加入' : 'Add when condition met') } : { status: next });
  };


  const agentPool = definitions.filter((definition) => definition.kind === 'agent');
  const hasBoundAgent = draft ? draft.agentIds.length > 0 : false;
  // 与旧卡片一致的对话使用防护：无智能体、或（有输出计划但无工作流的多智能体）歧义路由。
  const missingAgent = draft ? draft.agentIds.length === 0 : false;
  const ambiguousPlanned = draft
    ? draft.output.plan != null && draft.workflow.length === 0 && draft.agentIds.length > 1
    : false;
  const useBlocked = missingAgent || ambiguousPlanned;
  const useBlockedTitle = missingAgent
    ? (zh ? '请先在「能力与运行」绑定至少一个智能体，再用于对话。' : 'Bind at least one Agent before using this scenario in conversation.')
    : ambiguousPlanned
      ? (zh ? '请绑定唯一智能体，或添加工作流步骤明确分工。' : 'Bind exactly one Agent, or add workflow steps to route them.')
      : '';

  const updateWorkflowStep = (stepId: string, patch: Partial<ScenarioDefinition['workflow'][number]>) => {
    mutateDraft((scenario) => {
      scenario.workflow = scenario.workflow.map((step) => (step.id === stepId ? { ...step, ...patch } : step));
    });
  };

  const addWorkflowStep = () => {
    if (!draft || draft.agentIds.length === 0) return;
    mutateDraft((scenario) => {
      const previous = scenario.workflow[scenario.workflow.length - 1];
      scenario.workflow = [
        ...scenario.workflow,
        {
          id: `step-${Date.now().toString(36)}`,
          name: zh ? '新步骤' : 'New step',
          description: '',
          agentId: scenario.agentIds[0] ?? '',
          skillIds: [],
          toolIds: [],
          mcpIds: [],
          dependsOn: previous ? [previous.id] : [],
          maxTurns: 12,
        },
      ];
    });
  };

  const removeWorkflowStep = (stepId: string) => {
    mutateDraft((scenario) => {
      scenario.workflow = scenario.workflow.filter((step) => step.id !== stepId)
        .map((step) => ({ ...step, dependsOn: step.dependsOn.filter((dep) => dep !== stepId) }));
    });
  };

  const moveWorkflowStep = (stepId: string, direction: -1 | 1) => {
    mutateDraft((scenario) => {
      const index = scenario.workflow.findIndex((step) => step.id === stepId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= scenario.workflow.length) return;
      const next = [...scenario.workflow];
      const moved = next[index];
      if (!moved) return;
      next.splice(index, 1);
      next.splice(target, 0, moved);
      scenario.workflow = next;
    });
  };

  const runAiRefine = async (targetKind: 'section' | 'writingRules' | 'methodPolicy' | 'adaptivity') => {
    const metis = window.metis;
    if (!metis?.refineScenarioConfig || !draft) {
      setAiNote(zh ? 'AI 配置服务不可用。' : 'AI refine unavailable.');
      return;
    }
    if (aiInstruction.trim().length < 2) {
      setAiNote(zh ? '请先输入你希望 AI 如何调整。' : 'Describe what AI should adjust.');
      return;
    }
    setAiBusy(true);
    setAiNote('');
    try {
      let targetTitle = '';
      let currentValue = '';
      if (targetKind === 'section' && selectedSectionId) {
        const located = locate(draft.deliverable?.sections ?? [], selectedSectionId);
        targetTitle = located?.section.title ?? '';
        currentValue = JSON.stringify(located?.section ?? {});
      } else if (targetKind === 'writingRules') {
        targetTitle = zh ? '场景写作规范' : 'Writing rules';
        currentValue = JSON.stringify({ writingRules: draft.writingRules ?? [] });
      } else if (targetKind === 'methodPolicy') {
        targetTitle = zh ? '研究方法策略' : 'Method policy';
        currentValue = JSON.stringify(draft.methodPolicy ?? {});
      } else {
        targetTitle = zh ? '自适应策略' : 'Adaptivity';
        currentValue = JSON.stringify(draft.adaptivity ?? {});
      }
      const result = await metis.refineScenarioConfig({
        targetKind,
        targetTitle,
        currentValue,
        instruction: aiInstruction,
        materialIds: (draft.materials ?? []).map((material) => material.id),
      });
      if (!result.ok || !result.patch) {
        setAiNote(zh ? `AI 配置失败（${result.code ?? 'unknown'}）。` : `Refine failed (${result.code ?? 'unknown'}).`);
        return;
      }
      const patch = result.patch as Record<string, unknown>;
      if (targetKind === 'section' && selectedSectionId) {
        const merged: Partial<Section> = {};
        if (typeof patch.purpose === 'string') merged.purpose = patch.purpose;
        if (Array.isArray(patch.requirements)) merged.requirements = patch.requirements.map(String);
        if (Array.isArray(patch.optionalContent)) merged.optionalContent = patch.optionalContent.map(String);
        if (Array.isArray(patch.forbidden)) merged.forbidden = patch.forbidden.map(String);
        if (typeof patch.lengthTarget === 'string') merged.lengthTarget = patch.lengthTarget;
        if (typeof patch.method === 'string') merged.method = patch.method;
        if (typeof patch.evidence === 'string') merged.evidence = patch.evidence;
        updateSection(selectedSectionId, merged);
      } else if (targetKind === 'writingRules' && Array.isArray(patch.writingRules)) {
        mutateDraft((scenario) => { scenario.writingRules = patch.writingRules as string[]; });
      } else if (targetKind === 'methodPolicy') {
        mutateDraft((scenario) => {
          scenario.methodPolicy = {
            recommended: Array.isArray(patch.recommended) ? patch.recommended as string[] : scenario.methodPolicy?.recommended ?? [],
            allowed: Array.isArray(patch.allowed) ? patch.allowed as string[] : scenario.methodPolicy?.allowed ?? [],
            conditional: Array.isArray(patch.conditional) ? patch.conditional as string[] : scenario.methodPolicy?.conditional ?? [],
            forbidden: Array.isArray(patch.forbidden) ? patch.forbidden as string[] : scenario.methodPolicy?.forbidden ?? [],
          };
        });
      } else if (targetKind === 'adaptivity' && typeof patch === 'object') {
        mutateDraft((scenario) => { scenario.adaptivity = patch as ScenarioDefinition['adaptivity']; });
      }
      setAiNote(zh ? 'AI 已更新配置，请检查后保存。' : 'AI updated the config; review and save.');
      setAiInstruction('');
    } finally {
      setAiBusy(false);
    }
  };

  // 已指派到自定义分类的场景从内置分组排除（互斥：只出现在自定义分类 + 全部）。
  const grouped = useMemo(() => {
    const groups = new Map<string, ScenarioDefinition[]>();
    for (const scenario of scenarios) {
      if (categoryMap[scenario.id]) continue;
      const type = scenario.deliverable?.type;
      let groupId = 'mine';
      if (type) {
        const group = CATEGORY_GROUPS.find((candidate) => candidate.types.includes(type));
        groupId = group?.id ?? 'mine';
      }
      const list = groups.get(groupId) ?? [];
      list.push(scenario);
      groups.set(groupId, list);
    }
    return groups;
  }, [scenarios, categoryMap]);

  const categoryScenarios = useMemo(() => {
    const map = new Map<string, ScenarioDefinition[]>();
    for (const category of categories) map.set(category.id, []);
    for (const scenario of scenarios) {
      const categoryId = categoryMap[scenario.id];
      if (categoryId && map.has(categoryId)) map.get(categoryId)!.push(scenario);
    }
    return map;
  }, [scenarios, categories, categoryMap]);


  const applyScenarioUse = async (mode: 'current' | 'new' | 'autonomous') => {
    if (!draft) return;
    setUseMenuOpen(false);
    if (mode === 'current') {
      onActivateScenario(draft.id);
      return;
    }
    if (mode === 'new') {
      const store = await import('../research/researchWorkspaceStore.js');
      await store.researchWorkspaceStore.getState().createProject({
        title: draft.name,
        researchQuestion: draft.description || draft.name,
      } as never);
      onActivateScenario(draft.id);
      return;
    }
    // 自主科研：切换到自主科研控制台并预选该场景（控制台带场景选择）。
    try { localStorage.setItem('metis-autonomous-scenario-preset', draft.id); } catch { /* 忽略 */ }
    const nav = document.querySelector('.topbar-nav__item[data-nav-id="autonomous"]');
    (nav as HTMLButtonElement | null)?.click();
  };

  const sectionRow = (section: Section, depth: number): React.ReactElement => (
    <li key={section.id} className={`sw-tree__row depth-${Math.min(depth, 3)} ${selectedSectionId === section.id ? 'selected' : ''} status-${section.status}`}>
      <div className="sw-tree__line">
        <button type="button" className="sw-tree__select" onClick={() => { setSelectedSectionId(section.id); setTab('structure'); }} data-testid="sw-tree-row">
          <span className="sw-tree__icon" aria-label={STATUS_LABELS[section.status]?.[zh ? 'zh' : 'en']}><StatusIcon status={section.status} /></span>
          <span className="sw-tree__title">{section.title}</span>
          <span className="sw-tree__kind">{SECTION_KIND_LABELS[section.kind] ?? section.kind}</span>
          {section.children && section.children.length > 0 && <span className="sw-tree__count">{section.children.length}</span>}
        </button>
        <span className="sw-tree__ops">
          <button type="button" title={zh ? '上移' : 'Move up'} disabled={depth === 0 && false} onClick={() => moveSection(section.id, -1)}><ArrowUp size={12} aria-hidden="true" /></button>
          <button type="button" title={zh ? '下移' : 'Move down'} onClick={() => moveSection(section.id, 1)}><ArrowDown size={12} aria-hidden="true" /></button>
          <button type="button" title={zh ? '加子部分' : 'Add child'} onClick={() => addSection(section.id)}><Plus size={12} aria-hidden="true" /></button>
          <button type="button" title={zh ? (section.status === 'locked' ? '锁定（不可切换）' : '切换状态：必选/可选/条件') : 'Cycle status'} disabled={section.status === 'locked'} onClick={() => cycleSectionStatus(section.id)}><StatusIcon status={section.status} /></button>
          <button type="button" title={zh ? '锁定/解锁' : 'Lock/unlock'} onClick={() => updateSection(section.id, { status: section.status === 'locked' ? 'required' : 'locked' })}>{section.status === 'locked' ? <Unlock size={12} aria-hidden="true" /> : <Lock size={12} aria-hidden="true" />}</button>
          <button type="button" title={zh ? '删除（锁定不可删）' : 'Remove'} disabled={section.status === 'locked'} onClick={() => removeSection(section.id)}><X size={12} aria-hidden="true" /></button>
        </span>
      </div>
      {section.children && section.children.length > 0 && (
        <ul className="sw-tree__children">{section.children.map((child) => sectionRow(child, depth + 1))}</ul>
      )}
    </li>
  );

  const selectedSection = useMemo(() => {
    if (!draft || !selectedSectionId) return null;
    return locate(draft.deliverable?.sections ?? [], selectedSectionId)?.section ?? null;
  }, [draft, selectedSectionId]);

  const chapterCount = useMemo(() => (draft?.deliverable?.sections ?? []).filter((section) => section.kind === 'chapter').length, [draft]);

  const renderOverview = () => draft && (
    <div className="sw-overview" data-testid="sw-overview">
      <div className="sw-overview__cards">
        <div className="sw-card">
          <h4>{zh ? '最终成果' : 'Deliverable'}</h4>
          <p>{DELIVERABLE_LABELS[draft.deliverable?.type ?? ''] ?? (zh ? '未定义' : 'Undefined')}</p>
          <p className="sw-card__meta">{draft.deliverable?.globalLength || (zh ? '篇幅未设置' : 'No length target')}</p>
          <p className="sw-card__meta">{zh ? `默认 ${draft.deliverable?.structurePolicy?.defaultSections ?? chapterCount} 章` : `${draft.deliverable?.structurePolicy?.defaultSections ?? chapterCount} chapters`}</p>
        </div>
        <div className="sw-card sw-card--structure">
          <h4>{zh ? '成果结构' : 'Structure'}</h4>
          <ul>
            {(draft.deliverable?.sections ?? []).slice(0, 8).map((section) => (
              <li key={section.id}><span><StatusIcon status={section.status} /></span>{section.title}</li>
            ))}
            {(draft.deliverable?.sections?.length ?? 0) === 0 && <li className="sw-card__empty">{zh ? '尚未定义结构' : 'No structure yet'}</li>}
          </ul>
          <button type="button" className="btn-secondary btn-sm" onClick={() => setTab('structure')}>{zh ? '编辑结构' : 'Edit structure'} →</button>
        </div>
        <div className="sw-card">
          <h4>{zh ? '自适应' : 'Adaptivity'}</h4>
          {draft.deliverable?.structurePolicy && (
            <p className="sw-card__meta">{zh ? `允许 ${draft.deliverable.structurePolicy.suggestedMin}-${draft.deliverable.structurePolicy.suggestedMax} 章` : `${draft.deliverable.structurePolicy.suggestedMin}-${draft.deliverable.structurePolicy.suggestedMax} chapters`}</p>
          )}
          <ul className="sw-card__list">
            {draft.adaptivity?.structure?.addSections && <li>{zh ? '可调整章节' : 'Adjust sections'}</li>}
            {draft.adaptivity?.content?.reviseHypothesis && <li>{zh ? '可修改假设' : 'Revise hypotheses'}</li>}
            {draft.adaptivity?.method?.addRobustness && <li>{zh ? '可加稳健性检验' : 'Add robustness'}</li>}
            {(draft.adaptivity?.allowedBacktracks?.length ?? 0) > 0 && <li>{zh ? '允许回溯' : 'Backtracking'}</li>}
            {!draft.adaptivity && <li className="sw-card__empty">{zh ? '未配置（AI 按默认边界）' : 'Not configured'}</li>}
          </ul>
          <button type="button" className="btn-secondary btn-sm" onClick={() => setTab('adapt')}>{zh ? '设置边界' : 'Set boundaries'} →</button>
        </div>
        <div className="sw-card">
          <h4>{zh ? '能力' : 'Capabilities'}</h4>
          <p className="sw-card__meta">{zh ? `智能体 ${draft.agentIds.length} · 技能 ${draft.skillIds.length} · MCP ${draft.mcpIds.length} · Metis.md ${draft.rulesIds.length}` : `${draft.agentIds.length} agents · ${draft.skillIds.length} skills · ${draft.mcpIds.length} MCP · ${draft.rulesIds.length} rules`}</p>
          <p className="sw-card__meta">{zh ? `工作流 ${draft.workflow.length} 步` : `${draft.workflow.length} workflow steps`}</p>
          <button type="button" className="btn-secondary btn-sm" onClick={() => setTab('capability')}>{zh ? '配置能力' : 'Configure'} →</button>
        </div>
      </div>
      <div className="sw-card sw-card--path">
        <h4>{zh ? '默认运行路径' : 'Default run path'}</h4>
        <p className="sw-path">{draft.workflow.map((step) => step.name).join(' → ') || (zh ? '未配置工作流' : 'No workflow')}</p>
      </div>
      <div className="sw-materials" data-testid="sw-materials">
        <h4>{zh ? `参考材料（${(draft.materials ?? []).length}）` : `Reference materials (${(draft.materials ?? []).length})`}</h4>
        <p className="sw-materials__hint">{zh ? '参考材料是 AI 学习科研方式的原始材料（区别于运行时遵守的 Metis.md 规则文档）。' : 'Materials are raw sources AI learns from; Metis.md is the runtime rule doc.'}</p>
        <ul>
          {(draft.materials ?? []).map((material) => (
            <li key={material.id}>
              <span className="sw-materials__name">{material.name}</span>
              <span className="sw-materials__kind">{material.kind}</span>
              <span className="sw-materials__insights">
                {zh ? '结构' : 'struct'} {(material.insights?.structureRules ?? []).length}
                · {zh ? '写作' : 'writing'} {(material.insights?.writingPrinciples ?? []).length}
                · {zh ? '方法' : 'method'} {(material.insights?.methodSuggestions ?? []).length}
                · {zh ? '硬性' : 'hard'} {(material.insights?.hardRequirements ?? []).length}
              </span>
            </li>
          ))}
          {(draft.materials ?? []).length === 0 && <li className="sw-card__empty">{zh ? '尚无参考材料。可通过 AI 创建场景时上传。' : 'No materials yet; upload during AI creation.'}</li>}
        </ul>
      </div>
    </div>
  );

  const renderStructure = () => draft && (
    <div className="sw-structure" data-testid="sw-structure">
      <div className="sw-structure__toolbar">
        <button type="button" className="btn-primary btn-sm" onClick={() => addSection(null)} data-testid="sw-add-section">{zh ? '＋ 新增部分' : '＋ Add section'}</button>
        <span className="sw-structure__hint">{zh ? '锁定 · 必选 · 可选 · 条件（点击行在右侧编辑）' : 'Locked · Required · Optional · Conditional (click a row to edit on the right)'}</span>
      </div>
      <ul className="sw-tree" data-testid="sw-structure-tree">
        {(draft.deliverable?.sections ?? []).map((section) => sectionRow(section, 0))}
        {(draft.deliverable?.sections?.length ?? 0) === 0 && <li className="sw-tree__empty">{zh ? '还没有成果结构。点击「新增部分」或用 AI 创建场景生成。' : 'No structure yet.'}</li>}
      </ul>
      <div className="sw-structure__policy">
        <h4>{zh ? '结构策略与全局要求' : 'Structure policy & global requirements'}</h4>
        <div className="sw-policy-grid">
          <label>
            <span>{zh ? '默认章节数' : 'Default chapters'}</span>
            <input
              type="number" min={1} max={48}
              value={draft.deliverable?.structurePolicy?.defaultSections ?? chapterCount}
              onChange={(event) => mutateDraft((scenario) => {
                ensureDeliverable(scenario);
                const current = scenario.deliverable!.structurePolicy ?? { defaultSections: chapterCount, suggestedMin: Math.max(1, chapterCount - 1), suggestedMax: chapterCount + 2 };
                scenario.deliverable!.structurePolicy = { ...current, defaultSections: Math.min(48, Math.max(1, Number(event.target.value) || current.defaultSections)) };
              })}
            />
          </label>
          <label>
            <span>{zh ? '建议范围（最少）' : 'Suggested min'}</span>
            <input
              type="number" min={1} max={48}
              value={draft.deliverable?.structurePolicy?.suggestedMin ?? Math.max(1, chapterCount - 1)}
              onChange={(event) => mutateDraft((scenario) => {
                ensureDeliverable(scenario);
                const current = scenario.deliverable!.structurePolicy ?? { defaultSections: chapterCount, suggestedMin: chapterCount, suggestedMax: chapterCount + 2 };
                scenario.deliverable!.structurePolicy = { ...current, suggestedMin: Math.min(current.suggestedMax, Math.max(1, Number(event.target.value) || current.suggestedMin)) };
              })}
            />
          </label>
          <label>
            <span>{zh ? '建议范围（最多）' : 'Suggested max'}</span>
            <input
              type="number" min={1} max={64}
              value={draft.deliverable?.structurePolicy?.suggestedMax ?? chapterCount + 2}
              onChange={(event) => mutateDraft((scenario) => {
                ensureDeliverable(scenario);
                const current = scenario.deliverable!.structurePolicy ?? { defaultSections: chapterCount, suggestedMin: chapterCount, suggestedMax: chapterCount };
                const max = Math.max(current.suggestedMin, Number(event.target.value) || current.suggestedMax);
                scenario.deliverable!.structurePolicy = { ...current, suggestedMax: Math.min(64, max) };
              })}
            />
          </label>
          <label>
            <span>{zh ? '总篇幅' : 'Total length'}</span>
            <input
              value={draft.deliverable?.globalLength ?? ''}
              placeholder={zh ? '如 10000-12000 字' : 'e.g. 10k-12k words'}
              onChange={(event) => mutateDraft((scenario) => {
                ensureDeliverable(scenario);
                scenario.deliverable!.globalLength = event.target.value.slice(0, 200) || undefined;
              })}
            />
          </label>
          <label>
            <span>{zh ? '语言' : 'Language'}</span>
            <select
              value={draft.deliverable?.language ?? 'zh'}
              onChange={(event) => mutateDraft((scenario) => {
                ensureDeliverable(scenario);
                scenario.deliverable!.language = event.target.value === 'en' ? 'en' : 'zh';
              })}
            >
              <option value="zh">{zh ? '中文' : 'Chinese'}</option>
              <option value="en">{zh ? '英文' : 'English'}</option>
            </select>
          </label>
          <label>
            <span>{zh ? '期刊层次' : 'Tier'}</span>
            <select
              value={draft.deliverable?.journalTier ?? 'any'}
              onChange={(event) => mutateDraft((scenario) => {
                ensureDeliverable(scenario);
                const value = event.target.value;
                scenario.deliverable!.journalTier = value === 'core' || value === 'general' ? value : 'any';
              })}
            >
              <option value="any">{zh ? '不限' : 'Any'}</option>
              <option value="core">{zh ? '核心期刊' : 'Core'}</option>
              <option value="general">{zh ? '一般刊物' : 'General'}</option>
            </select>
          </label>
        </div>
      </div>
    </div>
  );

  const rulesListEditor = (title: string, values: string[], onChange: (next: string[]) => void, placeholder: string) => (
    <div className="sw-rules__group">
      <h4>{title}</h4>
      <textarea
        rows={Math.min(10, Math.max(3, values.length + 1))}
        value={values.join('\n')}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value.split('\n').map((line) => line.trim()).filter(Boolean))}
      />
    </div>
  );

  const renderRules = () => draft && (
    <div className="sw-rules" data-testid="sw-rules">
      {rulesListEditor(zh ? '写作规范' : 'Writing rules', draft.writingRules ?? [], (next) => mutateDraft((scenario) => { scenario.writingRules = next; }), zh ? '每行一条，如：摘要禁止出现"本文"……' : 'One rule per line')}
      <div className="sw-rules__methods">
        <h4>{zh ? '研究方法' : 'Research methods'}</h4>
        <div className="sw-policy-grid">
          {(['recommended', 'allowed', 'conditional', 'forbidden'] as const).map((key) => (
            <label key={key}>
              <span>{{ recommended: zh ? '推荐方法' : 'Recommended', allowed: zh ? '允许方法' : 'Allowed', conditional: zh ? '条件方法' : 'Conditional', forbidden: zh ? '禁止方法' : 'Forbidden' }[key]}</span>
              <textarea
                rows={3}
                value={(draft.methodPolicy?.[key] ?? []).join('\n')}
                onChange={(event) => mutateDraft((scenario) => {
                  const current = scenario.methodPolicy ?? { recommended: [], allowed: [], conditional: [], forbidden: [] };
                  scenario.methodPolicy = { ...current, [key]: event.target.value.split('\n').map((line) => line.trim()).filter(Boolean) };
                })}
              />
            </label>
          ))}
        </div>
      </div>
      <div className="sw-rules__hint">
        {zh ? '证据与引用类硬约束（引用必须真实可查、不得编造数据等）由平台真实性层强制执行，并在场景 Metis.md 中落地。' : 'Evidence/citation hard constraints are enforced by the platform truth layer and scenario Metis.md.'}
      </div>
    </div>
  );

  const adaptToggle = (group: 'structure' | 'content' | 'method', key: string) => ({
    checked: Boolean((draft?.adaptivity?.[group] as Record<string, boolean> | undefined)?.[key]),
    toggle: () => mutateDraft((scenario) => {
      const current = scenario.adaptivity ?? {
        structure: { addSections: false, deleteUnlockedSections: false, splitSections: false, mergeSections: false, reorderSections: false, adjustLength: false },
        content: { reviseQuestion: false, addQuestion: false, reviseHypothesis: false, dropUnsupportedHypothesis: false, adjustFramework: false },
        method: { addMethod: false, replaceUnsuitableMethod: false, addRobustness: false, addHeterogeneity: false, addMechanism: false },
        allowedBacktracks: [],
        majorAdjustmentTriggers: [],
      };
      const groupValue = { ...current[group] } as Record<string, boolean>;
      groupValue[key] = !groupValue[key];
      scenario.adaptivity = { ...current, [group]: groupValue } as ScenarioDefinition['adaptivity'];
    }),
  });

  const ADAPT_LABELS: Record<'structure' | 'content' | 'method', Array<[string, string]>> = {
    structure: [
      ['addSections', zh ? '增加章节' : 'Add sections'],
      ['deleteUnlockedSections', zh ? '删除非锁定章节' : 'Delete unlocked sections'],
      ['splitSections', zh ? '拆分章节' : 'Split sections'],
      ['mergeSections', zh ? '合并章节' : 'Merge sections'],
      ['reorderSections', zh ? '调整章节顺序' : 'Reorder sections'],
      ['adjustLength', zh ? '调整篇幅' : 'Adjust length'],
    ],
    content: [
      ['reviseQuestion', zh ? '修改非锁定研究问题' : 'Revise questions'],
      ['addQuestion', zh ? '新增研究问题' : 'Add questions'],
      ['reviseHypothesis', zh ? '修改研究假设' : 'Revise hypotheses'],
      ['dropUnsupportedHypothesis', zh ? '删除证据不足假设' : 'Drop unsupported hypotheses'],
      ['adjustFramework', zh ? '调整理论框架' : 'Adjust framework'],
    ],
    method: [
      ['addMethod', zh ? '增加分析方法' : 'Add methods'],
      ['replaceUnsuitableMethod', zh ? '更换不适用方法' : 'Replace unsuitable methods'],
      ['addRobustness', zh ? '增加稳健性检验' : 'Add robustness'],
      ['addHeterogeneity', zh ? '增加异质性分析' : 'Add heterogeneity'],
      ['addMechanism', zh ? '增加机制分析' : 'Add mechanism'],
    ],
  };

  const renderAdapt = () => draft && (
    <div className="sw-adapt" data-testid="sw-adapt">
      <p className="sw-adapt__lead">{zh ? '这里设置的是 AI 的自主边界：AI 只能在以下允许范围内自主调整；锁定内容与硬约束永不可改。' : 'These switches define what AI may adjust autonomously; locked content and hard constraints never change.'}</p>
      {(['structure', 'content', 'method'] as const).map((group) => (
        <fieldset key={group} className="sw-adapt__group">
          <legend>{{ structure: zh ? '成果结构' : 'Structure', content: zh ? '研究内容' : 'Content', method: zh ? '方法与分析' : 'Method' }[group]}</legend>
          {ADAPT_LABELS[group].map(([key, label]) => {
            const control = adaptToggle(group, key);
            return (
              <label key={key} className="sw-adapt__switch">
                <input type="checkbox" checked={control.checked} onChange={control.toggle} data-testid={`sw-adapt-${group}-${key}`} />
                <span>{label}</span>
              </label>
            );
          })}
        </fieldset>
      ))}
      <div className="sw-adapt__backtracks">
        <h4>{zh ? '允许自动回溯（研究过程可循环）' : 'Allowed backtracking'}</h4>
        <textarea
          rows={2}
          value={(draft.adaptivity?.allowedBacktracks ?? []).join('\n')}
          placeholder={zh ? '每行一条，如 analysis->literature（分析后可回补文献）' : 'One edge per line, e.g. analysis->literature'}
          onChange={(event) => mutateDraft((scenario) => {
            const current = scenario.adaptivity ?? { structure: { addSections: false, deleteUnlockedSections: false, splitSections: false, mergeSections: false, reorderSections: false, adjustLength: false }, content: { reviseQuestion: false, addQuestion: false, reviseHypothesis: false, dropUnsupportedHypothesis: false, adjustFramework: false }, method: { addMethod: false, replaceUnsuitableMethod: false, addRobustness: false, addHeterogeneity: false, addMechanism: false } };
            scenario.adaptivity = { ...current, allowedBacktracks: event.target.value.split('\n').map((line) => line.trim()).filter(Boolean) } as ScenarioDefinition['adaptivity'];
          })}
        />
      </div>
      <div className="sw-adapt__triggers">
        <h4>{zh ? 'AI 什么时候可以进行重大调整？' : 'When may AI make major adjustments?'}</h4>
        <textarea
          rows={3}
          value={(draft.adaptivity?.majorAdjustmentTriggers ?? []).join('\n')}
          placeholder={zh ? '每行一条，如：新证据推翻原假设；原结构无法解释重要发现……' : 'One trigger per line'}
          onChange={(event) => mutateDraft((scenario) => {
            const current = scenario.adaptivity ?? { structure: { addSections: false, deleteUnlockedSections: false, splitSections: false, mergeSections: false, reorderSections: false, adjustLength: false }, content: { reviseQuestion: false, addQuestion: false, reviseHypothesis: false, dropUnsupportedHypothesis: false, adjustFramework: false }, method: { addMethod: false, replaceUnsuitableMethod: false, addRobustness: false, addHeterogeneity: false, addMechanism: false } };
            scenario.adaptivity = { ...current, majorAdjustmentTriggers: event.target.value.split('\n').map((line) => line.trim()).filter(Boolean) } as ScenarioDefinition['adaptivity'];
          })}
        />
        <p className="sw-adapt__note">{zh ? '重大调整不要求逐次审批，但必须记录调整前内容、调整后内容、原因与依据。' : 'Major adjustments require before/after records, not per-instance approval.'}</p>
      </div>
    </div>
  );

  const bindingList = (kind: 'agent' | 'skill' | 'mcp' | 'rules', boundIds: string[], onToggle: (id: string) => void) => {
    const pool = definitions.filter((definition) => definition.kind === kind);
    return (
      <div className="sw-cap__list">
        {pool.map((definition) => (
          <label key={definition.id} className="sw-cap__item">
            <input
              type="checkbox"
              checked={boundIds.includes(definition.id)}
              onChange={() => onToggle(definition.id)}
              data-testid={`sw-cap-${kind}`}
            />
            <span className="sw-cap__name">{definition.name}</span>
            <span className="sw-cap__desc">{definition.description || (definition.kind === 'agent' ? (definition as { role?: string }).role ?? '' : '')}</span>
          </label>
        ))}
        {pool.length === 0 && <p className="sw-card__empty">{zh ? '暂无可绑定资源，请先在顶部导航对应资源中心创建。' : 'No definitions of this kind yet.'}</p>}
      </div>
    );
  };

  const toggleBinding = (field: 'agentIds' | 'skillIds' | 'mcpIds' | 'rulesIds', id: string) => {
    mutateDraft((scenario) => {
      const current = scenario[field];
      scenario[field] = current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
    });
  };

  const renderCapability = () => draft && (
    <div className="sw-cap" data-testid="sw-capability">
      <section className="sw-cap__group">
        <h4>{zh ? '智能体' : 'Agents'}</h4>
        {bindingList('agent', draft.agentIds, (id) => toggleBinding('agentIds', id))}
      </section>
      <section className="sw-cap__group">
        <h4>{zh ? '技能' : 'Skills'}</h4>
        {bindingList('skill', draft.skillIds, (id) => toggleBinding('skillIds', id))}
      </section>
      <section className="sw-cap__group">
        <h4>MCP</h4>
        {bindingList('mcp', draft.mcpIds, (id) => toggleBinding('mcpIds', id))}
      </section>
      <section className="sw-cap__group">
        <h4>Metis.md</h4>
        {bindingList('rules', draft.rulesIds, (id) => toggleBinding('rulesIds', id))}
      </section>
      <section className="sw-cap__group sw-cap__group--workflow">
        <h4>{zh ? '运行方式（工作流）' : 'Workflow'}</h4>
        <ol className="sw-cap__workflow" data-testid="sw-workflow-list">
          {draft.workflow.map((step) => (
            <li key={step.id} data-testid="sw-workflow-step">
              <div className="sw-cap__step-line">
                <input
                  className="sw-cap__step-name"
                  value={step.name}
                  aria-label={zh ? `步骤 ${step.id} 名称` : `Step ${step.id} name`}
                  onChange={(event) => updateWorkflowStep(step.id, { name: event.target.value })}
                />
                <select
                  value={step.agentId}
                  aria-label={zh ? `步骤 ${step.id} 智能体` : `Step ${step.id} agent`}
                  onChange={(event) => updateWorkflowStep(step.id, { agentId: event.target.value })}
                >
                  {agentPool.map((agent) => (
                    <option key={agent.id} value={agent.id}>{agent.name}</option>
                  ))}
                </select>
                <span className="sw-cap__ops">
                  <button type="button" title={zh ? '上移' : 'Move up'} onClick={() => moveWorkflowStep(step.id, -1)}><ArrowUp size={12} aria-hidden="true" /></button>
                  <button type="button" title={zh ? '下移' : 'Move down'} onClick={() => moveWorkflowStep(step.id, 1)}><ArrowDown size={12} aria-hidden="true" /></button>
                  <button type="button" title={zh ? '删除步骤' : 'Remove step'} onClick={() => removeWorkflowStep(step.id)}><X size={12} aria-hidden="true" /></button>
                </span>
              </div>
              <input
                className="sw-cap__step-desc"
                value={step.description}
                aria-label={zh ? `步骤 ${step.id} 说明` : `Step ${step.id} description`}
                placeholder={zh ? '步骤说明' : 'Description'}
                onChange={(event) => updateWorkflowStep(step.id, { description: event.target.value })}
              />
            </li>
          ))}
          {draft.workflow.length === 0 && <li className="sw-card__empty">{zh ? '未配置工作流。可由 AI 创建场景时生成，或绑定智能体后新增步骤。' : 'No workflow yet.'}</li>}
        </ol>
        <div className="sw-cap__workflow-actions">
          <button type="button" className="btn-secondary btn-sm" disabled={!hasBoundAgent} title={hasBoundAgent ? '' : (zh ? '请先绑定智能体' : 'Bind an agent first')} onClick={addWorkflowStep} data-testid="sw-workflow-add">
            {zh ? '＋ 新增步骤' : '＋ Add step'}
          </button>
        </div>
        {(draft.adaptivity?.allowedBacktracks?.length ?? 0) > 0 && (
          <p className="sw-cap__backtrack">{zh ? '允许自动回溯：' : 'Allowed backtracks: '}{draft.adaptivity!.allowedBacktracks!.join('、')}</p>
        )}
      </section>
      <section className="sw-cap__group sw-cap__group--advanced" data-testid="sw-advanced">
        <h4>{zh ? '高级设置（记忆 · 权限 · 输出契约）' : 'Advanced (memory · access · output)'}</h4>
        <div className="sw-policy-grid">
          <label>
            <span>{zh ? '记忆范围' : 'Memory scope'}</span>
            <select
              value={draft.memory?.scope ?? 'project'}
              aria-label={zh ? '记忆范围' : 'Memory scope'}
              onChange={(event) => mutateDraft((scenario) => {
                const scope = event.target.value as 'none' | 'session' | 'project' | 'scenario';
                scenario.memory = { ...scenario.memory, scope };
              })}
            >
              <option value="none">{zh ? '不保留' : 'None'}</option>
              <option value="session">{zh ? '当前会话' : 'Session'}</option>
              <option value="project">{zh ? '当前项目' : 'Project'}</option>
              <option value="scenario">{zh ? '本场景' : 'Scenario'}</option>
            </select>
          </label>
          <label>
            <span>{zh ? '输出格式' : 'Output format'}</span>
            <select
              value={draft.output?.format ?? 'markdown'}
              aria-label={zh ? '输出格式' : 'Output format'}
              onChange={(event) => mutateDraft((scenario) => {
                const format = event.target.value as ScenarioDefinition['output']['format'];
                scenario.output = { ...scenario.output, format };
              })}
            >
              <option value="markdown">Markdown</option>
              <option value="document">{zh ? '文档' : 'Document'}</option>
              <option value="json">JSON</option>
              <option value="artifact_bundle">{zh ? '成果包' : 'Artifact bundle'}</option>
              <option value="custom">{zh ? '自定义' : 'Custom'}</option>
            </select>
          </label>
          <label>
            <span>{zh ? '主要交付物' : 'Primary deliverable'}</span>
            <input
              value={draft.output?.plan?.primaryDeliverable ?? ''}
              aria-label={zh ? '主要交付物' : 'Primary deliverable'}
              placeholder={zh ? '如：一篇可投稿的实证论文' : 'e.g. A submittable empirical paper'}
              onChange={(event) => mutateDraft((scenario) => {
                const plan = scenario.output.plan ?? { primaryDeliverable: '', supportingArtifacts: [], qualityCriteria: [] };
                scenario.output = { ...scenario.output, plan: { ...plan, primaryDeliverable: event.target.value.slice(0, 512) } };
              })}
            />
          </label>
          <label>
            <span>{zh ? '辅助成果（每行一条）' : 'Supporting artifacts'}</span>
            <textarea
              rows={2}
              aria-label={zh ? '辅助成果' : 'Supporting artifacts'}
              value={(draft.output?.plan?.supportingArtifacts ?? []).join('\n')}
              onChange={(event) => mutateDraft((scenario) => {
                const plan = scenario.output.plan ?? { primaryDeliverable: '', supportingArtifacts: [], qualityCriteria: [] };
                scenario.output = { ...scenario.output, plan: { ...plan, supportingArtifacts: event.target.value.split('\n').map((line) => line.trim()).filter(Boolean) } };
              })}
            />
          </label>
          <label>
            <span>{zh ? '质量标准（每行一条）' : 'Quality criteria'}</span>
            <textarea
              rows={2}
              aria-label={zh ? '质量标准' : 'Quality criteria'}
              value={(draft.output?.plan?.qualityCriteria ?? []).join('\n')}
              onChange={(event) => mutateDraft((scenario) => {
                const plan = scenario.output.plan ?? { primaryDeliverable: '', supportingArtifacts: [], qualityCriteria: [] };
                scenario.output = { ...scenario.output, plan: { ...plan, qualityCriteria: event.target.value.split('\n').map((line) => line.trim()).filter(Boolean) } };
              })}
            />
          </label>
        </div>
        <p className="sw-cap__access" data-testid="sw-full-access">
          {zh ? '全权限运行：自动执行、实时纠偏、失败不自动回滚外部副作用；真实性层始终强制。' : 'Full access: autonomous execution with live steering; external side effects are never auto-rolled back.'}
        </p>
      </section>
    </div>
  );

  const renderRightPanel = () => {
    if (tab === 'structure' && selectedSection) {
      const section = selectedSection;
      return (
        <div className="sw-ctx" data-testid="sw-context-editor">
          <h3>{section.title}</h3>
          <p className="sw-ctx__kind">{SECTION_KIND_LABELS[section.kind] ?? section.kind} · {STATUS_LABELS[section.status]?.[zh ? 'zh' : 'en']}</p>
          <label><span>{zh ? '标题' : 'Title'}</span>
            <input value={section.title} onChange={(event) => updateSection(section.id, { title: event.target.value })} />
          </label>
          <label><span>{zh ? '类型' : 'Kind'}</span>
            <select value={section.kind} onChange={(event) => updateSection(section.id, { kind: event.target.value as Section['kind'] })}>
              {Object.entries(SECTION_KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          {section.status === 'conditional' && (
            <label><span>{zh ? '出现条件' : 'Condition'}</span>
              <input value={section.condition ?? ''} onChange={(event) => updateSection(section.id, { condition: event.target.value })} />
            </label>
          )}
          <label><span>{zh ? '这一部分负责什么' : 'Purpose'}</span>
            <textarea rows={2} value={section.purpose ?? ''} onChange={(event) => updateSection(section.id, { purpose: event.target.value })} />
          </label>
          <label><span>{zh ? '必须包含（每行一条）' : 'Must include'}</span>
            <textarea rows={3} value={(section.requirements ?? []).join('\n')} onChange={(event) => updateSection(section.id, { requirements: event.target.value.split('\n').map((line) => line.trim()).filter(Boolean) })} />
          </label>
          <label><span>{zh ? '可选内容（每行一条）' : 'Optional content'}</span>
            <textarea rows={2} value={(section.optionalContent ?? []).join('\n')} onChange={(event) => updateSection(section.id, { optionalContent: event.target.value.split('\n').map((line) => line.trim()).filter(Boolean) })} />
          </label>
          <label><span>{zh ? '禁止事项（每行一条）' : 'Forbidden'}</span>
            <textarea rows={2} value={(section.forbidden ?? []).join('\n')} onChange={(event) => updateSection(section.id, { forbidden: event.target.value.split('\n').map((line) => line.trim()).filter(Boolean) })} />
          </label>
          <label><span>{zh ? '建议篇幅' : 'Length'}</span>
            <input value={section.lengthTarget ?? ''} placeholder={zh ? '如 1800-2500 字' : 'e.g. 1800-2500 words'} onChange={(event) => updateSection(section.id, { lengthTarget: event.target.value })} />
          </label>
          <label><span>{zh ? '方法' : 'Method'}</span>
            <input value={section.method ?? ''} onChange={(event) => updateSection(section.id, { method: event.target.value })} />
          </label>
          <label><span>{zh ? '证据要求' : 'Evidence'}</span>
            <input value={section.evidence ?? ''} onChange={(event) => updateSection(section.id, { evidence: event.target.value })} />
          </label>
          <AiRefineBox
            zh={zh}
            busy={aiBusy}
            note={aiNote}
            instruction={aiInstruction}
            onInstructionChange={setAiInstruction}
            onRun={() => void runAiRefine('section')}
            placeholder={zh ? `按更高标准完善「${section.title}」的要求…` : 'Refine this section…'}
          />
        </div>
      );
    }
    if (tab === 'rules') {
      return (
        <div className="sw-ctx" data-testid="sw-context-editor">
          <h3>{zh ? '写作规范 · AI 辅助' : 'Writing rules · AI assist'}</h3>
          <p className="sw-ctx__hint">{zh ? '让 AI 按你的要求（或参考材料）补全写作规范或方法策略。' : 'Let AI refine rules or methods.'}</p>
          <AiRefineBox
            zh={zh}
            busy={aiBusy}
            note={aiNote}
            instruction={aiInstruction}
            onInstructionChange={setAiInstruction}
            onRun={() => void runAiRefine('writingRules')}
            placeholder={zh ? '按 CSSCI 顶刊标准帮我完善写作规范…' : 'Refine writing rules…'}
          />
          <h3 style={{ marginTop: 16 }}>{zh ? '方法策略 · AI 辅助' : 'Method policy · AI assist'}</h3>
          <AiRefineBox
            zh={zh}
            busy={aiBusy}
            note=""
            instruction={aiInstruction}
            onInstructionChange={setAiInstruction}
            onRun={() => void runAiRefine('methodPolicy')}
            placeholder={zh ? '根据这个场景的研究类型调整方法策略…' : 'Refine method policy…'}
          />
        </div>
      );
    }
    if (tab === 'adapt') {
      return (
        <div className="sw-ctx" data-testid="sw-context-editor">
          <h3>{zh ? '自适应 · AI 辅助' : 'Adaptivity · AI assist'}</h3>
          <p className="sw-ctx__hint">{zh ? '让 AI 按场景特征建议一组合理的自主边界。' : 'Let AI propose boundaries.'}</p>
          <AiRefineBox
            zh={zh}
            busy={aiBusy}
            note={aiNote}
            instruction={aiInstruction}
            onInstructionChange={setAiInstruction}
            onRun={() => void runAiRefine('adaptivity')}
            placeholder={zh ? '为理论型论文场景设计合理的自适应边界…' : 'Propose adaptivity…'}
          />
        </div>
      );
    }
    return (
      <div className="sw-ctx sw-ctx--empty" data-testid="sw-context-editor">
        <p>{zh ? '点击中间区域的章节、能力或规则，在此编辑。' : 'Click a section, capability, or rule to edit it here.'}</p>
      </div>
    );
  };

  const TABS: Array<[WorkbenchTab, string]> = [
    ['overview', zh ? '总览' : 'Overview'],
    ['structure', zh ? '成果结构' : 'Deliverable'],
    ['rules', zh ? '规则与方法' : 'Rules & methods'],
    ['adapt', zh ? '自适应' : 'Adaptivity'],
    ['capability', zh ? '能力与运行' : 'Capabilities'],
  ];

  const renderScenarioItem = (scenario: ScenarioDefinition): React.ReactElement => {
    const typeLabel = DELIVERABLE_LABELS[scenario.deliverable?.type ?? ''] ?? (zh ? '自定义' : 'Custom');
    return (
      <div key={scenario.id} className={'sw-library__item' + (selectedId === scenario.id ? ' selected' : '')}>
        <button type="button" className="sw-library__select" onClick={() => onSelect(scenario.id)} data-testid="sw-scenario-item">
          <strong>{scenario.name}</strong>
          <span className="sw-library__meta">
            <em>{typeLabel}</em>
            {scenario.enabled ? (zh ? '已启用' : 'Enabled') : (zh ? '已停用' : 'Disabled')}
          </span>
        </button>
        <button type="button" className={'sw-library__fav' + (favorites.includes(scenario.id) ? ' on' : '')} onClick={() => toggleFavorite(scenario.id)} aria-label={zh ? '收藏' : 'Favorite'}><Star size={13} aria-hidden="true" /></button>
        <button type="button" className="sw-library__del" title={zh ? '删除场景' : 'Delete scenario'} aria-label={zh ? '删除场景' : 'Delete scenario'} onClick={() => requestDeleteScenario(scenario)} data-testid="sw-scenario-delete"><Trash2 size={13} aria-hidden="true" /></button>
      </div>
    );
  };

  // 可折叠分组：全部/最近/收藏 + 内置分组 + 自定义分类。头部左侧箭头折叠/展开，自定义分类可删除。
  const renderGroup = (groupId: string, label: string, list: ScenarioDefinition[], opts?: { deletable?: boolean }): React.ReactElement => {
    const isCollapsed = !expanded.has(groupId);
    return (
      <div key={groupId} className="sw-group">
        <div className="sw-group__head">
          <button type="button" className="sw-group__toggle" onClick={() => toggleCollapse(groupId)} aria-expanded={!isCollapsed} data-testid="sw-library-view">
            {isCollapsed ? <ChevronRight size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
            <span className="sw-group__label">{label}</span>
            <span className="sw-group__count">{list.length}</span>
          </button>
          {opts?.deletable && (
            <button type="button" className="sw-group__del" title={zh ? '删除分类' : 'Delete category'} aria-label={zh ? '删除分类' : 'Delete category'} onClick={() => setDeletingCategory(categories.find((item) => item.id === groupId) ?? null)} data-testid={'sw-category-delete-' + groupId}><Trash2 size={12} aria-hidden="true" /></button>
          )}
        </div>
        {!isCollapsed && (
          <div className="sw-group__list">
            {list.map(renderScenarioItem)}
            {list.length === 0 && <p className="sw-library__empty">{zh ? '暂无场景' : 'No scenarios'}</p>}
          </div>
        )}
      </div>
    );
  };

  const recentScenarios = (() => {
    const recent = readJsonMap(RECENT_KEY);
    return [...scenarios].sort((a, b) => (recent[b.id] ?? 0) - (recent[a.id] ?? 0)).slice(0, 8);
  })();
  const favoriteScenarios = scenarios.filter((scenario) => favorites.includes(scenario.id));

  return (
    <div className="sw-layout" data-testid="scenario-workbench">
      <aside className="sw-library">
        <div className="sw-library__actions">
          <button type="button" className="btn-primary" onClick={() => { createScenario(); }} data-testid="sw-new-scenario">{zh ? '＋ 新建场景' : '＋ New'}</button>
          <button type="button" className="sw-library__ai" onClick={onOpenAiCreate} data-testid="sw-ai-create"><Sparkles size={14} aria-hidden="true" /> {zh ? 'AI 创建场景' : 'AI create'}</button>
          {onOpenTemplateRecognize && (
            <button type="button" className="sw-library__template" onClick={onOpenTemplateRecognize} data-testid="sw-new-template">{zh ? '模板识别（论文结构）' : 'Template recognition'}</button>
          )}
        </div>
        <div className="sw-library__tree">
          {renderGroup('all', zh ? '全部' : 'All', scenarios)}
          {renderGroup('recent', zh ? '最近使用' : 'Recent', recentScenarios)}
          {renderGroup('favorites', zh ? '收藏' : 'Favorites', favoriteScenarios)}
          <div className="sw-library__cathead">
            <span>{zh ? '分类' : 'Categories'}</span>
            <button type="button" className="sw-library__catnew" title={zh ? '新建分类' : 'New category'} aria-label={zh ? '新建分类' : 'New category'} onClick={() => setNewCategoryOpen((open) => !open)} data-testid="sw-new-category"><Plus size={13} aria-hidden="true" /></button>
          </div>
          {newCategoryOpen && (
            <div className="sw-library__catnewform" data-testid="sw-new-category-form">
              <input
                type="text"
                value={newCategoryName}
                onChange={(event) => setNewCategoryName(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') createCategory(); }}
                placeholder={zh ? '分类名称' : 'Category name'}
                aria-label={zh ? '分类名称' : 'Category name'}
                data-testid="sw-new-category-input"
              />
              <button type="button" className="btn-primary btn-sm" onClick={createCategory} data-testid="sw-new-category-submit">{zh ? '新建' : 'Create'}</button>
            </div>
          )}
          {CATEGORY_GROUPS.map((group) => renderGroup(group.id, zh ? group.labelZh : group.labelEn, grouped.get(group.id) ?? []))}
          {renderGroup('mine', zh ? '我的场景' : 'My scenarios', grouped.get('mine') ?? [])}
          {categories.map((category) => renderGroup(category.id, category.name, categoryScenarios.get(category.id) ?? [], { deletable: true }))}
          {deletingCategory && (
            <div className="sw-catdel" data-testid="sw-category-delete-panel">
              <p className="sw-catdel__title">{zh ? ('删除分类「' + deletingCategory.name + '」？') : ('Delete category "' + deletingCategory.name + '"?')}</p>
              <p className="sw-catdel__meta">{zh ? ('分类内有 ' + (categoryScenarios.get(deletingCategory.id)?.length ?? 0) + ' 个场景') : ((categoryScenarios.get(deletingCategory.id)?.length ?? 0) + ' scenario(s) inside')}</p>
              <button type="button" className="btn-secondary btn-sm" onClick={() => deleteCategory(deletingCategory, false)} data-testid="sw-category-delete-keep">{zh ? '保留场景，仅删分类' : 'Keep scenarios, delete category'}</button>
              <button type="button" className="btn-secondary btn-sm sw-catdel__danger" onClick={() => deleteCategory(deletingCategory, true)} data-testid="sw-category-delete-all">{zh ? ('连同 ' + (categoryScenarios.get(deletingCategory.id)?.length ?? 0) + ' 个场景一起删除') : ('Delete category and its scenarios')}</button>
              <button type="button" className="sw-catdel__cancel" onClick={() => setDeletingCategory(null)} data-testid="sw-category-delete-cancel">{zh ? '取消' : 'Cancel'}</button>
            </div>
          )}
        </div>
      </aside>

      <main className="sw-main">
        {!draft && (
          <div className="sw-empty" data-testid="sw-empty">
            <p>{zh ? '选择左侧场景，或使用「AI 创建场景」开始。' : 'Pick a scenario on the left, or start with AI creation.'}</p>
          </div>
        )}
        {draft && (
          <>
            <header className="sw-head">
              <div className="sw-head__info">
                <input
                  className="sw-head__name"
                  value={draft.name}
                  onChange={(event) => mutateDraft((scenario) => { scenario.name = event.target.value; })}
                  aria-label={zh ? '场景名称' : 'Scenario name'}
                />
                <input
                  className="sw-head__desc"
                  value={draft.description}
                  placeholder={zh ? '一句话说明这个场景做什么' : 'One-line description'}
                  onChange={(event) => mutateDraft((scenario) => { scenario.description = event.target.value; })}
                  aria-label={zh ? '场景说明' : 'Description'}
                />
              </div>
              <div className="sw-head__actions">
                {categories.length > 0 && selected && (
                  <label className="sw-head__category" title={zh ? '归入自定义分类' : 'Assign to custom category'}>
                    <span>{zh ? '分类' : 'Category'}</span>
                    <select
                      value={categoryMap[selected.id] ?? ''}
                      onChange={(event) => assignCategory(selected.id, event.target.value || null)}
                      data-testid="sw-assign-category"
                      aria-label={zh ? '归入分类' : 'Assign category'}
                    >
                      <option value="">{zh ? '自动（按成果类型）' : 'Auto (by deliverable type)'}</option>
                      {categories.map((category) => (
                        <option key={category.id} value={category.id}>{category.name}</option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="sw-head__enabled">
                  <input type="checkbox" checked={draft.enabled} onChange={() => mutateDraft((scenario) => { scenario.enabled = !scenario.enabled; })} />
                  {zh ? '启用' : 'Enabled'}
                </label>
                <span className="sw-head__save-state" data-testid="sw-save-state">{saveState}</span>
                <button type="button" className="btn-secondary btn-sm" disabled={!draft || !selected} onClick={() => void persistDraft()} data-testid="sw-save">{zh ? '保存' : 'Save'}</button>
                {selected && (
                  <button type="button" className="btn-secondary btn-sm sw-head__delete" title={zh ? '删除场景' : 'Delete scenario'} onClick={() => requestDeleteScenario(selected)} data-testid="sw-delete">{zh ? '删除' : 'Delete'}</button>
                )}
                <div className="sw-use">
                  <button type="button" className="btn-primary btn-sm" onClick={() => setUseMenuOpen((open) => !open)} data-testid="sw-use">{zh ? '使用此场景' : 'Use scenario'} <ChevronDown size={13} aria-hidden="true" /></button>
                  {useMenuOpen && (
                    <div className="sw-use__menu" role="menu" data-testid="sw-use-menu">
                      <button type="button" disabled={useBlocked} title={useBlockedTitle} data-testid="sw-use-current" onClick={() => void applyScenarioUse('current')}>{zh ? '用于当前项目' : 'Current project'}</button>
                      <button type="button" disabled={useBlocked} title={useBlockedTitle} data-testid="sw-use-new" onClick={() => void applyScenarioUse('new')}>{zh ? '用于新项目' : 'New project'}</button>
                      <button type="button" onClick={() => void applyScenarioUse('autonomous')}>{zh ? '用于自主科研' : 'Autonomous research'}</button>
                    </div>
                  )}
                </div>
              </div>
            </header>
            <nav className="sw-tabs" role="tablist">
              {TABS.map(([value, label]) => (
                <button key={value} type="button" role="tab" aria-selected={tab === value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)} data-testid={`sw-tab-${value}`}>{label}</button>
              ))}
            </nav>
            <div className="sw-body">
              {tab === 'overview' && renderOverview()}
              {tab === 'structure' && renderStructure()}
              {tab === 'rules' && renderRules()}
              {tab === 'adapt' && renderAdapt()}
              {tab === 'capability' && renderCapability()}
            </div>
          </>
        )}
      </main>

      <aside className="sw-right">{renderRightPanel()}</aside>
    </div>
  );
}

function AiRefineBox({
  zh, busy, note, instruction, onInstructionChange, onRun, placeholder,
}: {
  zh: boolean;
  busy: boolean;
  note: string;
  instruction: string;
  onInstructionChange(value: string): void;
  onRun(): void;
  placeholder: string;
}) {
  return (
    <div className="sw-airefine" data-testid="sw-ai-refine">
      <h4><Sparkles size={13} aria-hidden="true" /> {zh ? '让 AI 帮我配置' : 'AI assist'}</h4>
      <textarea rows={2} value={instruction} placeholder={placeholder} onChange={(event) => onInstructionChange(event.target.value)} data-testid="sw-ai-refine-input" />
      <button type="button" className="btn-primary btn-sm" disabled={busy || instruction.trim().length < 2} onClick={onRun} data-testid="sw-ai-refine-run">
        {busy ? (zh ? '生成中…' : 'Working…') : (zh ? 'AI 补全' : 'Refine')}
      </button>
      {note && <p className="sw-airefine__note" role="status">{note}</p>}
    </div>
  );
}
