import {
  ResearchCapabilityRouteDtoSchema,
  ScenarioPlanDtoSchema,
  ScenarioTemplateDtoSchema,
  decodeScenarioGeneratePlanRequest,
  decodeScenarioGetTemplateRequest,
  decodeScenarioListTemplatesRequest,
  type HumanitiesScenarioId,
  type ResearchCapabilityId,
  type ResearchCapabilityRouteDto,
  type ScenarioGeneratePlanRequest,
  type ScenarioHumanApprovalDto,
  type ScenarioIssueDto,
  type ScenarioLocalizedText,
  type ScenarioLocale,
  type ScenarioPlanDto,
  type ScenarioPlanResult,
  type ScenarioRequirementFieldDto,
  type ScenarioRequirementResponseDto,
  type ScenarioTemplateListResult,
  type ScenarioTemplateResult,
  type ScenarioTemplateDto,
} from '../runtime/ScenarioRuntimeContract.js';

function localized(zh: string, en: string): ScenarioLocalizedText {
  return { zh, en };
}

function approval(
  gate: ScenarioHumanApprovalDto['gate'],
  titleZh: string,
  titleEn: string,
  instructionZh: string,
  instructionEn: string,
  criteria: ReadonlyArray<readonly [string, string]>,
): ScenarioHumanApprovalDto {
  return {
    gate,
    title: localized(titleZh, titleEn),
    instruction: localized(instructionZh, instructionEn),
    criteria: criteria.map(([zh, en]) => localized(zh, en)),
  };
}

/**
 * Seven routable research capabilities shared by humanities scenarios.
 *
 * These records describe safe routing boundaries, not concrete provider names,
 * internal prompts, filesystem locations, or claims that work has been done.
 */
export const HUMANITIES_RESEARCH_CAPABILITY_ROUTES: readonly ResearchCapabilityRouteDto[] = [
  {
    capabilityId: 'retrieval',
    routeKey: 'research.retrieve',
    title: localized('检索与来源导入', 'Retrieval and source import'),
    summary: localized(
      '记录检索式、目录或档案馆入口、纳入排除决定与去重结果；检索失败必须显式保留。',
      'Record queries, catalogue or archive entry points, inclusion decisions, and deduplication; retrieval failures remain explicit.',
    ),
    acceptedInputs: ['research_question', 'search_protocol', 'source_query'],
    producedRecords: ['source_record', 'search_protocol'],
    supportedStages: ['source_import', 'counterevidence_and_limitations'],
    humanReviewRequired: true,
  },
  {
    capabilityId: 'close_reading',
    routeKey: 'research.read',
    title: localized('精读与语境化阅读', 'Close and contextual reading'),
    summary: localized(
      '在版本、体裁、作者位置、历史语境和上下文窗口中阅读材料，不把摘要当作原文。',
      'Read materials within edition, genre, authorial position, historical context, and surrounding passages; summaries never substitute for the source.',
    ),
    acceptedInputs: ['source_record', 'document_text'],
    producedRecords: ['reading_note', 'evidence_anchor'],
    supportedStages: ['evidence_anchoring', 'coding_and_claims', 'counterevidence_and_limitations'],
    humanReviewRequired: true,
  },
  {
    capabilityId: 'evidence_anchoring',
    routeKey: 'research.evidence',
    title: localized('证据锚定与可定位引用', 'Evidence anchoring and locatable citation'),
    summary: localized(
      '把摘录绑定到页码、段落、行号、时间码、档案层级或其他可复核定位信息。',
      'Bind excerpts to pages, sections, lines, timecodes, archival hierarchy, or another reviewable locator.',
    ),
    acceptedInputs: ['source_record', 'document_text', 'reading_note'],
    producedRecords: ['evidence_anchor', 'reading_note'],
    supportedStages: ['evidence_anchoring', 'coding_and_claims', 'artifact_and_review'],
    humanReviewRequired: true,
  },
  {
    capabilityId: 'qualitative_coding',
    routeKey: 'research.code.qualitative',
    title: localized('质性编码与解释备忘', 'Qualitative coding and analytic memos'),
    summary: localized(
      '生成待审代码建议、代码本和分析备忘；机器建议默认待人工接受，不自动成为结论。',
      'Produce pending code suggestions, codebooks, and analytic memos; machine suggestions require human acceptance and never become findings automatically.',
    ),
    acceptedInputs: ['evidence_anchor', 'reading_note', 'codebook'],
    producedRecords: ['codebook', 'coded_excerpt', 'claim'],
    supportedStages: ['coding_and_claims', 'counterevidence_and_limitations'],
    humanReviewRequired: true,
  },
  {
    capabilityId: 'quantitative_analysis',
    routeKey: 'research.analyze.quantitative',
    title: localized('量化分析与方法诊断', 'Quantitative analysis and method diagnostics'),
    summary: localized(
      '仅在数据结构与识别条件允许时进行描述性或统计分析；诊断未通过时不得输出因果结论。',
      'Run descriptive or statistical analysis only when the data and identification conditions support it; failed diagnostics block causal conclusions.',
    ),
    acceptedInputs: ['dataset', 'coded_excerpt', 'research_question'],
    producedRecords: ['analysis_diagnostic', 'claim', 'limitation'],
    supportedStages: ['coding_and_claims', 'counterevidence_and_limitations'],
    humanReviewRequired: true,
  },
  {
    capabilityId: 'writing_citations',
    routeKey: 'research.write.citations',
    title: localized('论证写作与引用', 'Argument writing and citations'),
    summary: localized(
      '从已登记主张和证据起草成果，仅引用项目内可定位来源，并区分事实、解释与作者论断。',
      'Draft from registered claims and evidence, cite only locatable project sources, and distinguish fact, interpretation, and authorial claim.',
    ),
    acceptedInputs: ['claim', 'evidence_anchor', 'counterevidence', 'limitation'],
    producedRecords: ['draft_artifact', 'citation_audit'],
    supportedStages: ['coding_and_claims', 'artifact_and_review'],
    humanReviewRequired: true,
  },
  {
    capabilityId: 'review_reproducibility',
    routeKey: 'research.review.reproduce',
    title: localized('审阅、审计与复现', 'Review, audit, and reproducibility'),
    summary: localized(
      '检查检索轨迹、证据覆盖、反证、方法限制、引用与版本；未解决阻断项时不得标记完成。',
      'Audit retrieval history, evidence coverage, counterevidence, method limits, citations, and versions; unresolved blockers prevent completion claims.',
    ),
    acceptedInputs: ['search_protocol', 'claim', 'draft_artifact', 'citation_audit'],
    producedRecords: ['reproduction_record', 'review_decision', 'limitation'],
    supportedStages: ['counterevidence_and_limitations', 'artifact_and_review'],
    humanReviewRequired: true,
  },
];

