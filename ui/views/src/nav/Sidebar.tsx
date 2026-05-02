/**
 * Sidebar - Data-driven navigation sidebar
 *
 * Connected wrapper that wires framework hooks to NavSidebar:
 * - Page definitions from the navigation registry (grouped by NavigationGroup)
 * - Collapsed state from useSidebarStore (persisted to localStorage per navigation level)
 * @packageDocumentation
 */
import { useMemo, type ReactNode } from 'react';
import { useWindowIdPages, useNavigationLevel, useSidebarStore, groupPagesByNavigationGroup } from '@makaio/ui-hooks';
import type { ExecutablePage } from '@makaio/ui-hooks';
import { defaultNavigationGroups } from '@makaio/ui-kernel';
import { NavSidebar } from '@makaio/ui-components';
import type { NavSidebarItem, NavSidebarSection } from '@makaio/ui-components';

/**
 * Maps an ExecutablePage to a NavSidebarItem.
 * @param page - Page definition with navigation action.
 * @returns NavSidebar-compatible item.
 */
function toNavItem(page: ExecutablePage): NavSidebarItem {
  const Icon = page.icon;
  return {
    icon: Icon ? <Icon size={16} /> : undefined,
    id: page.id,
    isActive: page.isActive,
    label: page.name,
    onClick: page.execute,
    shortcut: page.shortcut,
    title: page.description ?? page.name,
  };
}

/**
 * Sidebar navigation component.
 *
 * Reads page definitions from registry, groups by NavigationGroup,
 * and delegates rendering to NavSidebar. Collapsed state is persisted
 * per navigation level via useSidebarStore (localStorage).
 * @returns Sidebar navigation UI, or null if no pages are available.
 */
export function Sidebar(): ReactNode {
  const level = useNavigationLevel();
  const surface = window.__MAKAIO_MOBILE__ ? ('mobile' as const) : ('web' as const);
  const allPages = useWindowIdPages({ level, surface });
  const isCollapsed = useSidebarStore((s) => s.isCollapsed(level));
  const toggle = useSidebarStore((s) => s.toggle);

  const sections: NavSidebarSection[] = useMemo(() => {
    const groups = groupPagesByNavigationGroup(allPages, defaultNavigationGroups);
    return groups
      .filter(({ pages }) => pages.length > 0)
      .map(({ config, pages }) => ({
        id: config.id,
        items: pages.map(toNavItem),
        label: config.label,
      }));
  }, [allPages]);

  if (sections.length === 0) {
    return null;
  }

  return <NavSidebar collapsed={isCollapsed} onToggleCollapse={() => toggle(level)} sections={sections} />;
}
