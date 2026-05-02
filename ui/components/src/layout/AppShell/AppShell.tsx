import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import styles from './AppShell.module.scss';

export interface AppShellProps extends HTMLAttributes<HTMLDivElement> {
  /** Left sidebar content (IconSidebar) */
  sidebar?: ReactNode;
  /** Top navigation bar content */
  topbar?: ReactNode;
  /** Main content area */
  children: ReactNode;
  /** Bottom panel slot (e.g., terminal, git status) */
  bottomPanel?: ReactNode;
  /** Optional footer content */
  footer?: ReactNode;
  /** Whether sidebar is collapsed (responsive behavior) */
  sidebarCollapsed?: boolean;
}

/**
 * AppShell component
 *
 * Main layout container for the web app. Provides a CSS Grid-based layout with slots for:
 * - Sidebar (64px left sidebar for icon navigation)
 * - Topbar (top navigation bar)
 * - Main content area
 * - Bottom panel (terminal, git status, problems)
 * - Optional footer
 *
 * Matches the visual structure from design-concept/prototype.html
 * @param sidebar - Left sidebar content (IconSidebar)
 * @param topbar - Top navigation bar content
 * @param children - Main content area
 * @param bottomPanel - Bottom panel content (e.g., PanelSlot)
 * @param footer - Optional footer content
 * @param sidebarCollapsed - Whether sidebar is collapsed (responsive behavior)
 * @param className - CSS class name for custom styling
 * @param ref - Forwarded ref to the underlying div element
 * @returns The rendered AppShell layout component
 * @example
 * ```tsx
 * <AppShell
 *   sidebar={<IconSidebar />}
 *   topbar={<Topbar />}
 *   bottomPanel={<PanelSlot {...panelProps} />}
 *   footer={<Footer />}>
 *   <MainContent />
 * </AppShell>
 * ```
 */
export const AppShell = forwardRef<HTMLDivElement, AppShellProps>(function AppShell(
  { sidebar, topbar, children, bottomPanel, footer, sidebarCollapsed = false, className, ...props },
  ref,
) {
  const shellClassNames = [styles.appShell, sidebarCollapsed && styles.sidebarCollapsed, className]
    .filter(Boolean)
    .join(' ');

  return (
    <div data-component="AppShell" ref={ref} className={shellClassNames} {...props}>
      {sidebar && <aside className={styles.sidebar}>{sidebar}</aside>}
      <div className={styles.mainWrapper}>
        {topbar && <header className={styles.topbar}>{topbar}</header>}
        <main className={styles.main}>{children}</main>
        {bottomPanel && <div className={styles.bottomPanel}>{bottomPanel}</div>}
        {footer && <footer className={styles.footer}>{footer}</footer>}
      </div>
    </div>
  );
});
