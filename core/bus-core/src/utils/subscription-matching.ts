/**
 * Subscription pattern matching utilities.
 *
 * Supports exact matches, subject wildcards (e.g., 'adapter.*'),
 * and namespace wildcards (e.g., 'adapter:*').
 *
 * ## Pattern Matching Decision Tree
 *
 * ```
 * Pattern ends with...?
 * │
 * ├─ No asterisk (e.g., 'adapter.log')
 * │  └─ Exact match: subject === pattern
 * │
 * ├─ ':*' (e.g., 'adapter:*', 'adapter:claudeCode:*')
 * │  └─ Namespace wildcard: matches child namespace subjects
 * │     • 'adapter:*' matches 'adapter:claudeCode.log'
 * │     • 'adapter:*' matches 'adapter:claudeCode:sdk.thinking'
 * │     • 'adapter:*' does NOT match 'adapter.log' (no child namespace)
 * │
 * └─ '.*' (e.g., 'adapter.*', 'adapter:claudeCode.*')
 *    └─ Subject wildcard: matches subjects in specific namespace
 *       • 'adapter.*' matches 'adapter.log', 'adapter.error'
 *       • 'adapter.*' does NOT match 'adapter:claudeCode.log'
 *       • 'adapter:claudeCode.*' matches 'adapter:claudeCode.log'
 * ```
 *
 * ## Colon vs Dot Semantics
 *
 * - **Colon (`:`)** = namespace hierarchy boundary
 *   - `adapter:claudeCode` is a child namespace of `adapter`
 *   - Wildcard `:*` crosses this boundary
 *
 * - **Dot (`.`)** = subject separator within namespace
 *   - `adapter.log` is a subject in the `adapter` namespace
 *   - Wildcard `.*` enumerates subjects, doesn't cross namespace boundaries
 */

/**
 * Check if a subject matches a subscription pattern.
 *
 * Patterns can be:
 * - Exact match: 'adapter:claudeCode.log' matches only 'adapter:claudeCode.log'
 * - Subject wildcard: 'adapter:claudeCode.*' matches 'adapter:claudeCode.log', 'adapter:claudeCode.initialized'
 * - Namespace wildcard: 'adapter:*' matches subjects from child namespaces
 * @param subject - Subject to match (e.g., 'adapter:claudeCode:sdk.thinking')
 * @param pattern - Subscription pattern (e.g., 'adapter:*', 'adapter:claudeCode.*', 'adapter:claudeCode.log')
 * @returns true if subject matches pattern
 * @example
 * ```typescript
 * // Exact match
 * matchesSubscription('adapter.log', 'adapter.log')
 * // → true
 *
 * // Subject wildcard - matches subjects in namespace
 * matchesSubscription('adapter.log', 'adapter.*')
 * // → true
 * matchesSubscription('adapter.initialized', 'adapter.*')
 * // → true
 * matchesSubscription('adapter:claudeCode.log', 'adapter.*')
 * // → false (different namespace - adapter:claudeCode vs adapter)
 *
 * // Namespace wildcard - matches child namespaces
 * matchesSubscription('adapter:claudeCode.initialized', 'adapter:*')
 * // → true (claudeCode is child of adapter)
 * matchesSubscription('adapter:claudeCode:sdk.thinking', 'adapter:*')
 * // → true (sdk is descendant of adapter)
 * matchesSubscription('adapter:gpt.initialized', 'adapter:*')
 * // → true (gpt is child of adapter)
 *
 * // Multi-level namespace wildcard
 * matchesSubscription('adapter:claudeCode:sdk.thinking', 'adapter:claudeCode:*')
 * // → true (sdk is child of adapter:claudeCode)
 * matchesSubscription('adapter:gpt.initialized', 'adapter:claudeCode:*')
 * // → false (different branch)
 * ```
 */
export function matchesSubscription(subject: string, pattern: string): boolean {
  // Global wildcard: matches every subject unconditionally.
  if (pattern === '*') {
    return true;
  }

  // Exact match
  if (!pattern.endsWith('*')) {
    return subject === pattern;
  }

  // Namespace wildcard: 'adapter:*'
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -2); // Remove ':*'
    // Match if subject starts with namespace and has child namespace or subject
    // 'adapter:claudeCode.log' starts with 'adapter:'
    // 'adapter:claudeCode:sdk.thinking' starts with 'adapter:'
    return subject.startsWith(prefix + ':');
  }

  // Subject wildcard: 'adapter.*' or 'adapter:claudeCode.*'
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -2); // Remove '.*'
    // Match if subject starts with namespace + '.'
    // 'adapter.log' matches 'adapter.*'
    // 'adapter:claudeCode.initialized' matches 'adapter:claudeCode.*'
    return subject.startsWith(prefix + '.');
  }

  return false;
}

/**
 * Check if a subject matches any pattern in a collection.
 * @param subject - Subject to match
 * @param patterns - Collection of subscription patterns
 * @returns true if subject matches at least one pattern
 * @example
 * ```typescript
 * matchesAnySubscription('adapter.log', new Set(['adapter.*', 'agent.*']))
 * // → true (matches 'adapter.*')
 *
 * matchesAnySubscription('adapter:claudeCode.initialized', new Set(['adapter:*']))
 * // → true (matches 'adapter:*')
 *
 * matchesAnySubscription('session.started', new Set(['adapter.*', 'adapter:*']))
 * // → false (no match)
 *
 * matchesAnySubscription('adapter.log', new Set())
 * // → false (empty patterns)
 * ```
 */
export function matchesAnySubscription(subject: string, patterns: Iterable<string>): boolean {
  for (const pattern of patterns) {
    if (matchesSubscription(subject, pattern)) {
      return true;
    }
  }
  return false;
}
