# 场景模块重构 —— 交接文档

> 生成时间：2026-08-17（工作中断点）
> 用途：把「场景」模块重构的已完成/进行中/待办状态完整移交给下一位执行者。
> 原始需求：两份文档（21 节 UI 规范 + 18 条功能需求），核心一句话：
> **用户不需要理解 Agent/Workflow 等底层概念也能创建和使用场景；同时完整能力（成果结构、自适应、智能体、技能、MCP、Metis.md、工作流）必须可见可配置；场景必须真正驱动执行。**

---

## 一、任务目标（要达到什么目的）

1. **场景定义升级**：场景不止是"绑定了哪些智能体/技能/MCP/规则"，还要描述：
   - 这类科研任务最终产出什么（成果类型）
   - 成果由哪些部分组成（题目/摘要/关键词/章节/申报栏目/附件…），每部分怎么写（作用/必须包含/禁止/篇幅/方法/证据要求）
   - 采用什么方法（推荐/允许/条件/禁止）
   - AI 可以自主调整什么（成果结构/研究问题/假设/理论框架/方法/章节数范围），重大调整的触发条件
   - 研究过程可回溯（不要求严格线性）
2. **AI 创建场景**：只写自然语言需求 +（可选）上传任意参考材料（模板/范文/论文/写作教材/方法书/投稿指南/政策文件…），AI 综合分析后给出「AI 已理解该场景」摘要，一键生成完整场景。
3. **场景真正驱动执行**：协同对话（resolver）和自主科研（autonomousStart）都能读取成果结构/自适应/写作规范/方法策略并受其约束。
4. **场景与项目分离**：运行时 AI 对结构的调整只影响当前项目（走既有 research_decisions 记录），不自动反写场景。
5. **UI 原则**：简单入口 + 分层展开 + 上下文编辑；三栏 15%/58%/27%；保留 Metis 视觉风格（白/浅灰、深蓝、细边框、高密度）；解决原页面中央大面积空白。

## 二、已完成且有验证的部分

### P0 数据层（engine/runtime/PersonalizationRuntimeContract.ts，已验证）
- 新增 schema（全部 optional，兼容存量定义，旧测试 18/18 通过）：
  - `DeliverableSectionSchema`：递归树；kind（title/abstract/keywords/chapter/section/grant_column/attachment/references/other）、status（locked/required/optional/conditional）、condition、purpose、requirements/optionalContent/forbidden、lengthTarget/method/evidence、aiAdjust
  - `DeliverableSpecSchema`：type（17 种成果类型）、sections 树、structurePolicy（默认/建议最小/建议最大章节）、globalLength/language/journalTier；自带 superRefine（条件部分必须有 condition、深度 ≤4、总数 ≤96、min≤max）
  - `AdaptivityPolicySchema`：structure/content/method 三组布尔开关 + allowedBacktracks + majorAdjustmentTriggers
  - `ReferenceMaterialSchema` + `MaterialInsightsSchema`（structureRules/writingPrinciples/methodSuggestions/hardRequirements）
  - 场景新增字段：deliverable / adaptivity / writingRules / methodPolicy / materials
- 测试：tests/engine/ScenarioDeliverableContract.test.ts（7/7）

### P1 服务层（已验证）
- `engine/io/DocxTextReader.ts`（新）：零依赖 .docx 正文提取（central directory + inflateRaw），测试 5/5
- `electron/ScenarioMaterialService.ts`（新）：
  - importMaterial：txt/md 直读、docx 用 DocxTextReader、pdf 用注入的 PdfReader 提取器；文本落盘到 `DATA_DIR/scenario-materials/`；过短/二进制拒绝
  - buildAnalysisPrompts：描述 + 材料（每份截断）+ 现有定义清单 → 分析提示词
  - parseAnalysisResponse：模型输出容错解析（枚举回退、数量裁剪、条件降级、id 清洗）
  - buildRefinePrompts：「AI 帮我配置」按目标类型（section/writingRules/methodPolicy/adaptivity）生成补全提示词
  - 测试：tests/electron/ScenarioMaterialService.test.ts（9/9）
