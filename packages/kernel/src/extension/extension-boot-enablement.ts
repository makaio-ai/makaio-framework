import type { KernelMakaioExtension } from './types.js';

/** Result of {@link resolveBootEnabledNames}. */
export interface BootEnabledResolution {
  /**
   * Names that will boot enabled: `entry.enabled` is seeded `true` for each,
   * and each is included in {@link TopoSortOptions.enabledNames} so
   * {@link topoSort} validates its dependency graph fatally.
   */
  readonly enabled: ReadonlySet<string>;
}

/**
 * Compute the preference-enabled boot set for every eligible package before
 * the dependency graph is sorted and validated.
 *
 * Hoisted out of {@link ExtensionCoordinator.load}'s entry-building loop
 * because {@link topoSort} needs to know which names are preference-enabled
 * before any coordinator entry exists, so its fatal graph validation
 * (missing dependency, incompatible version, cycle) can be scoped to only
 * the packages that actually participate in this boot — see `topoSort`'s
 * `enabledNames` option. The same set then seeds `entry.enabled` for every
 * entry built afterwards, so the two never compute it independently and
 * risk drifting apart.
 *
 * A package outside `extensionManagedNames` (a framework package) is always
 * enabled: framework packages are not subject to operator enablement at
 * all, so `loadEnabled` is never consulted for one. A `critical`
 * extension-managed package is force-enabled even when the durable store
 * records it as disabled, with a console warning, to keep the runtime
 * functional.
 * @param eligible - Packages that survived surface/environment filtering.
 * @param extensionManagedNames - Names whose enablement is operator-managed;
 *   `undefined` treats every package as managed.
 * @param loadEnabled - Durable enablement preference reader; `undefined`
 *   when the coordinator has no durable enablement store wired in.
 * @returns The names that will boot enabled.
 */
export function resolveBootEnabledNames(
  eligible: ReadonlyArray<KernelMakaioExtension>,
  extensionManagedNames: ReadonlySet<string> | undefined,
  loadEnabled: ((name: string) => boolean | undefined) | undefined,
): BootEnabledResolution {
  const enabled = new Set<string>();
  for (const pkg of eligible) {
    const managed = extensionManagedNames?.has(pkg.name) ?? true;
    if (!managed) {
      enabled.add(pkg.name);
      continue;
    }

    const loadedEnabled = loadEnabled?.(pkg.name) !== false;
    if (loadedEnabled || pkg.critical) {
      enabled.add(pkg.name);
    }
    if (!loadedEnabled && pkg.critical) {
      console.warn(
        `[ExtensionCoordinator] Critical extension "${pkg.name}" is marked disabled in the enablement store but ` +
          'will start anyway to keep the runtime functional. ' +
          'Remove it from the disabled list in config/extensions.json to silence this warning.',
      );
    }
  }
  return { enabled };
}
