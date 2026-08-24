// Shared SVG icons — no emoji anywhere.

import React from 'react';

interface IconProps {
  size?: number;
  className?: string;
  color?: string;
}

const base = ({ size = 16, className, color, children }: IconProps & { children: React.ReactNode }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color ?? 'currentColor'}
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0, color }}
  >
    {children}
  </svg>
);

export const CheckIcon = (p: IconProps) => base({ ...p, children: <polyline points="20 6 9 17 4 12" /> });
export const CrossIcon = (p: IconProps) => base({ ...p, children: <><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></> });
export const WarningIcon = (p: IconProps) => base({ ...p, children: <><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></> });
export const TerminalIcon = (p: IconProps) => base({ ...p, children: <><polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" /></> });
export const PaperclipIcon = (p: IconProps) => base({ ...p, children: <><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" /></> });
export const BrainIcon = (p: IconProps) => base({ ...p, children: <><path d="M9.5 2a2.5 2.5 0 0 0-2.5 2.5v.1A2.5 2.5 0 0 0 4.5 7v.1A2.5 2.5 0 0 0 2.6 11.5 2.5 2.5 0 0 0 5 14.4v.1A2.5 2.5 0 0 0 7.5 17v1.5A2.5 2.5 0 0 0 10 21h.5a2 2 0 0 0 3.5-1.4V6.4a2.4 2.4 0 0 0-1.2-2.08L11.5 3A2.5 2.5 0 0 0 9.5 2Z" /><path d="M14.5 3.2a5 5 0 0 1 0 9.6M14.5 15.8a5 5 0 0 1 0 3.4" /></> });
export const TagIcon = (p: IconProps) => base({ ...p, children: <><path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42Z" /><circle cx="7.5" cy="7.5" r="1.5" /></> });
export const ClockIcon = (p: IconProps) => base({ ...p, children: <><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></> });
/** O15: 多模型对比——左右并排的两个面板。 */
export const CompareIcon = (p: IconProps) => base({ ...p, children: <><rect x="3" y="4" width="8" height="16" rx="1.5" /><rect x="13" y="4" width="8" height="16" rx="1.5" /></> });
export const RocketIcon = (p: IconProps) => base({ ...p, children: <><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" /><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" /><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" /><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" /></> });
export const SearchIcon = (p: IconProps) => base({ ...p, children: <><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></> });
export const PackageIcon = (p: IconProps) => base({ ...p, children: <><line x1="16.5" y1="9.4" x2="7.5" y2="4.21" /><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /><polyline points="3.27 6.96 12 12.01 20.73 6.96" /><line x1="12" y1="22.08" x2="12" y2="12" /></> });
export const PlayIcon = (p: IconProps) => base({ ...p, children: <polygon points="5 3 19 12 5 21 5 3" /> });
export const GearIcon = (p: IconProps) => base({ ...p, children: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></> });
export const FlaskIcon = (p: IconProps) => base({ ...p, children: <><path d="M10 2h4" /><path d="M12 2v15" /><path d="M19 9a7 7 0 1 0 0 12H5a7 7 0 1 0 0-12Z" /></> });
export const RefreshIcon = (p: IconProps) => base({ ...p, children: <><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></> });
export const SparklesIcon = (p: IconProps) => base({ ...p, children: <><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" /><path d="M5 3v4" /><path d="M19 17v4" /><path d="M3 5h4" /><path d="M17 19h4" /></> });

// File-type icons rendered as simple colored squares with a label letter.
export function FileTypeIcon({ type, size = 24 }: { type: string; size?: number }) {
  const labels: Record<string, string> = {
    pdf: 'PDF',
    docx: 'DOC',
    xlsx: 'XLS',
    pptx: 'PPT',
    md: 'MD',
    latex: 'TEX',
    other: 'FILE',
  };
  const label = labels[type] ?? type.toUpperCase();
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0 }}>
      <rect x="3" y="3" width="18" height="18" rx="3" fill="var(--primary)" opacity="0.12" />
      <rect x="3" y="3" width="18" height="18" rx="3" stroke="var(--primary)" strokeWidth="1.5" fill="none" />
      <text x="12" y="16" textAnchor="middle" fontSize="7" fontWeight="600" fill="var(--primary)">{label}</text>
    </svg>
  );
}
