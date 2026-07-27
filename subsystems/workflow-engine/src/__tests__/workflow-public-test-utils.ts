import { expect, vi } from 'vitest';
import { MakaioBus, RequestError } from '@makaio/bus-core';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import {
  type WorkflowErrorCode,
  type WorkflowRunnerCompletion,
  type WorkflowRunResult,
  type WorkflowWorkerConfig,
} from '@makaio/contracts';

/**
 * Assert that a failed bus request wraps a typed workflow error.
 * @param error - Request error returned by the bus.
 * @param code - Expected workflow error code.
 * @param message - Expected workflow error message.
 */
export function expectRequestErrorCause(error: unknown, code: WorkflowErrorCode, message: string): void {
  expect(error).toBeInstanceOf(RequestError);
  expect((error as RequestError).cause).toMatchObject({ code, message });
}

/**
 * Keep a stub workflow runner alive until test teardown aborts it.
 * @param config - Worker config passed to the runner.
 * @param signal - Abort signal controlled by the executor.
 * @returns Uncommitted cancellation completion resolved on abort.
 */
export function waitForRunnerAbort(
  config: WorkflowWorkerConfig,
  signal: AbortSignal,
): Promise<WorkflowRunnerCompletion> {
  const cancelledResult: WorkflowRunResult = {
    executionId: config.executionId,
    workflowId: config.workflowId,
    status: 'cancelled',
    reason: 'test teardown',
  };
  const completion: WorkflowRunnerCompletion = { state: 'uncommitted', result: cancelledResult };
  if (signal.aborted) {
    return Promise.resolve(completion);
  }
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(completion), { once: true });
  });
}

/**
 * Wait until a workflow execution reaches the expected terminal status.
 * @param executionId - Execution to inspect.
 * @param status - Expected persisted status.
 */
export async function expectExecutionStatus(executionId: string, status: 'failed' | 'completed'): Promise<void> {
  await vi.waitFor(async () => {
    const { execution } = await MakaioBus.request(WorkflowStorageSubjects.getExecution, { executionId });
    expect(execution?.status).toBe(status);
  });
}