const LITERATURE_REVIEW: ScenarioTemplateDto = {
  id: 'literature_review',
  version: 1,
  title: localized('文献综述与研究版图', 'Literature review and field mapping'),
  summary: localized(
    '从可审计检索协议出发，形成来源集、证据矩阵、争论脉络和带局限说明的综述草稿。',
    'Start from an auditable search protocol and build a source set, evidence matrix, debate map, and limitation-aware review draft.',
  ),
  suitableFor: [
    localized('叙述性、范围性或系统化文献综述', 'Narrative, scoping, or systematic literature reviews'),
    localized('概念演变、方法谱系与研究空白梳理', 'Mapping conceptual change, method lineages, and research gaps'),
  ],
  boundaryNotes: [
    localized('模板只生成工作计划，不包含真实检索结果、引用或研究结论。', 'The template produces a work plan only; it contains no retrieved sources, citations, or findings.'),
    localized('数据库覆盖、语言范围和纳入标准必须由研究者确认。', 'Database coverage, language scope, and inclusion criteria require researcher approval.'),
    localized('所谓“研究空白”必须由已审阅的来源集支持，不能从检索缺失直接推断。', 'A claimed research gap must be supported by the reviewed corpus, not inferred merely from retrieval absence.'),
  ],
  requirementFields: [
    {
      key: 'review_type',
      kind: 'single_select',
      label: localized('综述类型', 'Review type'),
      helpText: localized('不同综述类型对应不同检索与报告义务。', 'Different review types carry different search and reporting obligations.'),
      required: true,
      options: [
        { value: 'narrative', label: localized('叙述性综述', 'Narrative review') },
        { value: 'scoping', label: localized('范围性综述', 'Scoping review') },
        { value: 'systematic', label: localized('系统化综述', 'Systematic review') },
      ],
    },
    {
      key: 'disciplinary_scope',
      kind: 'long_text',
      label: localized('学科、时间与地域范围', 'Discipline, period, and geography'),
      helpText: localized('说明纳入哪些学科传统、年份、地域或研究对象。', 'State the disciplinary traditions, years, regions, or populations in scope.'),
      required: true,
      placeholder: localized('例如：2015—2025 年中文与英文教育技术研究……', 'Example: Chinese- and English-language education technology research, 2015–2025…'),
    },
    {
      key: 'source_languages',
      kind: 'multi_select',
      label: localized('材料语言', 'Source languages'),
      helpText: localized('语言限制需要在成果中作为覆盖边界说明。', 'Language restrictions must be reported as a coverage boundary.'),
      required: true,
      options: [
        { value: 'chinese', label: localized('中文', 'Chinese') },
        { value: 'english', label: localized('英文', 'English') },
        { value: 'other_languages', label: localized('其他语言', 'Other languages') },
      ],
    },
    {
      key: 'inclusion_rules',
      kind: 'long_text',
      label: localized('纳入与排除规则', 'Inclusion and exclusion rules'),
      helpText: localized('记录材料类型、研究设计、主题相关性和质量门槛。', 'Record publication types, study designs, topical relevance, and quality thresholds.'),
      required: true,
      placeholder: localized('分别列出纳入条件、排除条件和边界案例处理方式。', 'List inclusion rules, exclusion rules, and how borderline cases will be handled.'),
    },
    {
      key: 'deliverable_form',
      kind: 'single_select',
      label: localized('预期成果形式', 'Intended deliverable'),
      helpText: localized('成果形式影响证据矩阵和报告结构。', 'The deliverable shapes the evidence matrix and reporting structure.'),
      required: true,
      options: [
        { value: 'review_article', label: localized('综述论文', 'Review article') },
        { value: 'field_map', label: localized('研究版图/证据地图', 'Field or evidence map') },
        { value: 'proposal_section', label: localized('课题或论文综述章节', 'Proposal or thesis review chapter') },
      ],
    },
  ],
  stages: [
    {
      id: 'lit-clarify',
      kind: 'question_clarification',
      title: localized('澄清综述问题与协议', 'Clarify the review question and protocol'),
      objective: localized('把兴趣主题转化为可检索、可筛选、可解释的综述问题。', 'Turn the topic into a review question that can be searched, screened, and interpreted.'),
      actions: [
        localized('界定核心概念、同义词、时间地域、学科传统和材料语言。', 'Define core concepts, synonyms, period, geography, disciplinary traditions, and languages.'),
        localized('选择综述类型，并预先记录纳入、排除、质量判断和边界案例规则。', 'Choose the review type and prerecord inclusion, exclusion, quality, and borderline-case rules.'),
        localized('声明预期成果与任何需要注册或遵循的报告规范。', 'Declare the intended deliverable and any registration or reporting standard to follow.'),
      ],
      expectedOutputs: [
        localized('经确认的综述问题与范围说明', 'Approved review question and scope statement'),
        localized('版本化检索与筛选协议', 'Versioned search and screening protocol'),
      ],
      capabilityIds: ['retrieval', 'review_reproducibility'],
      humanApproval: approval(
        'question_scope',
        '审批综述问题与范围',
        'Approve the review question and scope',
        '研究者确认协议后，才能开始来源检索。',
        'Retrieval may begin only after the researcher confirms the protocol.',
        [
          ['问题可回答且范围可执行', 'The question is answerable and the scope is feasible'],
          ['纳入排除规则没有明显后见偏差', 'Inclusion rules do not encode an obvious desired conclusion'],
        ],
      ),
    },
    {
      id: 'lit-import',
      kind: 'source_import',
      title: localized('执行检索、扩展与去重', 'Run retrieval, expansion, and deduplication'),
      objective: localized('形成保留检索轨迹和筛选决定的候选来源集。', 'Create a candidate corpus with search history and screening decisions intact.'),
      actions: [
        localized('按协议运行数据库、目录、引文追踪和已知文献检索，并记录失败入口。', 'Search databases, catalogues, citations, and known items according to protocol, recording failed entry points.'),
        localized('按 DOI、ISBN、稳定标识和题名核对去重，不臆造缺失元数据。', 'Deduplicate by DOI, ISBN, stable identifier, and title without inventing missing metadata.'),
        localized('保留标题摘要筛选与全文筛选的排除理由。', 'Retain exclusion reasons from title/abstract and full-text screening.'),
      ],
      expectedOutputs: [
        localized('候选来源清单与检索日志', 'Candidate source set and search log'),
        localized('去重记录和带理由的筛选表', 'Deduplication record and reasoned screening table'),
      ],
      capabilityIds: ['retrieval', 'review_reproducibility'],
      humanApproval: approval(
        'source_corpus',
        '审批候选来源集',
        'Approve the candidate corpus',
        '研究者抽查检索覆盖和排除理由，再冻结本轮来源集。',
        'The researcher samples retrieval coverage and exclusions before freezing this corpus version.',
        [
          ['关键数据库、目录或替代入口已覆盖', 'Key databases, catalogues, or justified alternatives are covered'],
          ['排除理由可解释且可复核', 'Exclusion reasons are reviewable and defensible'],
        ],
      ),
    },
    {
      id: 'lit-anchor',
      kind: 'evidence_anchoring',
      title: localized('精读并建立证据矩阵', 'Read closely and build the evidence matrix'),
      objective: localized('把主题判断、方法描述和关键论断锚定到可定位文本。', 'Anchor thematic judgments, method descriptions, and key claims to locatable passages.'),
      actions: [
        localized('记录研究问题、样本、方法、理论框架、主要发现和作者自述局限。', 'Record question, sample, method, theoretical frame, reported findings, and author-stated limitations.'),
        localized('为关键摘录保留页码、章节或段落定位及必要上下文。', 'Retain page, section, or paragraph locators and enough context for key excerpts.'),
        localized('区分作者报告、综述者解释和无法验证的信息。', 'Separate author reports, reviewer interpretation, and unverifiable information.'),
      ],
      expectedOutputs: [
        localized('来源—主题—方法证据矩阵', 'Source–theme–method evidence matrix'),
        localized('带定位信息的精读笔记', 'Close-reading notes with locators'),
      ],
      capabilityIds: ['close_reading', 'evidence_anchoring'],
      humanApproval: approval(
        'evidence_sample',
        '审批证据抽样质量',
        'Approve evidence sample quality',
        '研究者抽查来源与锚点，确认摘要没有替代原文、解释没有伪装成作者结论。',
        'The researcher samples sources and anchors to ensure summaries do not replace text and interpretations are not presented as author findings.',
        [
          ['锚点可返回原文位置', 'Anchors return to the original passage'],
          ['证据矩阵字段在不同来源间一致', 'Evidence-matrix fields are consistent across sources'],
        ],
      ),
    },
    {
      id: 'lit-synthesize',
      kind: 'coding_and_claims',
      title: localized('编码主题并形成暂定综合论断', 'Code themes and form provisional synthesis claims'),
      objective: localized('从证据矩阵组织争论、共识、分歧、方法差异和时间变化。', 'Organize debates, consensus, disagreement, method variation, and change over time from the evidence matrix.'),
      actions: [
        localized('建立可修订代码本，并记录主题合并、拆分与定义变化。', 'Build a revisable codebook and record merged, split, or redefined themes.'),
        localized('把每个综合论断链接到支持和不支持它的来源与证据锚点。', 'Link every synthesis claim to supporting and non-supporting sources and anchors.'),
        localized('若进行数量统计，只报告适当的描述性覆盖并说明分母。', 'If counts are used, report only appropriate descriptive coverage with explicit denominators.'),
      ],
      expectedOutputs: [
        localized('版本化主题代码本', 'Versioned thematic codebook'),
        localized('带证据关系的暂定综合论断集', 'Provisional synthesis claims with evidence relations'),
      ],
      capabilityIds: ['qualitative_coding', 'quantitative_analysis', 'writing_citations'],
      humanApproval: approval(
        'codebook_or_claims',
        '审批代码本与综合论断',
        'Approve the codebook and synthesis claims',
        '研究者逐项确认代码定义、证据覆盖和论断措辞。',
        'The researcher confirms code definitions, evidence coverage, and claim wording item by item.',
        [
          ['论断没有超出来源集和方法所支持的范围', 'Claims do not exceed the corpus or methods'],
          ['机器建议代码已被接受、修改或拒绝', 'Machine-suggested codes have been accepted, revised, or rejected'],
        ],
      ),
    },
    {
      id: 'lit-limit',
      kind: 'counterevidence_and_limitations',
      title: localized('主动寻找反证与覆盖局限', 'Search for counterevidence and coverage limits'),
      objective: localized('检验综合论断是否遗漏负面案例、边缘传统或方法偏差。', 'Test whether synthesis claims omit negative cases, marginal traditions, or method bias.'),
      actions: [
        localized('围绕关键论断进行反向检索、引文追踪和边缘来源复核。', 'Run reverse searches, citation tracing, and marginal-source checks around key claims.'),
        localized('评估发表偏差、数据库偏差、语言限制、时间截断和学科分类影响。', 'Assess publication, database, language, temporal, and disciplinary-classification bias.'),
        localized('记录无法解决的矛盾、空白和不确定性，不将其抹平。', 'Record unresolved contradictions, absences, and uncertainty rather than smoothing them away.'),
      ],
      expectedOutputs: [
        localized('反证与矛盾清单', 'Counterevidence and contradiction register'),
        localized('覆盖边界与局限说明', 'Coverage boundary and limitation statement'),
      ],
      capabilityIds: ['retrieval', 'close_reading', 'review_reproducibility'],
      humanApproval: approval(
        'limitations',
        '审批反证与局限说明',
        'Approve counterevidence and limitations',
        '研究者决定哪些论断应缩小、撤回或保留争议状态。',
        'The researcher decides which claims should be narrowed, withdrawn, or kept contested.',
        [
          ['主要论断已检查反向证据', 'Major claims have been checked against counterevidence'],
          ['局限不是通用免责声明，而是对应具体协议和材料', 'Limitations are tied to this protocol and corpus rather than generic caveats'],
        ],
      ),
    },
    {
      id: 'lit-deliver',
      kind: 'artifact_and_review',
      title: localized('起草综述并完成引用与复现审阅', 'Draft the review and complete citation and reproducibility review'),
      objective: localized('产出可审阅草稿及其检索、筛选、证据和版本记录。', 'Produce a reviewable draft with search, screening, evidence, and version records.'),
      actions: [
        localized('按争论或主题结构起草，引用仅指向已登记且可定位的来源。', 'Draft by debate or theme, citing only registered and locatable sources.'),
        localized('核对引用、数字、筛选流、证据覆盖和论断—证据关系。', 'Audit citations, numbers, screening flow, evidence coverage, and claim–evidence relations.'),
        localized('保留修订决定和未解决问题，提交研究者终审。', 'Retain revision decisions and unresolved issues for final researcher review.'),
      ],
      expectedOutputs: [
        localized('带引用的综述草稿', 'Cited review draft'),
        localized('检索筛选附录、审计结果和版本记录', 'Search and screening appendix, audit results, and version record'),
      ],
      capabilityIds: ['writing_citations', 'review_reproducibility'],
      humanApproval: approval(
        'artifact_release',
        '人工终审与发布决定',
        'Human final review and release decision',
        '系统不得自动标记完成；研究者处理阻断问题后决定修订、接受或发布。',
        'The system must not mark completion automatically; the researcher resolves blockers and decides whether to revise, accept, or release.',
        [
          ['所有引用可定位且与表述相符', 'Every citation is locatable and supports the wording'],
          ['未解决错误已阻断发布或被明确处理', 'Unresolved errors block release or have been explicitly resolved'],
        ],
      ),
    },
  ],
};

