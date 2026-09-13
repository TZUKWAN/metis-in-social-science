import { type ReactNode } from 'react';
import './ui.css';

export type StatusChipTone = 'running' | 'success' | 'warning' | 'danger' | 'neutral';

export interface StatusChipProps {
  tone?: StatusChipTone;
  children: ReactNode;
  className?: string;
  dot?: boolean;
}

export function StatusChip({ tone = 'neutral', children, className = '', dot = true }: StatusChipProps) {
  return (
    <span className={`mui-status-chip mui-status-chip--${tone}${className ? ` ${className}` : ''}`}>
      {dot && <span className="mui-status-chip__dot" aria-hidden="true" />}
      <span>{children}</span>
    </span>
  );
}
