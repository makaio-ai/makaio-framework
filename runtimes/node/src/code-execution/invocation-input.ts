import {
  CodeExecutionProgramSchema,
  snapshotJsonBoundary,
  type CodeExecutionFailedOutcome,
  type CodeExecutionRequest,
} from '@makaio/contracts';

/** Detached invocation fields before argument admission. */
export interface OwnedInvocationInput {
  /** Validated, detached program definition. */
  readonly program: CodeExecutionRequest['program'];
  /** Detached argument tree, still subject to JSON value admission. */
  readonly arguments: unknown;
}

/**
 * Identify the two-field compact snapshot produced below.
 * @param value - Candidate compact boundary snapshot.
 * @returns Whether the snapshot carries both retained fields.
 */
function isInvocationProjection(value: unknown): value is Readonly<Record<'program' | 'arguments', unknown>> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && 'program' in value && 'arguments' in value
  );
}

/**
 * Create the compact invalid-program outcome used before provider admission.
 * @param message - Safe diagnostic returned to the direct caller.
 * @returns A terminal invalid-program outcome.
 */
function invalidInvocation(message: string): CodeExecutionFailedOutcome {
  return { status: 'failed', error: { code: 'invalid_program', message } };
}

/**
 * Read and detach the provider-owned invocation fields exactly once.
 * @param request - Direct invocation whose retained fields are being owned.
 * @returns Detached fields, or a terminal invalid-program outcome.
 */
export function snapshotInvocationInput(
  request: CodeExecutionRequest,
): OwnedInvocationInput | CodeExecutionFailedOutcome {
  const compact: Record<'program' | 'arguments', unknown> = { program: undefined, arguments: undefined };
  let snapshot;
  try {
    compact.program = Reflect.get(request, 'program');
    compact.arguments = Reflect.get(request, 'arguments');
    snapshot = snapshotJsonBoundary(compact);
  } catch {
    return invalidInvocation('The invocation could not be read into a stable JSON boundary snapshot.');
  }
  if (!snapshot.ok || !isInvocationProjection(snapshot.value)) {
    return invalidInvocation('The invocation could not be read into a stable JSON boundary snapshot.');
  }
  const program = CodeExecutionProgramSchema.safeParse(snapshot.value.program);
  if (!program.success) return invalidInvocation('The invocation program does not satisfy the CodeExecution contract.');
  return { program: program.data, arguments: snapshot.value.arguments };
}
