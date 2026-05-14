import { versionSatisfies } from '@makaio/contracts';
import type { ExtensionRuntimeSurface, KernelMakaioExtension, RuntimeEnvironment } from './types.js';

/**
 * Keep the last extension registered for a given name.
 * @param extensions - Eligible extensions in load priority order.
 * @returns Unique extensions with later entries winning name collisions.
 */
export function coalesceExtensionOverrides(extensions: ReadonlyArray<KernelMakaioExtension>): KernelMakaioExtension[] {
  const byName = new Map<string, KernelMakaioExtension>();
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
 * @param env - Host-provided runtime environment, or `undefined` to allow all.
 * @returns Extensions eligible for loading in the current host environment.
 */
export function filterEligibleExtensions(
  extensions: ReadonlyArray<KernelMakaioExtension>,
  surface: ExtensionRuntimeSurface,
  env: RuntimeEnvironment | undefined,
): KernelMakaioExtension[] {
  const allInputNames = new Set(extensions.map((p) => p.name));
  const directlyEligible = extensions.filter((pkg) => matchesRequirements(pkg, surface, env));
  const byName = new Map(directlyEligible.map((pkg) => [pkg.name, pkg]));
  const eligibleNames = new Set(byName.keys());

  let changed = true;
  while (changed) {
    changed = false;
    for (const name of eligibleNames) {
      const hasFilteredDependency = (byName.get(name)!.dependencies ?? []).some(
        (dependency) =>
          !dependency.optional && allInputNames.has(dependency.name) && !eligibleNames.has(dependency.name),
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
 * @param env - Host-provided runtime environment, or `undefined` to allow all.
 * @returns `true` when the extension is eligible for this runtime.
 */
function matchesRequirements(
  pkg: KernelMakaioExtension,
  surface: ExtensionRuntimeSurface,
  env: RuntimeEnvironment | undefined,
): boolean {
  if (!matchesSurface(pkg, surface)) return false;
  const requirements = pkg.requires;
  if (!requirements || requirements.length === 0) return true;
  if (!env) return true;
  return requirements.every((req) => {
    switch (req.type) {
      case 'host':
        return env.hosts.has(req.id);
      case 'capability':
        if (!env.capabilities.has(req.id)) return false;
        if (req.version === undefined) return true;
        return capabilityVersionSatisfies(env, req.id, req.version);
    }
  });
}

/**
 * Check a versioned host capability requirement.
 * @param env - Host-provided runtime environment.
 * @param id - Capability token.
 * @param range - Required semver range.
 * @returns `true` when the host declared a satisfying concrete capability version.
 */
function capabilityVersionSatisfies(env: RuntimeEnvironment, id: string, range: string): boolean {
  const version = env.capabilityVersions?.get(id);
  return version !== undefined && versionSatisfies(version, range);
}

/**
 * Check whether an extension should load on the configured runtime surface.
 * @param pkg - Extension manifest to evaluate.
 * @param surface - Runtime surface to match.
 * @returns `true` when the extension is eligible for this runtime surface.
 */
function matchesSurface(pkg: KernelMakaioExtension, surface: ExtensionRuntimeSurface): boolean {
  return pkg.surface === undefined || pkg.surface === 'any' || pkg.surface === surface;
}
