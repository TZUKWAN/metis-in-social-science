import {
  BarChart3,
  BookOpen,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  FileSearch,
  FileText,
  Landmark,
  ListChecks,
  LoaderCircle,
  MessagesSquare,
  PenLine,
  Quote,
  RotateCcw,
  Scale,
  Search,
  ShieldCheck,
  Sparkles,
  Tags,
  type LucideIcon,
} from 'lucide-react';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import {
  ResearchCapabilityRouteDtoSchema,
  ScenarioGeneratePlanRequestSchema,
  ScenarioPlanDtoSchema,
  ScenarioTemplateDtoSchema,
  decodeScenarioPlanResult,
  type HumanitiesScenarioId,
  type ResearchCapabilityId,
  type ResearchCapabilityRouteDto,
  type ScenarioGeneratePlanRequest,
  type ScenarioIssueCode,
  type ScenarioPlanDto,
  type ScenarioRequirementFieldDto,
  type ScenarioRequirementResponseValue,
  type ScenarioTemplateDto,
} from '../../engine/runtime/ScenarioRuntimeContract.js';
import {
  HUMANITIES_RESEARCH_CAPABILITY_ROUTES,
  HUMANITIES_RESEARCH_SCENARIOS,
  createHumanitiesScenarioPlan,
  localizeScenarioText,
} from '../../engine/research/HumanitiesResearchScenarios.js';
import { useTranslation, type LocaleKey } from '../i18n';
import CurrentAffairsPanel from './CurrentAffairsPanel';
import './ScenarioLauncher.css';

