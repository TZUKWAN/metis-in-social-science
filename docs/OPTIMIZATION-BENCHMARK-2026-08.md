# METIS 优化清单（基于开源对标调研 + 真实代码核查）

> 生成时间：2026-08-11
> 方法：① 四路并行真实检索 GitHub 同类项目（AI 客户端 / 文献管理 / 本地知识库 / 生产力平台）→ ② 只读核查 METIS 现有代码逐项对照 → ③ 交叉过滤出"真缺口"并排序。
> 原则：每条都标注【对标项目(含 URL)】+【METIS 现状(含文件:行证据)】+【缺口】+【收益】+【复杂度】。已实现的不列；对标但不适配 METIS 定位的明确标"暂缓"。
> 结论先行：METIS 的定位（Electron 本地优先研究工作台 + 目标引擎）在所调研项目中**独特，无完全等价对手**，最贴近的对标是 mission-control（完成判定/控制层）+ Reor（Electron 笔记/RAG）+ PaperLib（文献流水线）的组合。

---

## 对标项目速查（带可验证 URL）

| 类别 | 项目 | URL | 对 METIS 最有价值的点 |
|---|---|---|---|
| AI 客户端 | Cherry Studio | https://github.com/CherryHQ/cherry-studio | 多模型同会话对比、WebDAV 备份、GUI 化 provider 配置 |
| AI 客户端 | LobeChat | https://github.com/lobehub/lobe-chat | 白盒可编辑记忆、Pages 共享上下文 |
| AI 客户端 | AnythingLLM | https://github.com/Mintplex-Labs/anything-llm | source citations 引用回链、Agent Flows 可视化、per-workspace 配置 |
| 文献 | Zotero | https://github.com/zotero/zotero | 三级 fallback + 可解释提示文案、Create Parent Item 反查 |
| 文献 | PaperLib | https://github.com/Future-Scholars/paperlib | 抓取器可组合+可排序、CTRL+E 补标识符重匹配、paper-locate 多 downloader |
| 文献 | JabRef | https://github.com/JabRef/jabref | Unpaywall 优先、5 个一组批量节流、Event Log 透明化 |
| 文献 | Sioyek | https://github.com/ahrm/sioyek | Smart Jump 引用跳转、Portals 多窗联动 |
| 笔记/RAG | Reor | https://github.com/reorproject/reor | 单目录 vault、note 自动 chunk+embed、侧边栏 related notes（同 Electron 技术栈） |
| 笔记/RAG | Logseq | https://github.com/logseq/logseq | 本地 markdown + 测试中 SQLite 版、图谱视图 |
| Agent | mission-control | https://github.com/MeisnerDan/mission-control | **acceptanceCriteria + 强制 verify + 3 次循环检测 + retry/skip/stop** |
| Agent | Plandex | https://github.com/plandex-ai/plandex | plan 版本控制 + sandbox 隔离 + rollback |
| 生产力 | Plane | https://github.com/makeplane/plane | Power K 命令面板（导航/搜索/创建/修改四合一 + G/O/N 模式语言） |
| 生产力 | AppFlowy | https://github.com/AppFlowy-IO/AppFlowy | Workspace→Folder→Page→View 清晰四层、同库多视图 |
| 生产力 | Excalidraw | https://github.com/excalidraw/excalidraw | 空状态即引导（WelcomeScreen 自动消失） |
| 生产力 | tldraw | https://github.com/tldraw/tldraw | 引导即内容（Welcome 文件可编辑可删，删除即"完成"） |

> star 数与细节见各 agent 调研报告（已落库）。防"假完成"对标最关键的是 mission-control。

---

## 优化条目（按【体验收益 × 定位契合度 ÷ 复杂度】排序）

### 第一批 · 高收益 / 中低复杂度 / 强契合（建议优先执行）

#### O1 接通已写好但未挂载的 CommandBar（命令面板升级）
- **对标**：Plane Power K（导航/搜索/创建/修改四合一）
- **METIS 现状（已核查）**：`src/shell/CommandBar.tsx:1-84` 是一个**功能完整的命令面板组件**（fuzzy 匹配、分组、↑↓ Enter ESC 全键盘导航），但 `ProjectShell.commandBar?` prop（`ProjectShell.tsx:84`）**无任何调用方传入**，`App.tsx:698` 渲染时未传 → 实为孤儿。当前 Ctrl/Cmd+K 只打开 `GlobalSearch`（`App.tsx:505`），仅搜索论文/笔记/实验/页面，不能新建/执行命令。
- **缺口**：键盘党与多工作区用户切换成本高；7 个顶栏工作区 + 多项目无法快速跳转/新建。
- **动作**：把 CommandBar 接到 Ctrl/Cmd+K（或新增 Cmd+Shift+P），注册命令：切工作区 / 切项目 / 新建会话·项目·笔记 / 打开最近文献 / 跳设置；保留 GlobalSearch 作为命令之一。
- **收益**：高（缓解顶栏 7 工作区切换焦虑）；**复杂度**：低（组件已存在，只差注册命令与挂载）；**契合度**：强。

