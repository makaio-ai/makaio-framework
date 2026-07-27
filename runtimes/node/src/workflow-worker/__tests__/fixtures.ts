import type { WorkflowExecution, WorkflowWorkerConfig } from '@makaio/contracts';
import { WorkflowNamespace } from '@makaio/contracts';
import { WorkflowStorageNamespace, WorkflowStorageSubjects } from '@makaio/subsystem-workflow-engine';
import { createBusInstance } from '@makaio/bus-core';

/**
 * Create a minimal {@link WorkflowWorkerConfig} for testing.
 *
 * Provides sensible defaults for all required fields. Pass `overrides` to
 * specialise individual properties without repeating the full fixture.
 * @param overrides - Partial config fields merged on top of defaults.
 * @returns A valid WorkflowWorkerConfig stub.
 */
export function makeWorkerConfig(overrides?: Partial<WorkflowWorkerConfig>): WorkflowWorkerConfig {
  return {
    source: { kind: 'definition', workflowId: 'workflow-1' },
    executionId: 'wfx-1',
    workflowId: 'workflow-1',
    triggerPayload: {},
    inputs: {},
    scope: { type: 'global' },
    busAuth: { kind: 'none' },
    env: {},
    coordinatorSessionId: 'session-1',
    cancelSubject: 'workflow.wfx-1.cancel',
    suspensionStrategy: 'wait-in-process',
    ...overrides,
  };
}

/**
 * Register in-memory workflow storage handlers on a bus instance.
 *
 * Provides the minimum storage surface the orchestrator needs for a zero-step
 * workflow run, including the atomic start checkpoint subject.
 * @param bus - Bus instance to register handlers on.
 * @returns Tuple of cleanup function and execution store.
 */
export function registerInMemoryStorage(
  bus: ReturnType<typeof createBusInstance>,
): [() => void, Map<string, WorkflowExecution>] {
  const executions = new Map<string, WorkflowExecution>();

  const offSet = bus.on(WorkflowStorageSubjects.setExecution, (ctx) => {
    const execution = ctx.payload.execution as WorkflowExecution;
    executions.set(execution.id, execution);
    ctx.setResult({ id: execution.id });
  });

  const offSetExecutionStart = bus.on(WorkflowStorageSubjects.setExecutionStart, (ctx) => {
    const execution = ctx.payload.execution as WorkflowExecution;
    executions.set(execution.id, execution);
    ctx.setResult({ id: execution.id, executionId: execution.id });
  });

  const offUpdate = bus.on(WorkflowStorageSubjects.updateExecution, (ctx) => {
    const { executionId, status, error, completedAt } = ctx.payload;
    const execution = executions.get(executionId);
    if (!execution) {
      ctx.setResult({ success: false });
      return;
    }
    if (status !== undefined) execution.status = status;
    if (error !== undefined) execution.error = error ?? undefined;
    if (completedAt !== undefined) execution.completedAt = completedAt ?? undefined;
    ctx.setResult({ success: true });
  });

  const offSpan = bus.on(WorkflowStorageSubjects.setSpan, (ctx) => {
    ctx.setResult({ id: ctx.payload.span.stepId });
  });

  return [
    () => {
      offSet();
      offSetExecutionStart();
      offUpdate();
      offSpan();
    },
    executions,
  ];
}

/**
 * Create an isolated bus with workflow namespaces and in-memory storage handlers.
 * @returns Tuple of bus, cleanup function, and execution store.
 */
export function makeBusWithStorage(): [
  ReturnType<typeof createBusInstance>,
  () => void,
  Map<string, WorkflowExecution>,
] {
  const bus = createBusInstance();
  bus.registerNamespace(WorkflowNamespace);
  bus.registerNamespace(WorkflowStorageNamespace);
  const [cleanup, executions] = registerInMemoryStorage(bus);
  return [bus, cleanup, executions];
}
