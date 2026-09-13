import { type ReactNode, useState } from 'react';
import './ui.css';

export interface CollapsiblePanelProps {
  title: ReactNode;
  summary?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}

export function CollapsiblePanel({ title, summary, children, defaultOpen = false, className = '' }: CollapsiblePanelProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details className={`mui-collapsible${className ? ` ${className}` : ''}`} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span className="mui-collapsible__chevron" aria-hidden="true">›</span>
        <strong>{title}</strong>
        {summary && <span className="mui-collapsible__summary">{summary}</span>}
      </summary>
      <div className="mui-collapsible__body">{children}</div>
    </details>
  );
}
