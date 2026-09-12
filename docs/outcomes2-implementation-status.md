# Outcomes 2.0 实施状态（任务书 §33 纪律文档）

> 基线：main `127785e`（任务书编写基线 f514e5e 的后继）。执行窗口：2026-09-13 02:34 起。
> 记录规则：DONE 必须有真实实现 + 测试/回归证据；未达标一律 BLOCKED，不虚报。

## Phase 0 当前实现审计

Status: DONE

- `docs/outcomes2-current-architecture.md`：三条数据链（Outcome 数据链 / Outcome AI 数据链 / Office 链）逐文件核实，IPC 与服务均带文件:行号证据；复用清单与不动边界已记录。
- 验收：不凭文件名推测 ✓（OutcomeRepository/OutcomeAssistantService/migrations/ipc/ 均真实阅读）；记录可复用能力 ✓。

## Phase 1 数据模型与迁移

### T01.01 Outcome Working Draft Contract — DONE
- 契约 `engine/runtime/OutcomeWorkbenchContract.ts`（zod strict）+ `outcome_working_drafts` 表（SCHEMA_SQL + migration 118 双路径收敛）。
- 测试：Working Draft create/reload/version 不变（OutcomeWorkbenchService.test.ts A 组）。

### T01.02 Draft Base Version 冲突 — DONE
- `saveDraft` 在 baseVersion 落后时返回 `outcome_draft_conflict`（禁止自动覆盖）；`resolveDraftConflict` 支持 discard/keep/rebase；UI 显示冲突提示。
- 测试：conflict → force keep → discard 三步断言。

### T01.03 Outcome Snapshot — DONE
- `outcome_snapshots` 表 + createSnapshot（同 contentHash 去重；自动类保留 50 上限；manual 独立计数）。
- 测试：dedupe/retention/manual 隔离（B 组）。

### T01.04/T01.05 Revision Set / Revision Contract — DONE
- 契约含 status 六态、creator 四类、target 五种（全部携带 beforeHash）；提案输入 `OutcomeRevisionTargetInputSchema`（模型不带 beforeHash）。
- Schema 严格校验在 createRevisionSet 落实（target 缺失整组拒绝）。

### T01.06 Revision Persistence — DONE
- `outcome_revision_sets`/`outcome_revisions` 正式 versioned migration；renderer 不存 revision。
- 测试：accept 后重新读取（等价重启读库）状态持久。

### T01.07 Outcome Memory Contract — DONE
- `outcome_memory` + `outcome_memory_proposals` 表；AI 只 propose、用户确认才写；revision 并发检查。
- 测试：save/conflict/propose/accept/reject 全链（F 组）。

### T01.08 Review Issue Contract — DONE
- `outcome_review_issues` + `outcome_review_runs`；issue 携带 anchor（可定位）或显式 document-level。
- 测试：持久化/显式 resolved/draft hash 失配标 stale（G 组）。

### T01.09 Research Graph Contract — DONE
- `research_graph_nodes`/`edges`；canonical 节点必须指向真实 claim/evidence/source/outcome/artifact（`research_graph_canonical_entity_missing`）。
- 测试：canonical 校验/AI 默认 unverified/用户确认上限 supported/项目隔离（H 组）。

## Phase 2 Working Draft

- T02.01 打开读取优先级 — DONE（openForEdit + OutcomesPage.open 集成，徽标「有未保存草稿」；历史只读不触碰草稿）。
- T02.02 编辑不自动产生 Version — DONE（onChange→draft debounce；保存按钮=显式保存版本）。
- T02.03 Draft Autosave — DONE（1.2s debounce；scope 绑定 projectId+outcomeId；late response 按 scope 丢弃；写失败保留页面草稿）。
- T02.04 保存版本 — DONE（保存成功后 clearDraft + draftInfo 重置 + 新 base）。
- T02.05 手动快照 — DONE（header「创建快照」按钮）。
- T02.06 恢复快照 — DONE（restoreSnapshot 只写 Working Draft；历史 Tab 快照列表「恢复到草稿」）。

## Phase 3 Revision Engine