const HISTORICAL_SOURCE_CRITICISM: ScenarioTemplateDto = {
  id: 'historical_source_criticism',
  version: 1,
  title: localized('历史档案与史料批判', 'Historical archives and source criticism'),
  summary: localized(
    '围绕档案层级、形成背景、文本物质性、内外部批判和史料沉默，建立可复核的历史论证计划。',
    'Build a reviewable historical argument plan around archival hierarchy, creation context, materiality, internal and external criticism, and archival silences.',
  ),
  suitableFor: [
    localized('档案、书信、报刊、官方文件、图像与口述史料研究', 'Research using archives, letters, newspapers, official records, images, or oral histories'),
    localized('历史事件重构、制度史、思想史与社会文化史', 'Event reconstruction, institutional, intellectual, and social-cultural history'),
  ],
  boundaryNotes: [
    localized('模板不推断缺失的档案出处、作者身份或传承链。', 'The template does not infer missing archival origin, authorship, or chain of custody.'),
    localized('目录描述、转录和译文都必须与原件或可靠复制件区分。', 'Catalogue descriptions, transcriptions, and translations must remain distinct from originals or reliable surrogates.'),
    localized('未留存、未开放和未被编目的材料构成证据边界，不等于历史上不存在。', 'Unpreserved, closed, or uncatalogued materials mark an evidentiary boundary and do not prove historical absence.'),
  ],
  requirementFields: [
    {
      key: 'time_space_scope',
      kind: 'long_text',
      label: localized('时间、地域与行动者范围', 'Period, geography, and actors'),
      helpText: localized('注明时间边界、地域尺度、机构与关键行动者。', 'Specify temporal bounds, geographic scale, institutions, and relevant actors.'),
      required: true,
      placeholder: localized('例如：1937—1945 年某地区教育行政机构及其政策网络……', 'Example: education authorities and policy networks in a region, 1937–1945…'),
    },
    {
      key: 'archive_context',
      kind: 'long_text',
      label: localized('已知档案馆与材料入口', 'Known archives and material entry points'),
      helpText: localized('只描述馆藏、目录、数据库或已知文献入口，不粘贴访问凭据。', 'Describe repositories, catalogues, databases, or known works; do not paste access credentials.'),
      required: true,
      placeholder: localized('列出已知馆藏、全宗/系列、目录或数字化集合。', 'List known collections, fonds/series, catalogues, or digitized collections.'),
    },
    {
      key: 'source_genres',
      kind: 'multi_select',
      label: localized('主要史料类型', 'Primary source genres'),
      helpText: localized('不同体裁需要不同真实性、目的和受众批判。', 'Different genres require distinct criticism of authenticity, purpose, and audience.'),
      required: true,
      options: [
        { value: 'official_records', label: localized('官方/机构文件', 'Official or institutional records') },
        { value: 'personal_writings', label: localized('书信、日记与回忆', 'Letters, diaries, and memoirs') },
        { value: 'press_publications', label: localized('报刊与公开出版物', 'Press and public publications') },
        { value: 'visual_materials', label: localized('图像、地图与物质材料', 'Images, maps, and material sources') },
        { value: 'oral_histories', label: localized('口述史与访谈', 'Oral histories and interviews') },
      ],
    },
    {
      key: 'source_languages',
      kind: 'multi_select',
      label: localized('原始材料语言', 'Primary-source languages'),
      helpText: localized('记录是否依赖译本，以及谁负责核对关键术语。', 'Record reliance on translations and who will verify key terminology.'),
      required: true,
      options: [
        { value: 'chinese', label: localized('中文', 'Chinese') },
        { value: 'english', label: localized('英文', 'English') },
        { value: 'other_languages', label: localized('其他语言', 'Other languages') },
      ],
    },
    {
      key: 'historiographic_position',
      kind: 'long_text',
      label: localized('史学争论或理论位置', 'Historiographic debate or theoretical position'),
      helpText: localized('说明研究要介入的既有解释及需要避免的目的论。', 'State the interpretations being addressed and teleologies to avoid.'),
      required: false,
      placeholder: localized('可列出主要争论、已有解释和预期比较维度。', 'Optionally list major debates, existing interpretations, and comparison dimensions.'),
    },
  ],
  stages: [
    {
      id: 'history-clarify',
      kind: 'question_clarification',
      title: localized('界定历史问题与时空尺度', 'Define the historical question and scale'),
      objective: localized('把问题限定到可由特定史料类型检验的时间、空间、行动者与概念。', 'Bound the question by period, place, actors, and concepts that specific source genres can address.'),
      actions: [
        localized('区分事件重构、意义解释、制度变化、概念史或因果解释等任务。', 'Distinguish event reconstruction, interpretation, institutional change, conceptual history, or causal explanation.'),
        localized('识别关键历史术语与可能的时代错置。', 'Identify period-specific terminology and possible anachronisms.'),
        localized('预先列出史料能够回答和不能回答的问题。', 'State what the available source genres can and cannot answer.'),
      ],
      expectedOutputs: [
        localized('时空与行动者边界明确的历史问题', 'Historical question with explicit temporal, spatial, and actor boundaries'),
        localized('概念使用与史料适配说明', 'Concept-use and source-fit statement'),
      ],
      capabilityIds: ['close_reading', 'review_reproducibility'],
      humanApproval: approval(
        'question_scope',
        '审批历史问题与尺度',
        'Approve the historical question and scale',
        '研究者确认问题没有预设目的论，且所需史料现实可及。',
        'The researcher confirms that the question avoids built-in teleology and that necessary sources are realistically accessible.',
        [
          ['问题与史料类型匹配', 'The question matches the source genres'],
          ['核心概念按历史语境定义', 'Core concepts are defined in historical context'],
        ],
      ),
    },
    {
      id: 'history-import',
      kind: 'source_import',
      title: localized('登记档案层级与史料形成背景', 'Register archival hierarchy and creation context'),
      objective: localized('建立可追溯的史料目录，同时保留开放限制和目录不确定性。', 'Build a traceable source register while retaining access restrictions and catalogue uncertainty.'),
      actions: [
        localized('按馆藏、全宗、系列、盒、卷、件或等价层级记录目录定位。', 'Record repository, fonds, series, box, folder, item, or equivalent hierarchy.'),
        localized('登记形成机构、拟定作者、日期、体裁、受众、保存状态和复制件关系；未知项保持未知。', 'Record creating body, attributed author, date, genre, audience, preservation state, and surrogate relation; unknowns remain unknown.'),
        localized('分别标注目录描述、原件观察、转录、译文和二手引用。', 'Distinguish catalogue description, original inspection, transcription, translation, and secondary quotation.'),
      ],
      expectedOutputs: [
        localized('带档案层级的史料登记表', 'Source register with archival hierarchy'),
        localized('访问限制、缺失与不确定性记录', 'Register of access restrictions, gaps, and uncertainty'),
      ],
      capabilityIds: ['retrieval', 'review_reproducibility'],
      humanApproval: approval(
        'source_corpus',
        '审批史料范围与出处记录',
        'Approve source scope and origin records',
        '研究者抽查目录定位、形成背景和原件/复制件区分。',
        'The researcher samples catalogue locators, creation context, and original/surrogate distinctions.',
        [
          ['所有可知出处均可复核', 'Every known origin is reviewable'],
          ['未知出处未被推测填充', 'Unknown origins have not been filled by inference'],
        ],
      ),
    },
    {
      id: 'history-anchor',
      kind: 'evidence_anchoring',
      title: localized('转录、定位并进行史料内外部批判', 'Transcribe, locate, and perform internal and external criticism'),
      objective: localized('把证据与原件位置、文本上下文、形成目的和物质特征一起记录。', 'Record evidence together with original location, textual context, creation purpose, and material features.'),
      actions: [
        localized('以页、叶、栏、行、图版或时间码定位，并记录缺损、删改与难辨字。', 'Anchor by page, folio, column, line, plate, or timecode and record damage, alterations, and uncertain readings.'),
        localized('外部批判检查真伪、日期、作者归属、传承和版本关系。', 'External criticism checks authenticity, date, attribution, transmission, and version relations.'),
        localized('内部批判检查目的、受众、体裁惯例、立场、修辞和可信限度。', 'Internal criticism checks purpose, audience, genre convention, position, rhetoric, and credibility limits.'),
      ],
      expectedOutputs: [
        localized('带原件定位与转录不确定性的证据锚点', 'Evidence anchors with original locators and transcription uncertainty'),
        localized('逐件史料批判笔记', 'Item-level source criticism notes'),
      ],
      capabilityIds: ['close_reading', 'evidence_anchoring'],
      humanApproval: approval(
        'evidence_sample',
        '审批转录与史料批判抽样',
        'Approve a sample of transcription and source criticism',
        '研究者对照原件或可靠复制件抽查转录、定位和批判判断。',
        'The researcher compares a sample against originals or reliable surrogates and reviews locators and criticism judgments.',
        [
          ['关键引文转录准确或标明不确定', 'Key quotations are accurate or explicitly uncertain'],
          ['史料立场与形成目的已纳入解释', 'Source position and purpose inform interpretation'],
        ],
      ),
    },
    {
      id: 'history-claims',
      kind: 'coding_and_claims',
      title: localized('建立史料主题、时间线与暂定论断', 'Build themes, chronology, and provisional claims'),
      objective: localized('在不抹平史料差异的前提下连接事件、概念、行动者和制度变化。', 'Connect events, concepts, actors, and institutional change without flattening source differences.'),
      actions: [
        localized('编码行动者、事件、概念、修辞、制度实践和史料沉默。', 'Code actors, events, concepts, rhetoric, institutional practice, and source silences.'),
        localized('建立日期确定性分级的时间线与史料关系图。', 'Build a chronology and source-relation map with date certainty levels.'),
        localized('把事实判断、解释性推论和史学论断分别链接到证据。', 'Link factual judgments, interpretive inferences, and historiographic claims separately to evidence.'),
      ],
      expectedOutputs: [
        localized('主题代码本和带不确定性的时间线', 'Thematic codebook and uncertainty-aware chronology'),
        localized('分层的暂定历史论断集', 'Layered set of provisional historical claims'),
      ],
      capabilityIds: ['qualitative_coding', 'writing_citations'],
      humanApproval: approval(
        'codebook_or_claims',
        '审批史料编码与历史论断',
        'Approve source coding and historical claims',
        '研究者确认推论强度与史料质量匹配，并处理相互冲突的记录。',
        'The researcher confirms inference strength matches source quality and addresses conflicting records.',
        [
          ['事实、推论与解释没有混为一谈', 'Fact, inference, and interpretation remain distinct'],
          ['冲突史料被保留并说明权衡', 'Conflicting sources are retained with reasoning'],
        ],
      ),
    },
    {
      id: 'history-limit',
      kind: 'counterevidence_and_limitations',
      title: localized('检验反例、档案沉默与替代解释', 'Test counterexamples, archival silences, and rival explanations'),
      objective: localized('避免把保存偏差、国家或机构视角和后见之明误当完整历史。', 'Avoid treating preservation bias, state or institutional viewpoints, and hindsight as complete history.'),
      actions: [
        localized('寻找来自不同机构、社会位置、地域与体裁的互证和反证。', 'Seek corroboration and counterevidence across institutions, social positions, regions, and genres.'),
        localized('分析谁有能力留下记录、谁被排除，以及目录和开放政策如何塑造材料集。', 'Analyze who could leave records, who was excluded, and how cataloguing and access policy shape the corpus.'),
        localized('列出可竞争解释、时代错置风险和无法确定的因果链。', 'List competing interpretations, anachronism risks, and indeterminate causal chains.'),
      ],
      expectedOutputs: [
        localized('互证、反证和替代解释表', 'Corroboration, counterevidence, and rival-explanation table'),
        localized('档案沉默、保存偏差与可知性局限说明', 'Statement of archival silence, preservation bias, and epistemic limits'),
      ],
      capabilityIds: ['retrieval', 'close_reading', 'review_reproducibility'],
      humanApproval: approval(
        'limitations',
        '审批替代解释与史料边界',
        'Approve rival explanations and source boundaries',
        '研究者决定哪些论断需要降级、限定或暂缓。',
        'The researcher decides which claims must be downgraded, bounded, or withheld.',
        [
          ['主要替代解释已得到公平检验', 'Major rival explanations received a fair test'],
          ['“没有记录”没有被误写为“没有发生”', 'Absence of records is not written as absence of events'],
        ],
      ),
    },
    {
      id: 'history-deliver',
      kind: 'artifact_and_review',
      title: localized('形成历史叙述并审阅史料链', 'Compose the historical account and review the source chain'),
      objective: localized('产出可追溯到史料层级和批判笔记的历史论证草稿。', 'Produce a historical argument draft traceable to archival hierarchy and criticism notes.'),
      actions: [
        localized('按问题需要组织叙述、专题或比较结构，并标记不确定性。', 'Organize narrative, thematic, or comparative structure as appropriate and mark uncertainty.'),
        localized('核对档案引注、版本、译文、日期、专名和引文上下文。', 'Audit archival citations, versions, translations, dates, names, and quotation context.'),
        localized('提交史料链、反证、局限和表达伦理的人工终审。', 'Submit source chain, counterevidence, limitations, and representational ethics for final human review.'),
      ],
      expectedOutputs: [
        localized('带史料引注的历史论证草稿', 'Historical argument draft with source citations'),
        localized('史料登记、批判笔记与审阅决定附录', 'Appendix of source register, criticism notes, and review decisions'),
      ],
      capabilityIds: ['writing_citations', 'review_reproducibility'],
      humanApproval: approval(
        'artifact_release',
        '人工终审历史论证',
        'Human final review of the historical argument',
        '系统只提供草稿和审计记录；研究者决定是否可以提交或发布。',
        'The system provides only a draft and audit record; the researcher decides whether it may be submitted or released.',
        [
          ['关键论断可追溯到史料及批判过程', 'Key claims trace to sources and criticism'],
          ['不确定性、史料沉默和伦理风险已明确表达', 'Uncertainty, archival silences, and ethical risks are explicit'],
        ],
      ),
    },
  ],
};

