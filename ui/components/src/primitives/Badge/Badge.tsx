import type { ReactNode, HTMLAttributes } from 'react';
import styles from './Badge.module.scss';

/**
 * Badge variant types
 *
 * Maps to semantic color categories in the Aura design system.
 */
export type BadgeVariant = 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

/**
 * Badge size types
 *
 * - sm: Small badges with uppercase text and wider letter-spacing
 * - md: Medium badges with normal text styling
 */
export type BadgeSize = 'sm' | 'md';

/**
 * Badge component props
 *
 * Extends standard HTML span attributes for full flexibility.
 */
export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  /**
   * Badge variant - maps to theme accent colors
   */
  variant?: BadgeVariant;

  /**
   * Badge size preset
   */
  size?: BadgeSize;

  /**
   * Optional icon to display on the left side
   */
  icon?: ReactNode;

  /**
   * Badge content
   */
  children: ReactNode;
}

/**
 * Badge component
 *
 * A compact component for displaying status indicators, labels, or counts.
 * Supports multiple variants mapped to theme accent colors and two size presets.
 *
 * Small badges use uppercase text with wider letter-spacing for improved readability
 * at small sizes, matching the Aura design system badge pattern.
 * @param props - Component props
 * @returns Badge component
 * @example
 * ```tsx
 * <Badge variant="success" size="sm">Active</Badge>
 * <Badge variant="primary">New Feature</Badge>
 * <Badge variant="danger" icon={<AlertIcon />}>Error</Badge>
 * ```
 */
export function Badge({
  variant = 'default',
  size = 'md',
  icon,
  children,
  className,
  ...restProps
}: BadgeProps): ReactNode {
  const badgeClass = [styles.badge, styles[`variant-${variant}`], styles[`size-${size}`], className]
    .filter(Boolean)
    .join(' ');

  return (
    <span data-component="Badge" className={badgeClass} {...restProps}>
      {icon && <span className={styles.icon}>{icon}</span>}
      <span className={styles.content}>{children}</span>
    </span>
  );
}
