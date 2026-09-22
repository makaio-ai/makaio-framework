import { versionSatisfies } from '@makaio/contracts';
import type { ExtensionRuntimeSurface, KernelMakaioExtension, RuntimeEnvironment } from './types.js';

/** Shared empty set so the default argument allocates nothing per call. */
const EMPTY_NAME_SET: ReadonlySet<string> = new Set<string>();

/**
 * Resolve name collisions across a registration list, allowing exactly one
 * kind of collision: an extension package deliberately overriding a framework
 * package that the host loads unconditionally.
 *
 * Extension package names are identities, not suggestions. Two extension
 * packages registering under the same name have no legitimate winner — one
 * would silently displace the other, including the case where the displacing
 * registration is operator-disabled and therefore never starts at all. Upstream
 * stages already guarantee unique extension identities: filesystem discovery
 * rejects a same-tier descriptor-name collision outright and resolves a
 * cross-tier one by tier precedence. Reaching this function with two extension
 * registrations under one name therefore means a stage upstream of it stopped
 * holding that guarantee, so it fails loudly rather than picking one.
 *
 * A framework package name is different: the host loads those packages
 * unconditionally, and an extension registering under one of them is the
 * supported core-override flow. `frameworkPackageNames` names exactly those,
 * so the override wins the name (taking the overridden package's place at the
 * end of the load order) while any further registration under the same name is
 * again a collision with no legitimate winner.
 * @param extensions - Eligible extensions in load priority order.
 * @param frameworkPackageNames - Names the host loads unconditionally as
 *   framework packages. A single extension registration under one of these is
 *   a deliberate core override and wins the name. Omitted (or empty) means
 *   every name in `extensions` is an extension identity, so any collision
 *   throws.
 * @returns Unique extensions, with an accepted core override in place of the
 *   framework package it replaced.
 * @throws Error when two registrations collide on a name that is not an
 *   overridable framework package name, or when a framework package name is
 *   claimed more than once by an override.
 */
export function coalesceExtensionOverrides(
  extensions: ReadonlyArray<KernelMakaioExtension>,
  frameworkPackageNames: ReadonlySet<string> = EMPTY_NAME_SET,
): KernelMakaioExtension[] {
  const byName = new Map<string, KernelMakaioExtension>();
  const overriddenFrameworkNames = new Set<string>();
  for (const pkg of extensions) {
    const existing = byName.get(pkg.name);
    if (existing === undefined) {
      byName.set(pkg.name, pkg);
      continue;
    }
    if (!frameworkPackageNames.has(pkg.name) || overriddenFrameworkNames.has(pkg.name)) {
      throw new Error(formatNameCollisionMessage(pkg.name, existing, pkg));
    }
    overriddenFrameworkNames.add(pkg.name);
    console.info(
      `[ExtensionCoordinator] Extension "${pkg.name}" overrides the framework package registered under the same name`,
    );
    // Re-insert at the override's own input position rather than inheriting
    // the overridden package's earlier Map slot.
    byName.delete(pkg.name);
    byName.set(pkg.name, pkg);
  }
  return [...byName.values()];
}

/**
 * Describe both sides of an unresolvable name collision.
 * @param name - The contested package name.
 * @param first - Registration that claimed the name first.
 * @param second - Registration that tried to claim it again.
 * @returns Diagnostic message naming both registrations.
 */
function formatNameCollisionMessage(name: string, first: KernelMakaioExtension, second: KernelMakaioExtension): string {
  return (
    `Extension name collision: "${name}" is registered twice ` +
    `(${describeRegistration(first)} and ${describeRegistration(second)}). ` +
    'Extension package names are identities and cannot be shared — uninstall or rename one of them. ' +
    'Reaching load with two registrations under one name means discovery or boot selection ' +
    'admitted both, which they must not.'
  );
}

/**
 * Render one registration for a collision diagnostic.
 * @param pkg - Registration to describe.
 * @returns Display name and version of the registration.
 */
function describeRegistration(pkg: KernelMakaioExtension): string {
  return `"${pkg.displayName}" v${pkg.version}`;
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
