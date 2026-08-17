# 场景模块重构 —— 验收报告（对照 21 节 UI 规范 + 18 条功能需求）

> 日期：2026-08-17
> 分支：release/personalization-alpha2（commit 6c75edd）
> 范围：场景定义升级 · AI 创建场景 · 场景驱动执行 · 场景/项目分离 · 三栏工作台 UI
> 证据：全量 vitest 4907/4907 · 真实 Electron 模拟器 109/109 · 打包后 CDP 冒烟 14/14

---

## 一、核心需求一句话验收

> **用户不需要理解 Agent/Workflow 等底层概念也能创建和使用场景；同时完整能力（成果结构、自适应、智能体、技能、MCP、Metis.md、工作流）可见可配置；场景必须真正驱动执行。**

| 验收点 | 结论 | 证据 |
|---|---|---|
| 只写自然语言 + 任意参考材料即可创建场景 | ✅ | 模拟器「AI 创建」段：材料导入 → 分析摘要 → 生成全通；CDP 冒烟播种/选中/展示全通 |
| 完整能力可见可配置（结构/自适应/智能体/技能/MCP/Metis.md/工作流） | ✅ | 五分区工作台（总览/成果结构/规则与方法/自适应/能力与运行）+ 右栏上下文编辑 |
| 场景真正驱动执行（对话 + 自主科研受约束） | ✅ | PersonalizationResolver 注入执行上下文（precedence 450）；autonomous:start 带 scenarioId → 注入场景规则；模拟器自主科研段全绿 |

---

## 二、18 条功能需求逐项对照

| # | 需求要点 | 落地 | 验证 |
|---|---|---|---|
| 1 | 场景描述最终成果类型（17 种） | DeliverableSpec.type + typeLabel | ScenarioDeliverableContract.test 7/7；模拟器 theory_paper 落库 |
| 2 | 成果由部分（题目/摘要/关键词/章节/申报栏目/附件…）组成 | DeliverableSectionSchema 递归树（kind 9 类） | 结构树直展 7 行（锁 2 / 条件 1） |
| 3 | 每部分怎么写（作用/必须包含/禁止/篇幅/方法/证据） | sections 字段 purpose/requirements/forbidden/lengthTarget/method/evidence | 右栏上下文编辑器逐节编辑；CDP 冒烟「修改章节要求并保存落库」通过 |
| 4 | 部分状态：锁定/必须/可选/条件 | status + condition（条件必须有 condition 字段，superRefine 校验） | 结构树锁定不可删、状态图标；测试 7/7 |
| 5 | 结构策略（默认/建议最小/建议最大章节） | structurePolicy + globalLength/language/journalTier | 模拟器断言 structurePolicy 落库 |
| 6 | 采用什么方法（推荐/允许/条件/禁止） | MethodPolicySchema 四组 | 规则与方法页四组展示；模拟器断言「概念分析」推荐 |
| 7 | AI 可自主调整成果结构 | adaptivity.structure（增删拆并移调长度） | 自适应页三组开关（结构/内容/方法），模拟器 checked=11 |
| 8 | 可调整研究问题/假设/理论框架 | adaptivity.content | 自适应页/草案/保存测试 7/7 |
| 9 | 章节数范围（重大调整触发条件） | structurePolicy.suggestedMin/Max + majorAdjustmentTriggers | 模拟器断言 triggers 两条落库展示 |
| 10 | 研究过程可回溯（不要求严格线性） | allowedBacktracks | 模拟器 analysis->literature 展示通过 |
| 11 | AI 创建场景：描述 + 可选材料上传 | 材料导入（txt/md/docx/pdf）→ buildAnalysisPrompts → 摘要 → 生成 | 模拟器分析摘要 + 生成全通 |
| 12 | 「AI 已理解该场景」摘要 | summary（成果类型/结构/硬规则/写作原则/方法/可调整/推荐能力/学习来源） | 模拟器断言摘要含成果类型 + 材料来源 |
| 13 | 参考材料任意（模板/范文/论文/教材/方法书/投稿指南/政策） | ReferenceMaterialSchema + Insights（structure/writing/method/hard） | 模拟器断言材料绑定 + insights 落库 |
| 14 | 场景驱动协同对话 | PersonalizationResolver 场景执行上下文注入（sourceKind rules, precedence 450） | 旧测试 8/8 通过 |
| 15 | 场景驱动自主科研 | AutonomousRuntimeContract.scenarioId → main.ts 注入执行上下文 + 场景规则 | 模拟器自主科研段全绿（场景预选下拉 + 目标驱动） |
| 16 | 场景与项目分离 | 运行期结构调整仅走 research_decisions，不反写场景 | 代码路径：autonomous runner 只读场景 |
| 17 | 场景可保存（CAS） | 保存提交版本 = 当前 + 1；persistDraft + AI 创建二次保存均遵守（本轮修复 AI 创建绑定 CAS） | CDP 冒烟保存落库 persisted=true；测试 52/52 |
| 18 | 场景库（全部/最近/收藏/分类/我的） | 左栏分类树 + localStorage 最近/收藏 | 模拟器 libraryViews=8；PersonalizationCenter 52/52 |

