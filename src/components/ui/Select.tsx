import { forwardRef, type SelectHTMLAttributes } from 'react';
import './ui.css';

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement>;

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className = '', children, ...props }, ref) => (
    <select ref={ref} className={`mui-select ${className}`} {...props}>
      {children}
    </select>
  ),
);

Select.displayName = 'Select';
