# METIS 架构审计（解耦后）— 机械数据部分

- **生成时间**: 2026-09-14 19:10 UTC
- **HEAD SHA**: `d5f67f341d20dd6f2a2ba7ab17e57d0e1a6485c7`（`git rev-parse HEAD`，短 SHA `d5f67f3`，最后提交日期 2026-09-15）
- **仓库根**: `D:\LATEXTEST\metis-alpha2-release`（`git rev-parse --show-toplevel` 确认即仓库根）
- **数据性质**: 本文档为只读机械扫描结果，全部数据来自对工作区源码的真实 grep / 脚本解析 / 人工读码，未运行 build 或测试，未修改任何代码。行号以当前 HEAD 工作区为准。
- **扫描口径**: TypeScript 源文件；依赖图与边界检查均排除 `*.test.ts` / `*.d.ts`。

---

## 1. IPC Owner Matrix

**方法**：
- 域注册侧：`grep -ohE "[A-Za-z_$][A-Za-z0-9_$]*\.handle\('[^']*'" electron/ipc/*.ts`。electron/ipc 下注册变量名不统一（`dom.handle` / `topic.handle` / `domain.handle` 等），底层均为 `electron/ipc/IpcRegistry.ts` 的 `DomainIpcRegistrar`（其内部在 `IpcRegistry.ts:151` 调用 `ipcMain.handle(channel, listener)`）。
- main.ts 内联侧：`grep -o "ipcMain\.handle('...')"` 提取字面量通道 325 个；另有 4 个通道经常量 `AUTONOMOUS_CHANNELS.start/control/listSessions/resumeSession` 注册（定义于 `engine/runtime/AutonomousRuntimeContract.ts:217`，值为 `autonomous:start` 等），main.ts:8585/8722/8771/8804 使用。main.ts:857 为注释行，不计。
- 重名校验：`comm -12` 比对 electron/ipc 通道集与 main.ts 字面量通道集 → **0 个重叠**；main.ts 自身无重复注册（`sort | uniq -d` 为空）。
- 第三类注册点：部分 Service 自行调用 `ipcMain.handle('...')` 注册（不属于 electron/ipc，也不在 main.ts），共 40 个通道，计入"已迁出"。

### 1.1 汇总统计