const QUALITATIVE_INTERVIEW_CODING: ScenarioTemplateDto = {
  id: 'qualitative_interview_coding',
  version: 1,
  title: localized('质性访谈编码与主题分析', 'Qualitative interview coding and thematic analysis'),
  summary: localized(
    '在伦理许可、知情同意和匿名化边界内，对已授权访谈材料进行锚定、编码、负面案例检验与主题草稿规划。',
    'Plan anchored coding, negative-case analysis, and thematic drafting for authorized interview materials within ethics, consent, and anonymization boundaries.',
  ),
  suitableFor: [
    localized('半结构式或深度访谈、焦点小组与口述资料', 'Semi-structured or in-depth interviews, focus groups, and oral materials'),
    localized('主题分析、框架分析、扎根理论式编码或解释现象学分析', 'Thematic, framework, grounded-theory-style, or interpretative phenomenological analysis'),
  ],
  boundaryNotes: [
    localized('启动器不应接收受访者姓名、联系方式、原始转录全文或其他机密个人信息。', 'The launcher should not receive participant names, contact details, raw transcripts, or other confidential personal information.'),
    localized('伦理审批、同意范围和数据治理未确认前，只能制定计划，不能导入或分析访谈材料。', 'Until ethics approval, consent scope, and data governance are confirmed, only planning is allowed; materials must not be imported or analyzed.'),
    localized('自动建议的代码和主题一律保持待审，不能替代研究者解释与反思。', 'Automatically suggested codes and themes remain pending and cannot replace researcher interpretation and reflexivity.'),
  ],
  requirementFields: [
    {
      key: 'ethics_status',
      kind: 'single_select',
      label: localized('伦理与数据治理状态', 'Ethics and data-governance status'),
      helpText: localized('该选择只用于计划分支，不等同于伦理审批证明。', 'This selection only guides planning and is not proof of ethics approval.'),
      required: true,
      options: [
        { value: 'approved', label: localized('已获适用审批/确认', 'Applicable approval confirmed') },
        { value: 'pending', label: localized('审批或确认中', 'Approval or confirmation pending') },
        { value: 'uncertain', label: localized('尚不确定，需要人工核查', 'Uncertain; human verification needed') },
      ],
    },
    {
      key: 'participant_scope',
      kind: 'long_text',
      label: localized('研究对象与抽样策略', 'Population and sampling strategy'),
      helpText: localized('描述群体、招募逻辑和样本边界，不填写任何可识别个人的信息。', 'Describe the population, recruitment logic, and sample boundary without identifiable personal information.'),
      required: true,
      placeholder: localized('例如：某类职业群体，目的性抽样与最大差异策略……', 'Example: an occupational group using purposive and maximum-variation sampling…'),
    },
    {
      key: 'consent_anonymisation',
      kind: 'long_text',
      label: localized('同意、匿名化与访问边界', 'Consent, anonymization, and access boundaries'),
      helpText: localized('说明允许的分析、引用、共享和保留范围，以及匿名化责任人。', 'State permitted analysis, quotation, sharing, retention, and who is responsible for anonymization.'),
      required: true,
      placeholder: localized('仅描述规则，不粘贴同意书、姓名或敏感原文。', 'Describe rules only; do not paste consent forms, names, or sensitive excerpts.'),
    },
    {
      key: 'coding_approach',
      kind: 'single_select',
      label: localized('分析与编码路径', 'Analytic and coding approach'),
      helpText: localized('选择主要路径，后续仍需研究者确认方法一致性。', 'Choose the primary approach; the researcher must still confirm methodological coherence.'),
      required: true,
      options: [
        { value: 'reflexive_thematic', label: localized('反思性主题分析', 'Reflexive thematic analysis') },
        { value: 'framework_analysis', label: localized('框架分析', 'Framework analysis') },
        { value: 'grounded_coding', label: localized('扎根理论式编码', 'Grounded-theory-style coding') },
        { value: 'interpretative', label: localized('解释现象学/深描路径', 'Interpretative phenomenological or thick-description approach') },
      ],
    },
    {
      key: 'analytic_goal',
      kind: 'long_text',
      label: localized('希望理解的经验或机制', 'Experience or process to understand'),
      helpText: localized('避免把研究者预期写成已经存在的主题。', 'Do not write expected themes as if they already exist.'),
      required: true,
      placeholder: localized('说明要理解的经验、过程、意义建构或制度互动。', 'Describe the experience, process, meaning-making, or institutional interaction to understand.'),
    },
  ],
  stages: [
    {
      id: 'interview-clarify',
      kind: 'question_clarification',
      title: localized('澄清质性问题、抽样与伦理门槛', 'Clarify the qualitative question, sampling, and ethics gate'),
      objective: localized('确认研究问题、认识论立场、抽样逻辑和数据治理条件彼此一致。', 'Align the research question, epistemological position, sampling logic, and data-governance conditions.'),
      actions: [
        localized('区分描述经验、解释意义、建构理论或评估过程等目标。', 'Distinguish describing experience, interpreting meaning, building theory, or evaluating process.'),
        localized('记录抽样策略、预期差异维度和停止招募/材料扩展的判断方式。', 'Record sampling strategy, anticipated variation, and how recruitment or corpus expansion will stop.'),
        localized('核查伦理审批、知情同意、匿名化、保存期限、访问者和允许引用范围。', 'Verify ethics approval, informed consent, anonymization, retention, access, and permitted quotation.'),
      ],
      expectedOutputs: [
        localized('经确认的质性研究问题与抽样说明', 'Approved qualitative question and sampling statement'),
        localized('伦理与数据治理检查清单', 'Ethics and data-governance checklist'),
      ],
      capabilityIds: ['review_reproducibility'],
      humanApproval: approval(
        'question_scope',
        '伦理与研究设计人工审批',
        'Human approval of ethics and research design',
        '只有具有相应责任的研究者确认后，后续材料导入才可发生。',
        'Material import may occur only after an accountable researcher confirms these conditions.',
        [
          ['审批和同意范围覆盖拟议分析', 'Approval and consent cover the proposed analysis'],
          ['启动器中没有提交可识别或机密数据', 'No identifiable or confidential data were entered in the launcher'],
        ],
      ),
    },
    {
      id: 'interview-import',
      kind: 'source_import',
      title: localized('登记已授权材料与去标识状态', 'Register authorized materials and de-identification status'),
      objective: localized('只导入许可范围内的材料，并把访问、匿名化和转录状态作为显式记录。', 'Import only authorized materials and explicitly record access, de-identification, and transcription status.'),
      actions: [
        localized('为每份材料登记研究内匿名标识、访谈轮次、格式、语言和许可状态。', 'Register a study pseudonym, interview wave, format, language, and permission status for each item.'),
        localized('在进入分析前检查直接与间接标识符、第三方信息和敏感片段处理。', 'Check direct and indirect identifiers, third-party information, and sensitive passages before analysis.'),
        localized('记录转录、校对、翻译和说话者区分的责任与不确定性。', 'Record responsibility and uncertainty for transcription, checking, translation, and speaker separation.'),
      ],
      expectedOutputs: [
        localized('授权材料登记表', 'Authorized-material register'),
        localized('去标识与转录质量记录', 'De-identification and transcription-quality record'),
      ],
      capabilityIds: ['retrieval', 'review_reproducibility'],
      humanApproval: approval(
        'source_corpus',
        '审批可分析材料范围',
        'Approve the analyzable corpus',
        '数据责任人确认每份材料均可在当前目的和访问环境中分析。',
        'The responsible data steward confirms each item may be analyzed for this purpose and in this access environment.',
        [
          ['授权、同意和访问状态已逐项核对', 'Authorization, consent, and access status were checked item by item'],
          ['去标识措施与风险相称', 'De-identification controls match the risk'],
        ],
      ),
    },
    {
      id: 'interview-anchor',
      kind: 'evidence_anchoring',
      title: localized('分段、定位并建立反思性阅读笔记', 'Segment, anchor, and create reflexive reading notes'),
      objective: localized('把分析单元锚定到转录位置和必要上下文，同时记录研究者反思。', 'Anchor analytic units to transcript positions and context while recording researcher reflexivity.'),
      actions: [
        localized('按行号、话轮或时间码建立证据锚点，并保留前后语境。', 'Create anchors by line, turn, or timecode with surrounding context.'),
        localized('标记语气、停顿、重叠、翻译选择或转录不确定性在解释中的作用。', 'Mark how tone, pauses, overlap, translation choices, or transcription uncertainty affect interpretation.'),
        localized('分别记录参与者表述、研究者解释和反思性备忘。', 'Separate participant expression, researcher interpretation, and reflexive memo.'),
      ],
      expectedOutputs: [
        localized('带行号/时间码和上下文的证据锚点', 'Evidence anchors with line/timecode and context'),
        localized('反思性阅读与转录不确定性备忘', 'Reflexive reading and transcription-uncertainty memos'),
      ],
      capabilityIds: ['close_reading', 'evidence_anchoring'],
      humanApproval: approval(
        'evidence_sample',
        '审批分段与锚定样本',
        'Approve a segmentation and anchoring sample',
        '研究者抽查锚点是否保留语境、匿名化是否稳健、解释层次是否分明。',
        'The researcher samples anchors for context, robust anonymization, and separation of analytic layers.',
        [
          ['证据片段可回到授权材料中的位置', 'Evidence returns to a location in authorized material'],
          ['脱离语境的短句没有被过度解释', 'Short excerpts are not overinterpreted out of context'],
        ],
      ),
    },
    {
      id: 'interview-code',
      kind: 'coding_and_claims',
      title: localized('迭代代码本、主题与分析备忘', 'Iterate the codebook, themes, and analytic memos'),
      objective: localized('通过人工审阅的编码迭代形成暂定主题，而不是从频次自动推出结论。', 'Develop provisional themes through human-reviewed coding rather than automatic inference from frequency.'),
      actions: [
        localized('进行初始编码并记录代码定义、纳入排除边界、实例和反例。', 'Conduct initial coding and record definitions, boundaries, examples, and counterexamples.'),
        localized('所有自动代码建议保持待审，逐项接受、修改、合并或拒绝。', 'Keep every automated code suggestion pending until accepted, revised, merged, or rejected.'),
        localized('通过跨材料比较、备忘和必要的复核样本发展暂定主题或范畴。', 'Develop provisional themes or categories through cross-case comparison, memos, and an appropriate review sample.'),
      ],
      expectedOutputs: [
        localized('版本化代码本与决定日志', 'Versioned codebook and decision log'),
        localized('链接到证据的暂定主题与分析备忘', 'Provisional themes and analytic memos linked to evidence'),
      ],
      capabilityIds: ['qualitative_coding', 'quantitative_analysis'],
      humanApproval: approval(
        'codebook_or_claims',
        '审批代码本与暂定主题',
        'Approve the codebook and provisional themes',
        '研究者确认主题由材料支持，代码频次未被误当重要性或普遍性。',
        'The researcher confirms themes are supported and code frequency is not mistaken for importance or prevalence.',
        [
          ['建议代码已有明确人工决定', 'Suggested codes have explicit human decisions'],
          ['主题保留材料内部差异与少数声音', 'Themes retain within-corpus variation and minority voices'],
        ],
      ),
    },
    {
      id: 'interview-limit',
      kind: 'counterevidence_and_limitations',
      title: localized('分析负面案例、反思性与迁移边界', 'Analyze negative cases, reflexivity, and transfer boundaries'),
      objective: localized('检验主题对矛盾材料、研究者位置和样本边界的敏感性。', 'Test themes against contradictory material, researcher position, and sample boundaries.'),
      actions: [
        localized('主动查找负面案例、例外、沉默、矛盾和未被主题容纳的材料。', 'Actively seek negative cases, exceptions, silences, contradictions, and material not captured by themes.'),
        localized('记录研究者立场、访谈关系、提问方式和分析决定可能带来的影响。', 'Record effects of researcher position, interview relationship, questioning, and analytic decisions.'),
        localized('评估信息力、主题充分性和迁移条件，不声称统计代表性。', 'Assess information power, thematic sufficiency, and transfer conditions without claiming statistical representativeness.'),
      ],
      expectedOutputs: [
        localized('负面案例与主题修订表', 'Negative-case and theme-revision table'),
        localized('反思性、样本与迁移局限说明', 'Reflexivity, sampling, and transfer limitation statement'),
      ],
      capabilityIds: ['qualitative_coding', 'review_reproducibility'],
      humanApproval: approval(
        'limitations',
        '审批负面案例与解释边界',
        'Approve negative cases and interpretive boundaries',
        '研究者决定哪些主题需要重命名、拆分、降级或撤回。',
        'The researcher decides which themes require renaming, splitting, downgrading, or withdrawal.',
        [
          ['负面案例影响已进入主题修订', 'Negative cases affected theme revision'],
          ['结论没有越过样本与认识论边界', 'Claims remain within sampling and epistemological boundaries'],
        ],
      ),
    },
    {
      id: 'interview-deliver',
      kind: 'artifact_and_review',
      title: localized('起草主题报告并完成伦理与证据审阅', 'Draft the thematic report and complete ethics and evidence review'),
      objective: localized('形成可审阅的方法、主题和引文草稿，同时保护参与者与语境。', 'Produce a reviewable methods, themes, and quotation draft while protecting participants and context.'),
      actions: [
        localized('从已审主题和证据起草，清楚区分参与者声音与研究者解释。', 'Draft from reviewed themes and evidence, clearly separating participant voice from researcher interpretation.'),
        localized('核查引文许可、匿名化、上下文、翻译、主题覆盖和方法一致性。', 'Audit quotation permission, anonymization, context, translation, thematic coverage, and methodological coherence.'),
        localized('由研究者和必要的数据/伦理责任人作最终发布决定。', 'Obtain final release decisions from the researcher and any required data or ethics steward.'),
      ],
      expectedOutputs: [
        localized('方法与主题分析草稿', 'Methods and thematic-analysis draft'),
        localized('代码本、审计记录和伦理发布决定', 'Codebook, audit record, and ethical release decision'),
      ],
      capabilityIds: ['writing_citations', 'review_reproducibility'],
      humanApproval: approval(
        'artifact_release',
        '人工终审与伦理发布决定',
        'Human final review and ethical release decision',
        '系统不得自动宣称分析完成或材料可发布。',
        'The system must not automatically claim that analysis is complete or that materials may be released.',
        [
          ['引文和案例呈现符合同意与匿名化边界', 'Quotations and cases comply with consent and anonymization boundaries'],
          ['主题、负面案例和局限均可追溯到审阅记录', 'Themes, negative cases, and limits trace to review records'],
        ],
      ),
    },
  ],
};

