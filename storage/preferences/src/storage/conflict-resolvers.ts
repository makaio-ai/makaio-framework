import type { StoredPreference } from './types.js';

/**
 * Strategy for resolving write conflicts between backends.
 * SEAM: Pluggable for future strategies (merge, user prompt).
 */
export interface ConflictResolver {
  /**
   * Resolves conflict when both backends have different values.
   * @param local - Value from localStorage with timestamp
   * @param database - Value from database with timestamp
   * @returns The winning value to persist, or null if both are null
   */
  resolve(local: StoredPreference | null, database: StoredPreference | null): StoredPreference | null;
}

/**
 * Last-write-wins conflict resolver (default).
 * Compares timestamps and returns the most recent value.
 * When timestamps are equal, prefers database value for consistency.
 */
export const lastWriteWinsResolver: ConflictResolver = {
  resolve(local, database) {
    if (!local && !database) return null;
    if (!local) return database;
    if (!database) return local;
    return local.updatedAt > database.updatedAt ? local : database;
  },
};

/**
 * Creates a custom conflict resolver.
 * @param resolveFn - Custom resolution function
 * @returns ConflictResolver instance
 */
export function createConflictResolver(
  resolveFn: (local: StoredPreference | null, database: StoredPreference | null) => StoredPreference | null,
): ConflictResolver {
  return { resolve: resolveFn };
}
