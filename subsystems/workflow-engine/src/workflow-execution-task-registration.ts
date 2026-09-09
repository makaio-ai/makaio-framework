/**
 * Register and release the caller's exact task without removing a resumed successor.
 * @param executionTasks - Shared registry used for shutdown draining.
 * @param executionId - Logical owner identifier, shared across attempts.
 * @param task - Started execution task, including any caller-owned wrapper.
 */
export function registerExecutionTask(
  executionTasks: Map<string, Promise<void>>,
  executionId: string,
  task: Promise<void>,
): void {
  executionTasks.set(executionId, task);
  void task
    .finally(() => {
      if (executionTasks.get(executionId) === task) executionTasks.delete(executionId);
    })
    .catch((error: unknown) => {
      console.error(`[WorkflowExecutor] Execution task failed for ${executionId}:`, error);
    });
}