const THEORETICAL_TEXT_COMPARISON: ScenarioTemplateDto = {
  id: 'theoretical_text_comparison',
  version: 1,
  title: localized('理论文本比较与概念辨析', 'Theoretical text comparison and conceptual analysis'),
  summary: localized(
    '在版本、译本、语境和论证结构中比较理论文本，形成有锚点的概念矩阵、异同论断与反例审阅计划。',
    'Compare theoretical texts through editions, translations, contexts, and argument structures to build an anchored concept matrix and reviewed claims of similarity and difference.',
  ),
  suitableFor: [
    localized('思想史、政治哲学、社会理论、文学理论与跨传统比较', 'Intellectual history, political philosophy, social theory, literary theory, and cross-tradition comparison'),
    localized('概念谱系、理论争论、译介研究与经典文本精读', 'Conceptual genealogy, theoretical debate, translation reception, and close reading of canonical texts'),
  ],
  boundaryNotes: [
    localized('相似措辞不自动证明概念等同、影响关系或共同起源。', 'Similar wording does not automatically prove conceptual equivalence, influence, or common origin.'),
    localized('译本必须与具体版本和原文核对边界一同记录。', 'Translations must be recorded with their edition and the boundary of verification against original-language text.'),
    localized('模板只组织比较计划，不生成作者立场、文本引文或理论结论。', 'The template organizes a comparison plan only and does not generate authorial positions, quotations, or theoretical conclusions.'),
  ],
  requirementFields: [
    {
      key: 'comparison_problem',
      kind: 'long_text',
      label: localized('比较问题与争论背景', 'Comparison problem and debate'),
      helpText: localized('说明为什么需要比较，以及比较要回应什么理论争论。', 'Explain why comparison is needed and which theoretical debate it addresses.'),
      required: true,
      placeholder: localized('例如：两位作者如何理解“异化”，其问题意识是否可比……', 'Example: how two authors understand alienation and whether their problematics are comparable…'),
    },
    {
      key: 'primary_texts',
      kind: 'long_text',
      label: localized('拟比较的原始文本', 'Primary texts to compare'),
      helpText: localized('列出作品与章节范围，不粘贴受版权限制的长篇原文。', 'List works and chapter scope; do not paste long copyrighted passages.'),
      required: true,
      placeholder: localized('列出作者、作品、章节或时期。', 'List authors, works, chapters, or periods.'),
    },
    {
      key: 'edition_translation',
      kind: 'long_text',
      label: localized('版本、译本与语言能力', 'Editions, translations, and language access'),
      helpText: localized('说明使用哪些版本、译本，以及关键术语能否核对原文。', 'State editions, translations, and whether key terms can be checked in the original language.'),
      required: true,
      placeholder: localized('列出版本信息、译者和原文核对计划。', 'List edition details, translators, and the original-language verification plan.'),
    },
    {
      key: 'comparison_axes',
      kind: 'long_text',
      label: localized('预设比较维度', 'Provisional comparison axes'),
      helpText: localized('维度应保持可修订，避免只寻找预设相似性。', 'Axes remain revisable and should not force predetermined similarities.'),
      required: true,
      placeholder: localized('例如：概念定义、问题结构、论证方式、历史语境、规范后果。', 'Example: definitions, problem structure, argument form, context, and normative implications.'),
    },
    {
      key: 'deliverable_form',
      kind: 'single_select',
      label: localized('预期成果形式', 'Intended deliverable'),
      helpText: localized('选择比较矩阵、论文或理论章节的主要形态。', 'Choose the primary form of the matrix, article, or theoretical chapter.'),
      required: true,
      options: [
        { value: 'comparative_essay', label: localized('比较论文', 'Comparative essay') },
        { value: 'concept_matrix', label: localized('概念比较矩阵', 'Concept comparison matrix') },
        { value: 'theory_chapter', label: localized('论文理论章节', 'Thesis theory chapter') },
      ],
    },
  ],
  stages: [
    {
      id: 'theory-clarify',
      kind: 'question_clarification',
      title: localized('澄清可比问题与比较单位', 'Clarify comparability and units of comparison'),
      objective: localized('界定比较对象、概念层级、问题结构和比较的正当理由。', 'Define the objects, conceptual level, problem structures, and justification for comparison.'),
      actions: [
        localized('说明比较是概念、论证、问题意识、历史作用还是接受史层面。', 'State whether comparison concerns concepts, arguments, problematics, historical roles, or reception.'),
        localized('识别可能不可通约的语境、体裁、语言和理论目的。', 'Identify potentially incommensurable contexts, genres, languages, and theoretical aims.'),
        localized('把预设相似性和差异性改写为待检验问题。', 'Rewrite assumed similarities and differences as questions to be tested.'),
      ],
      expectedOutputs: [
        localized('可比性说明与比较问题', 'Comparability statement and comparison question'),
        localized('可修订的比较维度表', 'Revisable comparison-axis table'),
      ],
      capabilityIds: ['close_reading', 'review_reproducibility'],
      humanApproval: approval(
        'question_scope',
        '审批比较问题与可比性',
        'Approve the comparison question and comparability',
        '研究者确认比较不会因表面相似而抹平语境差异。',
        'The researcher confirms that superficial similarity will not erase contextual difference.',
        [
          ['比较单位和分析层级明确', 'Units and levels of analysis are explicit'],
          ['不可通约性被作为问题而非噪声处理', 'Incommensurability is treated as an analytic issue, not noise'],
        ],
      ),
    },
    {
      id: 'theory-import',
      kind: 'source_import',
      title: localized('登记原始文本、版本与解释传统', 'Register primary texts, editions, and interpretive traditions'),
      objective: localized('建立版本明确的主文本与必要二手解释材料集。', 'Build a version-specific corpus of primary texts and necessary interpretive scholarship.'),
      actions: [
        localized('登记作品、写作/出版时期、版本、章节、语言、译者和修订关系。', 'Register works, composition/publication period, edition, chapter, language, translator, and revision relation.'),
        localized('区分作者文本、编者材料、译者说明、同时代语境材料和二手解释。', 'Distinguish authorial text, editorial material, translator notes, contextual sources, and secondary interpretation.'),
        localized('选择具有代表性且彼此竞争的解释传统，记录选择理由。', 'Select representative and competing interpretive traditions and record the rationale.'),
      ],
      expectedOutputs: [
        localized('版本化文本与解释材料登记表', 'Versioned register of texts and interpretations'),
        localized('译本和原文核对范围说明', 'Translation and original-language verification statement'),
      ],
      capabilityIds: ['retrieval', 'review_reproducibility'],
      humanApproval: approval(
        'source_corpus',
        '审批文本版本与解释材料集',
        'Approve editions and interpretive corpus',
        '研究者确认版本适合比较，二手材料没有单一学派偏置。',
        'The researcher confirms edition suitability and that secondary literature is not restricted to one school without justification.',
        [
          ['关键版本、译本与章节边界明确', 'Key editions, translations, and chapter boundaries are explicit'],
          ['解释材料选择有可说明的覆盖原则', 'Interpretive scholarship follows a defensible coverage principle'],
        ],
      ),
    },
    {
      id: 'theory-anchor',
      kind: 'evidence_anchoring',
      title: localized('锚定概念段落与论证语境', 'Anchor conceptual passages and argumentative context'),
      objective: localized('从具体段落、术语用法和论证位置建立可复核比较单元。', 'Build reviewable comparison units from passages, term usage, and argumentative position.'),
      actions: [
        localized('记录页码、章节、段落及论证中的前提、转折、例证和结论位置。', 'Record page, chapter, passage, and the role of premise, transition, example, or conclusion.'),
        localized('为关键术语记录原文、译法、同文本变体和语境义。', 'Record original wording, translations, intra-textual variants, and contextual meaning for key terms.'),
        localized('保留支持与破坏初始比较维度的段落，不只摘取相似措辞。', 'Retain passages that support and disrupt initial axes rather than selecting only similar wording.'),
      ],
      expectedOutputs: [
        localized('概念—段落—论证位置证据表', 'Concept–passage–argument-position evidence table'),
        localized('关键术语原文与译法备忘', 'Key-term original-language and translation memo'),
      ],
      capabilityIds: ['close_reading', 'evidence_anchoring'],
      humanApproval: approval(
        'evidence_sample',
        '审批关键段落与术语核对样本',
        'Approve key-passage and terminology sample',
        '研究者抽查引文语境、版本和术语解释，确认没有断章取义。',
        'The researcher samples quotation context, edition, and terminology to ensure passages are not decontextualized.',
        [
          ['关键段落可定位到指定版本', 'Key passages locate to the specified edition'],
          ['译法差异进入解释而非被隐藏', 'Translation differences enter the analysis rather than being hidden'],
        ],
      ),
    },
    {
      id: 'theory-compare',
      kind: 'coding_and_claims',
      title: localized('构建概念矩阵与暂定比较论断', 'Build the concept matrix and provisional comparative claims'),
      objective: localized('比较定义、问题结构、论证功能、历史语境和规范后果。', 'Compare definitions, problem structures, argumentative functions, historical contexts, and normative implications.'),
      actions: [
        localized('用可修订代码标记概念功能、二分结构、因果或规范关系和修辞策略。', 'Use revisable codes for conceptual function, distinctions, causal or normative relations, and rhetorical strategy.'),
        localized('分别形成同源、相似、差异、不可通约和可能影响等不同强度的暂定论断。', 'Form distinct provisional claims of lineage, similarity, difference, incommensurability, or possible influence.'),
        localized('每个比较论断链接双方文本证据及必要语境材料。', 'Link each comparative claim to evidence from both texts and necessary context.'),
      ],
      expectedOutputs: [
        localized('版本化概念与论证比较矩阵', 'Versioned concept and argument comparison matrix'),
        localized('带双边证据的暂定比较论断', 'Provisional comparative claims with bilateral evidence'),
      ],
      capabilityIds: ['qualitative_coding', 'writing_citations'],
      humanApproval: approval(
        'codebook_or_claims',
        '审批比较矩阵与论断强度',
        'Approve the comparison matrix and claim strength',
        '研究者确认“相似”“影响”“继承”等关系使用了相称证据。',
        'The researcher confirms that similarity, influence, and inheritance claims use proportionate evidence.',
        [
          ['每个论断具有双边文本支持', 'Each claim has evidence from both sides'],
          ['影响关系没有从时间先后或词语相似直接推断', 'Influence is not inferred directly from chronology or lexical similarity'],
        ],
      ),
    },
    {
      id: 'theory-limit',
      kind: 'counterevidence_and_limitations',
      title: localized('检验反段落、语境差异与替代解释', 'Test counterpassages, contextual differences, and rival readings'),
      objective: localized('识别比较矩阵无法容纳的文本、译本差异和解释竞争。', 'Identify texts, translation differences, and interpretive competition that resist the comparison matrix.'),
      actions: [
        localized('针对主要论断搜集反段落、术语变体、不同写作时期和修订版本。', 'Collect counterpassages, term variants, different writing periods, and revised editions for major claims.'),
        localized('比较竞争性二手解释，并检查是否只采纳有利于预设结论的读法。', 'Compare rival scholarship and check for selective adoption of readings that favor the expected conclusion.'),
        localized('记录语言能力、版本可及性、历史语境和可比性限度。', 'Record limits from language access, edition availability, historical context, and comparability.'),
      ],
      expectedOutputs: [
        localized('反段落与替代解释表', 'Counterpassage and rival-reading table'),
        localized('可比性、译本与语境局限说明', 'Comparability, translation, and context limitation statement'),
      ],
      capabilityIds: ['close_reading', 'retrieval', 'review_reproducibility'],
      humanApproval: approval(
        'limitations',
        '审批反例与比较限度',
        'Approve counterexamples and comparison limits',
        '研究者决定哪些相似性需降级，哪些差异来自版本、语境或比较设计。',
        'The researcher decides which similarities should be downgraded and which differences arise from edition, context, or design.',
        [
          ['关键论断已接受反段落检验', 'Key claims have undergone counterpassage testing'],
          ['不可通约之处没有被强行统一', 'Incommensurable elements have not been forced into equivalence'],
        ],
      ),
    },
    {
      id: 'theory-deliver',
      kind: 'artifact_and_review',
      title: localized('起草比较论证并审阅引文与概念一致性', 'Draft the comparison and review citations and conceptual consistency'),
      objective: localized('形成以文本证据和比较限度为基础的可审阅理论成果草稿。', 'Produce a reviewable theoretical draft grounded in textual evidence and limits of comparison.'),
      actions: [
        localized('按问题、概念或争论组织草稿，避免“作者 A 对作者 B”的机械平行摘要。', 'Organize by problem, concept, or debate rather than mechanically parallel summaries of author A and author B.'),
        localized('核对引文版本、译文、原文术语、上下文和双边证据覆盖。', 'Audit edition, translation, original terminology, context, and bilateral evidence coverage.'),
        localized('将反例、不可通约性和替代解释纳入终稿审阅。', 'Include counterexamples, incommensurability, and rival interpretations in final review.'),
      ],
      expectedOutputs: [
        localized('带文本引注的比较草稿或概念矩阵', 'Comparative draft or concept matrix with textual citations'),
        localized('版本、译本、引文与论断审计记录', 'Edition, translation, citation, and claim audit record'),
      ],
      capabilityIds: ['writing_citations', 'review_reproducibility'],
      humanApproval: approval(
        'artifact_release',
        '人工终审理论比较成果',
        'Human final review of the theoretical comparison',
        '系统不得把计划或草稿标记为研究完成；研究者决定论证是否可接受。',
        'The system must not mark a plan or draft as completed research; the researcher decides whether the argument is acceptable.',
        [
          ['引文、版本和术语解释均可复核', 'Citations, editions, and terminology are reviewable'],
          ['比较论断明确表达证据强度与局限', 'Comparative claims state evidence strength and limits'],
        ],
      ),
    },
  ],
};

