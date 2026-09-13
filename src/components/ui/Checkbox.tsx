import { forwardRef, type InputHTMLAttributes } from 'react';
import './ui.css';

export type CheckboxProps = InputHTMLAttributes<HTMLInputElement>;

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className = '', ...props }, ref) => (
    <input ref={ref} type="checkbox" className={`mui-checkbox ${className}`} {...props} />
  ),
);

Checkbox.displayName = 'Checkbox';
