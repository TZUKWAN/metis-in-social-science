# UI Surface Inventory（T00.02）

范围：普通用户可达界面。Native WebContentsView 只审宿主边界，不审其内部。
Layout owner = 直接负责布局的组件；Scroll owner = 唯一允许出现该区域滚动条的容器。

| Surface | Entry | Root Component | CSS files | Layout owner | Scroll owner | Native view? | Responsive 现状 | 现存缺陷（baseline） | 优先级 | AIO 相关 |
|---|---|---|---|---|---|---|---|---|---|---|
| App Shell / Topbar | 常驻 | `App.tsx` header.topbar | App.css | App | topbar-nav 内部横滚 | 否 | 1280 可用，窄屏 nav 隐藏 | 选中态下划线偏移极小；可接受 | P2 | AIO 不渲染（T07.03 已实现） |
| 研究工作台（聊天） | 顶栏 研究 | `ChatPage`+`ProjectsPage` | ChatPage.css/ProjectsPage.css | ProjectsPage 三模式容器 | chat-messages；面板各自 | 否 | 中间列 minmax(0,1fr) | 右栏与对话宽度分配待按 T05.03 复核 | P1 | workspace 槽即禅模式内容 |
| 研究工作台（任务看板） | 研究→任务 | ProjectsPage→TaskBoard 内嵌 | TaskBoardPage.css | 同上 | kanban-board 横滚 | 否 | <1200 降 3 列 | 卡片墙倾向，需按 T05.03 收敛 | P2 | 不适用 |
| 研究工作台（资料） | 研究→资料 | ProjectMaterialsPanel | ProjectMaterialsPanel.css | 同上 | 列表内部 | 否 | 部分 | 待 T05.03 复核 | P2 | 不适用 |
| 会话侧栏 | 聊天页左侧 | SessionSidebar | ChatPage.css | ChatPage leftPanel 槽 | chat-sidebar-list | 否 | 窄屏折叠 | 与 ProjectsPage 双层侧栏叠加时层级偏深 | P2 | AIO 不渲染 |
| 独立聊天布局 | workspaceMode 非 projects | ChatPage+ProjectShell | ProjectShell.css | ProjectShell 三栏 | 同上 | 否 | 有 collapse | 与研究页布局不完全同源 | P2 | 不适用 |
| 选题 Topic | 顶栏 选题 | TopicWorkspacePage | TopicWorkspacePage.css | 页内三栏 | 候选/对话各自 | Chatbot=WebContentsView | 部分 | 大面积空白（T05.01）；Chatbot 边界待验 | P1 | 不适用 |
| 场景 Scenario | 顶栏 场景 | ScenarioWorkbench/PersonalizationCenter | scenarioWorkbench.css/PersonalizationCenter.css | 页内三栏 | 步骤列表/编辑器 | 否（审批 Toast 为 DOM） | 部分 | 30 步横向撑宽风险（T05.02） | P1 | 不适用 |
| 成果 Outcomes | 顶栏 成果 | OutcomesPage | OutcomesPage.css | 树+编辑器+AI 三栏 | 各栏内部 | Office 独立进程窗口（非内嵌 WebContentsView） | 分栏可拖拽 | 文档画布已排除玻璃；长版本列表待验 | P1 | 不适用 |
| 投稿 Submission | 顶栏 投稿 | SubmissionWorkspacePage/SubmissionsPage | SubmissionWorkspacePage.css/SubmissionsPage.css | Browser 中心三栏 | 各栏 | 是（browserShow/browserHide） | resize 同步依赖 IPC | T05.05 边界矩阵待跑 | P1 | 不适用 |
| 设置 Settings | 顶栏 设置 | SettingsPanel+各 Section | App.css/各 section | 单列 section 流 | placeholder-page | 否 | max-width 900 | 全卡片化倾向（T05.06） | P2 | 不适用 |
| Personalization | 顶栏 场景（中心） | PersonalizationCenter | PersonalizationCenter.css | 页内多栏 | 各栏 | 否 | 部分 | badge 堆叠（T05.02） | P2 | 不适用 |
| Onboarding | 首启未配置 | OnboardingOverlay | App.css | 全屏卡 | 卡内 | 否 | — | 待按 T05.07 对齐新 token | P2 | 不适用 |
| Global Search | Ctrl+K / 顶栏 | GlobalSearch | GlobalSearch（内联样式+App.css） | 浮层 | 结果列表 | 需隐藏 native view | — | 已接入 collabHide/browserHide | P1 | AIO 禁用入口 |
| Command Palette | Ctrl+Shift+P | CommandBar | CommandBar.css | 浮层 | 列表 | 需隐藏 native view | — | 同上 | P2 | AIO 禁用 |
| Shortcut Help | 顶栏 ? | ShortcutsHelp | App.css | 弹窗 | 弹窗内 | 同上 | — | — | P3 | 不适用 |
| Modal（全部） | 各页 | ConfirmDialog/各页 modal | 各页 css | L4 overlay | — | 必须隐藏 native view | — | MutationObserver 已全局同步 | P1 | 临时允许 |
| Popover/Dropdown | 各页 | Popover/ui 组件 | ui.css | L3 | — | 同上 | — | 边缘碰撞检测待全面验证 | P2 | 临时允许 |
| Toast | 全局 | ToastHost | ToastHost.css | L4 顶部 | — | 否 | — | 单条策略已有 | P3 | 仅错误类 |
| Loading/Error/Empty | 各页 | AsyncFeedback/各页空态 | async.css/各页 | L2 | — | 否 | — | 部分空态空洞偏大 | P2 | zen 空态已收敛 |
| AIO Zen | 顶栏 专注 / 快捷键 | AioZenView | App.css(+MetisGlassTokens) | zen root | chat-messages | 否 | 640 断点 | 已重做（T07）：无 topbar/dock/侧栏 | P0 | 本体 |

## Native embedded views 登记册

| 视图 | Owner 页 | 显示/隐藏桥 | 备注 |
|---|---|---|---|
| Topic Chatbot（第三方 AI webview） | TopicWorkspacePage | collabShow/collabHide | App 级 overlay 打开时强制 hide，MutationObserver 兜底 |
| Submission Browser | SubmissionWorkspacePage | browserShow/browserHide | 同上；resize bounds 同步在 T05.05 验证 |
| 场景审批浮层 | ScenarioApprovalToast | — | z-approval=1200，打开时同时隐藏上两者 |