export const HUMANITIES_RESEARCH_SCENARIOS: readonly ScenarioTemplateDto[] = [
  LITERATURE_REVIEW,
  HISTORICAL_SOURCE_CRITICISM,
  QUALITATIVE_INTERVIEW_CODING,
  THEORETICAL_TEXT_COMPARISON,
];

export function localizeScenarioText(
  text: ScenarioLocalizedText,
  locale: ScenarioLocale,
): string {
  return text[locale];
}

export function getHumanitiesResearchScenario(
  scenarioId: HumanitiesScenarioId,
): ScenarioTemplateDto | undefined {
  return HUMANITIES_RESEARCH_SCENARIOS.find((scenario) => scenario.id === scenarioId);
}

export function getHumanitiesCapabilityRoute(
  capabilityId: ResearchCapabilityId,
): ResearchCapabilityRouteDto | undefined {
  return HUMANITIES_RESEARCH_CAPABILITY_ROUTES.find(
    (route) => route.capabilityId === capabilityId,
  );
}

function responseIsEmpty(value: ScenarioRequirementResponseDto['value']): boolean {
  return typeof value === 'string'
    ? value.trim().length === 0
    : value.length === 0;
}

function validateRequirementResponse(
  field: ScenarioRequirementFieldDto,
  response: ScenarioRequirementResponseDto,
): ScenarioIssueDto | undefined {
  if (field.kind === 'short_text' || field.kind === 'long_text') {
    return typeof response.value === 'string'
      ? undefined
      : { code: 'response_type_invalid', fieldKey: field.key };
  }

  const allowedValues = new Set(field.options.map((option) => option.value));
  if (field.kind === 'single_select') {
    if (typeof response.value !== 'string') {
      return { code: 'response_type_invalid', fieldKey: field.key };
    }
    return allowedValues.has(response.value)
      ? undefined
      : { code: 'response_option_invalid', fieldKey: field.key };
  }

  if (!Array.isArray(response.value)) {
    return { code: 'response_type_invalid', fieldKey: field.key };
  }
  return response.value.every((value) => allowedValues.has(value))
    ? undefined
    : { code: 'response_option_invalid', fieldKey: field.key };
}

