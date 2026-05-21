import { toolError, ToolErrorCodes, type ToolResult, type ToolExecutionContext } from './index.js';

/**
 * Validates that sessionId is present in the context.
 * @param context - Tool execution context
 * @param entityName - Name of entity for error message (e.g., 'artifact', 'task')
 * @returns Session ID if valid, or error result
 */
export function validateSessionId(
  context: ToolExecutionContext,
  entityName: string = 'entity',
): { valid: true; sessionId: string } | { valid: false; error: ToolResult<never> } {
  if (!context.sessionId) {
    return {
      valid: false,
      error: toolError(
        ToolErrorCodes.VALIDATION_FAILED,
        `sessionId is required in context for ${entityName} operations`,
      ),
    };
  }
  return { valid: true, sessionId: context.sessionId };
}

/**
 * Emits an event on the bus if available.
 *
 * The subject must be a properly typed subject definition from a registered namespace.
 * Type inference ensures the payload matches the subject's schema at compile time.
 * @param context - Tool execution context
 * @param subject - Typed subject definition from a registered namespace
 * @param payload - Event payload matching the subject's schema
 * @example
 * ```typescript
 * import { TaskSubjects } from '@makaio/tools-tasks/subjects';
 *
 * await emitEvent(context, TaskSubjects.created, {
 *   taskId: '123',
 *   title: 'Fix bug',
 * });
 * ```
 */
export async function emitEvent<S extends { $meta: { payload: unknown } }>(
  context: ToolExecutionContext,
  subject: S,
  payload: S['$meta']['payload'],
): Promise<void> {
  if (context.bus) {
    // The subject type is constrained by S, and payload matches S['$meta']['payload'].
    // The `as never` casts bridge the generic constraint to the concrete bus signature
    // which expects full SubjectDefinition. This is safe because:
    // 1. S must have $meta.payload (enforced by generic constraint)
    // 2. payload is typed to match that $meta.payload
    // 3. At runtime, any subject with $meta will work with the bus
    await context.bus.emit(subject as never, payload as never);
  }
}

/**
 * Operation handler function type for CRUD tools.
 *
 * Handler functions receive the operation-specific input, validated sessionId,
 * and execution context.
 *
 * Type parameters:
 * - TInput: The operation-specific input type (extracted from discriminated union)
 * - TOutput: The tool's output type
 */
type OperationHandler<TInput, TOutput> = (
  input: TInput,
  sessionId: string,
  context: ToolExecutionContext,
) => Promise<ToolResult<TOutput>>;

/**
 * Handler map for discriminated union CRUD operations.
 *
 * Maps operation names (discriminator values) to their handler functions.
 *
 * Type parameters:
 * - TInput: The full discriminated union input type
 * - TOutput: The tool's output type
 */
type OperationHandlers<TInput extends { op: string }, TOutput> = {
  [K in TInput['op']]: OperationHandler<Extract<TInput, { op: K }>, TOutput>;
};

/**
 * Executes a CRUD tool operation with session validation and operation routing.
 *
 * This helper consolidates the common pattern of:
 * 1. Validating sessionId from context
 * 2. Routing to operation-specific handlers based on discriminated union
 *
 * The input type must be a discriminated union with an `op` field.
 * Handler functions are provided in a map keyed by operation name.
 *
 * Type parameters:
 * - TInput: Discriminated union input type with `op` field
 * - TOutput: Tool output type
 * @param input - The tool input with operation discriminator
 * @param context - Tool execution context
 * @param entityName - Entity name for validation error messages (e.g., 'task', 'artifact')
 * @param handlers - Map of operation names to handler functions
 * @returns Tool result from the appropriate operation handler
 * @example
 * ```typescript
 * export const myTool = defineTool({
 *   name: 'my_tool',
 *   inputSchema: z.discriminatedUnion('op', [
 *     z.object({ op: z.literal('create'), data: z.string() }),
 *     z.object({ op: z.literal('list') }),
 *   ]),
 *   execute: async (input, context) => {
 *     return executeCrudOperation(input, context, 'item', {
 *       create: async (input, sessionId, context) => {
 *         // Handle create...
 *       },
 *       list: async (input, sessionId, context) => {
 *         // Handle list...
 *       },
 *     });
 *   },
 * });
 * ```
 */
export async function executeCrudOperation<TInput extends { op: string }, TOutput>(
  input: TInput,
  context: ToolExecutionContext,
  entityName: string,
  handlers: OperationHandlers<TInput, TOutput>,
): Promise<ToolResult<TOutput>> {
  // Validate sessionId is present
  const sessionValidation = validateSessionId(context, entityName);
  if (!sessionValidation.valid) {
    return sessionValidation.error;
  }
  const { sessionId } = sessionValidation;

  // Route to appropriate handler based on operation
  // The cast is safe because TInput['op'] is guaranteed to be a key of handlers
  const handler = handlers[input.op as TInput['op']];
  return handler(input as never, sessionId, context);
}
