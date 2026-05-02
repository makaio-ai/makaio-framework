/**
 * NavSidebar Component
 *
 * Navigation sidebar for route-based or action-based navigation.
 * Supports both flat item lists and grouped sections.
 * Provides structural layout; link rendering can be supplied by the caller.
 */

import type { ReactNode } from 'react';
import { Logo } from '../../branding/index.js';
import { clsx } from 'clsx';
import { PanelLeft, PanelRight } from 'lucide-react';
import styles from './Sidebar.module.scss';

/**
 * Navigation item definition for NavSidebar.
 *
 * Items support two interaction models:
 * - Link-based: provide `path` for anchor/custom link rendering
 * - Action-based: provide `onClick` for button rendering
 */
export interface NavSidebarItem {
  /** Unique key for the item (falls back to path if not provided) */
  id?: string;
  /** Route path for link-based navigation */
  path?: string;
  /** Click handler for action-based navigation */
  onClick?: () => void;
  /** Display label for the nav item */
  label: string;
  /** Optional icon element */
  icon?: ReactNode;
  /** Optional active state */
  isActive?: boolean;
  /** Optional keyboard shortcut hint (display only) */
  shortcut?: string;
  /** Optional tooltip/description */
  title?: string;
  /**
   * Optional notification badge count.
   * Renders a count bubble on the icon when greater than 0.
   * Values greater than 99 render as "99+".
   */
  badge?: number;
}

/**
 * Grouped section of navigation items.
 *
 * Sections provide visual grouping with a label header and separator between groups.
 */
export interface NavSidebarSection {
  /** Unique section identifier */
  id: string;
  /** Display label for the section header */
  label: string;
  /** Navigation items in this section */
  items: NavSidebarItem[];
}

/**
 * Render function for custom link handling.
 * @param item - The navigation item being rendered
 * @param linkClassName - CSS class for the link element
 * @param activeClassName - CSS class for active state
 * @param children - Pre-rendered icon + label content
 */
export type NavSidebarLinkRenderer = (
  item: NavSidebarItem,
  linkClassName: string,
  activeClassName: string,
  children: ReactNode,
) => ReactNode;

/**
 * NavSidebar component props.
 *
 * Supports two rendering modes:
 * - Flat: provide `items` for a simple list
 * - Grouped: provide `sections` for labeled groups with separators
 *
 * When both are provided, flat items render before sections.
 */
export interface NavSidebarProps {
  /** Optional sidebar title displayed in header */
  title?: string;
  /** Flat navigation items (rendered before sections) */
  items?: NavSidebarItem[];
  /** Grouped navigation sections (rendered after flat items) */
  sections?: NavSidebarSection[];
  /** Optional footer content */
  footer?: ReactNode;
  /** Optional custom link renderer for link-based items */
  renderLink?: NavSidebarLinkRenderer;
  /** Additional CSS class */
  className?: string;
  /** Whether the sidebar is collapsed to icons only */
  collapsed?: boolean;
  /** Callback to toggle collapse state */
  onToggleCollapse?: () => void;
}

/**
 * Renders a single navigation item.
 *
 * Chooses element type based on interaction model:
 * - `onClick` provided: renders a `<button>`
 * - `path` + `renderLink` provided: delegates to custom renderer
 * - `path` only: renders an `<a>` element
 * @param item - Navigation item to render
 * @param renderLink - Optional custom link renderer
 */
function NavItem({ item, renderLink }: { item: NavSidebarItem; renderLink?: NavSidebarLinkRenderer }): ReactNode {
  const linkClassName = clsx(styles.navLink, item.isActive && styles.active);
  const title = item.title ?? item.label;
  const content = (
    <>
      {item.icon && (
        <span className={styles.navIcon}>
          {item.icon}
          {item.badge != null && item.badge > 0 && (
            <span className={styles.badge}>{item.badge > 99 ? '99+' : item.badge}</span>
          )}
        </span>
      )}
      <span className={styles.navLabel}>{item.label}</span>
      {item.shortcut && <span className={styles.shortcut}>{item.shortcut}</span>}
    </>
  );

  // Action-based: render a button
  if (item.onClick) {
    return (
      <button type="button" className={linkClassName} onClick={item.onClick} title={title}>
        {content}
      </button>
    );
  }

  // Link-based with custom renderer
  if (item.path && renderLink) {
    return renderLink(item, linkClassName, styles.active, content);
  }

  // Non-action and non-link items are render-only labels.
  // Keep this explicit so we never emit <a href={undefined}>.
  if (!item.path) {
    return (
      <span className={clsx(linkClassName, styles.staticItem)} title={title}>
        {content}
      </span>
    );
  }

  // Link-based with plain anchor
  return (
    <a href={item.path} className={linkClassName} title={title}>
      {content}
    </a>
  );
}

/**
 * Renders a list of navigation items.
 * @param items - Items to render
 * @param renderLink - Optional custom link renderer
 */
function NavItemList({
  items,
  renderLink,
}: {
  items: NavSidebarItem[];
  renderLink?: NavSidebarLinkRenderer;
}): ReactNode {
  return (
    <ul className={styles.navList}>
      {items.map((item, index) => (
        <li key={item.id ?? item.path ?? `${item.label}-${index}`} className={styles.navItem}>
          <NavItem item={item} renderLink={renderLink} />
        </li>
      ))}
    </ul>
  );
}

/**
 * Navigation sidebar component.
 *
 * Renders a sidebar with optional header, flat items, grouped sections,
 * footer, and collapse toggle. Supports both link-based and action-based
 * navigation items.
 * @param props - Component props
 */
export function NavSidebar(props: NavSidebarProps): ReactNode {
  const { title, items, sections, footer, renderLink, className, collapsed = false, onToggleCollapse } = props;
  const rootClassNames = clsx(styles.sidebar, collapsed && styles.collapsed, className);

  return (
    <aside data-component="NavSidebar" className={rootClassNames}>
      {/* Header */}
      <div className={styles.header}>
        {title ? <h2 className={styles.title}>{title}</h2> : <Logo className={styles.logo} />}
      </div>

      {/* Navigation */}
      <nav className={styles.nav}>
        {/* Flat items (rendered before sections) */}
        {items && items.length > 0 && <NavItemList items={items} renderLink={renderLink} />}

        {/* Grouped sections */}
        {sections?.map((section) =>
          section.items.length > 0 ? (
            <div key={section.id} className={styles.section}>
              <h3 className={styles.sectionTitle}>{section.label}</h3>
              <NavItemList items={section.items} renderLink={renderLink} />
            </div>
          ) : null,
        )}
      </nav>

      {/* Footer */}
      {footer && <div className={styles.footer}>{footer}</div>}

      {/* Collapse Toggle */}
      {onToggleCollapse && (
        <button
          type="button"
          className={styles.toggleButton}
          onClick={onToggleCollapse}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
        >
          {collapsed ? <PanelLeft size={16} /> : <PanelRight size={16} />}
        </button>
      )}
    </aside>
  );
}