- T03.01 Assistant 默认走 Revision — DONE（workbench 依赖注入交互助手通道；`applied` 仅保留给自动化管线；测试 OutcomeAssistantRevisionPath 2/2：提案基于 draft、version 不变、accept 后仍不变）。
- T03.02 Revision Preview — DONE（RevisionProposalCard：before/after diff + 理由 + 来源/证据计数；不引入富文本新引擎）。
- T03.03 Accept — DONE（十步流程 + 每条 beforeHash 实时验证；服务测试覆盖）。
- T03.04 Reject — DONE（不改草稿）。
- T03.05 Accept All — DONE（按 order 逐条独立验证 + 汇总计数）。
- T03.06 Conflict — DONE（手改后 accept → `outcome_revision_stale`，用户内容不覆盖；服务测试断言）。
- T03.07 Discuss — BLOCKED（对话内对修订的再讨论通道未在本次窗口实现；提案数据保留、可后续挂接）。
- T03.08 Bulk 二次确认 — DONE（pendingCount≥3 时 confirm）。
- T03.09 Set 状态统一计算 — DONE（refreshSetStatus 在 Service；renderer 不自算）。

## Phase 4 选区浮动 AI

- T04.01 浮动栏 — 存量已有（LocalWordAssistantPopover：选择后出现/Esc 关闭/定位），本次接入提案卡。
- T04.02 润色 / T04.03 改写 / T04.04 扩写 / T04.05 压缩 — DONE（动作提示词已有且走 Office Profile slot 覆盖；现在全部产出 Revision 而非直接改写）。
- T04.06 查证 / T04.07 找引用 — BLOCKED（需要真实检索工具编排；本轮未实现独立动作，现有证据面板可查看 Claim–Evidence）。
- T04.08 AI… — 存量（右侧协作入口已有）。
- T04.09 Table Cell — DONE（cell 级修订服务测试通过；既有 popover cell 定位保留）。
- T04.10/T04.11 PPT Element/Page — 部分 DONE（ppt_page 修订路径服务已实现并有测试；ppt_element apply 已实现；PPT 浮动工具未单独建 UI）。

## Phase 5 Conversation → Revision

- T05.01/T05.02/T05.06 — 存量 DONE（scoped conversation 单元本就完整，未建第二套）。
- T05.03 Conversation Target — BLOCKED（Composer 针对性 chip 未实现）。
- T05.04 AI Answer → Revision — 部分 BLOCKED（服务端 proposed 通道已通；协作面板「生成修改建议」按钮未挂）。
- T05.05 加入成果 — BLOCKED。

## Phase 6 @Context

- T06.02 复用 OutcomeSource — 存量 DONE（未新建类型）。
- T06.01/03–07 Mention UI — BLOCKED（未在本窗口实现）。
- T06.08 Context Package — 部分 DONE（Assistant 既有 Project Context + selection 通道保持；Memory 注入见 T07.04）。

## Phase 7 Outcome Memory

- T07.01 Memory Panel — DONE（协作 Tab）。
- T07.02 手工编辑 — DONE（revision 并发检查）。
- T07.03 AI Memory Proposal — DONE（服务端 propose/accept/reject 全链 + UI 列表）。
- T07.04 Prompt 注入 — BLOCKED（Assistant prompt 组装尚未读 memory；服务与数据就绪，接线未做）。
- T07.05 长度控制 — DONE（契约层 max 条数/长度 + 提案按字段追加去重）。

## Phase 8 Review Engine

- T08.01 审查入口 — DONE（审查 Tab + 「审查成果」按钮）。
- T08.02 Review Modes — DONE（八种模式选择）。
- T08.03 Pipeline — DONE（segmentDocument 确定性分段 + role 推断 + 逐段结构化 AI + 确定性证据覆盖 + 去重 + 持久化；测试 5/5）。
- T08.04 Severity — DONE（三档定义 + 落库）。
- T08.05 Anchor — DONE（anchor 校验失败 → document-level，不伪造）。
- T08.06 Issue Actions — 部分 DONE（忽略/已解决；「与 AI 讨论」「生成修改建议」挂接 BLOCKED）。
- T08.07 Issue → Revision — 部分 DONE（数据字段 reviewIssueId 契约与通道就绪；UI 按钮未挂）。
- T08.08 Issue Resolved — DONE（只有显式 resolved/accepted 才变更；不会自动）。
- T08.09 Staleness — DONE（markStaleByDraftHash；Office sync 联动）。

## Phase 9 Research Graph 基础层

