import { type ReactNode, useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import './ui.css';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'default' | 'lg';
}

export function Dialog({ open, onOpenChange, title, children, footer, size = 'default' }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onOpenChange]);

  if (!open) return null;

  return (
    <div
      className="mui-dialog-overlay modal-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onOpenChange(false); }}
      role="presentation"
    >
      <div
        ref={ref}
        className={`mui-dialog mui-dialog--${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? 'mui-dialog-title' : undefined}
      >
        {title && (
          <div className="mui-dialog__header">
            <h2 id="mui-dialog-title" className="mui-dialog__title">{title}</h2>
            <button
              type="button"
              className="mui-dialog__close"
              onClick={() => onOpenChange(false)}
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>
        )}
        <div className="mui-dialog__body">{children}</div>
        {footer && <div className="mui-dialog__footer">{footer}</div>}
      </div>
    </div>
  );
}