#### O2 采集元数据多源 fallback 链 + 可解释提示（直接打 METIS 既有痛点）
- **对标**：Zotero 三级 fallback（站点适配→Embedded Metadata→Save as Webpage，每级给中文提示）；PaperLib 抓取器可组合+可排序
- **METIS 现状（已核查）**：浏览器一键采集 `BrowserService.ts:317-357 collect()` 的 `extractMeta()`(459-502) **只读页面 meta 标签**（citation_/og:），失败即返回空；`doi = meta.doi ?? detectDoi(text) ?? detectDoi(url)`，无 CrossRef/arXiv 反查、无降级提示。**但同一仓库的 `engine/research/WebImport.ts:199-215 importFromUrl` 已实现"meta → 若有 DOI 查 CrossRef（getWorkByDoi）回退 meta"的多源链**——只是采集路径没复用它。
- **缺口**：刘总反馈的"我的文献那里 DOI 也没有"——采集某些页只能拿到题录，用户困惑（F9 只是加了提示文案，根因未除）。
- **动作**：让 `collect()` 复用 `WebImport` 的多源逻辑；抓不到 DOI 时自动用标题查 CrossRef/Semantic Scholar 补全；采集成"网页条目"时在 inspector 标注来源等级（完整/仅题录/网页）并给"补 DOI 重匹配"入口（联动 O5）。
- **收益**：高（直击用户原话痛点）；**复杂度**：中（核心逻辑 WebImport 已有，主要是接线路径 + UI 来源标注）；**契合度**：强。

#### O3 PDF 下载多源 fallback + Unpaywall 集成
- **对标**：JabRef（Unpaywall 优先 + 5 个一组批量节流）、PaperLib paper-locate（多 downloader 逐个尝试）
- **METIS 现状（已核查）**：元数据侧已多源解析 openAccessPdf（`DoiResolver.ts:121-151` Semantic Scholar、`ArxivResolver.ts:80`、`OpenAlexClient.ts:153`），**但实际下载 `main.ts:4695-4720 paper:downloadPdf` 只读 `paper.pdfUrl` 一个 URL，失败即报错**；`PdfDownloader.ts:66-82` 单 url 无重试；**全仓 `grep unpaywall` 零命中**。
- **缺口**：刘总反馈的"下载显示应用来源不正确"（F5 已修防盗链标题，但下载源单一，单源失败就彻底失败）。
- **动作**：① 集成 Unpaywall（用 DOI 查开放 PDF，最稳合法源，绕开大部分防盗链）；② 下载器改造为"候选 URL 列表逐个尝试"（arXiv → Unpaywall → Semantic Scholar openAccessPdf → 原页面 pdfUrl）；③ 失败时在 Event/下载面板透明化每个源的尝试结果（JabRef 式透明日志）。
- **收益**：高（下载成功率显著提升）；**复杂度**：中（Unpaywall API 简单 `https://api.unpaywall.org/v2/{doi}?email=`，需新增 client + 改下载器循环）；**契合度**：强。

#### O4 采集后"补标识符重匹配"入口
- **对标**：PaperLib CTRL/CMD+E 补 title/arxiv_id/doi 任意一个即可重新匹配
- **METIS 现状（已核查）**：`ResearchInspectorPanels.tsx:522-552` source 详情是**只读 DefinitionRow**，无 DOI/标题编辑控件；`import_by_doi` 仅作为工具调用演示标签存在，无 GUI 重匹配按钮。
- **缺口**：抓不全时用户没有自救路径，只能删了重抓。
- **动作**：在文献详情/inspector 加"补全元数据"按钮：让用户输入 DOI 或标题或 arXiv ID → 调用已有 `DoiResolver`/`ArxivResolver`/CrossRef 反查 → 回填字段并提示匹配结果。
- **收益**：中高（把死路变活路）；**复杂度**：低（resolver 全部已有，加 UI + 调用）；**契合度**：强。

