import type { ExecutionAttemptInstruction, WorkerProvisionRequest, WorkflowWorkerConfig } from '@makaio/contracts';
import { WorkflowWorkerConfigSchema } from '@makaio/contracts';
import { parseWorkflowAttemptInstruction } from '@makaio/subsystem-workflow-engine';

/** Owner-scoped reader for an Attempt's immutable instruction. */
export type WorkflowAttemptInstructionReader = (input: {
  readonly executionId: string;
  readonly executionAttemptId: string;
}) => Promise<ExecutionAttemptInstruction | null>;

/**
 * Resolves a workflow-specific launch configuration from a generic Worker request.
 *
 * This is intentionally a narrow adapter seam: common Worker provisioning never
 * interprets workload input, while the Piscina provider remains explicitly a
 * workflow runtime.
 */
export type WorkflowLaunchResolver = (
  request: WorkerProvisionRequest,
  signal: AbortSignal,
) => Promise<WorkflowWorkerConfig>;

/**
 * Create the workflow adapter used by the local Piscina provider.
 *
 * The reader is owner-scoped rather than bus-backed because a Worker has not
 * registered a runtime generation before the provider launches it.
 * @param readInstruction - Trusted Authority read for one owner and Attempt.
 * @returns Resolver that reconstructs the worker configuration for that Attempt.
 */
export function createWorkflowLaunchResolver(
  readInstruction: WorkflowAttemptInstructionReader,
): WorkflowLaunchResolver {
  return async (request, signal) => {
    signal.throwIfAborted();
    const instruction = await readInstruction({
      executionId: request.executionId,
      executionAttemptId: request.executionAttemptId,
    });
    signal.throwIfAborted();
    if (instruction === null) {
      throw new Error(
        `Workflow launch instruction is unavailable for execution '${request.executionId}' ` +
          `attempt '${request.executionAttemptId}'`,
      );
    }

    const input = parseWorkflowAttemptInstruction(instruction);
    if (input.executionId !== request.executionId) {
      throw new Error(
        `Workflow instruction execution '${input.executionId}' does not match Worker request '${request.executionId}'`,
      );
    }

    return WorkflowWorkerConfigSchema.parse({
      source: input.source,
      ...(input.definitionSnapshot !== undefined ? { definition: input.definitionSnapshot } : {}),
      executionId: input.executionId,
      workflowId: input.workflowId,
      triggerPayload: input.triggerPayload,
      ...(input.triggerMode !== undefined ? { triggerMode: input.triggerMode } : {}),
      inputs: input.inputs,
      ...(input.config !== undefined ? { config: input.config } : {}),
      ...(input.artifactRef !== undefined ? { artifactRef: input.artifactRef } : {}),
      scope: input.scope,
      ...(request.connection.busUrl !== undefined ? { busUrl: request.connection.busUrl } : {}),
      busAuth: request.connection.busAuth,
      ...(request.connection.env !== undefined ? { env: request.connection.env } : {}),
      coordinatorSessionId: input.coordinatorSessionId,
      cancelSubject: input.cancelSubject,
      suspensionStrategy: request.runtimeInputs.suspensionStrategy,
      terminalAuthority: input.terminalAuthority,
      ...(input.materializationSpec !== undefined ? { materializationSpec: input.materializationSpec } : {}),
    });
  };
}
