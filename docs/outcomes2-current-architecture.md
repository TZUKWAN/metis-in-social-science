# METIS Outcomes 当前架构审计（Phase 0，2026-09-13）

> 基线：`main` HEAD `127785e`（任务书编写时 `f514e5e`，执行前 `git fetch` 确认 127785e 为最新）。
> 审计方式：逐文件真实阅读（非文件名推测），关键 IPC/调用链均有文件:行号证据。

## 1. 现有文件清单与规模

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/pages/OutcomesPage.tsx` | 1873 | 成果工作台全部 UI（列表/编辑器/版本/AI 助手/导入导出） |
| `electron/OutcomeRepository.ts` | 181 | project-scoped 持久化（outcomes/versions/categories/trash/scoped conversations） |
| `electron/OutcomeAssistantService.ts` | 597 | AI 助手：Project Context → AgentLoop → 结构化 edit → **直接 save 新版本** |
| `electron/OutcomeProjectContextService.ts` | 218 | 助手上下文选择与字符预算 |
| `electron/OutcomeExternalEditorService.ts` | 459 | METIS Office 会话（open/sync/close/state） |
| `electron/OutcomeWordDocxService.ts` | 501 | DOCX 导入导出 |
| `electron/OutcomePptxService.ts` | 551 | PPTX 导入导出 |
| `engine/runtime/OutcomeRuntimeContract.ts` | 643 | zod 契约：OutcomeDocument(Word/PPT/Spreadsheet/PDF/Other)、OutcomeSource、Version、AssistantSelection、ScopedConversation |
| `engine/persistence/migrations.ts` | 323 | UNIFIED_MIGRATIONS（版本 100+，当前最高 117） |
| `electron/ipc/` | 8 个 register*Ipc | DomainIpcRegistrar 注册范式（artifact/topic/freeModel/project/experiment/system/wechat） |

## 2. 三条真实数据链

### 2.1 Outcome 数据链（已验证）
```text
OutcomesPage.tsx
→ window.metis.listOutcomes/getOutcome/saveOutcome…（preload.ts 1401-1411 等，zod 校验后 invoke）
→ ipcMain.handle('outcomes:*')（main.ts 4560-4567+，直接注册，未走 ipc/ domain）
→ OutcomeRepository（project-scoped：assertProject/owned 双重归属校验）
→ SQLite（outcomes / outcome_versions / outcome_changes / outcome_categories / outcome_media / scoped_conversations(+messages)）
→ UI
```
关键事实：
- `OutcomeRepository.save()` 自带 optimistic check：`current_version !== baseVersion` → 抛 `outcome_version_conflict`（**T17.02 Save Version Race 已存在**）。
- 每次保存写 `outcome_changes` 变更记录（actor/operation/summary/sources）。
- 回收站：软删 `deleted_at` + 7 天惰性清理（`purgeExpired`）。
- 版本不可变（insert-only），`restore()` 通过 `save(actor:'restore')` 实现回滚为新版本。

### 2.2 Outcome AI 数据链（已验证——Phase 3 改造对象）
```text
renderer selection（OutcomeAssistantSelection: word_block/word_table_cell/ppt_page/ppt_element）
→ outcomes:assistant:chat → OutcomeAssistantService.chat()
→ OutcomeProjectContextService（字符预算内选取 project records）
→ AgentLoop（结构化 JSON：OutcomeAssistantModelResponseSchema{answer, edit}）
→ applyEdit(detail.version.content, model.edit, selection)（OutcomeAssistantService.ts:560）
→ repository.save({ baseVersion, content: applied.content, actor:'ai' })（OutcomeAssistantService.ts:574）
→ **立即创建新 OutcomeVersion** ← 这正是任务书要求废除的默认行为
→ returned `applied` + conversation 追加
```
可复用资产：`OutcomeAssistantEditSchema`（word replacements 含 row/column cell 定位；ppt replacePage）即 Revision 的 `after` 语义来源；`applyEdit` 的 target 定位逻辑可改造为 Revision 验证器。

### 2.3 METIS Office 数据链（已验证，不动）
```text
Outcome Version → outcomes:external-editor:open → OutcomeExternalEditorService（token 会话）
→ GenOffice（外部 WebContentsView/窗口）
→ outcomes:external-editor:sync → 导入文档 → repository.save（新 Version）+ auto-sync 事件推 renderer
```
sync 后 `detail` 返回新版本；**当前没有任何 draft/revision 对账逻辑**（T14.03 要补的点）。

## 3. 权威数据资产（Phase 9-12 必须复用，不得复制）
- **Claim/Evidence/Source**：`claims`（schema.ts:327，project_id 索引 idx_claims_project）、`claim_evidence_links`（:342，claim/evidence 双索引）、`sources`、`evidence`（paper 桥接管线写入）。
- **Artifact**：`research_artifacts` + `artifact_versions`（OutcomeRepository.listAssistantProjectRecords 已按 project 归属读取）。
- **Conversation**：`scoped_conversations(+messages)`，scope_kind='outcome' 完整支持多单元（listConversations/createConversation/appendToConversation）——Phase 5 直接复用，**不存在两套运行时**。
- **ContextScope**：`engine/runtime/ContextScopeContract.ts`。

## 4. 现有能力 → Outcomes 2.0 映射（复用清单）
| 需求 | 现有承载 | 结论 |
|---|---|---|
| OutcomeDocument/版本/不可变 | OutcomeRuntimeContract + outcome_versions | 不动 |
| 选区定位 | OutcomeAssistantSelection（block/cell/page/element） | 扩展为 RevisionTarget |
| AI 结构化编辑 | OutcomeAssistantModelResponseSchema.edit | 改为 Revision 提案来源 |
| 多任务对话 | scoped_conversations 单元 | 原样复用 |
| @Context | OutcomeSource 9 种 kind | 原样复用，不新建 MentionSource |
| 保存冲突 | outcome_version_conflict | 已满足 T17.02 |
| 变更记录 | outcome_changes | 供历史 Tab |
| IPC 范式 | electron/ipc/ DomainIpcRegistrar | 新通道走 `outcomes2:` 前缀 + registerOutcomes2Ipc.ts |
| versioned migration | UNIFIED_MIGRATIONS(100+) | 新表：SCHEMA_SQL(baseline) + migration 118(老库幂等建表) |

## 5. 缺口（本次要建的）
无 Working Draft / Snapshot / RevisionSet / Revision / Memory / ReviewIssue / ResearchGraph 的契约、表、服务、IPC、UI；AI 编辑默认写版本；审查无结构化 Issue；图谱不存在。

## 6. 明确不动的边界
METIS Office 编辑器实现、Topic/Scenario/Skill/MCP/Web Research/Submission 架构、主对话流、全局导航、Provider 系统（任务书 §36）。存量 `outcomes:` 通道语义不变，仅在其上叠加。
