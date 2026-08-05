/**
 * Slash command definitions for the chat input.
 * Each command maps to an existing system capability (no new backend work).
 */

export interface SlashCommand {
  name: string;
  description: string;
  /** Placeholder text for the argument input. */
  argPlaceholder?: string;
  /** Whether the command takes an argument. */
  hasArg: boolean;
  /** Whether the command is always available or context-dependent. */
  requiresArg?: boolean;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'chat', description: '纯聊天（跳过场景匹配和任务检测）', hasArg: true, requiresArg: true, argPlaceholder: '输入聊天内容…' },
  { name: 'goal', description: '创建目标任务（自动拆解为工作流，同步到看板）', hasArg: true, requiresArg: true, argPlaceholder: '输入任务描述…' },
  { name: 'autonomous', description: '启动自主科研（idea→实验→分析→论文全自动闭环）', hasArg: true, requiresArg: true, argPlaceholder: '输入研究目标…' },
  { name: 'task', description: '同 /goal（创建目标任务）', hasArg: true, requiresArg: true, argPlaceholder: '输入任务描述…' },
  { name: 'scenario', description: '切换到指定场景', hasArg: true, requiresArg: true, argPlaceholder: '输入场景名称…' },
  { name: 'search', description: '打开全文搜索（Ctrl+K）', hasArg: true, requiresArg: true, argPlaceholder: '输入搜索关键词…' },
  { name: 'paper', description: '快速添加文献到当前项目', hasArg: true, requiresArg: true, argPlaceholder: '输入论文标题或 DOI…' },
  { name: 'note', description: '快速记笔记到当前项目', hasArg: true, requiresArg: true, argPlaceholder: '输入笔记内容…' },
  { name: 'export', description: '导出当前会话或文献库', hasArg: true, requiresArg: false, argPlaceholder: '输入格式（chat/bibtex/csv/html，默认 chat）…' },
  { name: 'stop', description: '中断当前运行的任务', hasArg: false },
  { name: 'pause', description: '暂停当前目标', hasArg: false },
  { name: 'resume', description: '恢复暂停的目标', hasArg: false },
  { name: 'status', description: '显示当前项目/任务/场景状态', hasArg: false },
  { name: 'help', description: '显示可用命令列表', hasArg: false },
];

/** Match a slash command prefix (case-insensitive). */
export function matchSlashCommand(input: string): { command: SlashCommand; arg: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;
  const spaceIdx = trimmed.indexOf(' ');
  const cmdName = (spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx)).toLowerCase();
  const arg = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();
  const cmd = SLASH_COMMANDS.find((c) => c.name === cmdName);
  if (!cmd) return null;
  // Commands that require an argument: return null if missing.
  if (cmd.requiresArg) {
    // Check there's a space after the command name (indicating an arg follows).
    const afterCmd = trimmed.slice(1 + cmdName.length).trim();
    if (!afterCmd) return null;
  }
  return { command: cmd, arg };
}

/** Filter commands by prefix for the dropdown. */
export function filterSlashCommands(prefix: string): SlashCommand[] {
  const p = prefix.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(p) || c.description.toLowerCase().includes(p));
}
