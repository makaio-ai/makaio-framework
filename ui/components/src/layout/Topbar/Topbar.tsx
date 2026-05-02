import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { clsx } from 'clsx';
import styles from './Topbar.module.scss';

/**
 * Breadcrumb item
 */
export interface BreadcrumbItem {
  /** Display label */
  label: string;
  /** Optional href for anchor link */
  href?: string;
  /** Optional click handler */
  onClick?: () => void;
}

/**
 * Topbar props
 */
export interface TopbarProps extends HTMLAttributes<HTMLDivElement> {
  /** Breadcrumb items for left side */
  breadcrumbs?: BreadcrumbItem[];
  /** Action buttons for right side */
  actions?: ReactNode;
  /** CSS class name */
  className?: string;
}

/**
 * Topbar component
 *
 * Fixed height navigation bar spanning the width of the main content area.
 * Left side displays breadcrumb navigation, right side displays action buttons.
 * @param breadcrumbs - Breadcrumb items for left side
 * @param actions - Action buttons for right side
 * @param className - CSS class name for custom styling
 * @param ref - Forwarded ref to the underlying div element
 * @returns The rendered Topbar component
 * @example
 * ```tsx
 * <Topbar
 *   breadcrumbs={[
 *     { label: 'Dashboard', href: '/dashboard' },
 *     { label: 'Chat', href: '/chat' },
 *     { label: 'New Session' }
 *   ]}
 *   actions={<Button>Save</Button>}
 * />
 * ```
 */
export const Topbar = forwardRef<HTMLDivElement, TopbarProps>(function Topbar(
  { breadcrumbs = [], actions, className, ...props },
  ref,
) {
  const classNames = clsx(styles.topbar, className);

  return (
    <div data-component="Topbar" ref={ref} className={classNames} {...props}>
      {/* Left: Breadcrumbs */}
      <div className={styles.breadcrumbs}>
        {breadcrumbs.map((crumb, index) => (
          <div key={`${crumb.label}-${index}`} className={styles.crumbWrapper}>
            {index > 0 && (
              <span className={styles.separator} aria-hidden="true">
                /
              </span>
            )}
            {crumb.href ? (
              <a href={crumb.href} className={styles.crumbLink} onClick={crumb.onClick}>
                {crumb.label}
              </a>
            ) : crumb.onClick ? (
              <button type="button" className={styles.crumb} onClick={crumb.onClick}>
                {crumb.label}
              </button>
            ) : (
              <span className={styles.crumb}>{crumb.label}</span>
            )}
          </div>
        ))}
      </div>

      {/* Right: Actions */}
      {actions && <div className={styles.actions}>{actions}</div>}
    </div>
  );
});
