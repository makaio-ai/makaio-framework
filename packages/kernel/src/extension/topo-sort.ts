import type { MakaioExtension } from '@makaio/contracts';

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
export function topoSort(packages: ReadonlyArray<MakaioExtension>): string[] {
  const nodes = new Set<string>();
  for (const p of packages) {
    if (nodes.has(p.name)) {
      throw new Error(`ExtensionCoordinator: duplicate package name detected: "${p.name}"`);
    }
    nodes.add(p.name);
  }

  // Validate that all declared dependencies are present in the loaded set.
  for (const p of packages) {
    const missing = (p.dependencies ?? []).filter((dep) => !nodes.has(dep));
    if (missing.length > 0) {
      throw new Error(`ExtensionCoordinator: package "${p.name}" declares missing dependencies: ${missing.join(', ')}`);
    }
  }

  // edges: name -> set of its dependencies
  const edges = new Map<string, Set<string>>();
  for (const p of packages) {
    edges.set(p.name, new Set(p.dependencies ?? []));
  }

  // remainingDeps tracks what each node still needs before it can run
  const remainingDeps = new Map<string, Set<string>>();
  for (const [name, deps] of edges) {
    remainingDeps.set(name, new Set(deps));
  }

  // Seed queue with nodes that have no unresolved deps
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