- T09.01 数据/可视化分离 — DONE（ResearchGraphService 为权威；UI 只读 projection）。
- T09.02 Canonical Entity — DONE（canonical 引用校验）。
- T09.03 AI Extracted 默认 unverified — DONE（服务+测试）。
- T09.04 Edge 规则 — DONE（AI→unverified；用户确认→user_confirmed+最高 supported；§23.9）。
- T09.05 Edge Evidence — DONE（evidenceIds/sourceIds 字段+投影展示）。
- T09.06 Dedup — DONE（canonical 相同/label 规范化候选；不做语义自动合并）。
- T09.07 Extraction Job — BLOCKED（AI 图谱抽取任务编排未实现；upsert 通道已就绪）。
- T09.08 Rebuild — DONE（projection 为确定性计算，重复调用无 LLM）。

## Phase 10 Argument Graph

- T10.01 Projection — DONE（projectArgumentGraph 分层投影；canonical claim 复用权威 store）。
- T10.02 布局 — DONE（分层 top-down 结构视图；未引入 Force Graph）。
- T10.03 Node 状态 — DONE（来自 canonical claim status/graph verification；无伪精确分数）。
- T10.04 正文→Graph 标记论断 — BLOCKED。
- T10.05 Graph→正文定位 — BLOCKED（节点无 document anchor；结构视图可看不可跳）。
- T10.06 Claim Detail — 部分 DONE（节点详情展开；上游/下游列表未做）。
- T10.07 漏洞检测 — 部分 DONE（确定性证据覆盖规则；其余 AI 检查走 Review Pipeline argument 模式）。
- T10.08 Refresh — 部分 DONE（verification hash 校验已具备；「更新论证图谱」按钮未挂）。

## Phase 11 Claim–Evidence Graph

- T11.01 权威数据 — DONE（直接读 claims/claim_evidence_links/evidence/sources，零复制）。
- T11.02/T11.03 Projection — DONE（claims/evidences/links + 计数）。
- T11.04/T11.05 Panel — DONE（证据 Tab 只读视图：snippet/来源/页码/关系）。
- T11.06 正文 Overlay — BLOCKED。
- T11.07 补证据 — BLOCKED（既有学术检索通道可复用，未接）。
- T11.08 反证优先 — 部分 DONE（contradicts 计数与展示已有；检索编排未做）。

## Phase 12 Project Knowledge Graph

- T12.01 Scope — DONE（全部 project_id 隔离）。
- T12.03/T12.04 首版节点/关系 — DONE（契约枚举按任务书首版集合）。
- T12.06 Filter — DONE（listNodes/listEdges filter + knowledge projection limit）。
- T12.07 Hidden Connection — DONE（hiddenConnections 列出 AI 推断未验证关系，含「AI 推断 · 未验证」语义）。
- T12.05 自动抽取 — BLOCKED（AI 抽取任务未编排）。
- T12.08 联动 / T12.09 Literature Projection — BLOCKED。

## Phase 13 UI 重构

- T13.01 拆分 — 部分 DONE（新增 src/outcomes/ 组件：RevisionProposalCard、OutcomeWorkbenchPanel；OutcomesPage 未大规模搬移）。
- T13.02 成果树计数 — BLOCKED。
- T13.03 Header — 存量保留 + 新增快照按钮。
- T13.04 Draft 状态 — DONE（「已自动保存草稿 HH:MM:SS」内联状态，无成功 Toast）。
- T13.05 右侧 Tabs — DONE（五 Tab，偏好按 outcome 持久化；以面板形式置于版本面板上方）。
- T13.06 协作 Tab — DONE（当前对话沿用既有面板 + 成果记忆；任务线程列表沿用既有）。
- T13.07 论证 Tab — DONE（结构视图；全屏展开 BLOCKED）。
- T13.08 审查 Tab — DONE（severity 汇总 + 列表；非仪表盘）。
- T13.09 证据 Tab — DONE（全篇覆盖视角；选区联动 BLOCKED）。
- T13.10 历史 Tab — DONE（修订建议/快照分组；正式版本在版本面板）。
- T13.11 Revision Inline — 部分 DONE（提案卡 diff；正文 gutter marker BLOCKED）。
- T13.12 Empty State — 存量 DONE。
- T13.13 Responsive — BLOCKED（未做新断言；面板可折叠）。

## Phase 14 METIS Office Bridge

