/**
 * Runtime type guards and coercion helpers for Claude Code settings values.
 *
 * All functions are pure and side-effect-free.  They validate raw JSON values
 * read from settings files and coerce them into strongly-typed structures,
 * silently dropping any non-conforming entries.
 * @packageDocumentation
 */

import { ClaudeCodeHookDefinitionSchema, ClaudeCodeStatuslineValueSchema } from '../schemas/config.js';
import type {
  ClaudeCodeStatuslineValue,
  ClaudeCodeHookDefinition,
  ClaudeCodeHookMatcherGroup,
} from '../schemas/config.js';

/**
 * Asserts that a value is structurally a valid status-line object.  Used as a
 * runtime narrowing guard when reading raw JSON from disk.
 * @param value - The raw value read from a JSON settings file.
 * @returns `true` when `value` conforms to the status-line shape.
 */
export function isStatuslineValue(value: unknown): value is ClaudeCodeStatuslineValue {
  return ClaudeCodeStatuslineValueSchema.safeParse(value).success;
}

/**
 * Asserts that a value is a valid {@link ClaudeCodeHookDefinition}.
 * @param value - The raw value to test.
 * @returns `true` when `value` conforms to the hook definition shape.
 */
export function isHookDefinition(value: unknown): value is ClaudeCodeHookDefinition {
  return ClaudeCodeHookDefinitionSchema.safeParse(value).success;
}

/**
 * Asserts that a value is a valid {@link ClaudeCodeHookMatcherGroup}.
 * @param value - The raw value to test.
 * @returns `true` when `value` conforms to the hook matcher group shape.
 */
export function isHookMatcherGroup(value: unknown): value is ClaudeCodeHookMatcherGroup {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (obj['matcher'] !== undefined && typeof obj['matcher'] !== 'string') return false;
  if (!Array.isArray(obj['hooks'])) return false;
  return obj['hooks'].every(isHookDefinition);
}

/**
 * Returns the raw `hooks` map when the settings value is object-shaped.
 * @param raw - The raw value of the `hooks` key from a settings file.
 * @returns The raw hook event map, or `null` when the value cannot be treated
 *   as a native Claude Code hooks object.
 */
export function getRawHooksMap(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

/**
 * Coerce the raw `hooks` value from settings JSON into a typed hooks map.
 * Non-conforming entries are silently dropped.
 * @param raw - The raw value of the `hooks` key from a settings file.
 * @returns A validated map of event name to hook matcher group arrays.
 */
export function coerceHooksMap(raw: unknown): Record<string, ClaudeCodeHookMatcherGroup[]> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const result: Record<string, ClaudeCodeHookMatcherGroup[]> = {};
  for (const [eventName, groups] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    const validated = groups.filter(isHookMatcherGroup);
    if (validated.length > 0) {
      result[eventName] = validated;
    }
  }
  return result;
}

/**
 * Returns `true` when two hook definitions are structurally identical (same
 * `type`, `command`, and `timeout`).
 * @param a - First hook definition.
 * @param b - Second hook definition.
 * @returns `true` when both hooks are identical.
 */
export function hooksAreIdentical(a: ClaudeCodeHookDefinition, b: ClaudeCodeHookDefinition): boolean {
  return a.type === b.type && a.command === b.command && a.timeout === b.timeout;
}