#### O5 每个工作区补"空状态即引导"
- **对标**：Excalidraw WelcomeScreen（空时引导，一动就消失）；tldraw/AFFiNE 引导即内容（示例文件可删）
- **METIS 现状（已核查）**：ChatPage/NotesPage/ExperimentsPage/GoalPage 有简单"暂无"文案（深度不一），TaskBoardPage 仅空列提示，BrowserPage/LaTeX/写作工作区无专门空状态引导。
- **缺口**：新手进每个空工作区不知"第一步做什么"。
- **动作**：为每个工作区空状态设计一句话价值主张 + 主 CTA（如对话页："粘贴摘要让 AI 解读"、文献页："拖入 PDF 或粘贴 DOI 开始采集"、写作页："新建项目从大纲开始"）；可选叠加一份预置示例项目（O10）。
- **收益**：中高（留存）；**复杂度**：低（纯 UI + 文案）；**契合度**：强。

---

### 第二批 · 中高收益 / 中复杂度（产品价值大，下一迭代做）

#### O6 目标引擎 acceptanceCriteria + 客观验证器（防"假完成"根因加固）
- **对标**：mission-control（`acceptanceCriteria: string[]` + 强制 `pnpm verify` 全过才算 done）、Plandex（build/lint/test 自动 debug）
- **METIS 现状（已核查）**：`GoalPlanner.ts:10-20 interface Goal` **无 acceptanceCriteria 字段**；`WorkflowStep`（workflow/types.ts:22-40）仅 `evalGates?: string[]`（命名 gate，非客观验证器）；完成判定完全靠 `agentResult.finalVerified`（LLM 自评布尔）。F1 只加了"拒答话术识别"，仍属 LLM 自评范畴。
- **缺口**：业界防假完成的标准答案（A 派）是"客观可执行验证器"——METIS 还没做。
- **动作**：① 给 Goal/WorkflowStep 加 `acceptanceCriteria?: string[]` 字段（planner 生成时输出）；② 按步骤类型绑定客观验证器：文档类=文件存在+内容校验、检索类=结果非空+引用真实、对话类=输出非拒答+二次校验可选；③ 验证不过不算 completed，触发重试。
- **收益**：高（直击刚修的假完成，从根上堵）；**复杂度**：中高（数据结构 + planner 提示词 + 验证器框架 + 持久化迁移）；**契合度**：强（这是 METIS 区别于 ChatBox 之辈的核心差异点）。

#### O7 工作流失败循环检测 + retry/skip/stop 人工决策
- **对标**：mission-control（3 次失败升级为 decision：retry differently / skip / stop）
- **METIS 现状（已核查）**：失败靠 maxTurns 上限兜底（F3 已 3→6），无"连续失败升级人工决策"机制。
- **动作**：记录每步连续失败次数，达阈值（如 3）时暂停执行并在 GoalPage 弹出决策卡：重试（换提示）/跳过（标记 skipped）/停止（终止目标）；决策记入 memory 供复盘。
- **收益**：中高（把失控的自动循环变成可控）；**复杂度**：中；**契合度**：强。

#### O8 AI 回答的来源引用/回链（citation，片段级）
- **对标**：AnythingLLM source citations、PrivateGPT Retrieval with citations、JabRef Event Log 透明化
- **METIS 现状（已核查）**：`ChatPage.tsx:61-75 ChatMessage` 无 sourceRefs/citations 字段；`linkifyDois`(299-309) 只把裸 DOI 变 doi.org 链接，点 DOI 命中本地库则打开该 paper——**只到"文献级"，无"片段/页码级回链"**。结构化 provenance 仅存在于 Artifact 流水线（`ArtifactManifest.ts`），没挂到 ChatMessage。
- **缺口**：研究工作台里 AI 说了结论却点不到出处片段，可信度打折。
- **动作**：ChatMessage 增 citations 字段（paperId + locator 页码/片段 + 原文摘录）；AI 工具调用返回结构化引用时回填；渲染时点击跳到 PdfReader 对应位置（联动 O9）。
- **收益**：高（研究场景刚需）；**复杂度**：中高（涉及 agent 工具输出协议 + 消息模型 + PDF 锚点）；**契合度**：强。