const LAUNCHER_COPY = {
  zh: {
    eyebrow: '人文与社会研究场景',
    title: '从真实研究流程开始，而不是从空白对话开始',
    introduction: '选择场景、补充研究边界，再生成一份可编辑且等待人工批准的工作计划。',
    chooseScenario: '选择研究场景',
    chooseScenarioHint: '方向键切换场景，Enter 或空格确认。',
    suitableFor: '适合',
    workflowStages: '6 个受控阶段',
    approvalGates: '6 个人工审批点',
    capabilities: '能力路由',
    capabilityMap: '七类核心能力映射',
    capabilityMapHint: '这些是可路由能力边界，不代表相应工作已经执行。',
    requirements: '采集研究需求',
    projectTitle: '计划名称',
    projectTitlePlaceholder: '例如：数字人文中的档案可见性综述',
    researchQuestion: '初步研究问题',
    researchQuestionPlaceholder: '写出希望解释、比较或理解的问题；可以保留不确定性。',
    commonRequirements: '共同信息',
    scenarioRequirements: '场景边界',
    required: '必填',
    optional: '可选',
    selectPlaceholder: '请选择',
    privacyTitle: '只填写研究设计，不提交敏感材料',
    privacyBody: '不要在启动器中粘贴本地路径、访问凭据、未公开全文、受访者身份、原始访谈转录或其他机密数据。',
    generate: '生成可编辑计划',
    generating: '正在生成计划…',
    resetRequirements: '清空当前需求',
    formRequired: '请完成必填信息。',
    questionTooShort: '请把研究问题写得更具体一些。',
    serviceUnavailable: '计划接口暂不可用；没有生成或保存任何研究结果。',
    templateUnavailable: '所选场景暂不可用。',
    requirementsIncomplete: '部分场景要求仍需补充或修正。',
    invalidRequest: '需求格式未通过安全校验，请检查输入。',
    planUnavailable: '无法形成有效计划草稿，请重试。',
    fieldInvalid: '该字段内容无效。',
    fieldOptionInvalid: '请选择给定选项。',
    fieldDuplicate: '该字段被重复提交。',
    capabilityUnavailable: '场景需要的能力路由不可用。',
    planPreview: '可编辑研究计划预览',
    planDraft: '草稿 · 等待人工批准',
    notCompleted: '研究尚未开始',
    noCompletionClaim: '没有完成声明',
    planOnlyTitle: '这是一份计划，不是研究结果',
    planOnlyBody: '尚未执行检索、阅读、证据摘录、编码、分析、写作或审阅。每个阶段开始前都需要对应人工审批，最终发布还需再次人工确认。',
    editHint: '可以编辑计划名称、研究问题、各阶段目标、行动和预期产物；人工审批门槛不会被自动移除。',
    stage: '阶段',
    objective: '阶段目标',
    actions: '计划行动（每行一项）',
    expectedOutputs: '预期产物（每行一项）',
    routedCapabilities: '路由能力',
    humanApproval: '必须人工审批',
    pendingHumanReview: '等待人工审阅',
    approvalCriteria: '批准条件',
    boundaryNotes: '研究边界与限制',
    draftValid: '当前草稿通过结构校验，但仍未获研究批准。',
    draftNeedsAttention: '当前编辑内容有空缺或超出限制，需修正后才能交接。',
    regenerate: '按当前需求重新生成',
    submitDraft: '提交草稿供人工审批',
    submittedNotice: '草稿已交给上层流程；这不代表已批准或已执行。',
    noSubmitHandler: '当前模块尚未接入共享入口，草稿只保留在本组件内。',
    blankLineHint: '使用换行分隔项目。',
  },
  en: {
    eyebrow: 'Humanities and social research scenarios',
    title: 'Start from a real research workflow, not a blank conversation',
    introduction: 'Choose a scenario, capture research boundaries, and draft an editable plan that awaits human approval.',
    chooseScenario: 'Choose a research scenario',
    chooseScenarioHint: 'Use arrow keys to move between scenarios; press Enter or Space to select.',
    suitableFor: 'Suitable for',
    workflowStages: '6 controlled stages',
    approvalGates: '6 human approval gates',
    capabilities: 'Capability routes',
    capabilityMap: 'Seven core capability routes',
    capabilityMapHint: 'These are routable capability boundaries, not evidence that any work has run.',
    requirements: 'Capture research requirements',
    projectTitle: 'Plan title',
    projectTitlePlaceholder: 'Example: Archival visibility in digital humanities',
    researchQuestion: 'Initial research question',
    researchQuestionPlaceholder: 'State what you want to explain, compare, or understand; uncertainty is allowed.',
    commonRequirements: 'Common information',
    scenarioRequirements: 'Scenario boundaries',
    required: 'Required',
    optional: 'Optional',
    selectPlaceholder: 'Select an option',
    privacyTitle: 'Enter research design only, not sensitive material',
    privacyBody: 'Do not paste local paths, credentials, unpublished full text, participant identities, raw interview transcripts, or other confidential data into this launcher.',
    generate: 'Generate editable plan',
    generating: 'Generating plan…',
    resetRequirements: 'Clear current requirements',
    formRequired: 'Complete the required information.',
    questionTooShort: 'Make the research question a little more specific.',
    serviceUnavailable: 'The planning interface is unavailable; no research result was generated or saved.',
    templateUnavailable: 'The selected scenario is unavailable.',
    requirementsIncomplete: 'Some scenario requirements still need attention.',
    invalidRequest: 'The requirement payload did not pass safety validation.',
    planUnavailable: 'A valid plan draft could not be produced. Try again.',
    fieldInvalid: 'This field is invalid.',
    fieldOptionInvalid: 'Choose from the available options.',
    fieldDuplicate: 'This field was submitted more than once.',
    capabilityUnavailable: 'A capability route required by this scenario is unavailable.',
    planPreview: 'Editable research plan preview',
    planDraft: 'Draft · awaiting human approval',
    notCompleted: 'Research has not started',
    noCompletionClaim: 'No completion claim',
    planOnlyTitle: 'This is a plan, not a research result',
    planOnlyBody: 'No retrieval, reading, evidence extraction, coding, analysis, writing, or review has run. Each stage requires its human gate, and release requires a separate human decision.',
    editHint: 'You may edit the plan title, question, stage objectives, actions, and expected outputs. Human approval gates are not removed automatically.',
    stage: 'Stage',
    objective: 'Stage objective',
    actions: 'Planned actions (one per line)',
    expectedOutputs: 'Expected outputs (one per line)',
    routedCapabilities: 'Routed capabilities',
    humanApproval: 'Human approval required',
    pendingHumanReview: 'Pending human review',
    approvalCriteria: 'Approval criteria',
    boundaryNotes: 'Research boundaries and limitations',
    draftValid: 'The current draft passes structural validation, but it is not yet approved research.',
    draftNeedsAttention: 'The edited draft has missing or out-of-bounds content and must be corrected before handoff.',
    regenerate: 'Regenerate from current requirements',
    submitDraft: 'Submit draft for human approval',
    submittedNotice: 'The draft was handed to the parent flow; it has not been approved or executed.',
    noSubmitHandler: 'This standalone module is not connected to a shared entry point; the draft remains local to the component.',
    blankLineHint: 'Separate items with line breaks.',
  },
} as const;

type LauncherCopy = (typeof LAUNCHER_COPY)[LocaleKey];
type FieldErrors = Record<string, string>;

const SCENARIO_ICONS: Record<HumanitiesScenarioId, LucideIcon> = {
  literature_review: BookOpen,
  historical_source_criticism: Landmark,
  qualitative_interview_coding: MessagesSquare,
  theoretical_text_comparison: Scale,
};

const CAPABILITY_ICONS: Record<ResearchCapabilityId, LucideIcon> = {
  retrieval: Search,
  close_reading: FileSearch,
  evidence_anchoring: Quote,
  qualitative_coding: Tags,
  quantitative_analysis: BarChart3,
  writing_citations: PenLine,
  review_reproducibility: ShieldCheck,
};

export interface ScenarioLauncherClient {
  generatePlan(request: ScenarioGeneratePlanRequest): Promise<unknown>;
}

const LOCAL_SCENARIO_CLIENT: ScenarioLauncherClient = {
  async generatePlan(request) {
    return createHumanitiesScenarioPlan(request);
  },
};

export interface ScenarioLauncherProps {
  className?: string;
  client?: ScenarioLauncherClient;
  templates?: readonly ScenarioTemplateDto[];
  capabilityRoutes?: readonly ResearchCapabilityRouteDto[];
  onPlanDraftGenerated?: (plan: ScenarioPlanDto) => void;
  onSubmitForHumanApproval?: (plan: ScenarioPlanDto) => void;
  projectId?: string;
}

