/**
 * Page Grouping Utilities
 *
 * Functions for grouping and organizing pages by navigation group.
 * @packageDocumentation
 */

import type { ExecutablePage } from '../pages/use-pages.js';
import type { NavigationGroupConfig } from '@makaio/ui-kernel';

/**
 * Synthetic config created for navigation groups that appear in page data
 * but have no entry in the provided `groupConfigs` array.
 *
 * Unlike {@link NavigationGroupConfig}, the `id` here is an arbitrary string
 * because the group was not declared in the navigation group registry.
 */
export interface SyntheticGroupConfig {
  /** Arbitrary string identifier from the page's `group` field */
  id: string;
  /** Label — falls back to the raw group id string */
  label: string;
  /** Sort order — unknown groups are appended at the end */
  order: number;
}

/**
 * A resolved group config is either a declared {@link NavigationGroupConfig}
 * (known groups) or a {@link SyntheticGroupConfig} (unknown groups whose id
 * does not appear in the provided configs).
 */
export type ResolvedGroupConfig = NavigationGroupConfig | SyntheticGroupConfig;

/**
 * Grouped pages result.
 */
export interface GroupedPages {
  /** Navigation group configuration (declared or synthetic) */
  config: ResolvedGroupConfig;
  /** Pages in this group */
  pages: ExecutablePage[];
}

/**
 * Group pages by NavigationGroup with config-driven ordering.
 *
 * Pages are organized by their `group` field. Pages without a group are excluded.
 * Groups are ordered according to the provided configs. Unknown groups
 * (groups not in configs) are appended at the end in the order they're encountered.
 *
 * Each group in the result includes its config and matching pages.
 * Groups with no matching pages are still included (with empty pages array).
 * @param pages - Pages to group
 * @param groupConfigs - Navigation group configurations for ordering
 * @returns Array of grouped pages, ordered by config
 * @example
 * ```typescript
 * const pages = usePages();
 * const grouped = groupPagesByNavigationGroup(pages, defaultNavigationGroups);
 *
 * grouped.forEach(({ config, pages }) => {
 *   console.log(`${config.label}:`, pages.map(p => p.name));
 * });
 * // Navigate: ['Dashboard', 'Chat', 'Git']
 * // Quick Access: ['Settings', 'Projects', 'Sessions']
 * ```
 */
export function groupPagesByNavigationGroup(
  pages: ExecutablePage[],
  groupConfigs: ReadonlyArray<NavigationGroupConfig>,
): GroupedPages[] {
  // Filter pages to only those with a group
  const pagesWithGroup = pages.filter((page) => page.group !== undefined);

  // Group pages by their group field
  const pagesByGroup = new Map<string, ExecutablePage[]>();
  for (const page of pagesWithGroup) {
    const groupId = page.group!;
    if (!pagesByGroup.has(groupId)) {
      pagesByGroup.set(groupId, []);
    }
    pagesByGroup.get(groupId)!.push(page);
  }

  // Build result array with known groups first, then unknown groups
  const result: GroupedPages[] = [];
  const seenGroups = new Set<string>();

  // Sort configs by order field, then add known groups
  const sortedConfigs = [...groupConfigs].sort((a, b) => a.order - b.order);

  // Add known groups in sorted order (even if they have no pages)
  for (const config of sortedConfigs) {
    const groupPages = pagesByGroup.get(config.id) ?? [];
    result.push({ config, pages: groupPages });
    seenGroups.add(config.id);
  }

  // Add unknown groups (groups not in config) at the end
  for (const [groupId, groupPages] of pagesByGroup) {
    if (!seenGroups.has(groupId)) {
      // Create synthetic config for unknown group — id is an arbitrary string
      // because this group was not declared in the navigation group registry.
      const config: SyntheticGroupConfig = {
        id: groupId,
        label: groupId,
        order: 999, // Append at end
      };
      result.push({ config, pages: groupPages });
    }
  }

  return result;
}
