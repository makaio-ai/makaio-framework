import type { MakaioExtension } from '@makaio/contracts';
import type { ExtensionRuntimeSurface } from './types.js';

/**
 * Keep the last extension registered for a given name.
 * @param extensions - Eligible extensions in load priority order.
 * @returns Unique extensions with later entries winning name collisions.
 */
export function coalesceExtensionOverrides(extensions: ReadonlyArray<MakaioExtension>): MakaioExtension[] {
  const byName = new Map<string, MakaioExtension>();
  for (const pkg of extensions) {
    if (byName.has(pkg.name)) {
      console.info(`[ExtensionCoordinator] Extension "${pkg.name}" overrides an earlier registration`);
      byName.delete(pkg.name);
    }
    byName.set(pkg.name, pkg);
  }
  return [...byName.values()];
}

/**
 * Filter extensions by runtime surface / environment requirements and prune dependents.
 * @param extensions - Full extension set to filter.
 * @param surface - Runtime surface to match.
 * @param capabilities - Host-provided environment capabilities, or `undefined` to allow all.
 * @returns Extensions eligible for loading in the current host environment.
 */
export function filterEligibleExtensions(
  extensions: ReadonlyArray<MakaioExtension>,
  surface: ExtensionRuntimeSurface,
  capabilities: ReadonlySet<string> | undefined,
): MakaioExtension[] {
  const allInputNames = new Set(extensions.map((p) => p.name));
  const directlyEligible = extensions.filter((pkg) => matchesRequirements(pkg, surface, capabilities));
  const byName = new Map(directlyEligible.map((pkg) => [pkg.name, pkg]));
  const eligibleNames = new Set(byName.keys());

  let changed = true;
  while (changed) {
    changed = false;
    for (const name of eligibleNames) {
      const hasFilteredDependency = (byName.get(name)!.dependencies ?? []).some(
        (dependency) => allInputNames.has(dependency) && !eligibleNames.has(dependency),
      );
      if (hasFilteredDependency) {
        eligibleNames.delete(name);
        changed = true;
      }
    }
  }

  return directlyEligible.filter((pkg) => eligibleNames.has(pkg.name));
}

/**
 * Check whether an extension's environment requirements are satisfied.
 * @param pkg - Extension manifest to evaluate.
 * @param surface - Runtime surface to match.
 * @param capabilities - Host-provided environment capabilities, or `undefined` to allow all.
 * @returns `true` when the extension is eligible for this runtime.
 */
function matchesRequirements(
  pkg: MakaioExtension,
  surface: ExtensionRuntimeSurface,
  capabilities: ReadonlySet<string> | undefined,
): boolean {
  if (!matchesSurface(pkg, surface)) return false;
  const requirements = pkg.requires;
  if (!requirements || requirements.length === 0) return true;
  if (!capabilities) return true;
  return requirements.every((capability) => capabilities.has(capability));
}

/**
 * Check whether an extension should load on the configured runtime surface.
 * @param pkg - Extension manifest to evaluate.
 * @param surface - Runtime surface to match.
 * @returns `true` when the extension is eligible for this runtime surface.
 */
function matchesSurface(pkg: MakaioExtension, surface: ExtensionRuntimeSurface): boolean {
  return pkg.surface === undefined || pkg.surface === 'any' || pkg.surface === surface;
}
