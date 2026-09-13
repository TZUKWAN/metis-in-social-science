import { forwardRef, type HTMLAttributes } from 'react';
import './ui.css';

export interface GlassSurfaceProps extends HTMLAttributes<HTMLDivElement> {
  level?: 'base' | 'raised' | 'floating';
}

export const GlassSurface = forwardRef<HTMLDivElement, GlassSurfaceProps>(
  ({ level = 'base', className = '', ...props }, ref) => (
    <div ref={ref} className={`mui-glass mui-glass--${level}${className ? ` ${className}` : ''}`} {...props} />
  ),
);
GlassSurface.displayName = 'GlassSurface';
