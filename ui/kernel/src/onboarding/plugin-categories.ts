/**
 * plugin-categories — Plugin category domain logic for onboarding.
 *
 * Defines the canonical plugin category configuration, default-enabled
 * derivation, and category lookup. Pure constants with no runtime side effects.
 *
 * The `persistPluginEnabled` bus helper lives in `\@makaio/ui-hooks` (it
 * performs bus requests and requires `\@makaio/services-core`).
 * @packageDocumentation
 */

/**
 * Category metadata including which plugin names belong here and what the
 * default enabled state is for newly discovered members.
 */
export interface PluginCategory {
  /** Display label */
  readonly label: string;
  /** Set of plugin names that belong to this category */
  readonly members: ReadonlySet<string>;
  /** Whether extensions in this category start enabled by default */
  readonly defaultEnabled: boolean;
  /**
   * When true, toggles for this category are disabled (always-on).
   * Used for Essential extensions.
   */
  readonly alwaysEnabled: boolean;
}

/**
 * Ordered list of plugin categories used to partition the full plugin list.
 *
 * Immutability is enforced structurally: the array is `ReadonlyArray` and
 * each category's `members` field is typed as `ReadonlySet<string>`, so
 * TypeScript prevents mutation at all call sites. Runtime freeze is not
 * applied — this constant is consumed only by TypeScript callers in the
 * framework shell.
 */
export const PLUGIN_CATEGORIES: ReadonlyArray<PluginCategory> = [
  {
    label: 'Essential',
    members: new Set(['hash-trigger', 'tool-tracking', 'artifacts', 'coordinator']),
    defaultEnabled: true,
    alwaysEnabled: true,
  },
  {
    label: 'Recommended',
    members: new Set([
      'context-advisor',
      'terminal',
      'conversation-timeline',
      'skill-injector',
      'code-annotations',
      'agent-notes',
      'pin-message',
      'file-history',
      'lock',
    ]),
    defaultEnabled: true,
    alwaysEnabled: false,
  },
  {
    label: 'Developer Workflow',
    members: new Set(['github', 'pr-review', 'worktree', 'drift-detector']),
    defaultEnabled: true,
    alwaysEnabled: false,
  },
  {
    label: 'Advanced',
    members: new Set(['routine', 'loop', 'summarize', 'vision', 'instruction-guard', 'question-extractor']),
    defaultEnabled: false,
    alwaysEnabled: false,
  },
  {
    label: 'Integrations',
    members: new Set(['pushover', 'linear-tasks', 'opencode']),
    defaultEnabled: false,
    alwaysEnabled: false,
  },
  {
    label: 'Debug',
    members: new Set([]),
    defaultEnabled: false,
    alwaysEnabled: false,
  },
];

/**
 * Derive the initial enabled state for a plugin based on its category.
 * @param category - The category this plugin belongs to
 * @returns True when the plugin should be toggled on by default
 */
export function deriveDefaultEnabled(category: PluginCategory): boolean {
  return category.alwaysEnabled || category.defaultEnabled;
}

/** Fallback category for extensions not listed in any known category. */
const OTHER_CATEGORY: PluginCategory = {
  label: 'Other',
  members: new Set<string>(),
  defaultEnabled: false,
  alwaysEnabled: false,
};

/**
 * Find which category a plugin belongs to, or return a synthetic "Other" category
 * when the plugin name is not listed in any known category.
 * @param pluginName - Plugin name to categorise
 * @returns The matching {@link PluginCategory}, or a catch-all "Other" category
 */
export function findCategory(pluginName: string): PluginCategory {
  return PLUGIN_CATEGORIES.find((cat) => cat.members.has(pluginName)) ?? OTHER_CATEGORY;
}
