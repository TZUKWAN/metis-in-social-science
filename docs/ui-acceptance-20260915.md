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

## judge P2 观察项（不阻断，列入积压）

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

## 工程门（合并后全量，真实输出）

- vitest：6048 passed / 0 failed（9 skipped，既有）
- typecheck：4 个 tsconfig 全过
- lint-gate：PASS
- IPC 快照：544/536/13，零漂移，无重复注册
