import { versionSatisfies } from '@makaio/contracts';
import { MakaioError } from '@makaio/core';
import { closeEnabledExtensionEntries } from './extension-entry-closure.js';
import type { ExtensionRuntimeSurface, KernelMakaioExtension, RuntimeEnvironment } from './types.js';

/** Shared empty set so the default argument allocates nothing per call. */
const EMPTY_NAME_SET: ReadonlySet<string> = new Set<string>();

const STORAGE_CAPABILITY = 'storage.drizzle';

/** Selection evaluates storage presence without inspecting executable callbacks. */
type EligibilityManifest = Pick<KernelMakaioExtension, 'name' | 'requires' | 'surface' | 'dependencies'> & {
  readonly storage?: object;
};

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
export function coalesceExtensionOverrides<
  TManifest extends Pick<KernelMakaioExtension, 'name' | 'displayName' | 'version'>,
>(extensions: ReadonlyArray<TManifest>, frameworkPackageNames: ReadonlySet<string> = EMPTY_NAME_SET): TManifest[] {
  const byName = new Map<string, TManifest>();
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
function formatNameCollisionMessage(
  name: string,
  first: Pick<KernelMakaioExtension, 'displayName' | 'version'>,
  second: Pick<KernelMakaioExtension, 'displayName' | 'version'>,
): string {
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
function describeRegistration(pkg: Pick<KernelMakaioExtension, 'displayName' | 'version'>): string {
  return `"${pkg.displayName}" v${pkg.version}`;
}

/** Storage-dependent manifests cannot load on a host without the required storage capability. */
export class ExtensionStorageCapabilityError extends MakaioError {
  /** Host capability that does not satisfy the package requirements. */
  public readonly capability = STORAGE_CAPABILITY;

  /**
   * @param extensions - Extensions requiring the missing capability.
   * @param dependents - Extensions that transitively require one of those extensions.
   */
  public constructor(
    public readonly extensions: readonly string[],
    public readonly dependents: readonly string[],
  ) {
    const affected = dependents.length > 0 ? ` Required dependents: ${dependents.join(', ')}.` : '';
    super(
      `Extensions ${extensions.join(', ')} require unavailable host capability "${STORAGE_CAPABILITY}".${affected}`,
    );
  }
}

/**
 * Reject a package set that requires storage on a host without that capability.
 * @param extensions - Manifests in scope for host admission.
 * @param env - Capabilities and versions advertised by the host.
 * @throws ExtensionStorageCapabilityError naming the storage extensions and their required dependents.
 */
export function assertExtensionStorageCapability(
  extensions: readonly EligibilityManifest[],
  env: Pick<RuntimeEnvironment, 'capabilities' | 'capabilityVersions'>,
): void {
  const hasStorage = env.capabilities.has(STORAGE_CAPABILITY);
  const missing = new Set(
    extensions
      .filter((pkg) => {
        if (!hasStorage && pkg.storage !== undefined) return true;
        return pkg.requires?.some(
          (req) =>
            req.type === 'capability' &&
            req.id === STORAGE_CAPABILITY &&
            (!hasStorage ||
              (pkg.storage !== undefined &&
                req.version !== undefined &&
                !capabilityVersionSatisfies(env, req.id, req.version))),
        );
      })
      .map((pkg) => pkg.name),
  );
  if (missing.size === 0) return;
  const { exclusions } = closeEnabledExtensionEntries(
    extensions.map((pkg) => ({ name: pkg.name, entry: { pkg, enabled: !missing.has(pkg.name) } })),
  );
  throw new ExtensionStorageCapabilityError(
    [...missing],
    exclusions.map(({ name }) => name),
  );
}

/**
 * Filter extensions by runtime surface and environment requirements and prune dependents.
 * On hosts without `storage.drizzle`, a surface-matching extension with a `storage` declaration
 * or an explicit `storage.drizzle` requirement fails selection before other environment requirements are evaluated.
 * @param extensions - Full extension set to filter.
 * @param surface - Runtime surface to match.
 * @param env - Host-provided runtime environment, or `undefined` to skip environment checks.
 * @returns Extensions eligible for loading in the current host environment.
 * @throws ExtensionStorageCapabilityError if a surface-matching extension requires unavailable `storage.drizzle`.
 *   The error names the storage extensions and their required dependents.
 */
export function filterEligibleExtensions<TManifest extends EligibilityManifest>(
  extensions: ReadonlyArray<TManifest>,
  surface: ExtensionRuntimeSurface,
  env: RuntimeEnvironment | undefined,
): TManifest[] {
  const surfaceMatches = extensions.filter((pkg) => matchesSurface(pkg, surface));
  if (env !== undefined) assertExtensionStorageCapability(surfaceMatches, env);

  const directlyEligible = surfaceMatches.filter((pkg) => matchesRequirements(pkg, env));
  const eligibleByName = new Map(directlyEligible.map((pkg) => [pkg.name, pkg]));
  const { closed } = closeEnabledExtensionEntries(
    extensions.map((pkg) => {
      const eligible = eligibleByName.get(pkg.name);
      return { name: pkg.name, entry: { pkg: eligible ?? pkg, enabled: eligible !== undefined } };
    }),
  );
  return directlyEligible.filter((pkg) => closed.has(pkg.name));
}

/**
 * Check whether an extension's environment requirements are satisfied.
 * @param pkg - Extension manifest to evaluate.
 * @param env - Host-provided runtime environment, or `undefined` to allow all.
 * @returns `true` when the extension is eligible for this runtime.
 */
function matchesRequirements(pkg: EligibilityManifest, env: RuntimeEnvironment | undefined): boolean {
  if (!env) return true;
  return (pkg.requires ?? []).every((req) => {
    switch (req.type) {
      case 'host':
        return env.hosts.has(req.id);
      case 'capability':
        if (!env.capabilities.has(req.id)) {
          console.warn(`[ExtensionCoordinator] missing-capability: "${pkg.name}" requires "${req.id}"`);
          return false;
        }
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
function capabilityVersionSatisfies(
  env: Pick<RuntimeEnvironment, 'capabilityVersions'>,
  id: string,
  range: string,
): boolean {
  const version = env.capabilityVersions?.get(id);
  return version !== undefined && versionSatisfies(version, range);
}

/**
 * Check whether an extension should load on the configured runtime surface.
 * @param pkg - Extension manifest to evaluate.
 * @param surface - Runtime surface to match.
 * @returns `true` when the extension is eligible for this runtime surface.
 */
function matchesSurface(pkg: Pick<KernelMakaioExtension, 'surface'>, surface: ExtensionRuntimeSurface): boolean {
  return pkg.surface === undefined || pkg.surface === 'any' || pkg.surface === surface;
}
