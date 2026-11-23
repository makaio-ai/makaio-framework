import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { createCarrierBus } from '@makaio/bus-core/kernel-api';
import {
  WorkerNamespace,
  WorkerSubjects,
  WorkflowNamespace,
  WorkflowSubjects,
  WorkflowWorkerConfigSchema,
  type WorkflowDefinition,
} from '@makaio/contracts';
import {
  ExecutionAttemptAuthority,
  submitAttemptOutcome,
  workflowAttemptOutcomeCodec,
  WorkflowExecutor,
  WorkflowStorageNamespace,
  WorkflowStorageSubjects,
  type WorkflowAttemptOutcome,
} from '@makaio/subsystem-workflow-engine';
import { createInMemoryAttemptRepository } from '@makaio/subsystem-workflow-engine/testing';
import { runWorkflowOrchestrator } from '@makaio/subsystem-workflow-engine/workflow-orchestrator';
import { createTestCall } from '@makaio/test-utils';
import { expect, it, vi } from 'vitest';
import {
  createTestDbForBus,
  createWorkflowDefinition,
  createWorkflowExecution,
} from '../../../../../subsystems/workflow-engine/src/__tests__/shared.js';
import { createNodeWorkflowRunner } from '../node-workflow-runner-factory.js';
import { makeWorkerConfig } from './fixtures.js';

/**
 * Run and converge dispatched attempts on the host bus without provisioning a process.
 * @param bus - Host carrier used by the WorkerRunner dispatch seam.
 * @param authority - Authority tracking the dispatched attempts.
 * @param executor - Execution owner that projects committed outcomes.
 * @param definition - Workflow running in the dispatch endpoint.
 * @returns Cleanup for the dispatch handler.
 */
function registerInlineWorkerDispatch(
  bus: IMakaioBus,
  authority: ExecutionAttemptAuthority<WorkflowAttemptOutcome>,
  executor: WorkflowExecutor,
  definition: WorkflowDefinition,
): () => void {
  return bus.on(WorkerSubjects.dispatch, async (ctx) => {
    const { executionAttemptId, config: workerConfig } = ctx.payload;
    const config = WorkflowWorkerConfigSchema.parse(workerConfig);
    const outcome = await runWorkflowOrchestrator({
      call: ctx.call,
      bus,
      config,
      loaded: { definition, runtimeHandlers: new Map() },
      signal: new AbortController().signal,
    });
    await submitAttemptOutcome(
      { authority, convergence: { converge: executor.acceptAuthorityOutcome } },
      { call: ctx.call, executionAttemptId, executionId: config.executionId, outcome },
    );
    ctx.setResult({ executionAttemptId, allocationRef: { version: 1, providerId: 'test', providerData: {} } });
  });
}

it('redispatches a parked worker gate with its configured timeout approval', async () => {
  const bus = createBusInstance();
  bus.registerNamespaces([WorkerNamespace, WorkflowNamespace, WorkflowStorageNamespace]);
  const executorBus = createCarrierBus(bus, { kind: 'makaio.extension', id: 'workflow-executor' });
  const db = await createTestDbForBus(bus);
  const authority = new ExecutionAttemptAuthority(createInMemoryAttemptRepository(workflowAttemptOutcomeCodec), {
    bootstrapTimeoutMs: 120_000,
  });
  const runner = createNodeWorkflowRunner({
    authority,
    bus,
    runner: { mode: 'worker' },
    moduleDir: import.meta.dirname,
    defaultWorkerEntryMode: 'source',
  });
  if (runner === undefined) throw new Error('Expected a configured worker runner');
  const executor = new WorkflowExecutor(executorBus, undefined, runner, authority);
  const timeoutMs = 1000;
  const gateId = 'approval';
  const definition = createWorkflowDefinition({
    steps: [{ id: gateId, type: 'gate', timeoutMs, autoAction: 'approve' }],
  });
  const config = makeWorkerConfig({
    workflowId: definition.id,
    source: { kind: 'definition', workflowId: definition.id },
    definition,
    suspensionStrategy: 'exit-and-redispatch',
    terminalAuthority: 'authority',
  });
  const { executionId } = config;
  const resolutions: object[] = [];
  const offResolved = bus.on(WorkflowSubjects.gate.resolved, (ctx) => {
    resolutions.push(ctx.payload);
  });
  const offDispatch = registerInlineWorkerDispatch(bus, authority, executor, definition);

  vi.useFakeTimers();
  try {
    await executor.init();
    const call = createTestCall();
    const execution = createWorkflowExecution({ id: executionId, workflowId: definition.id, status: 'running' });
    await bus.request(call, WorkflowStorageSubjects.setExecution, { execution });
    await bus.request(call, WorkflowStorageSubjects.setRunContext, {
      runContext: {
        ...config,
        config: {},
        definitionSnapshot: definition,
        workerManifest: { contributionRefs: [] },
        createdAt: Date.now(),
      },
    });
    await runner.run(call, config, new AbortController().signal);
    await expect(bus.request(call, WorkflowStorageSubjects.getExecution, { executionId })).resolves.toMatchObject({
      execution: { status: 'paused' },
    });

    await vi.advanceTimersByTimeAsync(timeoutMs);
    await vi.waitFor(async () => {
      const { execution: settled } = await bus.request(call, WorkflowStorageSubjects.getExecution, { executionId });
      expect(settled).toMatchObject({ status: 'completed', error: undefined });
    });
    expect(resolutions).toEqual([
      expect.objectContaining({ executionId, stepId: gateId, action: 'approve', source: 'timeout' }),
    ]);
  } finally {
    vi.useRealTimers();
    await executor.destroy();
    offDispatch();
    offResolved();
    db.cleanup();
  }
});
