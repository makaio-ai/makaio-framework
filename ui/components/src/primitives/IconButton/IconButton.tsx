import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import styles from './IconButton.module.scss';

export type IconButtonVariant = 'ghost' | 'filled';
export type IconButtonSize = 'sm' | 'md' | 'lg';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * Visual style variant
   * - ghost: transparent background with hover state (default)
   * - filled: solid background color
   */
  variant?: IconButtonVariant;

  /**
   * Size preset
   * - sm: 28px square
   * - md: 36px square
   * - lg: 44px square
   */
  size?: IconButtonSize;

  /**
   * Icon element to render
   */
  icon: ReactNode;

  /**
   * Accessibility label for screen readers. Required so every icon-only button
   * has an accessible name (WCAG 2.1 SC 4.1.2).
   * Callers may still override via the native `aria-label` spread prop when needed.
   */
  label: string;
}

/**
 * IconButton Component
 *
 * Square button for icon-only interactions.
 * Based on prototype nav-item pattern with Aura theme styling.
 * @param props - Component props
 * @returns Icon button element
 * @example
 * ```tsx
 * <IconButton
 *   icon={<CloseIcon />}
 *   label="Close"
 *   size="md"
 *   variant="ghost"
 * />
 * ```
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { variant = 'ghost', size = 'md', icon, label, type = 'button', className, ...props },
  ref,
) {
  const classNames = [styles.iconButton, styles[variant], styles[size], className].filter(Boolean).join(' ');

  return (
    <button data-component="IconButton" ref={ref} className={classNames} type={type} aria-label={label} {...props}>
      <span className={styles.iconWrapper}>{icon}</span>
    </button>
  );
});
