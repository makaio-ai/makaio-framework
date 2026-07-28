import { describe, expect, it, vi } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import type { WorkerContributionManifest, WorkflowWorkerConfig } from '@makaio/contracts';
import {
  BUILT_IN_THIN_WORKFLOW_PROVIDER_ID,
  PROVIDER_ALLOCATION_REF_VERSION,
  ProviderAllocationRefSchema,
  WorkerNodeNamespace,
  WorkerNodeSubjects,
} from '@makaio/contracts';
import { PiscinaThinWorkflowProvider } from '../piscina-thin-workflow-provider.js';
import { makeWorkerConfig } from './fixtures.js';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Create a bus instance with the WorkerNode namespace registered.
 * @returns A bus instance ready for provider construction.
 */
function createTestBus() {
  const bus = createBusInstance();
  bus.registerNamespace(WorkerNodeNamespace);
  return bus;
}

/**
 * Build a minimal provision request matching the current contract.
 * @param overrides - Optional field overrides.
 * @returns A valid WorkerNodeProvisionRequest.
 */
function makeProvisionRequest(
  overrides?: Partial<{
    executionAttemptId: string;
    executionId: string;
    workerManifest: WorkerContributionManifest;
  }>,
) {
  return {
    executionId: overrides?.executionId ?? 'wfx-1',
    executionAttemptId: overrides?.executionAttemptId ?? 'attempt-1',
    environment: 'piscina' as const,
    workerConfig: makeWorkerConfig(),
    workerManifest: overrides?.workerManifest ?? { contributionRefs: [] },
  };
}

/**
 * Create a test runner that resolves immediately with a completed result.
 * @returns A fake IWorkflowRunner.
 */
function makeCompletedRunner() {
  return {
    run: vi.fn().mockResolvedValue({
      state: 'uncommitted' as const,
      result: {
        executionId: 'wfx-1',
        workflowId: 'workflow-1',
        status: 'completed',
      },
    }),
    dispose: vi.fn(),
  };
}

// ─────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────

