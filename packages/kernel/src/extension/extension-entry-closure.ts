import type { ExtensionEntry } from './types.js';

/**
 * One coordinator entry excluded from the dependency-closed enabled set,
 * carrying the required, non-optional dependency names that kept it out.
 */
export interface ExtensionEntryClosureExclusion {
  /** Name of the excluded coordinator entry. */
  readonly name: string;
  /** Required, non-optional dependency names that are not in the closed set. */
  readonly missingDependencies: readonly string[];
}

/** Result of {@link closeEnabledExtensionEntries}. */
export interface ExtensionEntryClosureResult {
  /** Names whose preference-enabled state survives the dependency closure. */
  readonly closed: ReadonlySet<string>;
  /**
   * Entries removed from the closed set, in removal order, each carrying the
   * dependency names responsible for its removal.
   */
  readonly exclusions: readonly ExtensionEntryClosureExclusion[];
}

/**
 * Reduce the preference-enabled subset of `orderedEntries` to its
 * dependency-closed subset.
 *
 * `entry.enabled` alone only reflects one entry's own preference. A
 * preference-enabled entry whose required, non-optional dependency is
 * disabled will never reach `active`: {@link startExtensionEntry}'s own
 * dependency check (`extension-start-runner.ts` lines 49-53) refuses it at
 * start time by comparing each non-optional dependency's *live* state
 * (`depEntry?.state !== 'active'`) against `active`. This helper mirrors that
 * check at load time, before any entry has started, using each dependency's
 * *preference* (`entry.enabled`) as a stand-in for the `active` state that
 * check will observe once {@link ExtensionCoordinator.startAll} actually runs
 * — the two checks necessarily agree because both walk the same dependency
 * graph in the same direction. Any caller that needs to know in advance
 * which preference-enabled entries are guaranteed to fail that later check
 * should use this closure rather than reading `entry.enabled` directly.
 *
 * Only non-optional `dependencies` entries count toward the closure. A
 * dependency is satisfied when it is either itself part of the closed set or
 * is not a coordinator-managed name at all — a framework package, which
 * loads unconditionally and is outside the enablement store's jurisdiction,
 * so it is always treated as satisfied here exactly as the coordinator's own
 * entry map always contains it.
 *
 * A `critical` entry is not exempted from this rule: `critical` only means
 * the operator's enablement preference cannot disable the entry itself
 * (already folded into `entry.enabled` by {@link ExtensionCoordinator.load})
 * — it says nothing about that entry's own dependencies. If a critical
 * entry's required dependency is disabled, {@link startExtensionEntry} will
 * throw and abort boot entirely regardless of whether this closure excluded
 * the entry, so excluding it here cannot make that outcome worse.
 * @param orderedEntries - Every loaded coordinator entry, in load order.
 * @returns The dependency-closed subset of preference-enabled names, plus
 *   the excluded entries and the dependency names responsible for each.
 */
export function closeEnabledExtensionEntries(
  orderedEntries: ReadonlyArray<{ readonly name: string; readonly entry: ExtensionEntry }>,
): ExtensionEntryClosureResult {
  const managedNames = new Set(orderedEntries.map(({ name }) => name));
  const entryByName = new Map(orderedEntries.map(({ name, entry }) => [name, entry]));
  const closed = new Set(orderedEntries.filter(({ entry }) => entry.enabled).map(({ name }) => name));
  const exclusions: ExtensionEntryClosureExclusion[] = [];

  let changed = true;
  while (changed) {
    changed = false;
    for (const name of closed) {
      const missingDependencies = (entryByName.get(name)!.pkg.dependencies ?? [])
        .filter(
          (dependency) => !dependency.optional && managedNames.has(dependency.name) && !closed.has(dependency.name),
        )
        .map((dependency) => dependency.name);
      if (missingDependencies.length === 0) continue;
      closed.delete(name);
      changed = true;
      exclusions.push({ name, missingDependencies });
    }
  }

  return { closed, exclusions };
}
