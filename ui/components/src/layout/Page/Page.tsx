/**
 * Page component
 *
 * A reusable layout container for standardizing the spacing, padding,
 * and layout structure of top-level application pages.
 *
 * Supports:
 * - Fixed full-height layout
 * - Standardized control over content padding (default yes, can opt-out)
 * - Semantic structure (main container)
 */
import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import styles from './Page.module.scss';

export interface PageProps {
  /** Page content */
  children: ReactNode;

  /**
   * Whether to remove default content padding.
   * Useful for views that manage their own internal layout/scrolling (e.g. Chat, Git).
   * Defaults to false.
   */
  noPadding?: boolean;

  /** Optional className for the root element */
  className?: string;

  /** Optional className for the content area */
  contentClassName?: string;
}

/**
 * Standard page layout container.
 * @param props - Component props
 * @example
 * ```tsx
 * <Page>
 *   <ContentHeader title="Projects" />
 *   <ProjectList />
 * </Page>
 * ```
 */
export function Page(props: PageProps) {
  const { children, noPadding = false, className, contentClassName } = props;

  return (
    <div className={clsx(styles.page, className)} data-component="Page">
      <main className={clsx(styles.content, noPadding && styles.noPadding, contentClassName)}>{children}</main>
    </div>
  );
}