describe('PiscinaThinWorkflowProvider', () => {
  // ── Identity and capabilities ─────────────────────────────

  it('exposes the correct environment constant', () => {
    const runner = { run: vi.fn() };
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-1',
      displayName: 'Piscina',
      runner,
      bus: createTestBus(),
    });

    expect(provider.environment).toBe('piscina');
  });

  it('uses default base capabilities when none provided', () => {
    const runner = { run: vi.fn() };
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-1',
      displayName: 'Piscina',
      runner,
      bus: createTestBus(),
    });

    expect(provider.baseCapabilities.persistentStorage).toBe(true);
    expect(provider.baseCapabilities.customCapabilities).toContain('workflow.local-runtime');
    expect(provider.baseCapabilities.customCapabilities).toContain('workflow.thin-runner');
    expect(provider.baseCapabilities.suspensionStrategy).toBe('wait-in-process');
  });

  it('explicitly advertises supportsRecovery: false', () => {
    const runner = { run: vi.fn() };
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-1',
      displayName: 'Piscina',
      runner,
      bus: createTestBus(),
    });

    expect(provider.baseCapabilities.supportsRecovery).toBe(false);
  });

  it('does not expose a recovery property', () => {
    const runner = { run: vi.fn() };
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-1',
      displayName: 'Piscina',
      runner,
      bus: createTestBus(),
    });

    expect('recovery' in provider).toBe(false);
  });

  it('merges custom base capability overrides onto the local defaults', () => {
    const runner = { run: vi.fn() };
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-1',
      displayName: 'Piscina',
      runner,
      bus: createTestBus(),
      baseCapabilities: {
        persistentStorage: false,
        customCapabilities: ['custom.tag'],
      },
    });

    expect(provider.baseCapabilities.persistentStorage).toBe(false);
    expect(provider.baseCapabilities.customCapabilities).toEqual(['custom.tag']);
    expect(provider.baseCapabilities.suspensionStrategy).toBe('wait-in-process');
  });

  // ── Allocation reference conformance ──────────────────────

  it('returns a validated ProviderAllocationRef with the correct version and provider ID', async () => {
    const runner = makeCompletedRunner();
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-default',
      displayName: 'Piscina',
      runner,
      bus: createTestBus(),
    });

    const { allocationRef } = await provider.provision(makeProvisionRequest(), new AbortController().signal);

    expect(allocationRef.version).toBe(PROVIDER_ALLOCATION_REF_VERSION);
    expect(allocationRef.providerId).toBe(BUILT_IN_THIN_WORKFLOW_PROVIDER_ID);
    expect(allocationRef.providerData).toMatchObject({
      executionAttemptId: 'attempt-1',
    });

    // Must pass the schema codec validation
    expect(() => ProviderAllocationRefSchema.parse(allocationRef)).not.toThrow();
  });

  it('embeds the executionAttemptId in the allocation ref providerData', async () => {
    const runner = makeCompletedRunner();
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-default',
      displayName: 'Piscina',
      runner,
      bus: createTestBus(),
    });

    const { allocationRef } = await provider.provision(
      makeProvisionRequest({ executionAttemptId: 'attempt-42' }),
      new AbortController().signal,
    );

    expect(allocationRef.providerData).toMatchObject({
      executionAttemptId: 'attempt-42',
    });
  });

  // ── Handle shape conformance ──────────────────────────────

  it('returns a handle with executionAttemptId matching the request', async () => {
    const runner = makeCompletedRunner();
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-default',
      displayName: 'Piscina',
      runner,
      bus: createTestBus(),
    });

    const { handle } = await provider.provision(
      makeProvisionRequest({ executionAttemptId: 'attempt-99' }),
      new AbortController().signal,
    );

    expect(handle.executionAttemptId).toBe('attempt-99');
  });

  it('handle exposes cancel, terminate, and release but NOT ready or waitForResult', async () => {
    const runner = makeCompletedRunner();
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-default',
      displayName: 'Piscina',
      runner,
      bus: createTestBus(),
    });

    const { handle } = await provider.provision(makeProvisionRequest(), new AbortController().signal);

    expect(typeof handle.cancel).toBe('function');
    expect(typeof handle.terminate).toBe('function');
    expect(typeof handle.release).toBe('function');
    expect('ready' in handle).toBe(false);
    expect('waitForResult' in handle).toBe(false);
  });

  it('emits attempt-ready only after the runner reports post-composition readiness', async () => {
    const bus = createTestBus();
    const emit = vi.spyOn(bus, 'emit');
    let resolveReady!: (value: { executionId: string; cancelSubject: string; adapters: readonly string[] }) => void;
    const ready = new Promise<{ executionId: string; cancelSubject: string; adapters: readonly string[] }>(
      (resolve) => {
        resolveReady = resolve;
      },
    );
    const runner = {
      run: vi.fn(),
      runWithReadiness: vi.fn().mockReturnValue({
        ready,
        result: new Promise(() => undefined),
      }),
    };
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-ready',
      displayName: 'Piscina',
      runner,
      bus,
    });
    const request = makeProvisionRequest();

    await provider.provision(request, new AbortController().signal);
    expect(emit).not.toHaveBeenCalledWith(WorkerNodeSubjects.control['attempt-ready'], expect.anything());

    resolveReady({
      executionId: request.executionId,
      cancelSubject: request.workerConfig.cancelSubject,
      adapters: ['tools'],
    });
    await vi.waitFor(() =>
      expect(emit).toHaveBeenCalledWith(WorkerNodeSubjects.control['attempt-ready'], {
        executionAttemptId: request.executionAttemptId,
        executionId: request.executionId,
        adapters: ['tools'],
      }),
    );
  });

  it('release resolves without affecting the runner', async () => {
    let capturedSignal: AbortSignal | undefined;
    const runner = {
      run: vi.fn().mockImplementation((_config: WorkflowWorkerConfig, signal: AbortSignal) => {
        capturedSignal = signal;
        return new Promise<never>(() => {});
      }),
    };
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-default',
      displayName: 'Piscina',
      runner,
      bus: createTestBus(),
    });

    const { handle } = await provider.provision(makeProvisionRequest(), new AbortController().signal);

    await expect(handle.release()).resolves.toBeUndefined();
    expect(capturedSignal?.aborted).toBe(false);

    // Idempotent — second call also resolves cleanly.
    await expect(handle.release()).resolves.toBeUndefined();
  });

  // ── Cooperative provision cancellation ────────────────────

  it('rejects provision when the signal is already aborted', async () => {
    const runner = makeCompletedRunner();
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-1',
      displayName: 'Piscina',
      runner,
      bus: createTestBus(),
    });

    const controller = new AbortController();
    controller.abort(new Error('pre-aborted'));

    await expect(provider.provision(makeProvisionRequest(), controller.signal)).rejects.toThrow('pre-aborted');
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('rejects provision with string abort reason', async () => {
    const runner = makeCompletedRunner();
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-1',
      displayName: 'Piscina',
      runner,
      bus: createTestBus(),
    });

    const controller = new AbortController();
    controller.abort('cancelled by caller');

    await expect(provider.provision(makeProvisionRequest(), controller.signal)).rejects.toThrow('cancelled by caller');
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('propagates caller signal abort to the underlying runner during execution', async () => {
    let capturedSignal: AbortSignal | undefined;
    const runner = {
      run: vi.fn().mockImplementation((_config: WorkflowWorkerConfig, signal: AbortSignal) => {
        capturedSignal = signal;
        return new Promise<never>(() => {});
      }),
    };
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-1',
      displayName: 'Piscina',
      runner,
      bus: createTestBus(),
    });

    const callerController = new AbortController();
    await provider.provision(makeProvisionRequest(), callerController.signal);

    expect(capturedSignal?.aborted).toBe(false);
    callerController.abort('caller cancel');
    expect(capturedSignal?.aborted).toBe(true);
  });

  // ── Handle cancel/terminate ───────────────────────────────

  it('aborts the underlying runner when cancel is called', async () => {
    let capturedSignal: AbortSignal | undefined;
    const runner = {
      run: vi.fn().mockImplementation((_config: WorkflowWorkerConfig, signal: AbortSignal) => {
        capturedSignal = signal;
        return new Promise<never>(() => {});
      }),
    };
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-1',
      displayName: 'Piscina',
      runner,
      bus: createTestBus(),
    });

    const { handle } = await provider.provision(makeProvisionRequest(), new AbortController().signal);

    await handle.cancel('test cancel');

    expect(capturedSignal?.aborted).toBe(true);
  });

  it('aborts the underlying runner when terminate is called', async () => {
    let capturedSignal: AbortSignal | undefined;
    const runner = {
      run: vi.fn().mockImplementation((_config: WorkflowWorkerConfig, signal: AbortSignal) => {
        capturedSignal = signal;
        return new Promise<never>(() => {});
      }),
    };
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-1',
      displayName: 'Piscina',
      runner,
      bus: createTestBus(),
    });

    const { handle } = await provider.provision(makeProvisionRequest(), new AbortController().signal);

    await handle.terminate();

    expect(capturedSignal?.aborted).toBe(true);
  });

  it('cancel resolves after dispatching abort without waiting for runner settlement', async () => {
    const runner = {
      run: vi.fn().mockImplementation((_config: WorkflowWorkerConfig, _signal: AbortSignal) => {
        return new Promise<never>(() => {});
      }),
    };
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-1',
      displayName: 'Piscina',
      runner,
      bus: createTestBus(),
    });

    const { handle } = await provider.provision(makeProvisionRequest(), new AbortController().signal);

    const cancelResult = Promise.race([
      handle.cancel('test').then(() => 'cancelled'),
      new Promise((resolve) => setTimeout(() => resolve('timed out'), 0)),
    ]);

    await expect(cancelResult).resolves.toBe('cancelled');
  });

  // ── Manifest forwarding ───────────────────────────────────

  it('forwards the request workerManifest to the runner as a per-call manifest', async () => {
    let capturedManifest: WorkerContributionManifest | undefined;
    const runner = {
      run: vi
        .fn()
        .mockImplementation(
          (_config: WorkflowWorkerConfig, _signal: AbortSignal, manifest?: WorkerContributionManifest) => {
            capturedManifest = manifest;
            return Promise.resolve({
              state: 'uncommitted' as const,
              result: {
                executionId: 'wfx-1',
                workflowId: 'workflow-1',
                status: 'completed',
              },
            });
          },
        ),
    };
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-1',
      displayName: 'Piscina',
      runner,
      bus: createTestBus(),
    });
    const requestManifest: WorkerContributionManifest = {
      contributionRefs: [
        {
          packageName: 'pkg-a',
          version: '1.0.0',
          entrypoint: 'pkg-a.js',
          integrity: 'sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uFPNZHzA3w0=',
        },
      ],
    };

    await provider.provision(makeProvisionRequest({ workerManifest: requestManifest }), new AbortController().signal);

    expect(capturedManifest).toStrictEqual(requestManifest);
  });

  // ── Attempt correlation ───────────────────────────────────

  it('correlates handle and allocationRef to the same executionAttemptId', async () => {
    const runner = makeCompletedRunner();
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-default',
      displayName: 'Piscina',
      runner,
      bus: createTestBus(),
    });

    const { allocationRef, handle } = await provider.provision(
      makeProvisionRequest({ executionAttemptId: 'correlated-attempt' }),
      new AbortController().signal,
    );

    expect(handle.executionAttemptId).toBe('correlated-attempt');
    expect(allocationRef.providerData).toMatchObject({
      executionAttemptId: 'correlated-attempt',
    });
  });

  // ── Provider starts the runner ────────────────────────────

  it('starts the underlying runner on provision', async () => {
    const runner = makeCompletedRunner();
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-default',
      displayName: 'Piscina',
      runner,
      bus: createTestBus(),
    });

    await provider.provision(makeProvisionRequest(), new AbortController().signal);

    expect(runner.run).toHaveBeenCalledOnce();
  });

  // ── Outcome submission ────────────────────────────────────

  it('submits a completed result through the bus after the runner resolves', async () => {
    const bus = createTestBus();
    const submissions: Array<{ executionAttemptId: string; executionId: string; result: unknown }> = [];
    bus.on(WorkerNodeSubjects.control.outcome.submit, (ctx) => {
      submissions.push({ ...ctx.payload });
      ctx.setResult({ decision: 'accepted' });
    });

    const runner = makeCompletedRunner();
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-default',
      displayName: 'Piscina',
      runner,
      bus,
    });

    await provider.provision(makeProvisionRequest(), new AbortController().signal);

    // Allow the fire-and-forget settlement chain to complete.
    await vi.waitFor(() => {
      expect(submissions).toHaveLength(1);
    });

    expect(submissions[0]).toMatchObject({
      executionAttemptId: 'attempt-1',
      executionId: 'wfx-1',
      result: {
        executionId: 'wfx-1',
        workflowId: 'workflow-1',
        status: 'completed',
      },
    });
  });

  it('submits a failed result through the bus when the runner rejects', async () => {
    const bus = createTestBus();
    const submissions: Array<{ executionAttemptId: string; executionId: string; result: unknown }> = [];
    bus.on(WorkerNodeSubjects.control.outcome.submit, (ctx) => {
      submissions.push({ ...ctx.payload });
      ctx.setResult({ decision: 'accepted' });
    });

    const runner = {
      run: vi.fn().mockRejectedValue(new Error('workflow exploded')),
    };
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-default',
      displayName: 'Piscina',
      runner,
      bus,
    });

    await provider.provision(makeProvisionRequest(), new AbortController().signal);

    await vi.waitFor(() => {
      expect(submissions).toHaveLength(1);
    });

    expect(submissions[0]).toMatchObject({
      executionAttemptId: 'attempt-1',
      executionId: 'wfx-1',
      result: {
        executionId: 'wfx-1',
        workflowId: 'workflow-1',
        status: 'failed',
        error: 'workflow exploded',
      },
    });
  });

  it('retries transient local submit failures then succeeds', async () => {
    const bus = createTestBus();
    const submissions: Array<{ executionAttemptId: string; executionId: string; result: unknown }> = [];
    let callCount = 0;
    bus.on(WorkerNodeSubjects.control.outcome.submit, (ctx) => {
      callCount++;
      submissions.push({ ...ctx.payload });
      if (callCount <= 1) {
        throw new Error('Transient local failure');
      }
      ctx.setResult({ decision: 'accepted' });
    });

    const runner = makeCompletedRunner();
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-default',
      displayName: 'Piscina',
      runner,
      bus,
      outcomeRetry: { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 20, deadlineMs: 5_000 },
    });

    await provider.provision(makeProvisionRequest(), new AbortController().signal);

    await vi.waitFor(
      () => {
        expect(submissions).toHaveLength(2);
      },
      { timeout: 5_000 },
    );

    // Both submissions should contain the same result.
    expect(submissions[0]).toMatchObject({ executionId: 'wfx-1' });
    expect(submissions[1]).toMatchObject({ executionId: 'wfx-1' });
  });

  it('logs but does not throw when bus outcome submission fails after retries', async () => {
    const bus = createTestBus();
    // No handler registered — bus.request will reject on every attempt.

    const runner = makeCompletedRunner();
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-default',
      displayName: 'Piscina',
      runner,
      bus,
      // Use minimal retry delays so the test completes quickly.
      outcomeRetry: { maxRetries: 1, baseDelayMs: 10, maxDelayMs: 20, deadlineMs: 1_000 },
    });

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await provider.provision(makeProvisionRequest(), new AbortController().signal);

    // Allow the fire-and-forget retry chain to exhaust and log.
    await vi.waitFor(
      () => {
        expect(consoleSpy).toHaveBeenCalled();
      },
      { timeout: 5_000 },
    );

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[PiscinaThinWorkflowProvider] Failed to submit outcome'),
      expect.anything(),
    );

    consoleSpy.mockRestore();
  });
});