- T14.01 文案 — 存量 DONE（「Metis Office 原生编辑」）。
- T14.02 打开前 Draft 处理 — DONE（有草稿时确认对话框：保存为新版本并打开 / 取消保留草稿）。
- T14.03 Office Sync 对账 — DONE（sync 后 draft baseVersion 对账 + revision 逐条 hash 检查 + review issue stale）。
- T14.04 Stale Revision — DONE（标记 + 提案卡 stale 文案「基于旧内容，不能直接应用」）。
- T14.05 格式变更不污染 Revision — DONE（Office sync 走版本体系 actor/import，不生成 Revision）。

## Phase 15 AI Runtime

- T15.03 Revision Model Response — DONE（模型只给 target+after；Runtime 读 before+算 hash+验证）。
- T15.04 Review Model Response — DONE（strict schema + Service 校验 anchor/category/severity）。
- T15.05 Graph Model Response — 部分 DONE（candidate 通道 upsert 即校验；抽取编排 BLOCKED）。
- T15.01/T15.02/T15.06 — 部分（既有 Assistant 组合保持；Memory 注入与 @Context budget BLOCKED；查证/找引用工具编排 BLOCKED）。

## Phase 16 兼容迁移

- T16.01 旧 Outcome — DONE（无 draft 时 openForEdit 从 currentVersion 初始化；无 destructive migration；drift 由既有 fresh-vs-upgraded 机制覆盖）。
- T16.02 旧 AI Versions — DONE（原样保留，未反推 Revision）。
- T16.03 旧 Conversations — DONE（scoped conversations 原样）。
- T16.04 VersionPanel — DONE（仍在版本面板，语义=历史→正式版本）。
- T16.05 旧 Office Sessions — DONE（未触碰）。

## Phase 17 Race

- T17.01 Revision Race — DONE（beforeHash 验证；测试）。
- T17.02 Save Version Race — 存量 DONE（outcome_version_conflict）。
- T17.03 Draft Autosave Race — DONE（scope+generation：draftScopeRef 丢弃 late response）。
- T17.04/T17.05 Project/Outcome Switch — DONE（打开/切换时重置 draft 状态与 scope；late 保存被 scope 检查拦截）。
- T17.06 Review Race — DONE（run 绑定 baseDraftHash；失配 stale）。
- T17.07 Graph Extraction Race — N/A（抽取未编排；upsert 即时校验 scope）。

## Phase 18 性能

- T18.01–T18.05 — BLOCKED（未做专项长文/千级修订/大图谱性能压测；实现层面已有节制：快照上限、分段上限 12、projection limit 500、debounce）。

## 数据可信规则（§23）落实

- §23.1/2/9/12 DONE（契约默认值+服务强制+UI 徽标：AI extracted/unverified、user confirmed≠verified）。
- §23.4/5/6 DONE（Claim–Evidence 投影直接读权威表；evidence 外键 source；citation 通道沿用既有）。
- §23.10 DONE（审查界面固定提示「生成的是审查意见（判断），不是事实结论」）。
- §23.11 DONE（Memory 用户编辑 revision 优先；AI 提议需确认）。
- §23.3（外部 Chatbot 引用≠证据）由 Topic Chatbot 侧 ExternalReference 契约保证（独立表 external_references，永不进证据链）。
- §23.7/8 部分（Revision sourceRefs 字段存在；无 evidence 的边不显示 verified——服务层 confirmEdge 上限 supported）。

## 工程命令证据（截至本状态）

- `npm run typecheck` 四工程 0 错误（多次运行）。
- `npx vitest run tests/electron/OutcomeWorkbenchService.test.ts` 19/19；`OutcomeReviewPipeline.test.ts` 5/5；`OutcomeAssistantRevisionPath.test.ts` 2/2；`OutcomeAssistantService.test.ts` 15/15（回归）；`tests/frontend/OutcomesPage.test.tsx` 72/72（回归）。
- 待办：全量 vitest + build:electron 收尾（见最终报告）。

## 明确 BLOCKED 汇总（P1/P0 未竟事项）

1. T03.07/T05.03/T05.04/T05.05 对话↔修订闭环 UI。
2. T04.06/T04.07/T11.07/T11.08 查证/找引用/补证据的检索工具编排。
3. T06 @Context Mention UI 与 context budget 组装。
4. T07.04 Memory 注入 Assistant prompt（数据+服务就绪，接线未做）。
5. T09.07/T12.05 Graph AI 抽取任务编排；T10.04/T10.05 图谱↔正文互定位；T11.06 overlay。
6. T13.02/13.13 树计数与响应式专项；T13.01 深度拆分。
8. T18 性能专项。
