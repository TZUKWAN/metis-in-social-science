# UI Overhaul Baseline（T00.01）

- 执行时间：2026-09-14（UTC+8 凌晨开始，截止当日 08:55）
- BASELINE_SHA：`af6b38c3fa425f680a870b778caac03a87189e0d`
- `git status` 干净（除本次任务产生的修改）；无其他 AGENT 未提交修改需要避让。
- 远端：`origin = https://github.com/TZUKWAN/metis-in-social-science.git`，main 已 `--ff-only` 同步至 baseline。

## 基线工程状态（baseline 提交自带证据）

- typecheck：通过（4 个 tsconfig）
- lint：0 errors / 18 warnings（既有 hook deps）
- IPC 快照：invoke 544 / rendererInvoke 536 / send 13，与 golden 零差异
- 前端 Vitest：108 文件 / 1247 测试通过
- Electron 开发实例：PersistenceStore initialized；场景/研究/成果页真窗已验收

## 已知视觉基线事实（承接任务书 Appendix A）

1. `src/SkyAgentTheme.css` 为最后加载覆盖层，含 `!important`；本任务以
   `src/theme/MetisGlassTokens.css`（--fx-* token + L0–L4 层级）作为新 UI 的
   主导 token 层，新组件直接消费 token。
2. 旧 AIO（baseline 时）= topbar 常驻 + `aio-dock`（成果/投稿/设置），与本任务
   定义冲突；已按 T07 重做为 presentation branch。
3. `run-electron-layout-acceptance.py` 存在，但其 responsive/pixel 矩阵非 gate，
   不能作为本任务最终验收；本任务使用真实 Electron + computer-use + 几何断言。

## 验收数据

- 真实 userData（`C:/Users/lauze/AppData/Roaming/metis-workbench`）在验收前克隆到
  `logs/ui-acceptance-data/<timestamp>/real-userdata-clone/`，Electron 以
  `--user-data-dir=<clone>` 启动（与现有 acceptance 脚本同机制），禁止在真实
  userData 上做破坏性测试。