function normalizeResponses(
  template: ScenarioTemplateDto,
  request: ScenarioGeneratePlanRequest,
): { responses: ScenarioRequirementResponseDto[]; issues: ScenarioIssueDto[] } {
  const issues: ScenarioIssueDto[] = [];
  const responseByKey = new Map<string, ScenarioRequirementResponseDto>();
  const knownFields = new Map(template.requirementFields.map((field) => [field.key, field]));

  for (const response of request.requirementResponses) {
    if (responseByKey.has(response.fieldKey)) {
      issues.push({ code: 'duplicate_response', fieldKey: response.fieldKey });
      continue;
    }
    if (!knownFields.has(response.fieldKey)) {
      issues.push({ code: 'response_type_invalid', fieldKey: response.fieldKey });
      continue;
    }
    responseByKey.set(response.fieldKey, response);
  }

  const responses: ScenarioRequirementResponseDto[] = [];
  for (const field of template.requirementFields) {
    const response = responseByKey.get(field.key);
    if (response === undefined || responseIsEmpty(response.value)) {
      if (field.required) {
        issues.push({ code: 'required_response_missing', fieldKey: field.key });
      }
      continue;
    }
    const issue = validateRequirementResponse(field, response);
    if (issue !== undefined) {
      issues.push(issue);
      continue;
    }
    responses.push({
      fieldKey: response.fieldKey,
      value: typeof response.value === 'string'
        ? response.value.trim()
        : [...new Set(response.value)],
    });
  }

  return { responses, issues };
}

