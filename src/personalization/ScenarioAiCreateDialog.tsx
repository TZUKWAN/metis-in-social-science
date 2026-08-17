/**
 * ScenarioAiCreateDialog — AI 创建场景（场景重构 P2）。
 *
 * 最简入口：描述需求（可选）+ 上传任意参考材料（可选）→ AI 综合分析 →
 * 结果摘要（AI 已理解该场景）→ 生成场景 / 查看并调整。
 * 生成管线：智能体 → 场景（含成果结构/自适应/写作规范/方法策略/参考材料）
 * → 场景 Metis.md 绑定。
 */
import { useMemo, useRef, useState } from 'react';
import type { AgentDefinition, DeliverableSpec, MetisRulesDefinition, PersonalizationDefinition, ScenarioDefinition } from '../../engine/runtime/PersonalizationRuntimeContract.js';
import { availableUserId, createDefinition } from './personalizationLib.js';

interface ImportedMaterial {
  id: string;
  name: string;
  charCount: number;
}

interface AnalysisSummary {
  deliverableType: string;
  deliverableTypeLabel: string;
  structureTitles: string[];
  hardRuleCount: number;
  writingPrincipleCount: number;
  methods: string[];
  adjustable: string[];
  recommended: { agents: number; skills: number; mcps: number; rules: number };
}

interface AnalysisMaterial {
  name: string;
  kind: string;
  insights: { structureRules: string[]; writingPrinciples: string[]; methodSuggestions: string[]; hardRequirements: string[] };
}

interface ScenarioDraftPayload {
  name: string;
  description: string;
  triggerPhrases: string[];
  deliverableType: string;
  deliverableTypeLabel: string;
  sections: Array<Record<string, unknown>>;
  structurePolicy?: { defaultSections: number; suggestedMin: number; suggestedMax: number };
  globalLength?: string;
  language?: string;
  journalTier?: string;
  adaptivity?: Record<string, unknown>;
  writingRules: string[];
  methodPolicy?: { recommended: string[]; allowed: string[]; conditional: string[]; forbidden: string[] };
  agents: Array<{ name: string; role: string; systemPrompt: string; skillIds: string[]; toolIds: string[]; mcpIds: string[]; maxTurns: number }>;
  workflow: Array<{ name: string; description: string; agent: string; skillIds: string[]; toolIds: string[]; mcpIds: string[]; maxTurns: number }>;
  rulesMarkdown: string;
}

export interface ScenarioAiAnalysisResult {
  summary: AnalysisSummary;
  materials: AnalysisMaterial[];
  draft: ScenarioDraftPayload;
}

const DELIVERABLE_LABELS: Record<string, string> = {
  theory_paper: '纯理论论文', empirical_paper: '实证论文', computational_paper: '计算社会科学论文',
  case_study: '案例研究', review_paper: '综述论文',
  grant_nssfc: '国家社科基金申报', grant_nsfc: '国家自然科学基金申报', grant_postdoc: '博士后基金申报', grant_other: '其他项目申报',
  policy_report: '决策咨询报告', survey_report: '调研报告', tech_report: '技术报告', industry_report: '行业报告',
  thesis: '学位论文', opening_report: '开题报告', completion_report: '项目结项', custom: '自定义成果',
};