#### O9 PDF 阅读器引用跳转（Smart Jump）
- **对标**：Sioyek Smart Jump（无内嵌链接也能点引用号跳参考文献再跳回）、Portals 多窗联动
- **METIS 现状（已核查）**：`PdfReaderPage.tsx` 仅有页码/搜索/翻页/TOC 导航，**无 reference list 解析、无点 [1] 跳参考文献、无 back 回跳**。
- **动作**：解析参考文献区（启发式定位 + DOI/标题抽取），点正文 [n] 跳到参考文献条目，再点跳到该条目的 PDF（若库内有）或开 doi.org；维护跳转栈支持 back。
- **收益**：中高（论文阅读效率硬需求）；**复杂度**：中高（PDF 解析 + 锚点匹配，Sioyek 是 C++ 实现，移植到 Web 需评估 pdf.js 能力边界）；**契合度**：强，但建议先做 O8 再做 O9，二者协同。

#### O10 预置示例项目/示例内容（引导即内容）
- **对标**：tldraw Issue #9143（Welcome 文件可编辑可删）、AFFiNE 默认 welcome page
- **METIS 现状（已核查）**：首启只配 provider + 功能 Tour，**无任何 seed 数据**。
- **缺口**：新手配完 provider 进来一片空，Tour 看完仍不知"真实项目长什么样"。
- **动作**：首启成功后预置 1 个"示例研究项目"（含示例文献 2-3 篇、示例笔记、示例对话、示例目标），用户可整体删除（删除即"完成 onboarding"的天然标记）。
- **收益**：中（留存）；**复杂度**：中（需造样例数据 + seed 流程 + i18n）；**契合度**：强，但需注意与"本地优先、不预填隐私数据"理念一致（示例是公开论文）。

#### O11 顶栏工作区定位说明（tooltip）
- **对标**：Plane Power K（每个动作可预测）、AFFiNE/Logseq 清晰层级
- **METIS 现状（已核查）**：`App.tsx:783-848` 各 nav 按钮 `title` 与文字完全相同（重复）；`navConfig.ts:14-41 NavItem` 只有 labelKey，无 description 字段。
- **动作**：NavItem 加 descriptionKey，hover 显示一句话定位（如"对话：与 AI 多轮探讨""自主科研：AI 拆解目标并执行""浏览器：采集文献与下载 PDF"），降低"7 个模式我该用哪个"焦虑。
- **收益**：中（新手认知成本）；**复杂度**：极低；**契合度**：强。

#### O12 AI 自动记忆白盒化
- **对标**：LobeChat 白盒可编辑记忆、AnythingLLM User Managed Memories
- **METIS 现状（已核查）**：手写记忆可编辑（`SettingsProjectMemorySection.tsx` 共享 CLAUDE_MEMORY.md + 每项目 Metis.md），**但引擎自动记录的 key_decision/preference（`MemoryManager.ts:61-91`）无 UI 暴露**——main.ts 只消费 flashcard/autonomous_checkpoint，key_decision/preference 写进去就再也看不见。
- **动作**：在设置/项目侧加"AI 记住了什么"面板，列出自动记忆条目，支持查看/编辑/删除。
- **收益**：中（信任感）；**复杂度**：中（需加 IPC + 查询 + UI）；**契合度**：强（本地优先就该白盒）。

---

### 第三批 · 高价值但高复杂度 / 需产品决策（建议先做技术预研与原型）

#### O13 per-project provider/model 选择
- **对标**：AnythingLLM per-workspace agent 配置、Cherry Studio 多 provider 管理
- **METIS 现状（已核查）**：provider/model **全局**（`ProviderProfilesSection.tsx:199-236`、`ProviderProfileContract` 无 projectId）；项目只能挂规则/记忆（`WorkspaceAgentsManager`、`ProjectMetisRulesBridge`），不能挂不同模型。
- **决策点**：是否允许每个项目指定不同模型/系统提示？这会显著增强灵活性但也增加配置复杂度。需刘总定夺定位（轻量单模型 vs 灵活多模型）。
- **动作（若批准）**：项目设置加"覆盖全局模型"开关；goal/run 记录绑定 provider_profile。
- **收益**：中；**复杂度**：中高；**契合度**：待定。

#### O14 工作流/目标 rollback（恢复已有但未用的 checkpoint）
- **对标**：Plandex（plan 版本控制 + rollback）、mission-control（Decisions Queue）
- **METIS 现状（已核查）**：checkpoint **有写入**（`PersistenceStore.ts:544-562`、`ResearchRepository.ts:1129-1148`），但 `WorkflowEngine.ts:269` 和 `GoalEngine.ts:208,275` **硬编码 `resumeFromCheckpoint: false`**——数据存了从不用。
- **动作**：把 resumeFromCheckpoint 改为可配置，GoalPage 加"回滚到某步"操作；先做最小可用（回到上一个 checkpoint），再迭代。
- **收益**：中（容错）；**复杂度**：中（数据已在，主要是状态机恢复逻辑 + UI）；**契合度**：中。

