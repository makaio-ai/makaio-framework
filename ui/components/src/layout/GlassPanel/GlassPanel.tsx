import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import styles from './GlassPanel.module.scss';

/**
 * Props for GlassPanel component
 */
export interface GlassPanelProps extends HTMLAttributes<HTMLDivElement> {
  /** Child elements to render inside the panel */
  children: ReactNode;
  /** Enable hover effect (background brightens, border becomes more visible) */
  hoverable?: boolean;
  /** CSS class name for custom styling */
  className?: string;
}

/**
 * GlassPanel component
 *
 * Glass morphism effect panel with backdrop blur and semi-transparent background.
 * Used for floating panels, modals, dropdowns, and any UI element that needs
 * a subtle, modern glass-like appearance.
 * @param children - Child elements to render inside the panel
 * @param hoverable - Enable hover effect (background brightens, border becomes more visible)
 * @param className - CSS class name for custom styling
 * @param ref - Forwarded ref to the underlying div element
 * @returns The rendered GlassPanel component
 * @example
 * ```tsx
 * <GlassPanel hoverable>
 *   <p>Content with glass effect</p>
 * </GlassPanel>
 * ```
 */
export const GlassPanel = forwardRef<HTMLDivElement, GlassPanelProps>(function GlassPanel(
  { children, hoverable = false, className, ...props },
  ref,
) {
  const classNames = [styles.glassPanel, hoverable && styles.hoverable, className].filter(Boolean).join(' ');

  return (
    <div data-component="GlassPanel" ref={ref} className={classNames} {...props}>
      {children}
    </div>
  );
});
