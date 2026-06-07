import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { WorkflowNamespace } from '@makaio/contracts';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import { WorkflowGateTimeoutScheduler } from '../workflow-gate-timeout-scheduler.js';

/** Maximum delay accepted by Node.js timers without overflow. */
const NODE_SET_TIMEOUT_MAX_DELAY_MS = 2_147_483_647;

/**
 * Create a fresh isolated bus with the workflow namespace registered.
 * @returns A fresh bus instance.
 */
function makeBus(): ReturnType<typeof createBusInstance> {
  const bus = createBusInstance();
  bus.registerNamespace(WorkflowNamespace);
  return bus;
}

describe('WorkflowGateTimeoutScheduler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('re-arms an expired waiting gate until its execution is paused', async () => {
    vi.useFakeTimers();

    try {
      const bus = makeBus();
      const resumePausedExecution = vi.fn<() => Promise<void>>(() => Promise.resolve());
      const scheduler = new WorkflowGateTimeoutScheduler(bus, resumePausedExecution);
      let executionStatus: 'running' | 'paused' = 'running';

      bus.on(WorkflowStorageSubjects.getExecution, (ctx) => {
        ctx.setResult({
          execution: {
            id: 'exec-unwinding',
            workflowId: 'workflow-unwinding',
            status: executionStatus,
            inputs: {},
            startedAt: Date.now(),
            scope: { type: 'global' },
          },
        });
      });
      bus.on(WorkflowStorageSubjects.getGateInstance, (ctx) => {
        ctx.setResult({
          gate: {
            executionId: ctx.payload.executionId,
            nodeId: ctx.payload.nodeId,
            frameId: ctx.payload.frameId ?? 'frame-unwinding',
            schema: {},
            status: 'waiting',
            autoAction: 'reject',
            timeoutMs: 1,
            createdAt: Date.now() - 1,
          },
        });
      });

      scheduler.schedule({
        executionId: 'exec-unwinding',
        nodeId: 'gate-unwinding',
        frameId: 'frame-unwinding',
        timeoutMs: 1,
        openedAt: Date.now() - 1,
      });

      await vi.advanceTimersByTimeAsync(1);
      expect(resumePausedExecution).not.toHaveBeenCalled();

      executionStatus = 'paused';

      await vi.advanceTimersByTimeAsync(25);
      expect(resumePausedExecution).toHaveBeenCalledWith('exec-unwinding');

      scheduler.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-arms an expired waiting gate after a transient storage read failure', async () => {
    vi.useFakeTimers();

    try {
      const bus = makeBus();
      const resumePausedExecution = vi.fn<() => Promise<void>>(() => Promise.resolve());
      const scheduler = new WorkflowGateTimeoutScheduler(bus, resumePausedExecution);
      let gateReads = 0;

      bus.on(WorkflowStorageSubjects.getExecution, (ctx) => {
        ctx.setResult({
          execution: {
            id: 'exec-storage-retry',
            workflowId: 'workflow-storage-retry',
            status: 'paused',
            inputs: {},
            startedAt: Date.now(),
            scope: { type: 'global' },
          },
        });
      });
      bus.on(WorkflowStorageSubjects.getGateInstance, (ctx) => {
        gateReads += 1;
        if (gateReads === 1) {
          throw new Error('temporary storage outage');
        }
        ctx.setResult({
          gate: {
            executionId: ctx.payload.executionId,
            nodeId: ctx.payload.nodeId,
            frameId: ctx.payload.frameId ?? 'frame-storage-retry',
            schema: {},
            status: 'waiting',
            autoAction: 'reject',
            timeoutMs: 1,
            createdAt: Date.now() - 1,
          },
        });
      });

      scheduler.schedule({
        executionId: 'exec-storage-retry',
        nodeId: 'gate-storage-retry',
        frameId: 'frame-storage-retry',
        timeoutMs: 1,
        openedAt: Date.now() - 1,
      });

      await vi.advanceTimersByTimeAsync(1);
      expect(resumePausedExecution).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(250);
      expect(resumePausedExecution).toHaveBeenCalledWith('exec-storage-retry');

      scheduler.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-arms an expired waiting gate after a transient resume failure', async () => {
    vi.useFakeTimers();

    try {
      const bus = makeBus();
      const resumePausedExecution = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new Error('temporary runner outage'))
        .mockResolvedValue(undefined);
      const scheduler = new WorkflowGateTimeoutScheduler(bus, resumePausedExecution);

      bus.on(WorkflowStorageSubjects.getExecution, (ctx) => {
        ctx.setResult({
          execution: {
            id: 'exec-resume-retry',
            workflowId: 'workflow-resume-retry',
            status: 'paused',
            inputs: {},
            startedAt: Date.now(),
            scope: { type: 'global' },
          },
        });
      });
      bus.on(WorkflowStorageSubjects.getGateInstance, (ctx) => {
        ctx.setResult({
          gate: {
            executionId: ctx.payload.executionId,
            nodeId: ctx.payload.nodeId,
            frameId: ctx.payload.frameId ?? 'frame-resume-retry',
            schema: {},
            status: 'waiting',
            autoAction: 'reject',
            timeoutMs: 1,
            createdAt: Date.now() - 1,
          },
        });
      });

      scheduler.schedule({
        executionId: 'exec-resume-retry',
        nodeId: 'gate-resume-retry',
        frameId: 'frame-resume-retry',
        timeoutMs: 1,
        openedAt: Date.now() - 1,
      });

      await vi.advanceTimersByTimeAsync(1);
      expect(resumePausedExecution).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(250);
      expect(resumePausedExecution).toHaveBeenCalledTimes(2);

      scheduler.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops retrying failed expired wakeups after a bounded backoff budget', async () => {
    vi.useFakeTimers();

    try {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const bus = makeBus();
      const resumePausedExecution = vi.fn<() => Promise<void>>(() => Promise.reject(new Error('permanent failure')));
      const scheduler = new WorkflowGateTimeoutScheduler(bus, resumePausedExecution);

      bus.on(WorkflowStorageSubjects.getExecution, (ctx) => {
        ctx.setResult({
          execution: {
            id: 'exec-permanent-failure',
            workflowId: 'workflow-permanent-failure',
            status: 'paused',
            inputs: {},
            startedAt: Date.now(),
            scope: { type: 'global' },
          },
        });
      });
      bus.on(WorkflowStorageSubjects.getGateInstance, (ctx) => {
        ctx.setResult({
          gate: {
            executionId: ctx.payload.executionId,
            nodeId: ctx.payload.nodeId,
            frameId: ctx.payload.frameId ?? 'frame-permanent-failure',
            schema: {},
            status: 'waiting',
            autoAction: 'reject',
            timeoutMs: 1,
            createdAt: Date.now() - 1,
          },
        });
      });

      scheduler.schedule({
        executionId: 'exec-permanent-failure',
        nodeId: 'gate-permanent-failure',
        frameId: 'frame-permanent-failure',
        timeoutMs: 1,
        openedAt: Date.now() - 1,
      });

      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(250);
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(2000);
      expect(resumePausedExecution).toHaveBeenCalledTimes(5);
      expect(consoleError).toHaveBeenLastCalledWith(
        expect.stringContaining("Giving up on timed-out gate 'gate-permanent-failure'"),
        expect.any(Error),
      );

      await vi.advanceTimersByTimeAsync(2000);
      expect(resumePausedExecution).toHaveBeenCalledTimes(5);

      scheduler.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('chunks timeout delays above the Node.js timer ceiling', async () => {
    vi.useFakeTimers();

    try {
      const bus = makeBus();
      const resumePausedExecution = vi.fn<() => Promise<void>>(() => Promise.resolve());
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const scheduler = new WorkflowGateTimeoutScheduler(bus, resumePausedExecution);

      bus.on(WorkflowStorageSubjects.getExecution, (ctx) => {
        ctx.setResult({
          execution: {
            id: 'exec-long-timeout',
            workflowId: 'workflow-long-timeout',
            status: 'paused',
            inputs: {},
            startedAt: Date.now(),
            scope: { type: 'global' },
          },
        });
      });
      bus.on(WorkflowStorageSubjects.getGateInstance, (ctx) => {
        ctx.setResult({
          gate: {
            executionId: ctx.payload.executionId,
            nodeId: ctx.payload.nodeId,
            frameId: ctx.payload.frameId ?? 'frame-long-timeout',
            schema: {},
            status: 'waiting',
            autoAction: 'reject',
            timeoutMs: NODE_SET_TIMEOUT_MAX_DELAY_MS + 50,
            createdAt: Date.now(),
          },
        });
      });

      scheduler.schedule({
        executionId: 'exec-long-timeout',
        nodeId: 'gate-long-timeout',
        frameId: 'frame-long-timeout',
        timeoutMs: NODE_SET_TIMEOUT_MAX_DELAY_MS + 50,
        openedAt: Date.now(),
      });

      expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), NODE_SET_TIMEOUT_MAX_DELAY_MS);

      await vi.advanceTimersByTimeAsync(NODE_SET_TIMEOUT_MAX_DELAY_MS);
      expect(resumePausedExecution).not.toHaveBeenCalled();
      expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 50);

      await vi.advanceTimersByTimeAsync(50);
      expect(resumePausedExecution).toHaveBeenCalledWith('exec-long-timeout');

      scheduler.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
