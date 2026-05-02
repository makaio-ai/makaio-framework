import { type ReactNode } from 'react';
import styles from './IconSidebar.module.scss';

export interface NavItem {
  /** Unique identifier for the nav item */
  id: string;
  /** Icon element to display */
  icon: ReactNode;
  /** Accessible label for the button (used as aria-label and tooltip) */
  label: string;
  /** Whether this item is currently active */
  active?: boolean;
  /** Click handler */
  onClick?: () => void;
}

export interface IconSidebarProps {
  /** Navigation items for main section */
  navItems: NavItem[];
  /** Navigation items for bottom section (profile, settings) */
  bottomItems?: NavItem[];
  /** CSS class name */
  className?: string;
}

/**
 * Map an array of nav items to `IconSidebarItem` elements.
 * @param items - Nav items to render.
 * @returns Array of keyed `IconSidebarItem` elements.
 */
function renderItems(items: NavItem[]) {
  return items.map((item) => <IconSidebarItem key={item.id} item={item} />);
}

/**
 * IconSidebar component
 *
 * Vertical icon navigation sidebar (64px wide).
 * Displays context navigation icons with active states and hover effects.
 * Based on design-concept/prototype.html lines 122-195.
 * @param navItems - Navigation items for main section
 * @param bottomItems - Navigation items for bottom section (profile, settings)
 * @param className - CSS class name for custom styling
 * @returns The rendered IconSidebar component
 */
export function IconSidebar({ navItems, bottomItems = [], className }: IconSidebarProps) {
  const rootClassNames = [styles.sidebar, className].filter(Boolean).join(' ');

  return (
    <aside data-component="IconSidebar" className={rootClassNames}>
      {/* Main navigation section */}
      <nav className={styles.navSection}>{renderItems(navItems)}</nav>

      {/* Bottom section for profile/settings */}
      <div className={styles.bottomSection}>{renderItems(bottomItems)}</div>
    </aside>
  );
}

interface NavItemComponentProps {
  /** Nav item configuration */
  item: NavItem;
}

/**
 * Internal navigation item component
 * @param item - Nav item configuration
 * @returns The rendered navigation item button
 */
function IconSidebarItem({ item }: NavItemComponentProps) {
  const itemClassNames = [styles.navItem, item.active && styles.active].filter(Boolean).join(' ');
  const isInteractive = typeof item.onClick === 'function';

  return (
    <button
      type="button"
      className={itemClassNames}
      onClick={item.onClick}
      disabled={!isInteractive}
      title={item.label}
      aria-label={item.label}
      aria-current={item.active ? 'page' : undefined}
      data-component="IconSidebarItem"
    >
      <span className={styles.icon}>{item.icon}</span>
      {item.active && <span className={styles.activeIndicator} />}
    </button>
  );
}
