import { versionSatisfies } from '@makaio/contracts';
import type { KernelMakaioExtension } from './types.js';

/**
 * Options scoping {@link topoSort}'s fatal graph validation to a subset of
 * packages.
 */
export interface TopoSortOptions {
  /**
   * Names whose own declared dependency edges participate in fatal graph
   * validation (missing dependency, incompatible version, or cycle
   * membership).
   *
   * A name absent from this set still receives a slot in the returned order
   * — sorting itself always runs over every package, because load order is
   * harmless regardless of enablement — but a missing dependency,
   * incompatible version, or cycle that only involves names absent from this
   * set is reported through {@link TopoSortOptions.onSoftValidationWarning}
   * instead of throwing.
   *
   * Omitted entirely: every package is treated as participating, which is
   * the exact prior behavior (every graph defect is fatal). The
   * {@link ExtensionCoordinator} passes the boot-time preference-enabled set
   * here so a disabled extension's own broken dependency graph cannot abort
   * boot for the rest of the fleet — disabling it remains a working recovery
   * path.
   */
  readonly enabledNames?: ReadonlySet<string>;
  /**
   * Called once for each name excluded from fatal validation by
   * {@link TopoSortOptions.enabledNames} whose dependency graph would
   * otherwise have failed it.
   *
   * May be called more than once for the same name (for example a missing
   * dependency and an incompatible version both present). The caller is
   * responsible for recording the reason once the corresponding coordinator
   * entry exists — {@link topoSort} itself has no entry to record it on.
   * @param name - Excluded package name.
   * @param message - Human-readable description of the validation failure
   *   that was downgraded from fatal to a warning.
   */
  readonly onSoftValidationWarning?: (name: string, message: string) => void;
}

/**
 * Topological sort using Kahn's algorithm.
 *
 * Returns extension names in dependency-first order.
 * @param packages - Extensions to sort
 * @param options - Scopes fatal validation to a subset of packages; see
 *   {@link TopoSortOptions}.
 * @returns Names in topological order (dependencies before dependents)
 * @throws Error when a duplicate extension name is detected, a
 *   fatal-validated package declares a missing dependency, a fatal-validated
 *   package's dependency version is incompatible, or a circular dependency
 *   involving at least one fatal-validated package is detected
 */
export function topoSort(packages: ReadonlyArray<KernelMakaioExtension>, options: TopoSortOptions = {}): string[] {
  const nodes = collectUniqueNames(packages);
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg] as const));

  validateDependencies(packages, nodes, byName, options);

  const remainingDeps = buildRemainingDependencyMap(packages, nodes);
  const result = runKahnSort(nodes, remainingDeps, options);

  return result;
}

/**
 * Collect package names and reject duplicates before graph construction.
 * @param packages - Extensions to inspect.
 * @returns Unique package names.
 */
function collectUniqueNames(packages: ReadonlyArray<KernelMakaioExtension>): Set<string> {
  const nodes = new Set<string>();
  for (const p of packages) {
    if (nodes.has(p.name)) {
      throw new Error(`ExtensionCoordinator: duplicate package name detected: "${p.name}"`);
    }
    nodes.add(p.name);
  }
  return nodes;
}

/**
 * Validate dependency presence and version ranges before sorting.
 * @param packages - Extensions to validate.
 * @param nodes - Loaded package names.
 * @param byName - Loaded packages keyed by name.
 * @param options - Scopes fatal validation to a subset of packages.
 */
function validateDependencies(
  packages: ReadonlyArray<KernelMakaioExtension>,
  nodes: ReadonlySet<string>,
  byName: ReadonlyMap<string, KernelMakaioExtension>,
  options: TopoSortOptions,
): void {
  for (const p of packages) {
    validatePackageDependencies(p, nodes, byName, options);
  }
}

/**
 * Validate one package's dependencies.
 *
 * A package outside {@link TopoSortOptions.enabledNames} still has every
 * defect checked, but a defect is reported through
 * {@link TopoSortOptions.onSoftValidationWarning} instead of thrown.
 * @param pkg - Package whose dependencies should be checked.
 * @param nodes - Loaded package names.
 * @param byName - Loaded packages keyed by name.
 * @param options - Scopes fatal validation to a subset of packages.
 */
