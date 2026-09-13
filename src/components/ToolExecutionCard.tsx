import { useState, type ReactNode } from 'react';
import type { AgentToolResultSource } from '../../engine/runtime/ChatRuntimeContract.js';
import type {
  AssistantToolPart,
  LegacyAssistantToolCall,
} from '../lib/assistantMessagePartsReducer';
import { presentDiagnosticText, presentExecutionAction } from '../presentation/executionPresentation';
import { presentSafeMarkdownText, type SafeMarkdownMode } from '../presentation/SafeMarkdown';

export interface ToolExecutionCardProps {
  tool?: AssistantToolPart | LegacyAssistantToolCall;
  diagnosticMode?: boolean;
  locale: 'zh' | 'en';
  /** Button mode is used for a standalone legacy tool message; disclosure mode is used in timelines. */
  mode?: 'button' | 'disclosure';
  className?: string;
  testId?: string;
  icon?: ReactNode;
}

function normalizeTool(
  tool: AssistantToolPart | LegacyAssistantToolCall,
): AssistantToolPart {
  return {
    toolCallId: tool.toolCallId ?? `tool-${tool.name}`,
    name: tool.name,
    arguments: tool.arguments ?? '',
    ...(tool.result !== undefined ? { result: tool.result } : {}),
    ...(tool.error !== undefined ? { error: tool.error } : {}),
    status: tool.status,
    sources: tool.sources ?? [],
  };
}

function statusLabel(status: AssistantToolPart['status'], locale: 'zh' | 'en'): string {
  if (locale === 'zh') {
    return status === 'running' ? '运行中' : status === 'completed' ? '已完成' : '失败';
  }
  return status === 'running' ? 'Running' : status === 'completed' ? 'Completed' : 'Failed';
}

function safeDetail(value: string, diagnosticMode: boolean, locale: 'zh' | 'en'): string {
  const mode: SafeMarkdownMode = diagnosticMode ? 'diagnostic' : 'normal';
  return presentSafeMarkdownText(value, mode, locale);
}

function sourcesView(sources: AgentToolResultSource[], locale: 'zh' | 'en'): ReactNode {
  if (sources.length === 0) return null;
  return (
    <ul className="tool-execution-card__sources" aria-label={locale === 'zh' ? '工具返回的来源' : 'Tool-returned sources'}>
      {sources.map((source, index) => (
        <li key={`${source.label}-${source.url ?? index}`}>
          {source.url
            ? <a href={source.url} target="_blank" rel="noreferrer">{source.label}</a>
            : <span>{source.label}</span>}
        </li>
      ))}
    </ul>
  );
}

export function ToolExecutionCard({
  tool: suppliedTool,
  diagnosticMode = false,
  locale,
  mode = 'button',
  className = '',
  testId,
  icon,
}: ToolExecutionCardProps) {
  const [expanded, setExpanded] = useState(false);
  if (!suppliedTool) return null;
  const tool = normalizeTool(suppliedTool);
  const label = presentExecutionAction(tool.name, locale);
  const status = statusLabel(tool.status, locale);
  const hasDetail = Boolean(tool.arguments.trim() || tool.result?.trim() || tool.error?.trim() || tool.sources.length);
  const result = tool.result?.trim() ? safeDetail(tool.result, diagnosticMode, locale) : '';
  const error = tool.error?.trim() ? safeDetail(tool.error, diagnosticMode, locale) : '';
  const rootClass = `tool-execution-card tool-execution-card--${tool.status}${className ? ` ${className}` : ''}`;
  const body = hasDetail ? (
    <div className="tool-execution-card__body tool-call-body agent-tool-result__body">
      {result && <section className="tool-execution-card__section tool-call-section"><h4>{locale === 'zh' ? '结果' : 'Result'}</h4><p className="tool-call-result-preview">{result}</p></section>}
      {diagnosticMode && (
        <section className="tool-execution-card__section tool-call-section">
          <h4>{locale === 'zh' ? '内部操作标识' : 'Technical action'}</h4>
          <pre className="tool-call-code">{presentDiagnosticText(tool.name)}</pre>
        </section>
      )}
      {error && <section className="tool-execution-card__section tool-call-section tool-call-section--error"><h4>{locale === 'zh' ? '失败原因' : 'Failure reason'}</h4><p className="tool-call-result-preview agent-tool-result__error">{error}</p></section>}
      {tool.sources.length > 0 && <div className="tool-call-section">{sourcesView(tool.sources, locale)}</div>}
      {diagnosticMode && tool.arguments.trim() && (
        <section className="tool-execution-card__section tool-call-section">
          <h4>{locale === 'zh' ? '技术参数' : 'Technical arguments'}</h4>
          <pre className="tool-call-code">{presentDiagnosticText(tool.arguments).slice(0, 4000)}</pre>
        </section>
      )}
    </div>
  ) : null;

  if (mode === 'disclosure') {
    return (
      <details
        className={`${rootClass} agent-tool-result`}
        data-testid={testId ?? 'agent-tool-result'}
        open={expanded}
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary className="tool-execution-card__summary agent-tool-result__summary">
          {icon ?? <span className="tool-execution-card__marker agent-activity-timeline__event-marker" aria-hidden="true" />}
          <span className="tool-execution-card__name">{label}</span>
          <span className="tool-execution-card__status">{status}</span>
        </summary>
        {body}
      </details>
    );
  }

  return (
    <div className={rootClass} data-testid={testId}>
      <button
        type="button"
        className="tool-execution-card__summary tool-call-header"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-label={`${label} — ${status}`}
      >
        {icon ?? <span className="tool-execution-card__marker tool-call-icon" aria-hidden="true">◌</span>}
        <span className="tool-execution-card__name">{label}</span>
        <span className="tool-execution-card__status">{status}</span>
        <span className="tool-execution-card__chevron" aria-hidden="true">{expanded ? '⌃' : '⌄'}</span>
      </button>
      {expanded && body}
    </div>
  );
}

export default ToolExecutionCard;
