import { forwardRef, type HTMLAttributes, type ReactNode, type Ref } from 'react';
import styles from './Panel.module.scss';

export type PanelVariant = 'default' | 'elevated' | 'bordered' | 'ghost';
export type PanelPadding = 'none' | 'sm' | 'md' | 'lg';

/**
 * Props for the Panel component
 * @param variant - Visual style variant (default, elevated, bordered, ghost)
 * @param padding - Body padding preset (none, sm, md, lg)
 * @param title - Optional header title
 * @param subtitle - Optional header subtitle
 * @param titlePrefix - Optional element to render before title (icon, badge, etc.)
 * @param actions - Optional actions to render in header
 * @param fullHeight - Whether the panel should take full height
 * @param className - Additional CSS class name
 * @param children - Panel content
 * @returns Panel component JSX element
 */
export interface PanelProps extends HTMLAttributes<HTMLDivElement> {
  /** Visual style variant */
  variant?: PanelVariant;
  /** Body padding preset */
  padding?: PanelPadding;
  /** Optional header title */
  title?: string;
  /** Optional header subtitle */
  subtitle?: string;
  /** Optional element to render before title */
  titlePrefix?: ReactNode;
  /** Optional actions to render in header */
  actions?: ReactNode;
  /** Full height container */
  fullHeight?: boolean;
  /**
   * Ref forwarded to the inner scrollable `.body` div.
   *
   * Use this when a child needs the scroll container element
   * (e.g. Virtuoso's `customScrollParent`).
   */
  bodyRef?: Ref<HTMLDivElement>;
}

/**
 * Panel component
 *
 * Container with optional header section for grouping related content
 * with clear visual boundaries. Features Aura theme glass morphism styling.
 * @param props - Component props
 * @returns Panel component JSX element
 */
export const Panel = forwardRef<HTMLDivElement, PanelProps>(function Panel(
  {
    variant = 'default',
    padding = 'md',
    title,
    subtitle,
    titlePrefix,
    actions,
    fullHeight = false,
    bodyRef,
    className,
    children,
    ...props
  },
  ref,
) {
  const hasHeader = !!(title || subtitle || titlePrefix || actions);

  const classNames = [styles.panel, styles[variant], fullHeight && styles.fullHeight, className]
    .filter(Boolean)
    .join(' ');

  const bodyClassNames = [styles.body, styles[`padding-${padding}`]].filter(Boolean).join(' ');

  return (
    <div data-component="Panel" ref={ref} className={classNames} {...props}>
      {hasHeader && (
        <div className={styles.header}>
          <div className={styles.headerMain}>
            {titlePrefix && <div className={styles.titlePrefix}>{titlePrefix}</div>}
            <div className={styles.headerText}>
              {title && <h3 className={styles.title}>{title}</h3>}
              {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
            </div>
          </div>
          {actions && <div className={styles.actions}>{actions}</div>}
        </div>
      )}
      <div ref={bodyRef} className={bodyClassNames}>
        {children}
      </div>
    </div>
  );
});