- IPC（electron/main.ts）+ preload：
  - `scenario:importMaterials`（批量导入，pdf 走 PdfReader）
  - `scenario:analyzeMaterials`（描述 + materialIds + 定义清单 → 摘要 + 草案）
  - `scenario:aiRefine`（上下文补全）
  - `dialog:openReferenceFiles`（多选文件对话框）

### P2 UI（已验证）
- `src/personalization/ScenarioWorkbench.tsx`（新，约 1100 行）：
  - 三栏：左场景库（全部/最近使用/收藏 + 学术论文/项目申报/研究报告/其他/我的场景分类树 + ＋新建场景（AI/手动）+ ✨AI 创建场景）/ 中场景详情 / 右上下文编辑器
  - 五个一级分区：总览（最终成果/结构缩略/自适应摘要/能力计数/运行路径/参考材料）/ 成果结构（结构树 + 🔒●◇ 标识 + 增删移锁 + 结构策略/全局要求）/ 规则与方法（写作规范 + 方法四组）/ 自适应（三组开关 + 回溯路径 + 重大调整触发条件）/ 能力与运行（agents/skills/mcp/rules 绑定 + 工作流编辑（增删移/agent 选择/自动依赖）+ 高级设置（记忆范围/输出格式/主要交付物/辅助成果/质量标准）+ 全权限说明）
  - 右栏：点击章节 → 编辑该部分全部规则；底部 ✨ 让 AI 帮我配置（调 scenario:aiRefine）
  - 「使用此场景」三选项：当前项目（激活）/ 新项目（创建项目后激活）/ 自主科研（跳到控制台并预选场景）；无智能体或歧义路由场景禁用并提示
- `src/personalization/ScenarioAiCreateDialog.tsx`（新）：描述 + 材料拖放/选择 → 开始分析 → 「AI 已理解该场景」摘要（成果类型/默认结构/硬性规则/写作原则/方法/可调整/推荐能力/学习来源）→ 生成场景 / 查看并调整；生成管线 = 智能体 → 场景（含 deliverable/adaptivity/writingRules/methodPolicy/materials）→ 场景 Metis.md 绑定
- `src/personalization/personalizationLib.ts`（新）：从 center 抽取 createDefinition/availableUserId/localId/userProvenance（命名空间必须为复数：scenarios/agents/skills！）
- `src/personalization/scenarioWorkbench.css`（新）
- PersonalizationCenter 集成：kind==='scenario' 渲染 workbench；加载错误条；模板识别面板保留在 workbench 左栏底部
- 测试：tests/frontend/ScenarioWorkbench.test.tsx（7/7）、PersonalizationCenter.test.tsx（52/52，旧用例已适配 workbench）、tests/integration/PersonalizationHappyPathE2E.test.tsx（2/2）

### P3 执行打通（已验证）
- `engine/personalization/ScenarioExecutionContext.ts`（新）：把 deliverable/adaptivity/writingRules/methodPolicy 格式化为执行约束文本（含 🔒●◇、允许/不允许分组、回溯、重大调整记录要求）；测试 4/4
- `PersonalizationResolver`：场景执行上下文作为 prompt 层（sourceKind rules、precedence 450）注入对话 manifest；旧测试 8/8 通过
- `AutonomousRuntimeContract`：start 请求新增 scenarioId（专用宽松 id 校验，因 RuntimeIdSchema 不允许 `/`）
- main.ts autonomous:start：scenarioId → 读场景 → 注入执行上下文 + 场景规则 → goal 生效；运行期结构调整不反写场景（由引擎既有 decisions 机制记录）
- 自主科研控制台：新增「研究场景」下拉（真实 listPersonalization 加载；读取 localStorage 预设 `metis-autonomous-scenario-preset`）

## 三、已做但尚未验证/收尾的部分（重要！）