function validatePackageDependencies(
  pkg: KernelMakaioExtension,
  nodes: ReadonlySet<string>,
  byName: ReadonlyMap<string, KernelMakaioExtension>,
  options: TopoSortOptions,
): void {
  const isFatal = options.enabledNames === undefined || options.enabledNames.has(pkg.name);
  const dependencies = pkg.dependencies ?? [];

  const missing = dependencies.filter((dep) => !dep.optional && !nodes.has(dep.name));
  if (missing.length > 0) {
    reportValidationFailure(
      options,
      isFatal,
      pkg.name,
      `ExtensionCoordinator: package "${pkg.name}" declares missing dependencies: ${missing.map((d) => d.name).join(', ')}`,
    );
  }

  for (const dep of dependencies) {
    const dependencyPackage = byName.get(dep.name);
    if (dependencyPackage === undefined) continue;
    const dependencyVersion = dependencyPackage.version;
    if (!versionSatisfies(dependencyVersion, dep.version)) {
      reportValidationFailure(
        options,
        isFatal,
        pkg.name,
        `ExtensionCoordinator: package "${pkg.name}" dependency "${dep.name}" version ${dependencyVersion} does not satisfy ${dep.version}`,
      );
    }
  }
}

/**
 * Throw or soft-report one validation failure depending on fatality.
 * @param options - Scopes fatal validation to a subset of packages.
 * @param isFatal - Whether the offending package participates in fatal validation.
 * @param name - Offending package name.
 * @param message - Human-readable description of the validation failure.
 * @throws Error when `isFatal` is `true`.
 */
function reportValidationFailure(options: TopoSortOptions, isFatal: boolean, name: string, message: string): void {
  if (isFatal) throw new Error(message);
  options.onSoftValidationWarning?.(name, message);
}

/**
 * Build the mutable dependency map consumed by Kahn's algorithm.
 * @param packages - Extensions to sort.
 * @param nodes - Loaded package names.
 * @returns Map from package name to unresolved dependency names.
 */
function buildRemainingDependencyMap(
  packages: ReadonlyArray<KernelMakaioExtension>,
  nodes: ReadonlySet<string>,
): Map<string, Set<string>> {
  const remainingDeps = new Map<string, Set<string>>();
  for (const p of packages) {
    const deps = (p.dependencies ?? []).filter((dep) => nodes.has(dep.name)).map((dep) => dep.name);
    remainingDeps.set(p.name, new Set(deps));
  }
  return remainingDeps;
}

/**
 * Run Kahn's algorithm over the pre-validated dependency map.
 *
 * A residual cycle (nodes Kahn's algorithm could not order) aborts with an
 * error only when at least one cycle member participates in fatal
 * validation. A cycle running only through names outside
 * {@link TopoSortOptions.enabledNames} is reported through
 * {@link TopoSortOptions.onSoftValidationWarning} for each member instead,
 * and those members are appended to the result in their original order —
 * harmless, since none of them can ever reach `active` this boot.
 * @param nodes - Loaded package names.
 * @param remainingDeps - Mutable dependency map.
 * @param options - Scopes fatal validation to a subset of packages.
 * @returns Names in dependency-first order.
 */
function runKahnSort(
  nodes: ReadonlySet<string>,
  remainingDeps: Map<string, Set<string>>,
  options: TopoSortOptions,
): string[] {
  const queue: string[] = [];
  for (const [name, deps] of remainingDeps) {
    if (deps.size === 0) queue.push(name);
  }

  const result: string[] = [];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const node = queue.shift()!;
    if (visited.has(node)) continue;
    visited.add(node);
    result.push(node);

    // Unblock dependents whose only remaining dep was `node`
    for (const [dependent, deps] of remainingDeps) {
      if (!deps.has(node)) continue;
      deps.delete(node);
      if (deps.size === 0 && !visited.has(dependent)) {
        queue.push(dependent);
      }
    }
  }

  if (result.length === nodes.size) return result;

  const cycle = [...nodes].filter((n) => !visited.has(n));
  const fatalCycleMembers =
    options.enabledNames === undefined ? cycle : cycle.filter((n) => options.enabledNames!.has(n));
  if (fatalCycleMembers.length > 0) {
    throw new Error(`ExtensionCoordinator: circular dependency detected among: ${cycle.join(', ')}`);
  }

  // Every cycle member is outside the fatal-validated set: record the cycle
  // as a warning on each member instead of aborting boot, and give each one
  // a slot in the returned order so it is still an observable coordinator
  // entry.
  const message = `ExtensionCoordinator: circular dependency detected among disabled packages: ${cycle.join(', ')}`;
  for (const name of cycle) {
    options.onSoftValidationWarning?.(name, message);
    result.push(name);
  }

  return result;
}
