import { describe, it, expect } from 'vitest';
import { groupPagesByNavigationGroup } from './group-pages.js';
import { defaultNavigationGroups } from '@makaio/ui-kernel';
import type { ExecutablePage } from '../pages/use-pages.js';
import type { NavigationGroupConfig } from '@makaio/ui-kernel';

describe('groupPagesByNavigationGroup', () => {
  /**
   * Local two-entry fixture mirroring the current default groups structure.
   * Tests that assert on exact count or positional indices use this fixture so
   * they remain stable even if `defaultNavigationGroups` gains or reorders entries.
   */
  const testGroups: NavigationGroupConfig[] = [
    { id: 'navigate', label: 'Navigate', order: 0 },
    { id: 'quick-access', label: 'Quick Access', order: 10 },
  ];

  // Helper to create a minimal ExecutablePage for testing
  const createPage = (id: string, group: ExecutablePage['group'], name: string = id): ExecutablePage =>
    ({
      id,
      name,
      mode: 'switch',
      level: 'any',
      group,
      component: async () => ({ default: () => null }),
      execute: () => undefined,
      isActive: false,
    }) as ExecutablePage;

  it('should group pages correctly by their group field', () => {
    const pages: ExecutablePage[] = [
      createPage('dashboard', 'navigate'),
      createPage('chat', 'navigate'),
      createPage('settings', 'quick-access'),
      createPage('projects', 'quick-access'),
    ];

    const grouped = groupPagesByNavigationGroup(pages, testGroups);

    expect(grouped).toHaveLength(2);

    // Navigate group
    expect(grouped[0].config.id).toBe('navigate');
    expect(grouped[0].pages.map((p) => p.id)).toEqual(['dashboard', 'chat']);

    // Quick Access group
    expect(grouped[1].config.id).toBe('quick-access');
    expect(grouped[1].pages.map((p) => p.id)).toEqual(['settings', 'projects']);
  });

  it('should handle unknown groups by appending at end', () => {
    const customConfig: NavigationGroupConfig = {
      id: 'custom' as NavigationGroupConfig['id'],
      label: 'Custom',
      order: 5,
    };

    const pages: ExecutablePage[] = [
      createPage('page1', 'navigate'),
      createPage('page2', 'unknown-group' as ExecutablePage['group']),
      createPage('page3', 'quick-access'),
    ];

    const grouped = groupPagesByNavigationGroup(pages, [customConfig, ...testGroups]);

    expect(grouped).toHaveLength(4); // navigate, custom, quick-access, unknown-group

    // Navigate group (order 0) should be first
    expect(grouped[0].config.id).toBe('navigate');
    expect(grouped[0].pages.map((p) => p.id)).toEqual(['page1']);

    // Custom group (order 5) should be second
    expect(grouped[1].config.id).toBe('custom');
    expect(grouped[1].pages).toEqual([]);

    // Quick access group (order 10) should be third
    expect(grouped[2].config.id).toBe('quick-access');
    expect(grouped[2].pages.map((p) => p.id)).toEqual(['page3']);

    // Unknown group should be appended at end
    expect(grouped[3].config.id).toBe('unknown-group');
    expect(grouped[3].pages.map((p) => p.id)).toEqual(['page2']);
    expect(grouped[3].config.order).toBe(999);
  });

  it('should sort groups by config order', () => {
    const configs: NavigationGroupConfig[] = [
      { id: 'navigate', label: 'Navigate', order: 10 },
      { id: 'quick-access', label: 'Quick Access', order: 5 },
    ];

    const pages: ExecutablePage[] = [createPage('page1', 'navigate'), createPage('page2', 'quick-access')];

    const grouped = groupPagesByNavigationGroup(pages, configs);

    // Quick access (order 5) should come before navigate (order 10)
    expect(grouped[0].config.id).toBe('quick-access');
    expect(grouped[1].config.id).toBe('navigate');
  });

  /**
   * Integration-style test: uses the real `defaultNavigationGroups` to confirm
   * that the function correctly excludes pages with no group across the actual
   * kernel defaults, without depending on group count or order.
   */
  it('should exclude pages without a group (integration with defaultNavigationGroups)', () => {
    const pages: ExecutablePage[] = [
      createPage('page1', 'navigate'),
      createPage('page2', undefined),
      createPage('page3', 'quick-access'),
    ];

    const grouped = groupPagesByNavigationGroup(pages, defaultNavigationGroups);

    const allGroupedPages = grouped.flatMap((g) => g.pages);
    expect(allGroupedPages).toHaveLength(2);
    expect(allGroupedPages.map((p) => p.id)).toEqual(['page1', 'page3']);
  });

  it('should return empty pages array for groups with no matching pages', () => {
    const pages: ExecutablePage[] = [createPage('page1', 'navigate')];

    const grouped = groupPagesByNavigationGroup(pages, testGroups);

    expect(grouped).toHaveLength(2);
    expect(grouped[0].config.id).toBe('navigate');
    expect(grouped[0].pages).toHaveLength(1);
    expect(grouped[1].config.id).toBe('quick-access');
    expect(grouped[1].pages).toEqual([]);
  });

  it('should handle empty pages array', () => {
    const pages: ExecutablePage[] = [];

    const grouped = groupPagesByNavigationGroup(pages, testGroups);

    expect(grouped).toHaveLength(2);
    expect(grouped[0].pages).toEqual([]);
    expect(grouped[1].pages).toEqual([]);
  });

  it('should handle empty configs array', () => {
    const pages: ExecutablePage[] = [createPage('page1', 'navigate'), createPage('page2', 'quick-access')];

    const grouped = groupPagesByNavigationGroup(pages, []);

    // All pages should appear as unknown groups
    expect(grouped).toHaveLength(2);
    expect(grouped[0].config.id).toBe('navigate');
    expect(grouped[0].config.order).toBe(999);
    expect(grouped[1].config.id).toBe('quick-access');
    expect(grouped[1].config.order).toBe(999);
  });

  it('should use group ID as label for unknown groups', () => {
    const pages: ExecutablePage[] = [createPage('page1', 'custom-group' as ExecutablePage['group'])];

    const grouped = groupPagesByNavigationGroup(pages, testGroups);

    // testGroups has 2 entries; the unknown group is appended at the end.
    expect(grouped).toHaveLength(3); // navigate, quick-access, custom-group
    const customGroup = grouped[2];
    expect(customGroup.config.id).toBe('custom-group');
    expect(customGroup.config.label).toBe('custom-group');
  });
});
