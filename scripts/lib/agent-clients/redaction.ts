/**
 * Redaction utilities for the agent-client probe harness.
 *
 * Ensures that credentials, paths, identifiers, timestamps, transcripts,
 * tool inputs, and provider prose are stripped from hook event payloads
 * before fixture persistence.
 * @packageDocumentation
 */
import { REDACTED_PLACEHOLDER, REDACTION_KEY_PATTERNS, REDACTION_VALUE_PATTERNS } from './types.js';

/**
 * Checks whether a key name matches any credential-like pattern.
 * @param key - The property key to check.
 * @returns `true` if the key matches a redaction pattern.
 */
export function isRedactableKey(key: string): boolean {
  const lower = key.toLowerCase();
  return REDACTION_KEY_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * Redacts sensitive patterns from a string value.
 *
 * Replaces absolute paths, ISO timestamps, and UUIDs with `[redacted]`.
 * @param value - The string to redact.
 * @returns The redacted string.
 */
export function redactStringValue(value: string): string {
  let result = value;
  for (const pattern of REDACTION_VALUE_PATTERNS) {
    // Clone the regex to reset lastIndex for global patterns
    const regex = new RegExp(pattern.source, pattern.flags);
    result = result.replace(regex, REDACTED_PLACEHOLDER);
  }
  return result;
}

/**
 * Deeply redacts an object, removing credential-like keys and scrubbing
 * sensitive patterns from string values.
 * @param input - The value to redact. Primitives are returned with string scrubbing;
 *   objects and arrays are recursively processed.
 * @returns A new value with all sensitive data replaced by `[redacted]`.
 */
export function redactDeep(input: unknown): unknown {
  if (input === null || input === undefined) return input;
  if (typeof input === 'string') return redactStringValue(input);
  if (typeof input === 'number' || typeof input === 'boolean') return input;

  if (Array.isArray(input)) {
    return input.map((item) => redactDeep(item));
  }

  if (typeof input === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (isRedactableKey(key)) {
        result[key] = REDACTED_PLACEHOLDER;
      } else {
        result[key] = redactDeep(value);
      }
    }
    return result;
  }

  return input;
}