export default function ScenarioAiCreateDialog({
  zh, definitions, onClose, onGenerated,
}: {
  zh: boolean;
  definitions: PersonalizationDefinition[];
  onClose(): void;
  onGenerated(scenarioId: string, openStructure: boolean): void;
}) {
  const [description, setDescription] = useState('');
  const [materials, setMaterials] = useState<ImportedMaterial[]>([]);
  const [step, setStep] = useState<'input' | 'analyzing' | 'summary'>('input');
  const [status, setStatus] = useState('');
  const [result, setResult] = useState<ScenarioAiAnalysisResult | null>(null);
  const [materialNames, setMaterialNames] = useState<Array<{ name: string; kind: string; insights: AnalysisMaterial['insights'] }>>([]);
  const importing = useRef(false);

  const canAnalyze = description.trim().length >= 2 || materials.length > 0;

  const catalog = useMemo(() => definitions
    .map((d) => ({ id: d.id, kind: d.kind, name: d.name, description: d.description }))
    .slice(0, 500), [definitions]);

  const pickFiles = async () => {
    const metis = window.metis;
    if (!metis?.openReferenceFileDialog || importing.current) return;
    importing.current = true;
    try {
      const paths = await metis.openReferenceFileDialog();
      if (paths.length === 0) return;
      setStatus(zh ? '正在读取参考材料…' : 'Reading reference materials…');
      const imported = await metis.importScenarioMaterials({
        files: paths.map((filePath) => {
          const name = filePath.split('/').pop() ?? filePath;
          return { path: filePath, name };
        }),
      });
      if (!imported.ok || !imported.materials) {
        setStatus(zh ? `材料读取失败：${imported.error ?? imported.code ?? 'unknown'}` : `Import failed: ${imported.error ?? imported.code ?? 'unknown'}`);
        return;
      }
      setMaterials((prev) => [
        ...prev,
        ...imported.materials!.map((m) => ({ id: m.id, name: m.name, charCount: m.charCount })),
      ]);
      setStatus(imported.errors && imported.errors.length > 0
        ? (zh ? `已读取 ${imported.materials.length} 份；${imported.errors.length} 份失败（不支持的格式）` : `${imported.materials.length} imported; ${imported.errors.length} failed`)
        : (zh ? `已读取 ${imported.materials.length} 份参考材料。` : `${imported.materials.length} materials imported.`));
    } finally {
      importing.current = false;
    }
  };

  const analyze = async () => {
    const metis = window.metis;
    if (!metis?.analyzeScenarioMaterials) {
      setStatus(zh ? 'AI 分析服务不可用，请检查模型连接。' : 'Analysis service unavailable.');
      return;
    }
    if (!canAnalyze) return;
    setStep('analyzing');
    setStatus(zh ? 'AI 正在阅读材料并设计场景…' : 'AI is reading the materials and designing the scenario…');
    try {
      const result = await metis.analyzeScenarioMaterials({
        prompt: description,
        materialIds: materials.map((m) => m.id),
        definitions: catalog,
      });
      if (!result.ok || !result.result) {
        setStep('input');
        setStatus(zh ? `分析失败（${result.code ?? 'unknown'}）${result.message ?? ''}` : `Analysis failed (${result.code ?? 'unknown'}) ${result.message ?? ''}`);
        return;
      }
      const analysis = result.result as unknown as ScenarioAiAnalysisResult;
      setResult(analysis);
      setMaterialNames(analysis.materials ?? []);
      setStep('summary');
      setStatus('');
    } catch {
      setStep('input');
      setStatus(zh ? '分析未完成，请重试。' : 'Analysis did not complete. Retry.');
    }
  };

  const generate = async (openStructure: boolean) => {
    if (!result) return;
    const metis = window.metis;
    if (!metis?.savePersonalization) return;
    const draft = result.draft;
    const summary = result.summary;
    setStatus(zh ? '正在生成场景…' : 'Creating the scenario…');
    try {
      // 1) 智能体
      const agentIdByName = new Map<string, string>();
      for (const agent of draft.agents ?? []) {
        const created = createDefinition('agent', agent.name, definitions) as AgentDefinition;
        const full: AgentDefinition = {
          ...created,
          role: agent.role || created.role,
          systemPrompt: agent.systemPrompt || created.systemPrompt,
          skillIds: (agent.skillIds ?? []).filter((id) => definitions.some((d) => d.id === id && d.kind === 'skill')),
          toolIds: agent.toolIds ?? [],
          mcpIds: (agent.mcpIds ?? []).filter((id) => definitions.some((d) => d.id === id && d.kind === 'mcp')),
          maxTurns: Math.min(100, Math.max(1, agent.maxTurns || 12)),
        };
        const saved = await metis.savePersonalization({ contractVersion: 1, definition: full, expectedRevision: 0 });
        if (saved.ok && saved.code === 'saved' && saved.definition) {
          agentIdByName.set(agent.name, saved.definition.id);
        }
      }
      // 2) 场景（含成果结构/自适应/写作规范/方法策略/参考材料）
      const scenarioBase = createDefinition('scenario', draft.name || '未命名场景', definitions) as ScenarioDefinition;
      const journalTier = draft.journalTier === 'core' || draft.journalTier === 'general' || draft.journalTier === 'any' ? draft.journalTier : undefined;
      const scenario: ScenarioDefinition = {
        ...scenarioBase,
        description: draft.description || scenarioBase.description,
        triggerPhrases: draft.triggerPhrases ?? [],
        agentIds: [...agentIdByName.values()],
        workflow: (draft.workflow ?? []).map((step, index) => ({
          id: `step-${index + 1}`,
          name: step.name,
          description: step.description,
          agentId: agentIdByName.get(step.agent) ?? [...agentIdByName.values()][0] ?? '',
          skillIds: (step.skillIds ?? []).filter((id) => definitions.some((d) => d.id === id && d.kind === 'skill')),
          toolIds: step.toolIds ?? [],
          mcpIds: (step.mcpIds ?? []).filter((id) => definitions.some((d) => d.id === id && d.kind === 'mcp')),
          dependsOn: index > 0 ? [`step-${index}`] : [],
          maxTurns: Math.min(100, Math.max(1, step.maxTurns || 12)),
        })).filter((step) => step.agentId),
        deliverable: {
          type: (draft.deliverableType || 'custom') as DeliverableSpec['type'],
          typeLabel: draft.deliverableTypeLabel || summary.deliverableTypeLabel,
          sections: (draft.sections ?? []) as unknown as DeliverableSpec['sections'],
          structurePolicy: draft.structurePolicy,
          globalLength: draft.globalLength,
          language: draft.language === 'en' ? 'en' : 'zh',
          journalTier,
        },
        adaptivity: draft.adaptivity as ScenarioDefinition['adaptivity'],
        writingRules: draft.writingRules ?? [],
        methodPolicy: draft.methodPolicy,
        materials: (materialNames ?? []).map((material, index) => {
          const imported = materials[index];
          return {
            id: imported?.id ?? `mat-${index + 1}`,
            name: material.name,
            kind: (['template', 'exemplar', 'paper', 'textbook', 'method_book', 'guide', 'policy', 'format_spec', 'user_spec', 'other'] as const).includes(material.kind as never)
              ? material.kind as 'other'
              : 'other',
            analyzedAt: Date.now(),
            insights: {
              structureRules: material.insights?.structureRules ?? [],
              writingPrinciples: material.insights?.writingPrinciples ?? [],
              methodSuggestions: material.insights?.methodSuggestions ?? [],
              hardRequirements: material.insights?.hardRequirements ?? [],
            },
          };
        }),
      };
      const savedScenario = await metis.savePersonalization({ contractVersion: 1, definition: scenario, expectedRevision: 0 });
      if (!savedScenario.ok || savedScenario.code !== 'saved' || !savedScenario.definition) {
        setStatus(zh ? `场景保存失败（${savedScenario.code}）。` : `Scenario save failed (${savedScenario.code}).`);
        return;
      }
      // 3) 场景 Metis.md
      if (draft.rulesMarkdown) {
        const rulesBase = createDefinition('rules', `${draft.name} · 场景记忆`, definitions) as MetisRulesDefinition;
        const rulesDefinition: MetisRulesDefinition = {
          ...rulesBase,
          id: availableUserId('rules', `${draft.name} · 场景记忆`, definitions),
          scope: 'scenario',
          scopeId: savedScenario.definition.id,
          markdown: `# ${draft.name} · 场景记忆\n\n${draft.rulesMarkdown}`,
        };
        const savedRules = await metis.savePersonalization({ contractVersion: 1, definition: rulesDefinition, expectedRevision: 0 });
        if (savedRules.ok && savedRules.code === 'saved' && savedRules.definition) {
          const bound = JSON.parse(JSON.stringify(savedScenario.definition)) as ScenarioDefinition;
          bound.rulesIds = [...(bound.rulesIds ?? []), savedRules.definition.id];
          // CAS 语义：仓库要求 definition.revision === 当前版本 + 1（见 PersonalizationRepository.save），
          // 场景已存为版本 1，绑定时必须提升到 2，否则 revision_conflict 静默失败。
          bound.revision = savedScenario.definition.revision + 1;
          await metis.savePersonalization({ contractVersion: 1, definition: bound, expectedRevision: savedScenario.definition.revision });
        }
      }
      onGenerated(savedScenario.definition.id, openStructure);
    } catch {
      setStatus(zh ? '生成未完成，请重试。' : 'Generation did not complete. Retry.');
    }
  };

  const summary = result?.summary;
  return (
    <div className="scai-overlay" data-testid="scenario-ai-create" role="dialog" aria-modal="true" aria-label={zh ? 'AI 创建场景' : 'AI scenario creation'}>
      <div className="scai-dialog">
        <header className="scai-dialog__head">
          <h2>✨ {zh ? 'AI 创建场景' : 'AI scenario creation'}</h2>
          <button type="button" className="btn-secondary btn-sm" onClick={onClose} aria-label={zh ? '关闭' : 'Close'}>✕</button>
        </header>

        {step !== 'summary' && (
          <div className="scai-dialog__body">
            <label className="scai-field">
              <span>{zh ? '你想创建什么场景？' : 'What scenario do you want?'}</span>
              <textarea
                rows={4}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                data-testid="scai-description"
                placeholder={zh
                  ? '描述你希望 AI 如何完成这类科研任务。例如：创建一个 CSSCI 纯理论论文场景，正文一般 5 章约 12000 字，强调理论逻辑与经典文献，不做实证，但允许 AI 根据论证需要调整主体章节数量。'
                  : 'Describe how AI should handle this kind of research task.'}
              />
            </label>

            <div
              className="scai-dropzone"
              data-testid="scai-materials"
              onClick={() => void pickFiles()}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => { event.preventDefault(); void pickFiles(); }}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => { if (event.key === 'Enter') void pickFiles(); }}
            >
              <strong>{zh ? '＋ 提供参考材料（可选）' : '＋ Reference materials (optional)'}</strong>
              <span>{zh ? '可上传模板、范文、论文、申报书、写作教材、专著、方法书、投稿指南、规范文件或其他任意参考材料（pdf / docx / txt / md）。' : 'Upload templates, exemplars, papers, textbooks, guides, or any reference file.'}</span>
            </div>
            {materials.length > 0 && (
              <ul className="scai-materials" data-testid="scai-material-list">
                {materials.map((material) => (
                  <li key={material.id}>
                    <span className="scai-materials__name">{material.name}</span>
                    <span className="scai-materials__meta">{(material.charCount / 1000).toFixed(1)}k {zh ? '字' : 'chars'}</span>
                    <button type="button" className="btn-secondary btn-sm" onClick={() => setMaterials((prev) => prev.filter((m) => m.id !== material.id))}>{zh ? '移除' : 'Remove'}</button>
                  </li>
                ))}
              </ul>
            )}

            <footer className="scai-dialog__actions">
              <span className="scai-dialog__hint">{zh ? '可以只写需求、只传材料，或两者都提供。' : 'Describe, upload, or both.'}</span>
              <button type="button" className="btn-primary" disabled={!canAnalyze || step === 'analyzing'} onClick={() => void analyze()} data-testid="scai-analyze">
                {step === 'analyzing' ? (zh ? '分析中…' : 'Analyzing…') : (zh ? '开始分析' : 'Analyze')}
              </button>
            </footer>
          </div>
        )}

        {step === 'summary' && summary && (
          <div className="scai-dialog__body scai-summary" data-testid="scai-summary">
            <h3>{zh ? 'AI 已理解该场景' : 'AI has understood the scenario'}</h3>
            <dl className="scai-summary__grid">
              <div><dt>{zh ? '成果类型' : 'Deliverable'}</dt><dd>{summary.deliverableTypeLabel || DELIVERABLE_LABELS[summary.deliverableType] || summary.deliverableType}</dd></div>
              <div><dt>{zh ? '默认结构' : 'Default structure'}</dt><dd>{summary.structureTitles.slice(0, 8).join(' + ')}{summary.structureTitles.length > 8 ? ' …' : ''}</dd></div>
              <div><dt>{zh ? '硬性规则' : 'Hard rules'}</dt><dd>{summary.hardRuleCount} {zh ? '条' : ''}</dd></div>
              <div><dt>{zh ? '写作原则' : 'Writing principles'}</dt><dd>{summary.writingPrincipleCount} {zh ? '条' : ''}</dd></div>
              <div><dt>{zh ? '研究方法' : 'Methods'}</dt><dd>{summary.methods.length > 0 ? summary.methods.join(' / ') : (zh ? '待定' : 'TBD')}</dd></div>
              <div><dt>{zh ? '可调整内容' : 'Adjustable'}</dt><dd>{summary.adjustable.join('、') || (zh ? '按默认自适应' : 'Default adaptivity')}</dd></div>
              <div><dt>{zh ? '推荐能力' : 'Recommended'}</dt><dd>{zh ? `${summary.recommended.agents} 智能体 / ${summary.recommended.skills} 技能 / ${summary.recommended.mcps} MCP / ${summary.recommended.rules} Metis.md` : `${summary.recommended.agents} agents / ${summary.recommended.skills} skills / ${summary.recommended.mcps} MCP / ${summary.recommended.rules} rules`}</dd></div>
            </dl>
            {materialNames.length > 0 && (
              <div className="scai-sources">
                <h4>{zh ? '主要学习来源' : 'Learning sources'}</h4>
                <ul>
                  {materialNames.map((material) => (
                    <li key={material.name}>
                      <span>{material.name}</span>
                      <span className="scai-sources__insights">
                        {zh ? '结构规则' : 'structure'} {material.insights?.structureRules?.length ?? 0}
                        · {zh ? '写作原则' : 'writing'} {material.insights?.writingPrinciples?.length ?? 0}
                        · {zh ? '方法' : 'method'} {material.insights?.methodSuggestions?.length ?? 0}
                        · {zh ? '硬性要求' : 'hard'} {material.insights?.hardRequirements?.length ?? 0}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <footer className="scai-dialog__actions">
              <button type="button" className="btn-secondary" onClick={() => setStep('input')}>{zh ? '返回修改' : 'Back'}</button>
              <button type="button" className="btn-secondary" onClick={() => void generate(true)} data-testid="scai-generate-adjust">{zh ? '查看并调整' : 'Review & adjust'}</button>
              <button type="button" className="btn-primary" onClick={() => void generate(false)} data-testid="scai-generate">{zh ? '生成场景' : 'Generate scenario'}</button>
            </footer>
          </div>
        )}
        {status && <p className="scai-status" role="status" aria-live="polite" data-testid="scai-status">{status}</p>}
      </div>
    </div>
  );
}
