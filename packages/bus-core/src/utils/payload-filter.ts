/**
 * Payload filter matching utilities.
 *
 * Provides runtime matching of payloads against declarative filter specs.
 * Supports dot-notation paths and filter operators ($in, $ne, $exists, $startsWith, $endsWith).
 */
import { type FilterOperator, isOperatorObject, type PayloadFilter } from '@makaio/core';

type Primitive = string | number | boolean | null;

/**
 * Get a nested value from an object using dot-notation path.
 * @param obj - Object to traverse
 * @param path - Dot-notation path (e.g., 'raw.msg.type')
 * @returns Value at path, or undefined if not found
 * @example
 * ```typescript
 * const obj = { raw: { msg: { type: 'event' } } };
 * getPath(obj, 'raw.msg.type'); // 'event'
 * getPath(obj, 'raw.missing'); // undefined
 * ```
 */
export function getPath(obj: unknown, path: string): unknown {
  if (obj === null || obj === undefined) {
    return undefined;
  }

  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Check if a value matches a filter operator.
 * @param actual - Actual value from payload
 * @param operator - Filter operator (equality value or operator object)
 * @returns true if value matches operator
 */
function matchOperator(actual: unknown, operator: FilterOperator): boolean {
  // Handle operator objects
  if (isOperatorObject(operator)) {
    if ('$in' in operator) {
      return (operator.$in as Primitive[]).includes(actual as Primitive);
    }
    if ('$ne' in operator) {
      return actual !== operator.$ne;
    }
    if ('$exists' in operator) {
      const exists = actual !== undefined;
      return operator.$exists ? exists : !exists;
    }
    if ('$startsWith' in operator) {
      return typeof actual === 'string' && actual.startsWith(operator.$startsWith);
    }
    if ('$endsWith' in operator) {
      return typeof actual === 'string' && actual.endsWith(operator.$endsWith);
    }
    // Should never reach here due to type system
    return false;
  }

  // Simple equality
  return actual === operator;
}

/**
 * Check if a payload matches all filter conditions.
 *
 * All conditions are ANDed together - all must match for the filter to pass.
 * @param payload - Message payload to check
 * @param filter - Filter specification with field paths and operators
 * @returns true if payload matches all filter conditions
 * @example
 * ```typescript
 * const payload = {
 *   agentId: 'agent-123',
 *   raw: { msg: { type: 'session_configured' } },
 *   status: 'active',
 * };
 *
 * // All conditions must match
 * matchesFilter(payload, {
 *   agentId: 'agent-123',
 *   'raw.msg.type': 'session_configured',
 * }); // true
 *
 * // With operators
 * matchesFilter(payload, {
 *   status: { $in: ['active', 'pending'] },
 * }); // true
 *
 * matchesFilter(payload, {
 *   error: { $exists: false },
 * }); // true (no error field)
 * ```
 */
export function matchesFilter(payload: unknown, filter: PayloadFilter): boolean {
  for (const [path, operator] of Object.entries(filter)) {
    const actual = getPath(payload, path);
    if (!matchOperator(actual, operator)) {
      return false;
    }
  }
  return true;
}

/**
 * Merge two payload filters together.
 *
 * Later filter values override earlier ones for the same path.
 * @param base - Base filter
 * @param override - Filter to merge in (overrides base)
 * @returns Merged filter
 */
export function mergeFilters(
  base: PayloadFilter | undefined,
  override: PayloadFilter | undefined,
): PayloadFilter | undefined {
  if (!base && !override) return undefined;
  if (!base) return override;
  if (!override) return base;

  return { ...base, ...override };
}
