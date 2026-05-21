/**
 * Declarative payload filter types for smart-routing across transports.
 *
 * Filters are serializable (no functions) so they can be sent over wire
 * and applied server-side before forwarding messages to clients.
 */

import type { Paths } from 'type-fest';

type Primitive = string | number | boolean | null;

/**
 * Filter operators for payload field matching.
 * @example
 * ```typescript
 * // Equality (implicit)
 * { agentId: 'agent-123' }
 *
 * // Membership
 * { status: { $in: ['active', 'pending'] } }
 *
 * // Not equal
 * { type: { $ne: 'internal' } }
 *
 * // Presence check
 * { error: { $exists: false } }
 *
 * // String prefix/suffix matching
 * { path: { $startsWith: '.git/' } }
 * { file: { $endsWith: '.ts' } }
 * ```
 */
export type FilterOperator<T extends Primitive = Primitive> =
  | T // Equality: { agentId: 'abc' }
  | { $in: T[] } // Membership: { status: { $in: ['a', 'b'] } }
  | { $ne: T } // Not equal: { type: { $ne: 'internal' } }
  | { $exists: boolean } // Presence: { error: { $exists: false } }
  | { $startsWith: string } // Prefix: { path: { $startsWith: '.git/' } }
  | { $endsWith: string }; // Suffix: { file: { $endsWith: '.ts' } }

/**
 * Untyped payload filter - accepts any string keys.
 * Use TypedPayloadFilter<T> for type-safe filters.
 */
export type PayloadFilter = Record<string, FilterOperator>;

/**
 * Type-safe payload filter constrained to valid paths of a payload type.
 *
 * Uses type-fest's `Paths` to support dotted path notation for nested fields.
 * @example
 * ```typescript
 * interface McpPayload {
 *   agentId: string;
 *   raw: { msg: { type: string } };
 * }
 *
 * // Type-safe - validates both top-level and nested paths
 * const filter: TypedPayloadFilter<McpPayload> = {
 *   agentId: 'agent-123',
 *   'raw.msg.type': 'session_configured',  // ✅ valid path
 *   'raw.msg.typo': 'x',                   // ❌ type error
 * };
 * ```
 */
export type TypedPayloadFilter<T> = {
  [K in Paths<T> & string]?: FilterOperator;
};

/**
 * Type guard to check if a value is a filter operator object.
 * @param value - The filter operator value to check
 * @returns True if the value is a filter operator object with $in, $ne, $exists, $startsWith, or $endsWith
 */
export function isOperatorObject(
  value: FilterOperator,
): value is
  | { $in: Primitive[] }
  | { $ne: Primitive }
  | { $exists: boolean }
  | { $startsWith: string }
  | { $endsWith: string } {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return '$in' in obj || '$ne' in obj || '$exists' in obj || '$startsWith' in obj || '$endsWith' in obj;
}