1. **全量 vitest 最后一次：4906 passed / 1 failed / 6 skipped** —— 唯一失败项未定位（日志：
   `C:\Users\lauze\.zcode\cli\exec\sess_1557ac77-e2f4-4b4a-a94d-ec8e0bcdb1fa\call_00_ET_MxWHtfuzhlJwP16tjhCZ1436-stdout.log`；此前 CurrentAffairsPanel 曾出现全量下的串行干扰、单跑稳定通过，疑似同类，**必须复跑确认**）。
2. **模拟器（platform-background-simulation.mjs）场景段已重写但从未运行**：
   - 新增 mock 响应（`人文社科科研场景设计师` 分支）返回完整 analysis JSON（含 deliverable/adaptivity/materials/agents/workflow/rules）
   - 场景段现在会：真实写一份 .md 材料文件 → importScenarioMaterials → 打开 AI 创建对话框 → 输入描述 → 分析 → 断言摘要 → 生成 → 断言场景/智能体/场景记忆/成果结构/自适应/参考材料落库 → 工作台选中展示（结构树/右栏编辑/自适应/规则/能力页）
   - **必须先跑通模拟器**（`./node_modules/.bin/electron.cmd scripts/platform-background-simulation.mjs`，约 5 分钟），预计会有几处选择器/时序问题要修
3. **build / 打包 / CDP 冒烟未做**（`npm run build:electron` → `npm run pack` → 用 scripts/autonomous-workspace-cdp-smoke.mjs 模式写场景页冒烟）
4. **git 未提交**（上一轮自主科研重构已提交为 d385e7a / 41add3e；本轮场景重构全部改动在工作区未提交，见下方文件清单）
5. lint 有一个**新引入的 warning 待修**：`src/components/autonomous/AutonomousWorkspacePage.tsx:140` —— startBatch 的 useCallback 缺 'method'/'output' 依赖（上一轮顶部启动条功能遗留，本轮未动它，但全仓 lint 会报）

## 四、文件清单（本轮改动）

新增：
- engine/io/DocxTextReader.ts
- engine/personalization/ScenarioExecutionContext.ts
- electron/ScenarioMaterialService.ts
- src/personalization/ScenarioWorkbench.tsx
- src/personalization/ScenarioAiCreateDialog.tsx
- src/personalization/personalizationLib.ts
- src/personalization/scenarioWorkbench.css
- tests/engine/DocxTextReader.test.ts
- tests/engine/ScenarioDeliverableContract.test.ts
- tests/engine/ScenarioExecutionContext.test.ts
- tests/electron/ScenarioMaterialService.test.ts
- tests/frontend/ScenarioWorkbench.test.tsx

修改：
- engine/runtime/PersonalizationRuntimeContract.ts（schema 扩展 + 类型导出）
- engine/runtime/AutonomousRuntimeContract.ts（scenarioId）
- engine/personalization/PersonalizationResolver.ts（执行上下文注入）
- electron/main.ts（3 个 scenario IPC + dialog + autonomous:start 注入 + import）
- electron/preload.ts（4 个 API + autonomousStart 类型）
- src/personalization/PersonalizationCenter.tsx（集成 workbench + 错误条 + 抽 lib）
- src/pages/AutonomousResearchPage.tsx（场景选择下拉）
- scripts/platform-background-simulation.mjs（场景段重写 + mock）
- tests/frontend/PersonalizationCenter.test.tsx（旧用例适配）
- tests/integration/PersonalizationHappyPathE2E.test.tsx（适配）

## 五、已知问题与风险

1. **最后一个 vitest 失败未查**（见上）
2. **模拟器场景段未跑过** —— 新代码行最多、风险最高的未验证区域（mock 响应格式、摘要页断言、生成后工作台展示）
3. 命名空间坑（已修）：personalizationLib 的 KIND_NAMESPACE 必须是 `scenarios/agents/skills`（复数），否则与存量 ID/测试冲突 —— **后续任何"新建定义"类改动都要回归 `user:agents/` 前缀测试**
4. CAS 语义（已修）：场景保存必须 `definition.revision = 当前版本 + 1`（persistDraft 已处理）；新编辑器若再写保存逻辑必须遵守
5. 本机磁盘存在秒级写延迟（历史上多次出现"写入后立刻读旧内容"），验证时对刚写的文件要等待/重读；大文件用 bash 分块写
6. 场景 select 的文案直接用了 `zh ? ... : ...`（页面内有 locale），与项目 i18n 模式不一致但可用
7. `ScenarioWorkbench` 的收藏/最近使用用 localStorage（metis-scenario-recent:v1 / favorites:v1），非持久化仓库数据，可接受

