import { ExecutionHintsSchema, JsonValueSchema, type JsonValue, type WorkflowRunContext } from '@makaio/contracts';

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
  if (config !== null && typeof config === 'object' && !Array.isArray(config)) {
    return config as Record<string, unknown>;
  }
  return {};
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

/**
 * Normalize workflow.start execution hints to the public opaque hints contract.
 * @param executionHints - Request payload hints value.
 * @returns Parsed execution hints, or undefined when omitted.
 */
export function normalizeExecutionHints(executionHints: unknown): WorkflowRunContext['executionHints'] {
  if (executionHints === undefined) {
    return undefined;
  }
  return ExecutionHintsSchema.parse(executionHints);
}