#### O15 多模型同会话对比
- **对标**：Cherry Studio（同会话多模型并排）、LobeChat（同会话切模型）
- **METIS 现状（已核查）**：`ComparisonMatrixPage` 是文献结构化对比，与模型无关；ChatMessage 无 model 字段；无并排/并行调用。
- **决策点**：研究者常需横向对比模型回答质量，是研究工作台的合理需求，但与"本地优先单 provider"的简洁定位有张力。
- **动作（若批准）**：ChatMessage 加 model 标签；发送时可勾选多个 profile 并排生成。
- **收益**：中；**复杂度**：中高；**契合度**：待定。

#### O16 消息分支/fork
- **对标**：LobeChat（从任意消息 fork 探索不同思路）、ChatBox
- **METIS 现状（已核查）**：ChatMessage 无 parentMessageId/siblings；聊天纯线性（仅 Artifact 有版本分支）。
- **动作（若批准）**：消息模型加分支字段，支持"从这条消息重新生成另一条分支"。
- **收益**：中（探索式研究）；**复杂度**：高（数据模型 + UI 树形导航）；**契合度**：中。

#### O17 工作流可视化节点编辑器
- **对标**：AnythingLLM Agent Flows（Web Scraper/API/Read/Write File 节点）、AutoGPT（drag/connect/branch/inspect）、AFFiNE 同源多视图
- **METIS 现状（已核查）**：仅 `StrategyEditor.tsx` 线性列表式选阶段顺序，**无 DAG 节点拖拽**。
- **决策点**：METIS 当前是"AI 自动拆解目标"，可视化手编 DAG 是否偏离"自主科研"定位？需刘总定夺是否要给用户手动编排工作流的能力。
- **动作（若批准）**：引入轻量 graph 库（如 reactflow），把 WorkflowStep 渲染为节点，支持拖拽连线 + inspect 每步。
- **收益**：中（高级用户控制力）；**复杂度**：高；**契合度**：待定。

---

### 暂缓 / 需特别权衡（对标有但不一定适合 METIS）

#### O18 跨端云同步
- **对标**：Cherry Studio WebDAV、Logseq 测试中 RTC、Jan Data Folder
- **METIS 现状**：有 JSON 备份导出/导入（`SettingsBackupSection.tsx`），无自动云同步。
- **权衡**：METIS 卖点是"本地优先 + 隐私"，自动云同步与定位有张力。建议**只做可选的 WebDAV/本地目录同步**（用户自托管，数据不出用户掌控），不做官方云。需刘总定夺。

---

## 推荐执行批次

| 批次 | 条目 | 主题 | 工作量预估 | 理由 |
|---|---|---|---|---|
| **第一批（立即可做）** | O1 O2 O3 O4 O5 O11 | 命令面板接通、文献采集/下载多源、补标识符、空状态引导、工作区 tooltip | 中 | 全部直击既有痛点或已写好未接线代码，收益高复杂度低，1-2 周可交付 |
| **第二批（核心差异化）** | O6 O7 O8 O9 O10 O12 | 目标引擎客观验证器、循环检测、引用回链、PDF 跳转、示例项目、记忆白盒 | 中高 | 巩固 METIS 区别于普通 AI 客户端的核心（可靠的目标引擎 + 研究级引用），3-5 周 |
| **第三批（需产品决策）** | O13 O14 O15 O16 O17 | per-project 模型、rollback、多模型对比、消息分支、可视化编辑器 | 高 | 涉及定位取舍，建议每项先出技术预研 + 原型再决定是否全量 |
| **暂缓** | O18 | 跨端云同步 | — | 与本地优先隐私定位有张力，需刘总定方向 |

---

## 与 F1-F9 的衔接说明

- **O2 / O3 / O4** 是 F5（下载标题）/ F9（文献元数据提示）的**根因深化**：F 系列修的是症状（提示文案、单点修复），O 系列从架构层补多源 fallback。
- **O6 / O7** 是 F1（假完成门禁）/ F3（maxTurns）的**根因深化**：F 系列靠 LLM 自评 + 拒答识别 + 轮次兜底，O 系列引入客观验证器 + 人工决策，从"自评"升级到"他评"。
- 第一批做完，METIS 在文献采集/下载/导航/onboarding 上即可达到 PaperLib + JabRef 的体验水准；第二批做完，目标引擎可靠性将超越 mission-control 之外的大多数开源同类。
