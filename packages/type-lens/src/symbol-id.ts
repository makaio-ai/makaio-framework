import type { SymbolKind } from './schemas.js';

/**
 * Compute a djb2-style 32-bit integer hash.
 * @param str - Input string to hash.
 * @returns 32-bit integer hash.
 */
function djb2Hash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash = hash & hash;
  }
  return hash;
}

/**
 * Generate a stable, hash-based symbol ID from its coordinates.
 *
 * The hash is intentionally a simple djb2-style integer fold so that it
 * runs in the worker without any external dependency. Collision probability
 * is negligible for the expected symbol counts per scope.
 * @param file - Relative file path
 * @param namespacePath - Owner class name, or empty string for top-level symbols
 * @param name - Symbol name
 * @param kind - Symbol kind
 * @returns Stable symbol ID prefixed with `sym_`
 */
export function generateId(file: string, namespacePath: string, name: string, kind: SymbolKind): string {
  return `sym_${Math.abs(djb2Hash(`${file}:${namespacePath}:${name}:${kind}`)).toString(36)}`;
}

/**
 * Generate a stable helper ID from arbitrary symbol coordinates.
 * @param scopeKey - Stable scope key.
 * @param file - Relative file path.
 * @param name - Symbol name.
 * @returns Stable symbol ID prefixed with `sym_`.
 */
export function createSymbolId(scopeKey: string, file: string, name: string): string {
  return `sym_${Math.abs(djb2Hash(`${scopeKey}:${file}:${name}`)).toString(36)}`;
}
