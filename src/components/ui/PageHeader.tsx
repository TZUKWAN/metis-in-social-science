import { type ReactNode } from 'react';
import './ui.css';

export interface PageHeaderProps {
  title: string;
  description?: string;
  eyebrow?: string;
  icon?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function PageHeader({ title, description, eyebrow, icon, actions, className = '' }: PageHeaderProps) {
  return (
    <header className={`mui-page-header${className ? ` ${className}` : ''}`}>
      <div className="mui-page-header__copy">
        {eyebrow && <span className="mui-page-header__eyebrow">{eyebrow}</span>}
        <div className="mui-page-header__title-row">
          {icon && <span className="mui-page-header__icon" aria-hidden="true">{icon}</span>}
          <h1>{title}</h1>
        </div>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="mui-page-header__actions">{actions}</div>}
    </header>
  );
}