| 指标 | 数值 |
|---|---:|
| 总 IPC handle 通道数（全应用） | **548** |
| 已迁出通道数（electron/ipc/*.ts） | **179** |
| 已迁出通道数（Service 文件自注册） | **40** |
| 已迁出合计 | **219** |
| main.ts 内联剩余（ipcMain.handle 直调） | **329** |
| 域前缀总数（去重） | **75** |
| 有迁出 owner 的前缀 | 23（其中 21 个完全迁出；`outcomes`、`dialog` 2 个前缀部分迁出） |
| 完全未迁出的前缀 | 52 |

### 1.2 electron/ipc/ 各 owner 文件

| owner 文件（electron/ipc/） | 通道数 | 域前缀 |
|---|---:|---|
| registerOutcomes2Ipc.ts | 45 | outcomes2 |
| registerOutcomeDataIpc.ts | 23 | outcomes |
| registerBrowserIpc.ts | 20 | browser |
| registerFreeModelIpc.ts | 18 | freeModel, mailbox |
| registerGoalIpc.ts | 18 | goal |
| registerSystemIpc.ts | 12 | backup, clipboard, dialog, flashcard, storage |
| registerTopicIpc.ts | 12 | topic |
| registerArtifactIpc.ts | 9 | artifact |
| registerExperimentIpc.ts | 9 | experiment |
| registerWeChatIpc.ts | 7 | wechat |
| registerProjectIpc.ts | 6 | project |
| **合计** | **179** | |

（`electron/ipc/` 下 `DomainIpcContext.ts`、`IpcRegistry.ts`、`sharedGuards.ts`、`goalPresentation.ts` 为基础设施/共享代码，不直接注册通道。）

### 1.3 Service 文件自注册（electron/ 根目录，非 main.ts）

| owner 文件 | 通道数 | 域前缀 |
|---|---:|---|
| electron/ResearchAgendaService.ts | 8 | agenda |
| electron/SubmissionTrackerService.ts | 7 | submissions |
| electron/MethodLibraryService.ts | 7 | methods |
| electron/CloudSyncService.ts | 7 | cloudSync |
| electron/LiteratureWatchService.ts | 4 | watch |
| electron/JobQueueService.ts | 4 | jobs |
| electron/AutonomousProfileService.ts | 3 | autonomousProfile |
| **合计** | **40** | |

### 1.4 全前缀 Owner Matrix

列说明：**通道数** = 该前缀全应用总通道数；**owner 文件** = 迁出后的注册 owner（ipc 域文件或 Service 文件）；**main.ts 内联剩余** = 该前缀仍以 `ipcMain.handle` 直调形式留在 electron/main.ts 的通道数。

| 域前缀 | 通道数 | owner 文件 | main.ts 内联剩余 |
|---|---:|---|---:|
| acceptance | 3 | （未迁出） | 3 |
| agenda | 8 | electron/ResearchAgendaService.ts | 0 |
| agent | 5 | （未迁出） | 5 |
| artifact | 9 | electron/ipc/registerArtifactIpc.ts | 0 |
| audio | 1 | （未迁出） | 1 |
| autonomous | 6 | （未迁出） | 6 |
| autonomousProfile | 3 | electron/AutonomousProfileService.ts | 0 |
| backup | 2 | electron/ipc/registerSystemIpc.ts | 0 |
| browser | 20 | electron/ipc/registerBrowserIpc.ts | 0 |
| ca | 6 | （未迁出） | 6 |
| capability | 7 | （未迁出） | 7 |
| clipboard | 2 | electron/ipc/registerSystemIpc.ts | 0 |
| cloudSync | 7 | electron/CloudSyncService.ts | 0 |
| collab | 7 | （未迁出） | 7 |
| collection | 3 | （未迁出） | 3 |
| concept | 1 | （未迁出） | 1 |
| data | 2 | （未迁出） | 2 |
| diag | 1 | （未迁出） | 1 |
| diagnostics | 2 | （未迁出） | 2 |
| dialog | 3 | electron/ipc/registerSystemIpc.ts | 2 |
| eval | 1 | （未迁出） | 1 |
| experiment | 9 | electron/ipc/registerExperimentIpc.ts | 0 |
| export | 3 | （未迁出） | 3 |
| externalRef | 3 | （未迁出） | 3 |
| fileCapability | 3 | （未迁出） | 3 |
| flashcard | 3 | electron/ipc/registerSystemIpc.ts | 0 |
| freeModel | 14 | electron/ipc/registerFreeModelIpc.ts | 0 |
| fundingTemplate | 3 | （未迁出） | 3 |
| genoffice-embedded | 3 | （未迁出） | 3 |
| goal | 18 | electron/ipc/registerGoalIpc.ts | 0 |
| gordenPpt | 3 | （未迁出） | 3 |
| hitl | 4 | （未迁出） | 4 |
| import | 1 | （未迁出） | 1 |
| jobs | 4 | electron/JobQueueService.ts | 0 |
| latex | 2 | （未迁出） | 2 |
| literature | 1 | （未迁出） | 1 |
| mailbox | 4 | electron/ipc/registerFreeModelIpc.ts | 0 |
| market | 3 | （未迁出） | 3 |
| mcp | 5 | （未迁出） | 5 |
| memory | 4 | （未迁出） | 4 |
| messages | 2 | （未迁出） | 2 |
| methods | 7 | electron/MethodLibraryService.ts | 0 |
| note | 3 | （未迁出） | 3 |
| officePrompt | 14 | （未迁出） | 14 |
| outcomePrompt | 10 | （未迁出） | 10 |
| outcomes | 56 | electron/ipc/registerOutcomeDataIpc.ts | 33 |
| outcomes2 | 45 | electron/ipc/registerOutcomes2Ipc.ts | 0 |
| paper | 8 | （未迁出） | 8 |
| papers | 3 | （未迁出） | 3 |
| personalization | 23 | （未迁出） | 23 |
| project | 6 | electron/ipc/registerProjectIpc.ts | 0 |
| projects | 3 | （未迁出） | 3 |
| providerProfiles | 5 | （未迁出） | 5 |
| research | 18 | （未迁出） | 18 |
| runtime | 1 | （未迁出） | 1 |
| scenario | 20 | （未迁出） | 20 |
| session | 4 | （未迁出） | 4 |
| settings | 4 | （未迁出） | 4 |
| setup | 4 | （未迁出） | 4 |
| shell | 1 | （未迁出） | 1 |
| skill | 6 | （未迁出） | 6 |
| skillStudio | 2 | （未迁出） | 2 |
| startup | 1 | （未迁出） | 1 |
| storage | 4 | electron/ipc/registerSystemIpc.ts | 0 |
| store | 1 | （未迁出） | 1 |
| strategy | 4 | （未迁出） | 4 |
| structure | 3 | （未迁出） | 3 |
| submission | 60 | （未迁出） | 60 |
| submissions | 7 | electron/SubmissionTrackerService.ts | 0 |
| terminal | 5 | （未迁出） | 5 |
| topic | 12 | electron/ipc/registerTopicIpc.ts | 0 |
| update | 4 | （未迁出） | 4 |
| watch | 4 | electron/LiteratureWatchService.ts | 0 |
| wechat | 7 | electron/ipc/registerWeChatIpc.ts | 0 |
| workspace | 2 | （未迁出） | 2 |
| **合计（75 个前缀）** | **548** | | **329** |

main.ts 内联剩余最大的前缀依次为：submission (60)、outcomes (33)、personalization (23)、scenario (20)、research (18)、officePrompt (14)、outcomePrompt (10)。

---

## 2. Service Dependency Graph

**方法**：遍历 `electron/` 全部非测试 `.ts` 文件（含 genofficeEmbedded/、office/、ipc/、preload/、RemoteBridge/ 子目录），静态解析 `import ... from` / `export ... from` / `await import(...)` 语句并解析相对路径到实际文件，构建 electron 模块间有向依赖图；用 Tarjan SCC 检测任意长度环，并独立复检两两互引（A import B 且 B import A）。另以第二种独立实现（逐行 split 解析 + 反向边查表）交叉验证循环结论。

**统计**：
| 指标 | 数值 |
|---|---:|
| 含 `export class` 的类文件数（electron/，非测试） | **101** |
| electron→electron import 边（含重复语句 / 去重后唯一边） | 801 / 329 |
| SCC 强连通分量（size > 1，即循环依赖） | **0** |
| 双向引用对（2-cycle） | **0**（两种独立实现一致） |
| 类文件中依赖 src/（UI）的 | **0** |
| 类文件中有 electron/ 内部依赖的 | 52 / 101 |
| 类文件中有 engine/ 依赖的 | 83 / 101 |
| 类文件中两者皆无的 | 12 |

**结论：electron 模块间未检测到任何循环依赖（含传递环）。** 下表为全部 101 个类文件的模块级 import 依赖清单（构造函数注入发生在 main.ts 组装层；import 图是机械可验证的模块依赖口径）。

| 文件 | 类 | electron/ 依赖 | engine/ 依赖 | src/ 依赖 |
|---|---|---|---|---|
| `AgentExecutionEventBridge.ts` | AgentExecutionEventBridge | — | `core/AgentLoop.ts`, `core/types.ts`, `core/HookBus.ts`, `runtime/ChatRuntimeContract.ts` | — |
| `ApprovalShutdownRegistry.ts` | ApprovalShutdownRegistry/ScenarioApprovalRegistry | `RuntimeShutdownCoordinator.ts` | — | — |
| `ArtifactPromptService.ts` | ArtifactPromptService | — | `artifacts/prompts/ArtifactPromptRegistry.ts` | — |
| `AutonomousProfileService.ts` | AutonomousProfileService | — | — | — |
| `AutoUpdaterService.ts` | AutoUpdaterService | `UpdateChannelPolicy.ts` | — | — |
| `BackupService.ts` | BackupService | — | `persistence/PersistenceStore.ts` | — |
| `BrowserService.ts` | BrowserService | — | `persistence/PersistenceStore.ts`, `research/CrossrefClient.ts` | — |
| `CapabilityVaultService.ts` | CapabilityVaultService | — | `capabilities/CapabilityImporter.ts`, `capabilities/McpCatalog.ts` | — |
| `CitationTruthReceiptService.ts` | CitationTruthReceiptService | — | `artifacts/ArtifactManifest.ts`, `evidence/ReferenceValidator.ts`, `persistence/ResearchRepository.ts`, `persistence/researchModel.ts`, `writing/CitationTruth.ts`, `writing/CitationTruthReceipt.ts`, `writing/CitationTruthResolver.ts` | — |
| `CloudSyncService.ts` | CloudSyncService | — | — | — |
| `CollabService.ts` | CollabService | — | — | — |
| `CoverLetterService.ts` | CoverLetterService | `ChatTurnService.ts`, `SubmissionGapService.ts`, `SubmissionPackageService.ts`, `JournalProfileRepository.ts`, `OutcomeRepository.ts`, `SubmissionPackageRepository.ts`, `SubmissionRepository.ts` | `core/AgentLoop.ts`, `runtime/ProviderProfileContract.ts`, `runtime/OutcomeRuntimeContract.ts`, `submission/JournalProfileContract.ts` | — |
| `CurrentAffairsRuntimeService.ts` | CurrentAffairsRuntimeService | — | `writing/CurrentAffairsProfile.ts`, `writing/CurrentAffairsService.ts`, `writing/CurrentAffairsPreview.ts`, `writing/CurrentAffairsSessionState.ts`, `writing/CurrentAffairsSourceAdapter.ts`, `writing/CurrentAffairsRepositoryService.ts`, `writing/CurrentAffairsApprovalStore.ts`, `writing/CurrentAffairsArtifactService.ts`, `runtime/CurrentAffairsRuntimeContract.ts` | — |
| `EvidenceEnvelopeService.ts` | EvidenceEnvelopeService | — | `runtime/EvidenceEnvelopeContract.ts` | — |
| `ExecutionCapabilityRegistry.ts` | ExecutionCapabilityRegistry | — | `runtime/ExecutionCapabilityContract.ts` | — |
| `ExperimentScriptService.ts` | ExperimentScriptService | `ExecutionCapabilityRegistry.ts` | `runtime/ExperimentRuntimeContract.ts` | — |
| `ExternalReferenceService.ts` | ExternalReferenceService | — | `runtime/ExternalReferenceContract.ts` | — |
| `FileCapabilityRegistry.ts` | FileCapabilityRegistry | `ExecutionCapabilityRegistry.ts` | `runtime/FileCapabilityContract.ts` | — |
| `FirstRunSetupService.ts` | FirstRunSetupService | — | `core/SecureStorage.ts`, `core/types.ts`, `setup/CapabilityProbe.ts`, `setup/AdaptiveStrategy.ts`, `setup/ErrorRecovery.ts`, `runtime/SetupRuntimeContract.ts` | — |
| `FreeModelService.ts` | FreeModelService | `ModelDiscoveryStore.ts`, `ProviderProfileStore.ts` | `providers/discovery/ProviderDiscoveryService.ts`, `providers/discovery/CommunitySourceDiscovery.ts`, `providers/discovery/AutoRegisterScheduler.ts`, `providers/discovery/NewAPIClient.ts`, `providers/discovery/OmniRouteGateway.ts`, `mail/MailboxPool.ts` | — |
| `FundingTemplateIpcService.ts` | FundingTemplateIpcService | `FundingTemplateRepository.ts`, `FundingTemplateService.ts`, `FundingTemplateRuntimeProjection.ts` | `runtime/FundingTemplateRuntimeContract.ts` | — |
| `FundingTemplateRepository.ts` | FundingTemplateRepository | — | `runtime/FundingTemplateContract.ts`, `personalization/FundingTemplateAnalyzer.ts` | — |
| `FundingTemplateService.ts` | FundingTemplateService | `FundingTemplateObservationAdapter.ts`, `FundingTemplateRepository.ts` | `personalization/FundingTemplateAnalyzer.ts`, `runtime/FundingTemplateContract.ts` | — |
| `FundingTemplateToolService.ts` | FundingTemplateToolService | `FundingTemplateRepository.ts`, `FundingTemplateRuntimeProjection.ts` | `core/types.ts`, `runtime/FundingTemplateRuntimeContract.ts`, `runtime/ToolPresentationContract.ts`, `tools/ToolDispatcher.ts`, `tools/ToolRegistry.ts` | — |
| `GeneratedMcpActivationCoordinator.ts` | GeneratedMcpActivationCrashSimulation/GeneratedMcpActivationCoordinator | `PersonalizationMcpInstaller.ts` | `runtime/McpActivationContract.ts`, `runtime/McpInstallationContract.ts`, `runtime/PersonalizationRuntimeContract.ts` | — |
| `genofficeEmbedded/GenofficeEmbeddedViewService.ts` | GenofficeEmbeddedViewService | `genofficeEmbedded/genofficeEmbeddedTypes.ts` | — | — |
| `GordenPptService.ts` | GordenPptService | `OutcomePptxService.ts` | — | — |
| `ipc/IpcRegistry.ts` | IpcRegistrationError/DomainIpcRegistrar/IpcRegistry | — | — | — |
| `JobQueueService.ts` | JobQueueService | — | `runtime/JobQueue.ts`, `persistence/PersistenceStore.ts` | — |
| `JournalCorpusService.ts` | JournalCorpusService | `JournalProfileRepository.ts`, `LiteratureSearchService.ts` | `submission/JournalProfileContract.ts` | — |
| `JournalPatternService.ts` | JournalPatternService | `ChatTurnService.ts`, `JournalProfileRepository.ts` | `core/AgentLoop.ts`, `runtime/ProviderProfileContract.ts`, `submission/JournalProfileContract.ts` | — |
| `JournalProfileRepository.ts` | JournalProfileRepository | — | `submission/JournalProfileContract.ts` | — |
| `JournalProfileService.ts` | JournalProfileService | `ChatTurnService.ts`, `JournalProfileRepository.ts` | `core/AgentLoop.ts`, `runtime/ProviderProfileContract.ts`, `submission/JournalProfileContract.ts` | — |
| `LiteratureSearchService.ts` | LiteratureSearchService | — | `literature/CoreJournalLists.ts` | — |
| `LiteratureWatchService.ts` | LiteratureWatchService | `LiteratureSearchService.ts` | `persistence/PersistenceStore.ts` | — |
| `MailSendService.ts` | MailSendService | `ModelDiscoveryStore.ts`, `SubmissionCorrespondenceRepository.ts`, `SubmissionRepository.ts` | `mail/MailSender.ts`, `mail/MailboxPool.ts`, `submission/SubmissionCorrespondenceContract.ts` | — |
| `MainProcessLogger.ts` | MainProcessLogger | — | — | — |
| `ManagedPersonalizationMcpRuntime.ts` | ManagedPersonalizationMcpRuntime | `PersonalizationMcpInstaller.ts` | `mcp/MCPClient.ts`, `mcp/ExactEnvironmentStdioTransport.ts`, `runtime/McpInstallationContract.ts`, `runtime/ManagedMcpRuntimeContract.ts`, `runtime/PersonalizationRuntimeContract.ts`, `tools/ArgsValidator.ts`, `runtime/EvidenceEnvelopeContract.ts`, `mcp/protocol.ts` | — |
| `MarketService.ts` | MarketService | `PersonalizationSecretVault.ts` | — | — |
| `McpBuilderService.ts` | McpBuilderService | `PersonalizationMcpInstaller.ts` | `tools/ArgsValidator.ts`, `runtime/McpInstallationContract.ts` | — |
| `MethodLibraryService.ts` | MethodLibraryService | — | — | — |
| `ModelDiscoveryStore.ts` | ModelDiscoveryStore/MailboxPoolStore | — | `providers/discovery/ProviderDiscoveryService.ts`, `providers/discovery/AutoRegisterScheduler.ts`, `mail/MailboxPool.ts` | — |
| `OfficePromptProfileService.ts` | OfficePromptProfileService | — | `artifacts/prompts/ArtifactPromptRegistry.ts`, `artifacts/prompts/OfficeCapabilityRegistry.ts` | — |
| `OpenAISetupProbeTransport.ts` | OpenAISetupProbeTransport | `FirstRunSetupService.ts` | `setup/CapabilityProbe.ts` | — |
| `OutcomeAssistantService.ts` | OutcomeAssistantService | `ChatTurnService.ts`, `OutcomeRepository.ts`, `OutcomeProjectContextService.ts` | `core/types.ts`, `core/AgentLoop.ts`, `runtime/OutcomeRuntimeContract.ts`, `runtime/ProviderProfileContract.ts` | — |
| `OutcomeExternalEditorService.ts` | OutcomeExternalEditorService | — | — | — |
| `OutcomeGraphExtractionService.ts` | OutcomeGraphExtractionService | `ChatTurnService.ts`, `OutcomeReviewPipelineService.ts`, `OutcomeWorkbenchService.ts`, `OutcomeMemoryReviewGraphService.ts` | `core/AgentLoop.ts`, `core/types.ts`, `runtime/OutcomeRuntimeContract.ts` | — |
| `OutcomeImageService.ts` | OutcomeImageService | `OutcomeMediaService.ts`, `OutcomeRepository.ts`, `PersonalizationSecretVault.ts` | `runtime/OutcomeRuntimeContract.ts` | — |
| `OutcomeMediaService.ts` | OutcomeMediaService | `OutcomeSvgSecurity.ts` | `runtime/OutcomeRuntimeContract.ts` | — |
| `OutcomeMemoryReviewGraphService.ts` | OutcomeMemoryService/OutcomeReviewService/ResearchGraphService | — | `runtime/OutcomeWorkbenchContract.ts` | — |
| `OutcomePptGenerationService.ts` | OutcomePptGenerationService | `ChatTurnService.ts`, `OutcomeProjectContextService.ts`, `OutcomeRepository.ts` | `pptx/ZoneLayoutEngine.ts`, `core/types.ts`, `core/AgentLoop.ts`, `runtime/OutcomeRuntimeContract.ts`, `runtime/ProviderProfileContract.ts` | — |
| `OutcomePptxService.ts` | OutcomePptxService | `OutcomeSvgSecurity.ts`, `office/genofficePptxBridge.ts` | `export/renderers/ZipWriter.ts`, `runtime/OutcomeRuntimeContract.ts` | — |
| `OutcomeProjectContextService.ts` | OutcomeProjectContextService | `OutcomeRepository.ts`, `ProjectMetisRulesBridge.ts` | `runtime/OutcomeRuntimeContract.ts`, `runtime/WorkspaceAgentsContract.ts` | — |
| `OutcomeRepository.ts` | OutcomeRepository | — | `runtime/OutcomeRuntimeContract.ts` | — |
| `OutcomeReviewPipelineService.ts` | OutcomeReviewPipelineService | `ChatTurnService.ts`, `OutcomeWorkbenchService.ts`, `OutcomeMemoryReviewGraphService.ts` | `core/types.ts`, `core/AgentLoop.ts`, `runtime/OutcomeRuntimeContract.ts`, `runtime/OutcomeWorkbenchContract.ts` | — |
| `OutcomeTemplateService.ts` | OutcomeTemplateService | — | `persistence/PersistenceStore.ts`, `runtime/OutcomeRuntimeContract.ts` | — |
| `OutcomeWordDocxService.ts` | OutcomeWordDocxService | `office/genofficeBridge.ts` | `export/renderers/ZipWriter.ts`, `runtime/OutcomeRuntimeContract.ts` | — |
| `OutcomeWorkbenchService.ts` | OutcomeWorkbenchService | `OutcomeRepository.ts` | `runtime/OutcomeRuntimeContract.ts`, `runtime/OutcomeWorkbenchContract.ts` | — |
| `PersonalizationBundleImportCoordinator.ts` | PersonalizationBundleImportCoordinator | `PersonalizationBundleService.ts`, `PersonalizationBundleSkillRehydrationService.ts` | `runtime/PersonalizationBundleContract.ts`, `runtime/PersonalizationRuntimeContract.ts`, `runtime/SkillInstallationContract.ts` | — |
| `PersonalizationBundleRepositorySink.ts` | PersonalizationBundleRepositorySink | `PersonalizationBundleService.ts` | `personalization/PersonalizationRepository.ts`, `runtime/PersonalizationBundleContract.ts`, `runtime/PersonalizationRuntimeContract.ts` | — |
| `PersonalizationBundleService.ts` | PersonalizationBundleService | — | `runtime/PersonalizationBundleContract.ts`, `runtime/PersonalizationRuntimeContract.ts` | — |
| `PersonalizationBundleSkillAssetSource.ts` | PersonalizationBundleSkillAssetSource | `PersonalizationBundleService.ts` | `runtime/PersonalizationRuntimeContract.ts`, `runtime/SkillInstallationContract.ts` | — |
| `PersonalizationBundleSkillRehydrationService.ts` | PersonalizationBundleSkillRehydrationService | — | `runtime/PersonalizationBundleContract.ts`, `runtime/PersonalizationRuntimeContract.ts`, `runtime/SkillInstallationContract.ts` | — |
| `PersonalizationExtensionService.ts` | FilesystemMcpInstallationCompensator/PersonalizationExtensionService | `PersonalizationMcpInstaller.ts` | `runtime/EvidenceEnvelopeContract.ts`, `runtime/McpInstallationContract.ts`, `runtime/PersonalizationRuntimeContract.ts`, `runtime/PersonalizationExtensionContract.ts`, `runtime/SkillInstallationContract.ts` | — |
| `PersonalizationMcpActivationService.ts` | McpActivationCrashSimulation/PersonalizationMcpActivationService | `PersonalizationExtensionService.ts`, `PersonalizationMcpInstaller.ts` | `runtime/EvidenceEnvelopeContract.ts`, `runtime/McpActivationContract.ts`, `runtime/McpInstallationContract.ts`, `runtime/ManagedMcpRuntimeContract.ts`, `runtime/PersonalizationRuntimeContract.ts` | — |
| `PersonalizationMcpInstaller.ts` | NodeHttpsMcpNetworkClient/PersonalizationMcpInstaller | — | `tools/ArgsValidator.ts`, `runtime/McpInstallationContract.ts` | — |
| `PersonalizationMcpProbeRunner.ts` | PersonalizationMcpProbeRunner | `PersonalizationMcpInstaller.ts` | `mcp/MCPClient.ts`, `mcp/ExactEnvironmentStdioTransport.ts`, `mcp/protocol.ts`, `runtime/McpInstallationContract.ts`, `tools/ArgsValidator.ts` | — |
| `PersonalizationMcpToolBridge.ts` | PersonalizationMcpToolRun/PersonalizationMcpToolBridge | `ManagedPersonalizationMcpRuntime.ts`, `PersonalizationMcpInstaller.ts` | `core/types.ts`, `personalization/ScenarioRunCoordinator.ts`, `runtime/McpInstallationContract.ts`, `runtime/ManagedMcpRuntimeContract.ts`, `runtime/PersonalizationRuntimeContract.ts`, `runtime/EvidenceEnvelopeContract.ts`, `tools/ArgsValidator.ts`, `tools/ToolDispatcher.ts` | — |
| `PersonalizationRuntimeService.ts` | PersonalizationRuntimeService | — | `runtime/PersonalizationRuntimeContract.ts`, `personalization/PersonalizationRepository.ts`, `personalization/PersonalizationResolver.ts` | — |
| `PersonalizationSecretVault.ts` | PersonalizationSecretVault | — | `runtime/PersonalizationSecretContract.ts` | — |
| `PersonalizationSkillInstaller.ts` | PersonalizationSkillInstaller | — | `runtime/SkillInstallationContract.ts` | — |
| `ProviderProfileStore.ts` | ProviderProfileStore | `FirstRunSetupService.ts` | `core/types.ts`, `runtime/ProviderProfileContract.ts`, `runtime/SetupRuntimeContract.ts` | — |
| `RemoteBridge/remoteDevBridge.ts` | RemoteDevBridge | — | — | — |
| `ResearchAgendaService.ts` | ResearchAgendaService | — | — | — |
| `ResearchJournalService.ts` | ResearchJournalService | — | `persistence/ResearchRepository.ts`, `persistence/PersistenceStore.ts`, `goal/GoalEngine.ts` | — |
| `ResearchMediaService.ts` | ResearchMediaService | `FileCapabilityRegistry.ts`, `ExecutionCapabilityRegistry.ts`, `ResearchExportAdapter.ts` | `artifacts/ArtifactManifest.ts`, `persistence/researchModel.ts`, `persistence/ResearchRepository.ts`, `export/ResearchExportBuilder.ts`, `export/renderers/ImageSupport.ts`, `runtime/ResearchMediaRuntimeContract.ts` | — |
| `ResearchRuntimeService.ts` | ResearchRuntimeService | `CitationTruthReceiptService.ts`, `ResearchArtifactTrust.ts` | `artifacts/ArtifactManifest.ts`, `persistence/ResearchRepository.ts`, `persistence/researchModel.ts`, `runtime/ResearchRuntimeContract.ts`, `runtime/ResearchMediaRuntimeContract.ts`, `writing/ProfileEnforcer.ts` | — |
| `ResearchWorkspaceService.ts` | ResearchWorkspaceService | — | `artifacts/ArtifactManifest.ts`, `sources/EvidenceAnchor.ts`, `sources/SourceService.ts`, `setup/QuickStart.ts`, `persistence/ResearchRepository.ts`, `persistence/researchModel.ts` | — |
| `RuntimeShutdownCoordinator.ts` | RuntimeShutdownCoordinator | — | — | — |
| `ScenarioMaterialService.ts` | ScenarioMaterialService | `MaterialExtractors.ts` | `io/DocxTextReader.ts` | — |
| `SecureDownloadService.ts` | SecureDownloadService | — | `runtime/NetworkCapabilityContract.ts`, `security/ExternalNavigation.ts` | — |
| `SecureExportService.ts` | SecureExportService | — | `export/ResearchExportBuilder.ts`, `runtime/ExportRuntimeContract.ts` | — |
| `SubmissionAssistantService.ts` | SubmissionAssistantService | `ChatTurnService.ts`, `SubmissionBrowserTools.ts` | `core/AgentLoop.ts`, `runtime/OutcomeRuntimeContract.ts` | — |
| `SubmissionCorrespondenceRepository.ts` | SubmissionCorrespondenceRepository | — | `submission/SubmissionCorrespondenceContract.ts` | — |
| `SubmissionDeadlineSync.ts` | SubmissionDeadlineSync | `SubmissionReviewRepository.ts`, `SubmissionRepository.ts` | — | — |
| `SubmissionGapService.ts` | SubmissionGapService | `ChatTurnService.ts`, `JournalProfileRepository.ts`, `OutcomeRepository.ts`, `SubmissionRepository.ts` | `core/AgentLoop.ts`, `runtime/OutcomeRuntimeContract.ts`, `submission/JournalProfileContract.ts` | — |
| `SubmissionMailService.ts` | SubmissionMailService | `ModelDiscoveryStore.ts`, `DecisionLetterAttachments.ts`, `SubmissionCorrespondenceRepository.ts`, `SubmissionRepository.ts`, `SubmissionReviewService.ts` | `mail/MailboxPool.ts`, `submission/SubmissionRuntimeContract.ts`, `submission/SubmissionCorrespondenceContract.ts` | — |
| `SubmissionMailWatcher.ts` | SubmissionMailWatcher | — | `mail/MailboxPool.ts`, `submission/SubmissionCorrespondenceContract.ts` | — |
| `SubmissionOptimizationService.ts` | SubmissionOptimizationService | `JournalProfileRepository.ts`, `SubmissionGapService.ts`, `OutcomeRepository.ts`, `SubmissionRepository.ts` | `submission/JournalProfileContract.ts`, `runtime/OutcomeRuntimeContract.ts` | — |
| `SubmissionPackageRepository.ts` | SubmissionPackageRepository | — | `submission/SubmissionPackageContract.ts` | — |
| `SubmissionPackageService.ts` | SubmissionPackageService | `SubmissionGapService.ts`, `JournalProfileRepository.ts`, `OutcomeRepository.ts`, `OutcomeWordDocxService.ts`, `SubmissionPackageRepository.ts`, `SubmissionPreflightService.ts`, `SubmissionRepository.ts` | `runtime/OutcomeRuntimeContract.ts`, `submission/SubmissionPackageContract.ts` | — |
| `SubmissionPortalService.ts` | SubmissionPortalService | `BrowserService.ts`, `SubmissionRepository.ts`, `JournalProfileRepository.ts` | `submission/SubmissionPortalContract.ts`, `submission/SubmissionRuntimeContract.ts`, `submission/portalAdapters.ts` | — |
| `SubmissionPreflightService.ts` | SubmissionPreflightService | `SubmissionGapService.ts`, `JournalProfileRepository.ts`, `OutcomeRepository.ts`, `SubmissionPackageRepository.ts`, `SubmissionRepository.ts` | `runtime/OutcomeRuntimeContract.ts`, `submission/JournalProfileContract.ts`, `submission/SubmissionPackageContract.ts` | — |
| `SubmissionRepository.ts` | SubmissionRepository | — | `submission/SubmissionRuntimeContract.ts` | — |
| `SubmissionReviewRepository.ts` | SubmissionReviewRepository | — | `submission/SubmissionReviewContract.ts` | — |
| `SubmissionReviewService.ts` | SubmissionReviewService | `SubmissionRepository.ts`, `SubmissionReviewRepository.ts`, `OutcomeRepository.ts` | `core/AgentLoop.ts`, `runtime/ProviderProfileContract.ts`, `submission/SubmissionReviewContract.ts` | — |
| `SubmissionTrackerService.ts` | SubmissionTrackerService | — | — | — |
| `TopicRepository.ts` | TopicRepository | — | `runtime/TopicRuntimeContract.ts` | — |
| `TopicService.ts` | TopicService | `TopicRepository.ts` | `runtime/TopicRuntimeContract.ts`, `persistence/ResearchRepository.ts`, `persistence/researchModel.ts` | — |
| `UpdateCheckerService.ts` | UpdateCheckerService | — | — | — |
| `WeChatBotService.ts` | WeChatBotService | — | `im/types.ts`, `im/IlinkClient.ts`, `im/MediaCodec.ts` | — |

---

## 3. Repository 边界检查

**依赖方向硬规则**：Infrastructure（engine/、各 Repository/Store）不得反向依赖 UI 层（`src/`）或 Electron 窗口层（`electron` 包的 BrowserWindow/ipcMain/ipcRenderer/WebContentsView）。

**检查范围与命令**：
- `engine/persistence/*.ts`（非测试 12 个文件：errors、ExperimentAttachmentRepository、ExperimentScriptMigration、index、MigrationRunner、migrations、PersistenceStore、researchModel、ResearchRepository、ResearchStrategyStore、schema、StartupHealth）；
- electron/ 根下 15 个 Repository/Store/KeyStore 文件：OutcomeRepository、FundingTemplateRepository、JournalProfileRepository、SubmissionRepository、SubmissionReviewRepository、SubmissionCorrespondenceRepository、SubmissionPackageRepository、TopicRepository、GoalPersistenceStore、ModelDiscoveryStore、ProviderProfileStore、CitationTruthKeyStore、CurrentAffairsReceiptKeyStore、PersonalizationBundleRepositorySink、StorageLocation；
- 追加全 `engine/` 目录扫描（含动态 `import()`/`require()` 形式），并做了正向对照（`from 'electron'` 模式在 electron/ 下命中 AutonomousProfileService、BrowserService 等，证明模式有效）。

**检查项**：`from 'electron'`、`require('electron')`、`import('electron')`、`BrowserWindow`、`ipcMain`、`ipcRenderer`、`WebContentsView`、`from '...src/...'`。

**结果（违规清单）**：

| 检查组 | 文件数 | 命中违规数 |
|---|---:|---:|
| engine/persistence/*.ts（非测试） | 12 | **0** |
| electron/ 根 Repository/Store/KeyStore | 15 | **0** |
| engine/ 全目录 import 指向 src/ 或 electron/ | 334（非测试 .ts） | **0** |

**违规数合计：0。**

支撑证据：
- `electron/OutcomeRepository.ts` 实际 import 仅：`node:crypto`、`better-sqlite3`、`../engine/runtime/OutcomeRuntimeContract.js`。
- `engine/persistence/` 实际 import 仅：`better-sqlite3`、engine 内部模块（`../core/types.js`、`../runtime/*Contract.js`、`../research/researchActions.js`、`../personalization/PersonalizationRepository.js`、`../artifacts/ArtifactManifest.js`、`../runtime/ProviderProfileContract.js`）。
- `engine/` 全目录外部依赖白名单（去重）：`better-sqlite3`、`csv-parse/sync`、`jsonrepair`、`mdast`、`remark-gfm`、`remark-parse`、`undici`、`unified`、`zod`（`vitest` 仅测试文件）+ `node:` 内建模块。无任何 UI/Electron 引用。
- 唯一的 `src/` 字样出现在 `engine/viewers/DocumentViewers.ts:6`，为注释（说明 React 渲染位于 src/viewers/），非 import。

---

## 4. 生命周期所有权表（electron/main.ts）

**关闭主流程**：`before-quit`（main.ts:13034）→ `completeApplicationShutdown()`（main.ts:12970，幂等，经 shutdownPromise 去重）→ 顺序清理（下表"停止/清理点"列）→ `app.quit()`。运行中未完成操作统一经 `runtimeShutdown.drain(SHUTDOWN_DRAIN_TIMEOUT_MS)`（main.ts:12975，超时常量 10s，定义于 main.ts:893）收口；main.ts 各 handler 以 `runtimeShutdown.isDraining()` 做关闭期准入拒绝（11 处）。

| 资源 | 创建者/创建点 | 停止者/清理调用点 | runtimeShutdown 注册 |
|---|---|---|---|
| mainWindow（BrowserWindow，全 main.ts 唯一 `new BrowserWindow`） | main.ts:3155（createWindow） | `closed` 处理器 main.ts:3213-3223：清 fileCapabilities(3214)/exportPreviews(3215)/kill activeTerminals(3216-3219)/executionCapabilities.clear(3221)，置 null；`window-all-closed` 13030 → quit | 无（由 app 事件驱动） |
| BrowserService 及其内嵌 WebContentsView | 实例 main.ts:1006（createWindow 内，绑定 win）；view: BrowserService.ts:146 | 无显式 dispose API；view 随宿主窗口销毁 | 无 |
| CollabService 及其 WebContentsView | 实例 main.ts:1021；view: CollabService.ts:41 | `destroy()` 定义于 CollabService.ts:166，但 main.ts **无调用点**；view 随宿主窗口销毁 | 无 |
| GenofficeEmbeddedViewService 及其 WebContentsView | 实例 main.ts:1823；view: GenofficeEmbeddedViewService.ts:76 | `shutdownAll()` main.ts:13004（内部 removeChildView :158/:176，含 isDestroyed 保护） | 无 |
| JobQueueService | main.ts:1082（attachStore: 12155） | **无 stop/dispose 调用点**；持久化为 400ms debounce `writeFileSync`（JobQueueService.ts:64-78，注释声明"尽力而为"） | 无 |
| GordenPptService（惰性单例） | main.ts:5158（声明 5156） | 无应用级停止点；子进程级：spawn（GordenPptService.ts:50）+ 超时 `child.kill()`（:53） | 无 |
| OutcomeExternalEditorService（outcomeExternalEditor） | main.ts:1787 | `shutdownAll()` main.ts:13003 | 无 |
| GoalEngine | main.ts:2912/3127/2952（runtime 重建路径） | `suspendActiveGoalsForShutdown()` 12973；`drainActiveRuns()` 12976（独立于 chat drain，并行等待） | 无（goal 侧独立 drain 通道） |
| AutonomousResearchEngine（autonomousEngine） | main.ts:3134/2954 | `interrupt(activeAutonomousSessionId, 'application_shutdown')` 12990（另 2886/2941 为 provider 重配路径）；activeAutonomousRun 等待完成 12992-12999 | `registerRuntimeRunOrRollback` main.ts:8540-8545（注册 abort 回调） |
| ScenarioLoopScheduler（scenarioLoopScheduler） | main.ts:12360 | `stop()` 12987（置 null 12377/12988） | 无 |
| backupTimer（备份定时器） | setInterval main.ts:12163 | clearInterval 12984 | 无 |
| WeChatBotService | main.ts:3306 | `stop()` 13000 | 无 |
| MCPManager（mcpManager） | main.ts:3108、12857 | `disconnectAll()` 13016 | 无 |
| ManagedPersonalizationMcpRuntime | main.ts:12582 | `shutdownAll()` 13017 | 无 |
| ExperimentScriptAdapter | createExperimentScriptAdapter main.ts:12807 | `dispose()` 13013 | 无 |
| FirstRunSetupService | main.ts:12906 | `dispose()` 12920（provider 重配路径）、13014（shutdown） | 无 |
| PersistenceStore（store） | main.ts:12138（声明 644） | `close()` 13018 | 无 |
| MainProcessLogger | main.ts:42 | `dispose()` 13025（shutdown 序列最后一步：冲刷日志并恢复 console） | 无 |
| HITL / Scenario 审批中断 | ApprovalShutdownRegistry / ScenarioApprovalRegistry 实例 main.ts:890-891 | drain 时由 coordinator 回调 | `runtimeShutdown.register`（ApprovalShutdownRegistry.ts:70） |
| 运行级临时操作（LLM 流、终端、上传等 in-flight 操作） | 各 IPC handler | drain 超时后强制收口 | `trackEphemeralOperation` ×18（main.ts:1114/4743/4859/4953/7612/8243/8298/8344/9218/9511/9550/9678/10000/10083/10346/10475/11187/11245）；`registerRuntimeRunOrRollback` ×3（main.ts:926/7380/8540）；electron/ipc/registerGoalIpc.ts 与 registerTopicIpc.ts 使用同一机制注册域内运行 |

**如实记录的观察项**（机械事实，非违规判定）：
1. `JobQueueService` 在 `completeApplicationShutdown` 中无停止/flush 调用点，其队列持久化为 400ms debounce 写文件——退出前最后 400ms 内的队列状态变更可能未落盘（源码注释自认"尽力而为"）；重启依赖 `restoreFromDisk` 恢复。
2. `CollabService.destroy()`（CollabService.ts:166）在 main.ts 中无任何调用点，视图清理完全依赖窗口销毁联动。
3. `BrowserService` 无 dispose/shutdown API；其下载会话使用持久 `session.fromPartition`（BrowserService.ts:143），不随应用退出清理。
4. WebContentsView 共 3 处创建点：BrowserService.ts:146、CollabService.ts:41、GenofficeEmbeddedViewService.ts:76——前两者生命周期挂接宿主窗口，仅 genofficeEmbedded 有显式 shutdownAll。
5. `outcomes:external-editor:*`、`genoffice-embedded:*` 等 main.ts 内联通道直接操作上述资源（main.ts:4462-4587），未迁出（与第 1 节矩阵一致）。

---

## 5. 文件规模 Top20

**口径**：`wc -l`；electron/ 统计全部 `.ts`（含 main.ts、preload、子目录，含测试文件）；src/ 统计全部 `.ts`/`.tsx`/`.css` 源文件（electron/ 下无 tsx/css）。electron/ 共 183 个 .ts 文件；src/ 共 308 个文件。

### 5.1 electron/ Top20

| # | 文件 | 行数 |
|---:|---|---:|
| 1 | electron/main.ts | 13,045 |
| 2 | electron/ScenarioWorkflowService.ts | 1,598 |
| 3 | electron/PersonalizationBundleImportCoordinator.ts | 1,267 |
| 4 | electron/PersonalizationSkillInstaller.ts | 1,215 |
| 5 | electron/ResearchRuntimeService.ts | 1,198 |
| 6 | electron/ExperimentScriptService.ts | 1,098 |
| 7 | electron/FirstRunSetupService.ts | 1,096 |
| 8 | electron/FundingTemplateObservationAdapter.ts | 1,064 |
| 9 | electron/preload.ts | 884 |
| 10 | electron/PersonalizationMcpInstaller.ts | 830 |
| 11 | electron/PersonalizationExtensionService.ts | 830 |
| 12 | electron/BrowserService.ts | 777 |
| 13 | electron/WeChatBotService.ts | 737 |
| 14 | electron/ManagedPersonalizationMcpRuntime.ts | 726 |
| 15 | electron/OutcomeAssistantService.ts | 694 |
| 16 | electron/ProviderProfileStore.ts | 661 |
| 17 | electron/PersonalizationBundleSkillRehydrationService.ts | 654 |
| 18 | electron/OutcomeWorkbenchService.ts | 647 |
| 19 | electron/PersonalizationBundleService.ts | 646 |
| 20 | electron/FreeModelService.ts | 644 |

main.ts（13,045 行）为第二名（1,598 行）的 8.2 倍，是 electron 层剩余体量的绝对主体，与第 1 节 329 个内联通道、第 4 节组装+shutdown 职责集中于 main.ts 相互印证。

### 5.2 src/ Top20

| # | 文件 | 行数 |
|---:|---|---:|
| 1 | src/App.css | 3,897 |
| 2 | src/pages/ChatPage.tsx | 2,811 |
| 3 | src/i18n/locales/zh.ts | 2,287 |
| 4 | src/i18n/locales/en.ts | 2,287 |
| 5 | src/pages/PdfReaderPage.tsx | 1,614 |
| 6 | src/personalization/PersonalizationCenter.tsx | 1,494 |
| 7 | src/research/ResearchInspectorPanels.tsx | 1,464 |
| 8 | src/research/ResearchWorkspace.css | 1,253 |
| 9 | src/App.tsx | 1,222 |
| 10 | src/store.ts | 1,100 |
| 11 | src/personalization/scenarioWorkbench.css | 1,098 |
| 12 | src/pages/LatexPreviewPage.tsx | 1,089 |
| 13 | src/pages/ChatPage.css | 1,032 |
| 14 | src/shell/VersionDiffReviewer.tsx | 1,024 |
| 15 | src/shell/VersionDiffReviewer.css | 1,006 |
| 16 | src/research/ProjectWorkspaceSidebar.tsx | 977 |
| 17 | src/personalization/ScenarioWorkbench.tsx | 972 |
| 18 | src/AcademicPolish.css | 958 |
| 19 | src/shell/RecycleRestore.tsx | 956 |
| 20 | src/conversation/chatTurnFlow.ts | 953 |

---

## 附：关键数字速览

| 指标 | 数值 |
|---|---:|
| IPC 总通道 | 548 |
| 已迁出（ipc 域文件 179 + Service 自注册 40） | 219 |
| main.ts 内联剩余 | 329 |
| 域前缀 | 75（完全迁出 21，部分迁出 2，未迁出 52） |
| electron 类文件 | 101 |
| 循环依赖（SCC / 双向对） | 0 / 0 |
| Repository 边界违规（engine/persistence、electron Repository、engine 全目录） | 0 |
| main.ts 行数 / electron 第二名 | 13,045 / 1,598 |
