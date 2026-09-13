import { type HTMLAttributes, forwardRef } from 'react';
import './ui.css';

export type ScrollAreaProps = HTMLAttributes<HTMLDivElement>;

export const ScrollArea = forwardRef<HTMLDivElement, ScrollAreaProps>(
  ({ className = '', children, ...props }, ref) => (
    <div ref={ref} className={`mui-scroll-area ${className}`} {...props}>
      {children}
    </div>
  ),
);

ScrollArea.displayName = 'ScrollArea';