function collectCapabilityIds(
  template: ScenarioTemplateDto,
  selectedCapabilityIds: readonly ResearchCapabilityId[],
): { capabilityIds: ResearchCapabilityId[]; issues: ScenarioIssueDto[] } {
  const knownCapabilityIds = new Set(
    HUMANITIES_RESEARCH_CAPABILITY_ROUTES.map((route) => route.capabilityId),
  );
  const requested = new Set<ResearchCapabilityId>();
  const issues: ScenarioIssueDto[] = [];

  for (const capabilityId of selectedCapabilityIds) {
    if (!knownCapabilityIds.has(capabilityId)) {
      issues.push({ code: 'capability_unavailable', fieldKey: null });
      continue;
    }
    requested.add(capabilityId);
  }
  for (const stage of template.stages) {
    for (const capabilityId of stage.capabilityIds) requested.add(capabilityId);
  }

  const capabilityIds = HUMANITIES_RESEARCH_CAPABILITY_ROUTES
    .map((route) => route.capabilityId)
    .filter((capabilityId) => requested.has(capabilityId));

  return { capabilityIds, issues };
}

function planIdentifier(requestId: string): string {
  return `plan-${requestId.slice(0, 123)}`;
}

export function createHumanitiesScenarioPlan(
  input: unknown,
  timestamp: number = Date.now(),
): ScenarioPlanResult {
  const decoded = decodeScenarioGeneratePlanRequest(input);
  if (!decoded.ok) {
    return {
      success: false,
      resultKind: 'plan_draft',
      code: 'scenario_request_invalid',
      issues: [{ code: 'request_invalid', fieldKey: null }],
    };
  }

  const request = decoded.value;
  const template = getHumanitiesResearchScenario(request.scenarioId);
  if (template === undefined) {
    return {
      success: false,
      resultKind: 'plan_draft',
      code: 'scenario_template_unavailable',
      issues: [{ code: 'template_unavailable', fieldKey: null }],
    };
  }

  const normalized = normalizeResponses(template, request);
  const capabilitySelection = collectCapabilityIds(template, request.selectedCapabilityIds);
  const issues = [...normalized.issues, ...capabilitySelection.issues];
  if (issues.length > 0) {
    return {
      success: false,
      resultKind: 'plan_draft',
      code: 'scenario_requirements_incomplete',
      issues,
    };
  }

  const safeTimestamp = Number.isSafeInteger(timestamp) && timestamp >= 0
    ? timestamp
    : Date.now();
  const locale = request.locale;
  const plan: ScenarioPlanDto = {
    id: planIdentifier(request.requestId),
    requestId: request.requestId,
    scenarioId: template.id,
    scenarioVersion: template.version,
    planVersion: 1,
    locale,
    title: request.projectTitle.trim(),
    researchQuestion: request.researchQuestion.trim(),
    requirementResponses: normalized.responses,
    stages: template.stages.map((stage, index) => ({
      id: stage.id,
      kind: stage.kind,
      order: index + 1,
      title: localizeScenarioText(stage.title, locale),
      objective: localizeScenarioText(stage.objective, locale),
      actions: stage.actions.map((action) => localizeScenarioText(action, locale)),
      expectedOutputs: stage.expectedOutputs.map((output) => localizeScenarioText(output, locale)),
      capabilityIds: [...stage.capabilityIds],
      status: 'not_started',
      humanApproval: {
        gate: stage.humanApproval.gate,
        title: localizeScenarioText(stage.humanApproval.title, locale),
        instruction: localizeScenarioText(stage.humanApproval.instruction, locale),
        criteria: stage.humanApproval.criteria.map((criterion) => localizeScenarioText(criterion, locale)),
        status: 'pending_human_review',
      },
    })),
    boundaryNotes: template.boundaryNotes.map((note) => localizeScenarioText(note, locale)),
    capabilityIds: capabilitySelection.capabilityIds,
    researchStatus: 'not_started',
    completionClaim: 'none',
    requiresHumanApprovalBeforeExecution: true,
    requiresHumanApprovalBeforeRelease: true,
    createdAt: safeTimestamp,
    updatedAt: safeTimestamp,
  };

  const validatedPlan = ScenarioPlanDtoSchema.safeParse(plan);
  if (!validatedPlan.success) {
    return {
      success: false,
      resultKind: 'plan_draft',
      code: 'scenario_plan_unavailable',
      issues: [],
    };
  }

  return {
    success: true,
    resultKind: 'plan_draft',
    code: 'scenario_plan_drafted',
    plan: validatedPlan.data,
  };
}

export function listHumanitiesScenarioTemplates(input: unknown): ScenarioTemplateListResult {
  const decoded = decodeScenarioListTemplatesRequest(input);
  if (!decoded.ok) {
    return {
      success: false,
      resultKind: 'template_list',
      code: 'scenario_templates_unavailable',
      templates: [],
      capabilityRoutes: [],
    };
  }

  const parsedTemplates = HUMANITIES_RESEARCH_SCENARIOS.map((template) =>
    ScenarioTemplateDtoSchema.safeParse(template));
  if (parsedTemplates.some((result) => !result.success)) {
    return {
      success: false,
      resultKind: 'template_list',
      code: 'scenario_templates_unavailable',
      templates: [],
      capabilityRoutes: [],
    };
  }
  const parsedCapabilityRoutes = HUMANITIES_RESEARCH_CAPABILITY_ROUTES.map((route) =>
    ResearchCapabilityRouteDtoSchema.safeParse(route));
  if (
    decoded.value.includeCapabilityRoutes
    && parsedCapabilityRoutes.some((result) => !result.success)
  ) {
    return {
      success: false,
      resultKind: 'template_list',
      code: 'scenario_templates_unavailable',
      templates: [],
      capabilityRoutes: [],
    };
  }

  return {
    success: true,
    resultKind: 'template_list',
    templates: parsedTemplates.flatMap((result) => result.success ? [result.data] : []),
    capabilityRoutes: decoded.value.includeCapabilityRoutes
      ? parsedCapabilityRoutes.flatMap((result) => result.success ? [result.data] : [])
      : [],
  };
}

export function getHumanitiesScenarioTemplate(input: unknown): ScenarioTemplateResult {
  const decoded = decodeScenarioGetTemplateRequest(input);
  if (!decoded.ok) {
    return {
      success: false,
      resultKind: 'template',
      code: 'scenario_template_unavailable',
    };
  }

  const template = getHumanitiesResearchScenario(decoded.value.scenarioId);
  if (template === undefined) {
    return {
      success: false,
      resultKind: 'template',
      code: 'scenario_template_unavailable',
    };
  }

  const parsedTemplate = ScenarioTemplateDtoSchema.safeParse(template);
  if (!parsedTemplate.success) {
    return {
      success: false,
      resultKind: 'template',
      code: 'scenario_template_unavailable',
    };
  }

  return {
    success: true,
    resultKind: 'template',
    template: parsedTemplate.data,
  };
}
