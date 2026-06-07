import { ExecutionHintsSchema, JsonValueSchema, type JsonValue, type WorkflowRunContext } from '@makaio/contracts';

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