function createRequestId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `scenario-${crypto.randomUUID()}`;
    }
  } catch {
    // Continue with a bounded renderer-only identifier.
  }
  return `scenario-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isResponseEmpty(value: ScenarioRequirementResponseValue | undefined): boolean {
  if (value === undefined) return true;
  return typeof value === 'string' ? value.trim().length === 0 : value.length === 0;
}

function splitEditableLines(value: string): string[] {
  return value.split(/\r?\n/u);
}

function issueMessage(code: ScenarioIssueCode, copy: LauncherCopy): string {
  if (code === 'required_response_missing') return copy.formRequired;
  if (code === 'response_option_invalid') return copy.fieldOptionInvalid;
  if (code === 'duplicate_response') return copy.fieldDuplicate;
  if (code === 'capability_unavailable') return copy.capabilityUnavailable;
  if (code === 'template_unavailable') return copy.templateUnavailable;
  if (code === 'request_invalid') return copy.invalidRequest;
  return copy.fieldInvalid;
}

function resultErrorMessage(
  code: 'scenario_request_invalid'
    | 'scenario_template_unavailable'
    | 'scenario_requirements_incomplete'
    | 'scenario_plan_unavailable'
    | 'scenario_service_unavailable',
  copy: LauncherCopy,
): string {
  if (code === 'scenario_request_invalid') return copy.invalidRequest;
  if (code === 'scenario_template_unavailable') return copy.templateUnavailable;
  if (code === 'scenario_requirements_incomplete') return copy.requirementsIncomplete;
  if (code === 'scenario_service_unavailable') return copy.serviceUnavailable;
  return copy.planUnavailable;
}

function collectScenarioCapabilityIds(template: ScenarioTemplateDto): ResearchCapabilityId[] {
  const requested = new Set(
    template.stages.flatMap((stage) => stage.capabilityIds),
  );
  return HUMANITIES_RESEARCH_CAPABILITY_ROUTES
    .map((route) => route.capabilityId)
    .filter((capabilityId) => requested.has(capabilityId));
}

function normalizeTemplates(templates: readonly ScenarioTemplateDto[]): ScenarioTemplateDto[] {
  return templates.flatMap((template) => {
    const decoded = ScenarioTemplateDtoSchema.safeParse(template);
    return decoded.success ? [decoded.data] : [];
  });
}

interface RequirementFieldProps {
  field: ScenarioRequirementFieldDto;
  locale: LocaleKey;
  value: ScenarioRequirementResponseValue | undefined;
  error: string | undefined;
  disabled: boolean;
  copy: LauncherCopy;
  controlId: string;
  onChange: (value: ScenarioRequirementResponseValue) => void;
}

function RequirementField({
  field,
  locale,
  value,
  error,
  disabled,
  copy,
  controlId,
  onChange,
}: RequirementFieldProps) {
  const errorId = `${controlId}-error`;
  const helpId = `${controlId}-help`;
  const describedBy = error ? `${helpId} ${errorId}` : helpId;
  const label = localizeScenarioText(field.label, locale);
  const helpText = localizeScenarioText(field.helpText, locale);

  if (field.kind === 'short_text' || field.kind === 'long_text') {
    const currentValue = typeof value === 'string' ? value : '';
    const commonProps = {
      id: controlId,
      value: currentValue,
      disabled,
      'aria-invalid': error ? true : undefined,
      'aria-describedby': describedBy,
      placeholder: localizeScenarioText(field.placeholder, locale),
      onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        onChange(event.currentTarget.value),
    };
    return (
      <div className="scenario-launcher-field">
        <label htmlFor={controlId}>
          <span>{label}</span>
          <span className="scenario-launcher-field__requirement">
            {field.required ? copy.required : copy.optional}
          </span>
        </label>
        <p id={helpId} className="scenario-launcher-field__help">{helpText}</p>
        {field.kind === 'long_text'
          ? <textarea {...commonProps} rows={4} />
          : <input {...commonProps} type="text" />}
        {error && <p id={errorId} className="scenario-launcher-field__error" role="alert">{error}</p>}
      </div>
    );
  }

  if (field.kind === 'single_select') {
    const currentValue = typeof value === 'string' ? value : '';
    return (
      <div className="scenario-launcher-field">
        <label htmlFor={controlId}>
          <span>{label}</span>
          <span className="scenario-launcher-field__requirement">
            {field.required ? copy.required : copy.optional}
          </span>
        </label>
        <p id={helpId} className="scenario-launcher-field__help">{helpText}</p>
        <select
          id={controlId}
          value={currentValue}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.currentTarget.value)}
        >
          <option value="">{copy.selectPlaceholder}</option>
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {localizeScenarioText(option.label, locale)}
            </option>
          ))}
        </select>
        {error && <p id={errorId} className="scenario-launcher-field__error" role="alert">{error}</p>}
      </div>
    );
  }

  const selectedValues = Array.isArray(value) ? value : [];
  return (
    <fieldset
      className="scenario-launcher-field scenario-launcher-field--choices"
      aria-describedby={describedBy}
      aria-invalid={error ? true : undefined}
      disabled={disabled}
    >
      <legend>
        <span>{label}</span>
        <span className="scenario-launcher-field__requirement">
          {field.required ? copy.required : copy.optional}
        </span>
      </legend>
      <p id={helpId} className="scenario-launcher-field__help">{helpText}</p>
      <div className="scenario-launcher-choice-grid">
        {field.options.map((option) => {
          const checked = selectedValues.includes(option.value);
          const optionId = `${controlId}-${option.value}`;
          return (
            <label key={option.value} htmlFor={optionId} className="scenario-launcher-choice">
              <input
                id={optionId}
                type="checkbox"
                checked={checked}
                onChange={() => {
                  const nextValues = checked
                    ? selectedValues.filter((item) => item !== option.value)
                    : [...selectedValues, option.value];
                  onChange(nextValues);
                }}
              />
              <span>{localizeScenarioText(option.label, locale)}</span>
            </label>
          );
        })}
      </div>
      {error && <p id={errorId} className="scenario-launcher-field__error" role="alert">{error}</p>}
    </fieldset>
  );
}

export default function ScenarioLauncher({
  className = '',
  client = LOCAL_SCENARIO_CLIENT,
  templates = HUMANITIES_RESEARCH_SCENARIOS,
  capabilityRoutes = HUMANITIES_RESEARCH_CAPABILITY_ROUTES,
  onPlanDraftGenerated,
  onSubmitForHumanApproval,
  projectId,
}: ScenarioLauncherProps) {
  const { locale } = useTranslation();
  const copy = LAUNCHER_COPY[locale];
  const safeTemplates = useMemo(() => normalizeTemplates(templates), [templates]);
  const safeCapabilityRoutes = useMemo(() => capabilityRoutes.flatMap((route) => {
    const decoded = ResearchCapabilityRouteDtoSchema.safeParse(route);
    if (!decoded.success) return [];
    const knownRoute = HUMANITIES_RESEARCH_CAPABILITY_ROUTES.find(
      (candidate) => candidate.capabilityId === decoded.data.capabilityId
        && candidate.routeKey === decoded.data.routeKey,
    );
    return knownRoute ? [decoded.data] : [];
  }), [capabilityRoutes]);
  const [selectedScenarioId, setSelectedScenarioId] = useState<HumanitiesScenarioId>(
    safeTemplates[0]?.id ?? 'literature_review',
  );
  const [projectTitle, setProjectTitle] = useState('');
  const [researchQuestion, setResearchQuestion] = useState('');
  const [responses, setResponses] = useState<Record<string, ScenarioRequirementResponseValue>>({});
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [requestError, setRequestError] = useState('');
  const [loading, setLoading] = useState(false);
  const [plan, setPlan] = useState<ScenarioPlanDto | null>(null);
  const [showCurrentAffairs, setShowCurrentAffairs] = useState(false);
  const [liveMessage, setLiveMessage] = useState('');
  const scenarioButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const planHeadingRef = useRef<HTMLHeadingElement>(null);
  const scenarioGroupId = useId();
  const requirementsHeadingId = useId();
  const projectTitleId = useId();
  const researchQuestionId = useId();
  const privacyId = useId();
  const planHeadingId = useId();

  const selectedTemplate = useMemo(
    () => safeTemplates.find((template) => template.id === selectedScenarioId),
    [safeTemplates, selectedScenarioId],
  );

  useEffect(() => {
    if (selectedTemplate !== undefined || safeTemplates.length === 0) return;
    const firstTemplate = safeTemplates[0];
    // eslint-disable-next-line react-hooks/set-state-in-effect -- pre-existing initialization
    if (firstTemplate !== undefined) setSelectedScenarioId(firstTemplate.id);
  }, [safeTemplates, selectedTemplate]);

  const selectedCapabilities = useMemo(
    () => selectedTemplate ? collectScenarioCapabilityIds(selectedTemplate) : [],
    [selectedTemplate],
  );

  const planValidation = useMemo(
    () => plan ? ScenarioPlanDtoSchema.safeParse(plan) : null,
    [plan],
  );

  function selectScenario(scenarioId: HumanitiesScenarioId, index: number) {
    if (scenarioId === selectedScenarioId) return;
    setSelectedScenarioId(scenarioId);
    setResponses({});
    setFieldErrors({});
    setRequestError('');
    setPlan(null);
    setLiveMessage(localizeScenarioText(safeTemplates[index]?.title ?? { zh: '', en: '' }, locale));
  }

  function handleScenarioKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    if (safeTemplates.length === 0) return;
    let nextIndex: number;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (index + 1) % safeTemplates.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (index - 1 + safeTemplates.length) % safeTemplates.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = safeTemplates.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    const nextTemplate = safeTemplates[nextIndex];
    if (nextTemplate === undefined) return;
    selectScenario(nextTemplate.id, nextIndex);
    scenarioButtonRefs.current[nextIndex]?.focus();
  }

  function setRequirementResponse(
    fieldKey: string,
    value: ScenarioRequirementResponseValue,
  ) {
    setResponses((current) => ({ ...current, [fieldKey]: value }));
    setFieldErrors((current) => {
      if (current[fieldKey] === undefined) return current;
      const next = { ...current };
      delete next[fieldKey];
      return next;
    });
    setRequestError('');
  }

  function validateForm(template: ScenarioTemplateDto): FieldErrors {
    const errors: FieldErrors = {};
    if (projectTitle.trim().length === 0) errors.projectTitle = copy.formRequired;
    if (researchQuestion.trim().length < 8) errors.researchQuestion = copy.questionTooShort;
    for (const field of template.requirementFields) {
      if (field.required && isResponseEmpty(responses[field.key])) {
        errors[field.key] = copy.formRequired;
      }
    }
    return errors;
  }

  async function generatePlan(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (selectedTemplate === undefined) {
      setRequestError(copy.templateUnavailable);
      return;
    }
    const errors = validateForm(selectedTemplate);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setRequestError(copy.requirementsIncomplete);
      return;
    }

    const requirementResponses = selectedTemplate.requirementFields.flatMap((field) => {
      const value = responses[field.key];
      return value === undefined || isResponseEmpty(value)
        ? []
        : [{ fieldKey: field.key, value }];
    });
    const candidateRequest: ScenarioGeneratePlanRequest = {
      operation: 'generate_plan',
      requestId: createRequestId(),
      scenarioId: selectedTemplate.id,
      locale,
      projectTitle: projectTitle.trim(),
      researchQuestion: researchQuestion.trim(),
      requirementResponses,
      selectedCapabilityIds: selectedCapabilities,
    };
    const decodedRequest = ScenarioGeneratePlanRequestSchema.safeParse(candidateRequest);
    if (!decodedRequest.success) {
      setRequestError(copy.invalidRequest);
      return;
    }

    setLoading(true);
    setRequestError('');
    setFieldErrors({});
    setLiveMessage(copy.generating);
    try {
      const rawResult = await client.generatePlan(decodedRequest.data);
      const result = decodeScenarioPlanResult(rawResult);
      if (!result.success) {
        const nextErrors: FieldErrors = {};
        for (const issue of result.issues) {
          if (issue.fieldKey !== null) {
            nextErrors[issue.fieldKey] = issueMessage(issue.code, copy);
          }
        }
        setFieldErrors(nextErrors);
        setRequestError(resultErrorMessage(result.code, copy));
        setLiveMessage(resultErrorMessage(result.code, copy));
        return;
      }
      setPlan(result.plan);
      try {
        onPlanDraftGenerated?.(result.plan);
      } catch {
        // An integration callback cannot turn a valid local draft into a research result.
      }
      setLiveMessage(copy.planOnlyTitle);
      requestAnimationFrame(() => planHeadingRef.current?.focus());
    } catch {
      setRequestError(copy.serviceUnavailable);
      setLiveMessage(copy.serviceUnavailable);
    } finally {
      setLoading(false);
    }
  }

  function clearRequirements() {
    setProjectTitle('');
    setResearchQuestion('');
    setResponses({});
    setFieldErrors({});
    setRequestError('');
    setPlan(null);
    setLiveMessage('');
  }

  function updatePlanRoot(field: 'title' | 'researchQuestion', value: string) {
    setPlan((current) => current
      ? { ...current, [field]: value, updatedAt: Date.now() }
      : current);
  }

  function updatePlanStage(
    stageIndex: number,
    field: 'title' | 'objective' | 'actions' | 'expectedOutputs',
    value: string,
  ) {
    setPlan((current) => {
      if (!current) return current;
      return {
        ...current,
        updatedAt: Date.now(),
        stages: current.stages.map((stage, index) => {
          if (index !== stageIndex) return stage;
          if (field === 'actions' || field === 'expectedOutputs') {
            return { ...stage, [field]: splitEditableLines(value) };
          }
          return { ...stage, [field]: value };
        }),
      };
    });
  }

  function submitForApproval() {
    if (!plan) return;
    const validated = ScenarioPlanDtoSchema.safeParse(plan);
    if (!validated.success) {
      setLiveMessage(copy.draftNeedsAttention);
      return;
    }
    if (onSubmitForHumanApproval) {
      try {
        onSubmitForHumanApproval(validated.data);
        setLiveMessage(copy.submittedNotice);
      } catch {
        setLiveMessage(copy.serviceUnavailable);
      }
    } else {
      setLiveMessage(copy.noSubmitHandler);
    }
  }

  if (showCurrentAffairs) {
    return (
      <div>
        <div style={{ padding: '0 20px', marginTop: 12 }}>
          <button
            type="button"
            className="scenario-launcher-button scenario-launcher-button--quiet"
            onClick={() => setShowCurrentAffairs(false)}
            aria-label="返回人文研究场景"
          >
            ← 返回研究场景
          </button>
        </div>
        {projectId ? (
          <CurrentAffairsPanel projectId={projectId} />
        ) : (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-secondary)' }}>
            请先选择或创建研究项目
          </div>
        )}
      </div>
    );
  }

  return (
    <section className={`scenario-launcher ${className}`.trim()} aria-labelledby={scenarioGroupId}>
      <header className="scenario-launcher-hero">
        <div>
          <p className="scenario-launcher-eyebrow">
            <Sparkles size={15} aria-hidden="true" />
            {copy.eyebrow}
          </p>
          <h2 id={scenarioGroupId}>{copy.title}</h2>
          <p className="scenario-launcher-introduction">{copy.introduction}</p>
          <button
            type="button"
            className="scenario-launcher-button scenario-launcher-button--primary"
            style={{ marginTop: 12 }}
            onClick={() => setShowCurrentAffairs(true)}
          >
            时政研究 Current Affairs
          </button>
        </div>
        <div className="scenario-launcher-hero__guardrail" role="note">
          <ShieldCheck size={20} aria-hidden="true" />
          <div>
            <strong>{copy.planOnlyTitle}</strong>
            <span>{copy.notCompleted}</span>
          </div>
        </div>
      </header>

      <div className="scenario-launcher-layout">
        <div className="scenario-launcher-setup">
          <section className="scenario-launcher-section" aria-labelledby={`${scenarioGroupId}-cards`}>
            <div className="scenario-launcher-section__heading">
              <div>
                <span className="scenario-launcher-step-number">01</span>
                <h3 id={`${scenarioGroupId}-cards`}>{copy.chooseScenario}</h3>
              </div>
              <p>{copy.chooseScenarioHint}</p>
            </div>

            <div className="scenario-card-grid" role="radiogroup" aria-label={copy.chooseScenario}>
              {safeTemplates.map((template, index) => {
                const Icon = SCENARIO_ICONS[template.id];
                const active = template.id === selectedScenarioId;
                const capabilityCount = new Set(
                  template.stages.flatMap((stage) => stage.capabilityIds),
                ).size;
                return (
                  <button
                    key={template.id}
                    ref={(node) => { scenarioButtonRefs.current[index] = node; }}
                    type="button"
                    className={`scenario-card${active ? ' is-active' : ''}`}
                    role="radio"
                    aria-checked={active}
                    tabIndex={active ? 0 : -1}
                    onClick={() => selectScenario(template.id, index)}
                    onKeyDown={(event) => handleScenarioKeyDown(event, index)}
                  >
                    <span className="scenario-card__topline">
                      <span className="scenario-card__icon"><Icon size={20} aria-hidden="true" /></span>
                      <span className="scenario-card__index">{String(index + 1).padStart(2, '0')}</span>
                    </span>
                    <strong>{localizeScenarioText(template.title, locale)}</strong>
                    <span className="scenario-card__summary">
                      {localizeScenarioText(template.summary, locale)}
                    </span>
                    <span className="scenario-card__fit">
                      <span>{copy.suitableFor}</span>
                      {localizeScenarioText(template.suitableFor[0] ?? { zh: '', en: '' }, locale)}
                    </span>
                    <span className="scenario-card__meta">
                      <span><ListChecks size={13} aria-hidden="true" /> {copy.workflowStages}</span>
                      <span><ShieldCheck size={13} aria-hidden="true" /> {copy.approvalGates}</span>
                      <span><ChevronRight size={13} aria-hidden="true" /> {capabilityCount} {copy.capabilities}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          {selectedTemplate && (
            <form className="scenario-launcher-section scenario-launcher-requirements" onSubmit={(event) => void generatePlan(event)}>
              <div className="scenario-launcher-section__heading">
                <div>
                  <span className="scenario-launcher-step-number">02</span>
                  <h3 id={requirementsHeadingId}>{copy.requirements}</h3>
                </div>
              </div>

              <div className="scenario-launcher-privacy" id={privacyId} role="note">
                <CircleAlert size={18} aria-hidden="true" />
                <div>
                  <strong>{copy.privacyTitle}</strong>
                  <p>{copy.privacyBody}</p>
                </div>
              </div>

              <fieldset className="scenario-launcher-fieldset" disabled={loading} aria-describedby={privacyId}>
                <legend>{copy.commonRequirements}</legend>
                <div className="scenario-launcher-field">
                  <label htmlFor={projectTitleId}>
                    <span>{copy.projectTitle}</span>
                    <span className="scenario-launcher-field__requirement">{copy.required}</span>
                  </label>
                  <input
                    id={projectTitleId}
                    type="text"
                    value={projectTitle}
                    maxLength={240}
                    placeholder={copy.projectTitlePlaceholder}
                    aria-invalid={fieldErrors.projectTitle ? true : undefined}
                    aria-describedby={fieldErrors.projectTitle ? `${projectTitleId}-error` : undefined}
                    onChange={(event) => {
                      setProjectTitle(event.currentTarget.value);
                      setFieldErrors((current) => ({ ...current, projectTitle: '' }));
                    }}
                  />
                  {fieldErrors.projectTitle && (
                    <p id={`${projectTitleId}-error`} className="scenario-launcher-field__error" role="alert">
                      {fieldErrors.projectTitle}
                    </p>
                  )}
                </div>
                <div className="scenario-launcher-field">
                  <label htmlFor={researchQuestionId}>
                    <span>{copy.researchQuestion}</span>
                    <span className="scenario-launcher-field__requirement">{copy.required}</span>
                  </label>
                  <textarea
                    id={researchQuestionId}
                    rows={4}
                    value={researchQuestion}
                    maxLength={2_000}
                    placeholder={copy.researchQuestionPlaceholder}
                    aria-invalid={fieldErrors.researchQuestion ? true : undefined}
                    aria-describedby={fieldErrors.researchQuestion ? `${researchQuestionId}-error` : undefined}
                    onChange={(event) => {
                      setResearchQuestion(event.currentTarget.value);
                      setFieldErrors((current) => ({ ...current, researchQuestion: '' }));
                    }}
                  />
                  {fieldErrors.researchQuestion && (
                    <p id={`${researchQuestionId}-error`} className="scenario-launcher-field__error" role="alert">
                      {fieldErrors.researchQuestion}
                    </p>
                  )}
                </div>
              </fieldset>

              <fieldset className="scenario-launcher-fieldset" disabled={loading}>
                <legend>{copy.scenarioRequirements}</legend>
                <div className="scenario-launcher-field-grid">
                  {selectedTemplate.requirementFields.map((field) => (
                    <RequirementField
                      key={field.key}
                      field={field}
                      locale={locale}
                      value={responses[field.key]}
                      error={fieldErrors[field.key] || undefined}
                      disabled={loading}
                      copy={copy}
                      controlId={`${requirementsHeadingId}-${field.key}`}
                      onChange={(value) => setRequirementResponse(field.key, value)}
                    />
                  ))}
                </div>
              </fieldset>

              <div className="scenario-launcher-capability-strip" aria-label={copy.capabilities}>
                {selectedCapabilities.map((capabilityId) => {
                  const route = safeCapabilityRoutes.find((item) => item.capabilityId === capabilityId);
                  if (!route) return null;
                  const Icon = CAPABILITY_ICONS[capabilityId];
                  return (
                    <span key={capabilityId}>
                      <Icon size={13} aria-hidden="true" />
                      {localizeScenarioText(route.title, locale)}
                    </span>
                  );
                })}
              </div>

              {requestError && (
                <div className="scenario-launcher-alert" role="alert">
                  <CircleAlert size={17} aria-hidden="true" />
                  <span>{requestError}</span>
                </div>
              )}

              <div className="scenario-launcher-form-actions">
                <button
                  type="button"
                  className="scenario-launcher-button scenario-launcher-button--quiet"
                  disabled={loading}
                  onClick={clearRequirements}
                >
                  <RotateCcw size={15} aria-hidden="true" />
                  {copy.resetRequirements}
                </button>
                <button
                  type="submit"
                  className="scenario-launcher-button scenario-launcher-button--primary"
                  disabled={loading}
                >
                  {loading
                    ? <LoaderCircle size={16} className="scenario-launcher-spin" aria-hidden="true" />
                    : <Sparkles size={16} aria-hidden="true" />}
                  {loading ? copy.generating : copy.generate}
                </button>
              </div>
            </form>
          )}

          <details className="scenario-launcher-capability-map">
            <summary>
              <span>
                <FileText size={16} aria-hidden="true" />
                <strong>{copy.capabilityMap}</strong>
              </span>
              <span>{copy.capabilityMapHint}</span>
            </summary>
            <div className="scenario-launcher-capability-grid">
              {safeCapabilityRoutes.map((route) => {
                const Icon = CAPABILITY_ICONS[route.capabilityId];
                return (
                  <article key={route.capabilityId}>
                    <span className="scenario-launcher-capability-grid__icon">
                      <Icon size={17} aria-hidden="true" />
                    </span>
                    <div>
                      <strong>{localizeScenarioText(route.title, locale)}</strong>
                      <code>{route.routeKey}</code>
                      <p>{localizeScenarioText(route.summary, locale)}</p>
                    </div>
                  </article>
                );
              })}
            </div>
          </details>
        </div>

        <aside className={`scenario-plan-preview${plan ? ' has-plan' : ''}`} aria-labelledby={planHeadingId}>
          {!plan ? (
            <div className="scenario-plan-preview__empty">
              <span className="scenario-plan-preview__empty-icon">
                <ListChecks size={24} aria-hidden="true" />
              </span>
              <h3 id={planHeadingId}>{copy.planPreview}</h3>
              <p>{copy.planOnlyBody}</p>
              <div>
                <span><CheckCircle2 size={14} aria-hidden="true" /> {copy.notCompleted}</span>
                <span><ShieldCheck size={14} aria-hidden="true" /> {copy.noCompletionClaim}</span>
              </div>
            </div>
          ) : (
            <div className="scenario-plan-preview__content">
              <header className="scenario-plan-preview__header">
                <div>
                  <span className="scenario-plan-preview__badge">{copy.planDraft}</span>
                  <h3 id={planHeadingId} ref={planHeadingRef} tabIndex={-1}>{copy.planPreview}</h3>
                </div>
                <span className="scenario-plan-preview__status">
                  <span aria-hidden="true" />
                  {copy.notCompleted}
                </span>
              </header>

              <div className="scenario-plan-notice" role="note">
                <ShieldCheck size={19} aria-hidden="true" />
                <div>
                  <strong>{copy.planOnlyTitle}</strong>
                  <p>{copy.planOnlyBody}</p>
                </div>
              </div>

              <p className="scenario-plan-edit-hint">{copy.editHint}</p>

              <div className="scenario-plan-root-fields">
                <label>
                  <span>{copy.projectTitle}</span>
                  <input
                    type="text"
                    value={plan.title}
                    maxLength={240}
                    onChange={(event) => updatePlanRoot('title', event.currentTarget.value)}
                  />
                </label>
                <label>
                  <span>{copy.researchQuestion}</span>
                  <textarea
                    rows={4}
                    value={plan.researchQuestion}
                    maxLength={2_000}
                    onChange={(event) => updatePlanRoot('researchQuestion', event.currentTarget.value)}
                  />
                </label>
              </div>

              <div className="scenario-plan-stage-list">
                {plan.stages.map((stage, index) => (
                  <article className="scenario-plan-stage" key={stage.id}>
                    <header>
                      <span className="scenario-plan-stage__number">{String(index + 1).padStart(2, '0')}</span>
                      <div>
                        <span>{copy.stage} {index + 1}</span>
                        <input
                          aria-label={`${copy.stage} ${index + 1}`}
                          value={stage.title}
                          maxLength={240}
                          onChange={(event) => updatePlanStage(index, 'title', event.currentTarget.value)}
                        />
                      </div>
                    </header>

                    <label className="scenario-plan-stage__field">
                      <span>{copy.objective}</span>
                      <textarea
                        rows={3}
                        value={stage.objective}
                        maxLength={2_000}
                        onChange={(event) => updatePlanStage(index, 'objective', event.currentTarget.value)}
                      />
                    </label>
                    <label className="scenario-plan-stage__field">
                      <span>{copy.actions}</span>
                      <textarea
                        rows={Math.min(8, Math.max(3, stage.actions.length + 1))}
                        value={stage.actions.join('\n')}
                        maxLength={24_000}
                        onChange={(event) => updatePlanStage(index, 'actions', event.currentTarget.value)}
                      />
                    </label>
                    <label className="scenario-plan-stage__field">
                      <span>{copy.expectedOutputs}</span>
                      <textarea
                        rows={Math.min(6, Math.max(3, stage.expectedOutputs.length + 1))}
                        value={stage.expectedOutputs.join('\n')}
                        maxLength={24_000}
                        onChange={(event) => updatePlanStage(index, 'expectedOutputs', event.currentTarget.value)}
                      />
                    </label>

                    <div className="scenario-plan-stage__capabilities">
                      <span>{copy.routedCapabilities}</span>
                      <div>
                        {stage.capabilityIds.map((capabilityId) => {
                          const route = safeCapabilityRoutes.find((item) => item.capabilityId === capabilityId);
                          if (!route) return null;
                          const Icon = CAPABILITY_ICONS[capabilityId];
                          return (
                            <span key={capabilityId}>
                              <Icon size={12} aria-hidden="true" />
                              {localizeScenarioText(route.title, locale)}
                            </span>
                          );
                        })}
                      </div>
                    </div>

                    <div className="scenario-plan-approval">
                      <div className="scenario-plan-approval__heading">
                        <ShieldCheck size={17} aria-hidden="true" />
                        <div>
                          <strong>{copy.humanApproval}</strong>
                          <span>{copy.pendingHumanReview}</span>
                        </div>
                      </div>
                      <p>{stage.humanApproval.title}</p>
                      <span>{stage.humanApproval.instruction}</span>
                      <details>
                        <summary>{copy.approvalCriteria}</summary>
                        <ul>
                          {stage.humanApproval.criteria.map((criterion, criterionIndex) => (
                            <li key={`${stage.id}-criterion-${criterionIndex}`}>{criterion}</li>
                          ))}
                        </ul>
                      </details>
                    </div>
                  </article>
                ))}
              </div>

              <section className="scenario-plan-boundaries" aria-labelledby={`${planHeadingId}-boundaries`}>
                <h4 id={`${planHeadingId}-boundaries`}>
                  <CircleAlert size={16} aria-hidden="true" />
                  {copy.boundaryNotes}
                </h4>
                <ul>
                  {plan.boundaryNotes.map((note, index) => (
                    <li key={`boundary-${index}`}>{note}</li>
                  ))}
                </ul>
              </section>

              <div
                className={`scenario-plan-validation ${planValidation?.success ? 'is-valid' : 'is-invalid'}`}
                role="status"
              >
                {planValidation?.success
                  ? <CheckCircle2 size={16} aria-hidden="true" />
                  : <CircleAlert size={16} aria-hidden="true" />}
                <span>{planValidation?.success ? copy.draftValid : copy.draftNeedsAttention}</span>
              </div>

              <div className="scenario-plan-actions">
                <button
                  type="button"
                  className="scenario-launcher-button scenario-launcher-button--quiet"
                  disabled={loading}
                  onClick={() => void generatePlan()}
                >
                  <RotateCcw size={15} aria-hidden="true" />
                  {copy.regenerate}
                </button>
                <button
                  type="button"
                  className="scenario-launcher-button scenario-launcher-button--primary"
                  disabled={!planValidation?.success}
                  onClick={submitForApproval}
                >
                  <ShieldCheck size={15} aria-hidden="true" />
                  {copy.submitDraft}
                </button>
              </div>
            </div>
          )}
        </aside>
      </div>

      <div className="scenario-launcher-live" role="status" aria-live="polite" aria-atomic="true">
        {liveMessage}
      </div>
    </section>
  );
}

export { ScenarioLauncher };
