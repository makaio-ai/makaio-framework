import { versionSatisfies } from '@makaio/contracts';
import type { KernelMakaioExtension } from './types.js';

/**
 * Topological sort using Kahn's algorithm.
 *
 * Returns extension names in dependency-first order.
 * @param packages - Extensions to sort
 * @returns Names in topological order (dependencies before dependents)
 * @throws Error when a duplicate extension name is detected, a declared
 *   dependency is missing from the loaded set, or a circular dependency
 *   is detected
 */
export function topoSort(packages: ReadonlyArray<KernelMakaioExtension>): string[] {
  const nodes = collectUniqueNames(packages);
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg] as const));

  validateDependencies(packages, nodes, byName);

  const remainingDeps = buildRemainingDependencyMap(packages, nodes);
  const result = runKahnSort(nodes, remainingDeps);

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
 */
function validateDependencies(
  packages: ReadonlyArray<KernelMakaioExtension>,
  nodes: ReadonlySet<string>,
  byName: ReadonlyMap<string, KernelMakaioExtension>,
): void {
  for (const p of packages) {
    validatePackageDependencies(p, nodes, byName);
  }
}

/**
 * Validate one package's dependencies.
 * @param pkg - Package whose dependencies should be checked.
 * @param nodes - Loaded package names.
 * @param byName - Loaded packages keyed by name.
 */
function validatePackageDependencies(
  pkg: KernelMakaioExtension,
  nodes: ReadonlySet<string>,
  byName: ReadonlyMap<string, KernelMakaioExtension>,
): void {
  const dependencies = pkg.dependencies ?? [];
  const missing = dependencies.filter((dep) => !dep.optional && !nodes.has(dep.name));
  if (missing.length > 0) {
    throw new Error(
      `ExtensionCoordinator: package "${pkg.name}" declares missing dependencies: ${missing.map((d) => d.name).join(', ')}`,
    );
  }

  for (const dep of dependencies) {
    const dependencyPackage = byName.get(dep.name);
    if (dependencyPackage === undefined) continue;
    const dependencyVersion = dependencyPackage.version;
    if (!versionSatisfies(dependencyVersion, dep.version)) {
      throw new Error(
        `ExtensionCoordinator: package "${pkg.name}" dependency "${dep.name}" version ${dependencyVersion} does not satisfy ${dep.version}`,
      );
    }
  }
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
 * @param nodes - Loaded package names.
 * @param remainingDeps - Mutable dependency map.
 * @returns Names in dependency-first order.
 */
function runKahnSort(nodes: ReadonlySet<string>, remainingDeps: Map<string, Set<string>>): string[] {
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

  if (result.length !== nodes.size) {
    const cycle = [...nodes].filter((n) => !visited.has(n));
    throw new Error(`ExtensionCoordinator: circular dependency detected among: ${cycle.join(', ')}`);
  }

  return result;
}
