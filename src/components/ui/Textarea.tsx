import { forwardRef, type TextareaHTMLAttributes } from 'react';
import './ui.css';

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className = '', ...props }, ref) => (
    <textarea ref={ref} className={`mui-textarea ${className}`} {...props} />
  ),
);

Textarea.displayName = 'Textarea';
