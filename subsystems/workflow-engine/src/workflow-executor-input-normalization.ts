import { JsonValueSchema, type JsonValue } from '@makaio/contracts';

/**
 * Coerce a bus-parsed config value to a plain object or `undefined`.
 *
 * The `workflow.start` schema types config as `JsonValue`, but the executor
 * expects `Record<string, unknown>`. Non-object values are coerced to `{}`.
 * When `config` is `undefined`, returns `undefined` so callers that need to
 * distinguish "caller omitted config" from "caller sent an empty object" can
 * do so (e.g. the rerun handler inherits from the original run context).
 * @param config - Raw config value from the bus request payload.
 * @returns Coerced config record, or `undefined` when omitted.
 */
export function normalizeConfig(config: unknown): Record<string, unknown> | undefined {
  if (config === undefined) return undefined;
  if (isPlainRecord(config)) {
    return config;
  }
  return {};
}

/**
 * Check whether a value is a JSON-like object record.
 * @param value - Candidate value.
 * @returns True when the value is a plain object or null-prototype object.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Normalize workflow.start input to the public JsonValue contract.
 * @param input - Request payload input value.
 * @returns The parsed JSON input, or undefined when omitted.
 */
export function normalizeStartInput(input: unknown): JsonValue | undefined {
  if (input === undefined) {
    return undefined;
  }
  return JsonValueSchema.parse(input);
}
