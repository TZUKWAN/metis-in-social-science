const fs = require('fs');
const checks = [
  ['src/pages/ChatPage.tsx', ['settleStreamingPlaceholder', 'refreshSessionSummaries', 'goalSuggestion', 'incomplete-draft', 'goal-suggestion-bar', 'messages.length, refreshSessionSummaries]']],
  ['src/pages/TaskBoardPage.tsx', ['kanban-new-task-project', 'defaultTaskProject', 'researchWorkspaceStore']],
  ['src/pages/AutonomousResearchPage.tsx', ['id="strategy-select"', 'id="structure-select"']],
  ['src/research/StrategyEditor.tsx', ['aria-label']],
  ['src/components/GlobalSearch.tsx', ['role="dialog"', 'aria-modal="true"', 'overlayRef']],
  ['src/components/SettingsProjectArchiveSection.tsx', ['htmlFor="project-archive-select"']],
  ['electron/ChatTurnService.ts', ['CHAT_DEFAULT_MAX_TURNS']],
  ['electron/main.ts', ['rawDescription', 'GOAL_RUNTIME_LIMITS.labelChars']],
  ['tests/frontend/ChatPageStreamSettle.test.tsx', ['UX-CHAT-002', 'UX-CHAT-004']],
  ['scripts/platform-background-simulation.mjs', ['goal-suggestion-bar', 'structure-platform-1', 'kanban-new-task-project', 'common.refresh']],
  ['src/i18n/locales/zh.ts', ["refresh: '刷新'", "title: '全局搜索'", "projectSelect: '选择项目'", "taskProject: '任务归属'"]],
  ['src/i18n/locales/en.ts', ["refresh: 'Refresh'", "title: 'Global Search'", "projectSelect: 'Select project'", "taskProject: 'Task project'"]],
];
let allOk = true;
for (const [file, needles] of checks) {
  const s = fs.readFileSync('D:/LATEXTEST/metis-alpha2-release/' + file, 'utf8');
  const missing = needles.filter((n) => !s.includes(n));
  if (missing.length) allOk = false;
  console.log((missing.length === 0 ? 'OK  ' : 'MISS ') + file + (missing.length ? ' -> ' + missing.join(' | ') : ''));
}
process.exit(allOk ? 0 : 1);