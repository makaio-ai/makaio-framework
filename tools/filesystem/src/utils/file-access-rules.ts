import type { MakaioContext } from '@makaio/core';
import { FILE_ACCESS_RULES_KEY, type FileAccessRules } from '../types.js';

/**
 * Check whether `allowedDirectories` is well-formed: undefined or a string[].
 * @param value - The candidate value to validate
 * @returns True when `allowedDirectories` is absent or a valid string array
 */
function hasValidAllowedDirectories(value: unknown): boolean {
  const allowedDirectories = (value as { allowedDirectories?: unknown })?.allowedDirectories;
  return (
    allowedDirectories === undefined ||
    (Array.isArray(allowedDirectories) && allowedDirectories.every((item) => typeof item === 'string'))
  );
}

/**
 * Runtime guard for FileAccessRules injected into context constraints.
 *
 * The `isDenied` predicate is the primary gate — it must always be callable.
 * `allowedDirectories` is validated separately: if malformed, it is sanitized
 * to `undefined` (unrestricted) rather than rejecting the entire rules object.
 * This prevents a bad `allowedDirectories` value from silently disabling the
 * ignore-rules predicate, which would be *less* secure than dropping the
 * directory constraint alone.
 * @param value - Unknown constraint payload
 * @returns True when payload has a callable deny predicate
 */
function isFileAccessRules(value: unknown): value is FileAccessRules {
  return (
    typeof value === 'object' &&
    value !== null &&
    'isDenied' in value &&
    typeof (value as { isDenied?: unknown }).isDenied === 'function'
  );
}

/**
 * Safely read compiled file access rules from context constraints.
 *
 * When the `isDenied` predicate is present and callable, rules are accepted.
 * If `allowedDirectories` is malformed it is stripped (treated as unrestricted)
 * so the ignore-rules predicate still applies. Fully malformed payloads
 * (missing `isDenied`) are treated as absent.
 * @param context - Makaio execution context
 * @returns File access rules when present and well-formed
 */
export function getFileAccessRules(context: MakaioContext): FileAccessRules | undefined {
  const candidate = context.constraints?.[FILE_ACCESS_RULES_KEY];
  if (!isFileAccessRules(candidate)) return undefined;

  // Sanitize: if allowedDirectories is malformed, strip it so isDenied still applies
  if (!hasValidAllowedDirectories(candidate)) {
    const { allowedDirectories: _malformed, ...rest } = candidate as FileAccessRules & {
      allowedDirectories: unknown;
    };
    return rest as FileAccessRules;
  }

  return candidate;
}