---

## 三、21 节 UI 规范对照

| 规范要点 | 落地 | 证据 |
|---|---|---|
| 简单入口 + 分层展开 | 顶部导航「场景」→ 三栏工作台；AI 创建一步入口 | 模拟器/CDP 冒烟导航段 |
| 上下文编辑（右栏） | 点章节 → 右栏编辑该部分全部规则；底部 AI 帮我配置 | 模拟器/CDP 冒烟「点击章节 → 右栏上下文编辑器」 |
| 三栏 15%/58%/27% | .sw-layout：左库 / 中详情 / 右上下文 | 工作台组件（ScenarioWorkbench.tsx） |
| 保留 Metis 视觉风格（白/浅灰、深蓝、细边框、高密度） | scenarioWorkbench.css 沿用 design tokens | 截图 scenario-workbench.png 等 |
| 解决中央大面积空白 | 选中场景前中央空态提示占位；选中后五分区直展 | 模拟器断言 empty→选中后五分区 |
| 五分区一级导航（总览/成果结构/规则与方法/自适应/能力与运行） | sw-tabs 五个 tab | 模拟器/CDP 冒烟「选中后五个一级分区就位」 |
| 结构树锁定/条件标识 | 锁定、状态图标（status-locked/conditional 类） | 模拟器 treeState locked=2 conditional=1 |
| 使用此场景三选项（当前项目/新项目/自主科研） | sw-use 菜单三项 | ScenarioWorkbench.test「使用场景触发激活回调」 |
| 无智能体/歧义路由禁用并提示 | useBlocked + title | 测试通过（本轮修夹具绑定智能体） |
| 能力页绑定 + 工作流编辑 + 自动依赖 | bindingList 四组 + workflow 增删移/agent 选择/dependsOn 自动 | 模拟器 agents=1 workflow=3 advanced=true |
| 右栏 AI 补全（scenario:aiRefine） | AiRefineBox → refineScenarioConfig（section/writingRules/methodPolicy/adaptivity） | ScenarioWorkbench.test「AI 精简」 |
| 加载错误条 / 模板识别面板 | PersonalizationCenter 加载错误条 + 左栏底部模板面板 | PersonalizationCenter 52/52 + 模拟器模板识别段 |
| 无横向滚动 / 无控制台错误 | 1400/1100/1000px 三段布局检查 | 模拟器布局段 3/3 + 稳定性段 |

---

## 四、质量门禁与回归证据

| 门禁 | 结果 |
|---|---|
| 全量 vitest | **4907 passed / 6 skipped / 0 failed**（本轮修复 3 个：使用场景夹具、PdfDownloader 磁盘延迟、AutonomousWorkspace buildOverview 排序断言） |
| 全仓 lint | **0 errors / 0 warnings**（修 AutonomousWorkspacePage:140 deps + 3 个遗留 unused-disable） |
| 全仓 typecheck（4 个 tsconfig） | **0 errors** |
| 真实 Electron 模拟器 | **109/109 PASS，0 issue**（platform-simulation/platform-simulation-report.json） |
| 打包 | win-unpacked 构建成功（release/win-unpacked） |
| 打包后 CDP 冒烟（真实用户数据） | **14/14 PASS**（test-results/scenario-workbench-smoke/，截图 6 张） |

### 本轮修复清单（从交接点至今）
1. **AI 创建 Metis.md 绑定 CAS 失败**（revision_conflict 静默失败 → rulesIds 永不绑定）：ScenarioAiCreateDialog 二次保存提版本 +1。模拟器断言 rulesIds 落库通过。
2. **AI 创建后工作台草稿永远为空**（definitions 异步刷新，selected 迟到）：ScenarioWorkbench 同步条件补 (!draft && selected && selected.id === selectedId)。
3. **模拟器跑的是陈旧构建**：先 build:electron 再跑（dist/dist-electron 落后于源码）。
4. 模拟器脚本时序/容错：预生成不要求五分区、生成后等待场景项、structure-select 等待、rulesState 布尔崩溃。
5. lint/typecheck 归零；2 个全量下 flaky 测试加固。

---

## 五、遗留说明（非阻塞）

- 场景 select 文案用 zh 三元（页面内 locale），与项目 i18n 模式不一致：可用，后续可迁移（交接文档 §五.6）。
- 收藏/最近使用走 localStorage（metis-scenario-recent:v1 / favorites:v1）：接受（§五.7）。
- 运行期结构调整不反写场景，走 research_decisions：合规（§一.4）。
- GitHub Dependabot 2 条 high 漏洞提醒：与本次改动无关（push 时远端提示）。
