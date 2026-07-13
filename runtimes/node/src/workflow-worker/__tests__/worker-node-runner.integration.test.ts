import { describe, expect, it } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { WorkerNodeNamespace, WorkerNodeSubjects } from '@makaio/contracts';
import { WorkerNodeRunner } from '../worker-node-runner.js';
import { makeWorkerConfig } from './fixtures.js';

describe('WorkerNodeRunner integration', () => {
  it('forwards provider-selection requirements, WorkerNode readiness, cancellation, and the terminal result', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(WorkerNodeNamespace);
    const readyEvents: unknown[] = [];
    const resultEvents: unknown[] = [];
    const offReady = bus.on(WorkerNodeSubjects.control.ready, (ctx) => {
      readyEvents.push(ctx.payload);
    });
    const offResult = bus.on(WorkerNodeSubjects.control.result, (ctx) => {
      resultEvents.push(ctx.payload);
    });
    let dispatchStarted!: () => void;
    const dispatchStartedPromise = new Promise<void>((resolve) => {
      dispatchStarted = resolve;
    });
    const runner = new WorkerNodeRunner({
      dispatch: async (request, signal) => {
        dispatchStarted();
        if (signal === undefined) throw new Error('WorkerNodeRunner did not forward its cancellation signal');
        const aborted = signal.aborted
          ? Promise.resolve()
          : new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        expect(request.requirements).toEqual({ customCapabilities: ['workflow.remote-reader'] });
        await bus.emit(WorkerNodeSubjects.control.ready, {
          nodeId: 'node-integration-1',
          executionId: request.config.executionId,
          adapters: ['test-adapter'],
        });
        await aborted;
        const result = {
          executionId: request.config.executionId,
          workflowId: request.config.workflowId,
          status: 'cancelled' as const,
          reason: 'integration cancellation',
        };
        await bus.emit(WorkerNodeSubjects.control.result, {
          nodeId: 'node-integration-1',
          executionId: result.executionId,
          result,
        });
        return result;
      },
    });
    const controller = new AbortController();

    try {
      const resultPromise = runner.run(
        makeWorkerConfig({
          executionHints: { requirements: { capabilities: ['workflow.remote-reader'] } },
        }),
        controller.signal,
      );
      await dispatchStartedPromise;
      controller.abort();

      await expect(resultPromise).resolves.toEqual({
        executionId: 'wfx-1',
        workflowId: 'workflow-1',
        status: 'cancelled',
        reason: 'integration cancellation',
      });
      expect(readyEvents).toEqual([{ nodeId: 'node-integration-1', executionId: 'wfx-1', adapters: ['test-adapter'] }]);
      expect(resultEvents).toEqual([
        {
          nodeId: 'node-integration-1',
          executionId: 'wfx-1',
          result: {
            executionId: 'wfx-1',
            workflowId: 'workflow-1',
            status: 'cancelled',
            reason: 'integration cancellation',
          },
        },
      ]);
    } finally {
      offResult();
      offReady();
    }
  });
});
