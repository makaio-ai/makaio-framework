import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import styles from './SlotPanel.module.scss';

export type SlotPanelPadding = 'none' | 'sm' | 'md' | 'lg';

/**
 * Props for the SlotPanel component.
 * @param padding - Inner padding preset
 * @param className - Additional CSS class name
 * @param children - Panel content
 * @returns SlotPanel component JSX element
 */
export interface SlotPanelProps extends HTMLAttributes<HTMLDivElement> {
  /** Inner padding preset */
  padding?: SlotPanelPadding;
  /** Panel content */
  children: ReactNode;
}

/**
 * SlotPanel component.
 *
 * Consistent container styling for page slot content.
 * @param props - Component props
 * @returns SlotPanel component JSX element
 */
export const SlotPanel = forwardRef<HTMLDivElement, SlotPanelProps>(function SlotPanel(
  { padding = 'md', className, children, ...props },
  ref,
) {
  const classNames = [styles.slotPanel, styles[`padding-${padding}`], className].filter(Boolean).join(' ');

  return (
    <div data-component="SlotPanel" ref={ref} className={classNames} {...props}>
      {children}
    </div>
  );
});
