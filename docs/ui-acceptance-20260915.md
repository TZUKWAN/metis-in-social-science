# UI 多分辨率验收报告（2026-09-15）

## 验收范围与工具

- `scripts/ui-feature-sweep.cjs`：真实 Electron 隔离 profile，30 条功能断言。
- `scripts/ui-resolution-matrix.cjs`（本批新增）：5 视口（1280×800 / 1440×900 /
  1600×900 / 1920×1080 / 2560×1440）× 6 surfaces（chat/topics/scenarios/
  outcomes/submissions/settings），每格断言：真实窗口 resize 生效、无横向文档
  溢出、顶栏 6 个一级导航几何可见、Scroll owner 容器存在且唯一（空态走
  eitherGroup 并实况记录命中分支）、composer 可见（chat）、截图 PNG 字节数>1000。
- 视觉验收：judge 对全部截图逐张评审（布局/视觉一致性/可用性/内容）。

## 两轮结果

| 轮次 | 功能 sweep | 分辨率矩阵 | 视觉 judge | P0/P1 |
|---|---|---|---|---|
| 第一轮 | 30/30（`logs/ui-feature-sweep-20260915060409.json`，含 relaunch PASS） | 164/164（`logs/ui-resolution-matrix-20260915065315.json`） | 30 张中 29 pass；1600×900 settings 被投稿原生视图覆盖判 P1 | P0=0，P1=1 |
| 第二轮 | —（同日 sweep 已绿） | 164/164（`logs/ui-resolution-matrix-20260915070538.json`） | settings 5 视口全 pass（1600 竞态已关） | **P0=0，P1=0** |

第一轮 P1（截图竞态）根因：投稿内嵌 WebContentsView 的隐藏经
MutationObserver 异步生效，capturePage 合成时原生层尚未退场。修复：surface
切换后统一 settle 700ms 再断言/截图（`scripts/ui-resolution-matrix.cjs`）。

## harness 首跑暴露并修复的问题（均为 harness bug，非产品缺陷）

1. `waitForDom` 把 CSS 选择器当 JS 表达式拼接（`Boolean(.chat-messages)` 语法错）。
2. `viewport-applied` 容差未考虑 Windows 显示缩放舍入（105% 下 innerWidth
   偏差 3px > 2px），改为 2px + 视口 1%，实测值仍完整记录。
3. outcomes 空态：无科研项目时产品正确渲染 `.outcomes-empty`
   （OutcomesPage.tsx），readySelector/eitherGroup 补充该分支。

## judge P2 观察项处置（2026-09-15 第二批）

- ✅ **已修**：设置页外观区强调色色板深色背景不可辨。真因不止是亮色值——
  `SkyAgentTheme.css` 全局 `button` 重置（background/border-radius/box-shadow
  带 !important）把色板内联样式全部压掉，只剩空心方框（首版修主题取值被
  judge 如实判 fail 后定位）。终版：色板加 `accent-swatch` class + 覆盖层
  例外规则，填充色经 `--swatch-fill` 按解析后主题注入；自定义渐变圆同机制
  （`accent-swatch-custom`）。judge 终验 PASS（20260915080619 截图）。
- ✅ **已修**：场景页中栏空态构图头重脚轻。根因是 `.scenario-workbench__editor`
  网格三行模板与四个子元素错位——1fr 落在 notice 行，空态掉进隐式 auto 行
  高度塌陷。终版：四行模板 + 编辑区/空态显式 `grid-row: 4`，空态水平垂直
  居中。judge PASS（20260915075822 截图）。
- ⏳ **积压（环境依赖）**：投稿内嵌浏览器首屏空白（eshukan.com）。按验收边界
  「Native WebContentsView 只审宿主边界」不阻断；待联网环境复核内容加载。
- ✅ topics 空态卡片锚定下半部：判定为设计取向（三分辨率一致），不修。

## P2 观察项（第一批记录，其中两项已在上文修复）

- 设置页外观区强调色色板在深色背景下对比度偏低（1920/2560 均现）。
- 场景页中栏空态文案靠左上、右侧留白偏大（1920/2560 均现）。
- topics 空态卡片锚定下半部、上方留白偏大（设计取向，三分辨率一致）。
- 投稿内嵌浏览器首屏空白（eshukan.com）：按 ui-surface-inventory 验收边界
  「Native WebContentsView 只审宿主边界」，第三方站点内容属范围外；宿主边界
  （显示/隐藏/resize 同步）已由矩阵与 sweep 覆盖。联网环境复核列入积压。

## 本批代码变更

- ChatPage 解耦第三批：会话操作 hook（`useChatSessionActions.ts`）+ composer
  键盘工厂（`createComposerKeyDownHandler.ts`），ChatPage.tsx 2,605 → 2,488。
- T05.06 Settings 卡片化收敛 + T05.07 OnboardingOverlay 对齐 Design System
  token（10 文件；`--ds-overlay-scrim` bridge token 只增未删）。
- 新增多分辨率矩阵 harness（本报告工具）。

## 打包应用验收（2026-09-15）

- `npx electron-builder --dir -c.directories.output=release7`：打包成功（含
  signtool 对 node-pty 随附 exe 的签名）。注意 `release6` 目录存在系统句柄
  锁死的 `win-unpacked.tmp`（EBUSY），与产物无关，未影响本验收。
- 打包冒烟（`scripts/packaged-smoke.mjs`，证据
  `logs/packaged-smoke-20260915.json`）：`Metis Research Workbench.exe` 以
  隔离 `METIS_USER_DATA_DIR` 启动 → `DevToolsActivePort` 出现 → CDP
  `/json/list` 见真实渲染页 `metis-app://renderer/index.html` → 进程 30 秒
  存活 → 按记录 PID 树清理。**PASS**。

## 工程门（合并后全量，真实输出）

- vitest：6048 passed / 0 failed（9 skipped，既有）
- typecheck：4 个 tsconfig 全过
- lint-gate：PASS
- IPC 快照：544/536/13，零漂移，无重复注册
