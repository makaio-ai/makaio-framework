import { eq, inArray } from 'drizzle-orm';
import type { SQL, Column } from 'drizzle-orm';

/**
 * Table with a scope column for two-tier scoping.
 */
interface ScopeTable {
  /** Scope column for filtering (default or projectId) */
  scope: Column;
}

/**
 * Builds standard scope predicates for two-tier scoping (default | projectId).
 *
 * When projectId is provided: returns both default and project-scoped entities.
 * When projectId is undefined: returns only default-scoped entities.
 * @param table - Table with 'scope' column
 * @param projectId - Optional project ID for scoping
 * @returns Array of SQL predicates
 * @example
 * ```typescript
 * const predicates = buildScopePredicates(profileDefinitions, 'proj-123');
 * // Returns: [inArray(profileDefinitions.scope, ['default', 'proj-123'])]
 *
 * const predicates = buildScopePredicates(profileDefinitions, undefined);
 * // Returns: [eq(profileDefinitions.scope, 'default')]
 * ```
 */
export function buildScopePredicates<T extends ScopeTable>(table: T, projectId: string | undefined): SQL[] {
  if (projectId) {
    return [inArray(table.scope, ['default', projectId])];
  }
  return [eq(table.scope, 'default')];
}