## 六、给下一位执行者的建议顺序

1. 复跑全量 vitest，定位并修复唯一失败（大概率是串行干扰类）
2. 跑模拟器全量（重点看「场景」段新检查），逐条修；模拟器报告在 `platform-simulation/platform-simulation-report.json`
3. 修 AutonomousWorkspacePage:140 的 lint warning；全仓 typecheck + lint 归零
4. `npm run build:electron` + `npm run pack`
5. 写场景页 CDP 冒烟（参考 scripts/autonomous-workspace-cdp-smoke.mjs 的结构：真实用户数据 → 场景中心 → 三栏 → 选中场景 → 结构树 → 右栏 → 自适应 → 保存）
6. git add -A && commit（建议信息：feat(scenario): deliverable structure, adaptivity, AI creation with reference materials, workbench UI）+ push
7. 对刘总出报告：对照 21 节 UI 规范 + 18 条需求逐项验收（文档存于本目录上一轮会话；关键验收点：AI 创建（描述+材料）→ 摘要 → 生成 → 结构树/自适应/能力页展示 → 保存 → 对话/自主科研受场景约束）

---

## 七、收尾执行记录（2026-08-17 完成，供报告引用）

- 全量 vitest：4907 passed / 6 skipped / 0 failed（390 文件）。修复 3 处：
  1. tests/frontend/ScenarioWorkbench.test.tsx「使用场景（当前项目）」—— 夹具场景无智能体，被新的「无智能体禁用」防护拦住，改为绑定智能体；
  2. tests/engine/PdfDownloader.test.ts —— 本机秒级写延迟下全量并行偶发「写入后立刻读旧内容」，下载后轮询等待内容落盘；
  3. tests/electron/AutonomousWorkspaceService.test.ts —— listProjects 按 updated_at 倒序，运行中项目不保证排第一，断言改为按 id 定位。
- 模拟器 platform-background-simulation.mjs：109/109 全绿，0 issue（报告在 platform-simulation/platform-simulation-report.json）。根因与修复：
  1. 上一轮 dist/dist-electron 陈旧（8/16 23:59 前构建），模拟器实际上跑老包 —— 先 npm run build:electron 再跑；
  2. ScenarioAiCreateDialog Metis.md 绑定二次保存违反 CAS（场景已存版本 1，绑定需提版本 2 否则 revision_conflict 静默失败）—— 修复为 bound.revision = saved + 1；
  3. ScenarioWorkbench 选择迟到竞态：AI 创建后 load() 异步刷新 definitions，selected 晚到但 lastSelectedId===selectedId 使草稿永远为空 —— 同步条件补 (!draft && selected && selected.id === selectedId)；
  4. 模拟器脚本时序：预生成阶段不该要求「五个分区」（选中才渲染）、生成后要等场景项出现再点选、structure-select 异步加载要等待，另修 rulesState.slice 崩溃（布尔 → 空串）。
- lint 归零：修 AutonomousWorkspacePage:140（useCallback 缺 method/output 依赖）+ 清理 3 个遗留 unused eslint-disable。
- 构建：npm run build:electron + npm run pack 成功（win-unpacked 口径）。pack 失败过一次，原因是残留的 Metis 进程锁 dxcompiler.dll，杀掉后重跑成功。
- 场景页 CDP 冒烟：新写 scripts/scenario-workbench-cdp-smoke.mjs（真实用户数据 → 场景中心三栏 → 播种结构化场景 → 选中 → 结构树/右栏/自适应/规则/能力 → 保存落库），14/14 通过，截图与报告在 test-results/scenario-workbench-smoke/。
- git：提交 feat(scenario): deliverable structure, adaptivity, AI creation with reference materials, workbench UI。
