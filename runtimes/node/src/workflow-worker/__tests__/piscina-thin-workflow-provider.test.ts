import { describe, expect, it, vi } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import type {
  WorkerContributionManifest,
  WorkerCapabilities,
  WorkflowRunResult,
  WorkflowWorkerConfig,
} from '@makaio/contracts';
import {
  PROVIDER_ALLOCATION_REF_VERSION,
  ProviderAllocationRefSchema,
  WorkerNamespace,
  WorkerSubjects,
} from '@makaio/contracts';
import { resolveWorkflowExecutionBusSecret } from '../../workflow-execution-bus-access.js';
import type { ThinWorkflowPiscinaAttemptBinding } from '../thin-workflow-piscina-runner.js';
import { PiscinaThinWorkflowProvider, type ReadinessAwareWorkflowRunner } from '../piscina-thin-workflow-provider.js';
import { WORKFLOW_WORKER_READY_MESSAGE_TYPE, type WorkflowWorkerReadyMessage } from '../worker-ready-message.js';
import { makeWorkerConfig } from './fixtures.js';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Create a bus instance with the Worker namespace registered.
 * @returns A bus instance ready for provider construction.
 */
function createTestBus() {
  const bus = createBusInstance();
  bus.registerNamespace(WorkerNamespace);
  return bus;
}

/** Bus URL every provisionable worker configuration below carries. */
const TEST_BUS_URL = 'ws://127.0.0.1:65535/bus';

/**
 * Build a minimal provision request matching the current contract.
 *
 * The bus URL is supplied here rather than in the shared `makeWorkerConfig`
 * fixture: the same fixture drives the attempt-free runner path, where a bus
 * URL would silently change what those tests exercise.
 * @param overrides - Optional field overrides.
 * @returns A valid WorkerProvisionRequest.
 */
function makeProvisionRequest(
  overrides?: Partial<{
    executionAttemptId: string;
    executionId: string;
    workerManifest: WorkerContributionManifest;
    workerConfig: WorkflowWorkerConfig;
  }>,
) {
  return {
    executionId: overrides?.executionId ?? 'wfx-1',
    executionAttemptId: overrides?.executionAttemptId ?? 'attempt-1',
    environment: 'piscina' as const,
    workerConfig: overrides?.workerConfig ?? makeWorkerConfig({ busUrl: TEST_BUS_URL }),
    workerManifest: overrides?.workerManifest ?? { contributionRefs: [] },
    provisioningStartedAt: '2026-07-27T10:00:00.000Z',
    bootstrapDeadlineAt: new Date(Date.now() + 120_000).toISOString(),
  };
}

/** Terminal result the default runner fake settles with. */
const COMPLETED_RESULT: WorkflowRunResult = {
  executionId: 'wfx-1',
  workflowId: 'workflow-1',
  status: 'completed',
};

/** Behaviour a runner fake may override for one test. */
interface RunnerBehaviour {
  /**
   * Produce the run's terminal result promise.
   * @param config - Worker configuration the provider passed through.
   * @param signal - Cancellation signal the provider wired to the handle.
   * @param manifest - Per-call contribution manifest the provider forwarded.
   * @returns Promise settling with the workflow result.
   */
  readonly result?: (
    config: WorkflowWorkerConfig,
    signal: AbortSignal,
    manifest?: WorkerContributionManifest,
  ) => Promise<WorkflowRunResult>;
  /**
   * Readiness signal. Defaults to one that resolves at once, the way an
   * admitted thread's does; a test about the refused path rejects it.
   */
  readonly ready?: Promise<WorkflowWorkerReadyMessage>;
}

/**
 * Create the readiness-aware runner fake this provider requires.
 *
 * The provider drives its runner only through `runWithReadiness`, so the fakes
 * exercise the same seam production wires rather than a second code path.
 * @param behaviour - Optional per-test result and readiness overrides.
 * @returns Runner fake with a spy on `runWithReadiness`.
 */
function makeRunner(behaviour?: RunnerBehaviour) {
  const runWithReadiness = vi.fn(
    (
      config: WorkflowWorkerConfig,
      signal: AbortSignal,
      manifest: WorkerContributionManifest | undefined,
      attempt: ThinWorkflowPiscinaAttemptBinding,
    ) => ({
      result: behaviour?.result?.(config, signal, manifest) ?? Promise.resolve(COMPLETED_RESULT),
      ready:
        behaviour?.ready ??
        Promise.resolve({
          type: WORKFLOW_WORKER_READY_MESSAGE_TYPE,
          executionId: config.executionId,
          cancelSubject: config.cancelSubject,
          executionAttemptId: attempt.executionAttemptId,
        }),
    }),
  );
  const runner: ReadinessAwareWorkflowRunner & { runWithReadiness: typeof runWithReadiness } = {
    run: vi.fn(),
    runWithReadiness,
  };
  return runner;
}

// ─────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────

describe('PiscinaThinWorkflowProvider', () => {
  // ── Identity and capabilities ─────────────────────────────

  it('exposes the correct environment constant', () => {
    const runner = makeRunner();
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-1',
      displayName: 'Piscina',
      runner,
      bus: createTestBus(),
    });

    expect(provider.environment).toBe('piscina');
  });

  it('uses default base capabilities when none provided', () => {
    const runner = makeRunner();
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
    const runner = makeRunner();
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-1',
      displayName: 'Piscina',
      runner,
      bus: createTestBus(),
    });

    expect(provider.baseCapabilities.supportsRecovery).toBe(false);
  });

  it('keeps supportsRecovery false for an untyped caller that asks for it', () => {
    // Writing `baseCapabilities: { supportsRecovery: true }` inline is a
    // compile error: the option type omits the key, so a typed caller is told
    // it is asking for something untrue rather than having the value quietly
    // dropped. Overrides that arrive as an already-built value — from plain
    // JavaScript, or across a config boundary — are not literals and are not
    // rejected, so the runtime pin is the only thing left holding the line.
    const overridesFromUntypedCaller: Partial<WorkerCapabilities> = { supportsRecovery: true };
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-1',
      displayName: 'Piscina',
      runner: makeRunner(),
      bus: createTestBus(),
      baseCapabilities: overridesFromUntypedCaller,
    });

    // Worker threads die with the process that provisioned them, so there is
    // nothing to recover and no recovery capability to call.
    expect(provider.baseCapabilities.supportsRecovery).toBe(false);
    expect('recovery' in provider).toBe(false);
  });

  it('does not expose a recovery property', () => {
    const runner = makeRunner();
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-1',
      displayName: 'Piscina',
      runner,
      bus: createTestBus(),
    });

    expect('recovery' in provider).toBe(false);
  });

  it('merges custom base capability overrides onto the local defaults', () => {
    const runner = makeRunner();
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
    const runner = makeRunner();
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-default',
      displayName: 'Piscina',
      runner,
      bus: createTestBus(),
    });

    const { allocationRef } = await provider.provision(makeProvisionRequest(), new AbortController().signal);

    expect(allocationRef.version).toBe(PROVIDER_ALLOCATION_REF_VERSION);
    // The reference names the instance that created it, so two providers of
    // this class in one process stay distinguishable.
    expect(allocationRef.providerId).toBe('piscina-default');
    expect(allocationRef.providerData).toMatchObject({
      executionAttemptId: 'attempt-1',
    });

    // Must pass the schema codec validation
    expect(() => ProviderAllocationRefSchema.parse(allocationRef)).not.toThrow();
  });

  it('embeds the executionAttemptId in the allocation ref providerData', async () => {
    const runner = makeRunner();
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

  it('does not start a runner that cannot return a valid allocation response', async () => {
    const runner = makeRunner();
    const provider = new PiscinaThinWorkflowProvider({
      // The allocation-reference contract rejects empty provider IDs.
      id: '',
      displayName: 'Piscina',
      runner,
      bus: createTestBus(),
    });

    await expect(provider.provision(makeProvisionRequest(), new AbortController().signal)).rejects.toThrow();

    expect(runner.runWithReadiness).not.toHaveBeenCalled();
  });

  // ── Handle shape conformance ──────────────────────────────

  it('returns a handle with executionAttemptId matching the request', async () => {
    const runner = makeRunner();
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
    const runner = makeRunner();
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

  // ── Attempt readiness is the Authority's fact ─────────────

  it('publishes nothing on a worker control subject when the runtime becomes ready', async () => {
    const bus = createTestBus();
    const emit = vi.spyOn(bus, 'emit');
    let resolveReady!: (value: WorkflowWorkerReadyMessage) => void;
    const ready = new Promise<WorkflowWorkerReadyMessage>((resolve) => {
      resolveReady = resolve;
    });
    const runner = makeRunner({ ready, result: () => new Promise<never>(() => {}) });
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-ready',
      displayName: 'Piscina',
      runner,
      bus,
    });
    const request = makeProvisionRequest();

    await provider.provision(request, new AbortController().signal);

    // Readiness is published by the Authority from the thread's own
    // registration, so this provider has nothing left to announce.
    resolveReady({
      type: WORKFLOW_WORKER_READY_MESSAGE_TYPE,
      executionId: request.executionId,
      cancelSubject: request.workerConfig.cancelSubject,
      executionAttemptId: request.executionAttemptId,
    });
    await Promise.resolve();
    await Promise.resolve();

    // `bus.emit` is subject-token generic, so the spy's recorded argument tuple
    // widens to `never`; read the subject positionally instead of destructuring.
    const emittedSubjects = (emit.mock.calls as ReadonlyArray<readonly unknown[]>).map((call) => String(call[0]));
    expect(emittedSubjects.filter((subject) => subject.startsWith('worker.control.'))).toEqual([]);
    // Nor does it announce readiness in the authority's own vocabulary: the
    // thread registers itself, and only the authority publishes on
    // `execution-attempt.*`.
    expect(emittedSubjects.filter((subject) => subject.startsWith('execution-attempt.'))).toEqual([]);
  });

  it('aborts the allocation when the runtime never becomes ready', async () => {
    let capturedSignal: AbortSignal | undefined;
    const refusal = new Error('Runtime registration refused by the Authority');
    const runner = makeRunner({
      ready: Promise.reject(refusal),
      result: (_config, signal) => {
        capturedSignal = signal;
        return new Promise<never>(() => {});
      },
    });
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-ready',
      displayName: 'Piscina',
      runner,
      bus: createTestBus(),
    });

    await provider.provision(makeProvisionRequest(), new AbortController().signal);

    // A rejected readiness used to be swallowed. It now ends the allocation,
    // which is the only honest answer for a runtime the Authority refused.
    await vi.waitFor(() => expect(capturedSignal?.aborted).toBe(true));
    expect(capturedSignal?.reason).toBe(refusal);
  });

  it('reports a refusal before admission as infrastructure evidence, never as a workflow outcome', async () => {
    const bus = createTestBus();
    const submissions: unknown[] = [];
    bus.on(WorkerSubjects.control.outcome.submit, (ctx) => {
      submissions.push(ctx.payload);
      ctx.setResult({ decision: 'accepted' });
    });
    // The thread throws out of registration before any workflow ran, so its
    // readiness and its result reject with the same refusal.
    const refusal = new Error('Runtime registration refused by the Authority');
    const runner = makeRunner({
      ready: Promise.reject(refusal),
      result: () => Promise.reject(refusal),
    });
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-refused',
      displayName: 'Piscina',
      runner,
      bus,
    });

    const outcome = await provider.provision(makeProvisionRequest(), new AbortController().signal);
    if (outcome.kind !== 'allocated') throw new Error(`Expected an allocation, got '${outcome.kind}'`);

    const conclusions: string[] = [];
    outcome.handle.observeInfrastructureConclusion?.((conclusion) => {
      conclusions.push(conclusion.evidence.summary);
    });

    // The refusal is terminal infrastructure evidence for the allocation...
    await vi.waitFor(() => expect(conclusions).toHaveLength(1));
    expect(conclusions[0]).toContain('refused before its workflow run was admitted');
    expect(conclusions[0]).toContain(refusal.message);
    // ...and no `failed` outcome is manufactured from it: the Authority must
    // converge the attempt as an infrastructure failure, not settle it as a
    // workflow that ran and failed.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(submissions).toEqual([]);
  });

  // ── Attempt-scoped bus identity ───────────────────────────

  it('rejects a provision whose worker configuration carries no bus URL', async () => {
    const runner = makeRunner();
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-no-bus',
      displayName: 'Piscina',
      runner,
      bus: createTestBus(),
    });

    await expect(
      provider.provision(
        makeProvisionRequest({
          executionAttemptId: 'attempt-no-bus',
          workerConfig: makeWorkerConfig(),
        }),
        new AbortController().signal,
      ),
    ).rejects.toThrow('requires a bus URL');

    // A thread with no transport could never register its runtime, so none is
    // started and no identity is minted for an attempt that cannot use it.
    expect(runner.runWithReadiness).not.toHaveBeenCalled();
    expect(resolveWorkflowExecutionBusSecret('attempt-no-bus')).toBeUndefined();
  });

  it('hands the worker an attempt-scoped bus identity instead of the host process secret', async () => {
    let capturedConfig: WorkflowWorkerConfig | undefined;
    let capturedAttempt: ThinWorkflowPiscinaAttemptBinding | undefined;
    const runner = makeRunner();
    vi.mocked(runner.runWithReadiness).mockImplementation((config, _signal, _manifest, attempt) => {
      capturedConfig = config;
      capturedAttempt = attempt;
      return {
        result: new Promise<WorkflowRunResult>(() => undefined),
        ready: new Promise<WorkflowWorkerReadyMessage>(() => undefined),
      };
    });
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-identity',
      displayName: 'Piscina',
      runner,
      bus: createTestBus(),
    });
    const request = makeProvisionRequest({ executionAttemptId: 'attempt-identity' });

    const { handle } = await provider.provision(request, new AbortController().signal);

    expect(capturedAttempt).toEqual({
      executionAttemptId: 'attempt-identity',
      bootstrapDeadlineAt: request.bootstrapDeadlineAt,
    });
    expect(capturedConfig?.busUrl).toBe(TEST_BUS_URL);
    // The registered identity is keyed by the attempt, which is what makes the
    // thread an authenticated attempt peer at the Authority's gates.
    expect(capturedConfig?.busAuth).toEqual({
      kind: 'hmac',
      secret: resolveWorkflowExecutionBusSecret('attempt-identity'),
    });
    expect(capturedConfig?.busAuth).not.toEqual(request.workerConfig.busAuth);

    await handle.release();
  });

  it('gives up the minted bus identity when the allocation is released', async () => {
    const runner = makeRunner({ result: () => new Promise<never>(() => {}) });
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-identity',
      displayName: 'Piscina',
      runner,
      bus: createTestBus(),
    });

    const { handle } = await provider.provision(
      makeProvisionRequest({ executionAttemptId: 'attempt-released' }),
      new AbortController().signal,
    );
    expect(resolveWorkflowExecutionBusSecret('attempt-released')).toBeDefined();

    await handle.release();

    expect(resolveWorkflowExecutionBusSecret('attempt-released')).toBeUndefined();
  });

  it('gives up the minted bus identity when the allocation is terminated', async () => {
    const runner = makeRunner({ result: () => new Promise<never>(() => {}) });
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-identity',
      displayName: 'Piscina',
      runner,
      bus: createTestBus(),
    });

    const { handle } = await provider.provision(
      makeProvisionRequest({ executionAttemptId: 'attempt-terminated' }),
      new AbortController().signal,
    );
    expect(resolveWorkflowExecutionBusSecret('attempt-terminated')).toBeDefined();

    await handle.terminate();

    expect(resolveWorkflowExecutionBusSecret('attempt-terminated')).toBeUndefined();
  });

  it('release resolves without affecting the runner', async () => {
    let capturedSignal: AbortSignal | undefined;
    const runner = makeRunner({
      result: (_config, signal) => {
        capturedSignal = signal;
        return new Promise<never>(() => {});
      },
    });
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

  it('rejects provision with the caller signal own abort reason', async () => {
    const runner = makeRunner();
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-1',
      displayName: 'Piscina',
      runner,
      bus: createTestBus(),
    });

    const reason = new Error('pre-aborted');
    const controller = new AbortController();
    controller.abort(reason);

    await expect(provider.provision(makeProvisionRequest(), controller.signal)).rejects.toBe(reason);
    expect(runner.runWithReadiness).not.toHaveBeenCalled();
  });

  it('rethrows a non-Error abort reason unchanged instead of flattening it', async () => {
    const runner = makeRunner();
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-1',
      displayName: 'Piscina',
      runner,
      bus: createTestBus(),
    });

    const controller = new AbortController();
    controller.abort('cancelled by caller');

    await expect(provider.provision(makeProvisionRequest(), controller.signal)).rejects.toBe('cancelled by caller');
    expect(runner.runWithReadiness).not.toHaveBeenCalled();
  });

  it('does not start the runner when cancellation arrives as the forwarder is attached', async () => {
    const runner = makeRunner();
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-1',
      displayName: 'Piscina',
      runner,
      bus: createTestBus(),
    });
    const reason = new Error('cancelled while attaching');
    const controller = new AbortController();
    const addEventListener = controller.signal.addEventListener.bind(controller.signal);
    vi.spyOn(controller.signal, 'addEventListener').mockImplementation((type, listener, options) => {
      addEventListener(type, listener, options);
      if (type === 'abort') controller.abort(reason);
    });

    await expect(provider.provision(makeProvisionRequest(), controller.signal)).rejects.toBe(reason);

    expect(runner.runWithReadiness).not.toHaveBeenCalled();
  });

  it('never reports cancellation as a provision outcome', async () => {
    const runner = makeRunner();
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-1',
      displayName: 'Piscina',
      runner,
      bus: createTestBus(),
    });

    const reason = new Error('cancelled before provisioning');
    const controller = new AbortController();
    controller.abort(reason);

    // Settling either way is captured so a resolved outcome is a visible
    // failure rather than an unasserted pass.
    const settled = await provider
      .provision(makeProvisionRequest(), controller.signal)
      .then((outcome) => ({ status: 'resolved' as const, value: outcome }))
      .catch((error: unknown) => ({ status: 'rejected' as const, value: error }));

    expect(settled).toEqual({ status: 'rejected', value: reason });
    expect(runner.runWithReadiness).not.toHaveBeenCalled();
  });

  it('propagates caller signal abort to the underlying runner during execution', async () => {
    let capturedSignal: AbortSignal | undefined;
    const runner = makeRunner({
      result: (_config, signal) => {
        capturedSignal = signal;
        return new Promise<never>(() => {});
      },
    });
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

  it('aborts a started runner when post-dispatch setup fails before a handle is returned', async () => {
    let capturedSignal: AbortSignal | undefined;
    const setupError = new Error('runner omitted its readiness promise');
    const runner = makeRunner();
    vi.mocked(runner.runWithReadiness).mockImplementation((_config, signal) => {
      capturedSignal = signal;
      return {
        result: new Promise<WorkflowRunResult>(() => undefined),
        get ready(): Promise<WorkflowWorkerReadyMessage> {
          throw setupError;
        },
      };
    });
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-1',
      displayName: 'Piscina',
      runner,
      bus: createTestBus(),
    });

    await expect(provider.provision(makeProvisionRequest(), new AbortController().signal)).rejects.toBe(setupError);

    expect(capturedSignal?.aborted).toBe(true);
  });

  // ── Handle cancel/terminate ───────────────────────────────

  it('aborts the underlying runner when cancel is called', async () => {
    let capturedSignal: AbortSignal | undefined;
    const runner = makeRunner({
      result: (_config, signal) => {
        capturedSignal = signal;
        return new Promise<never>(() => {});
      },
    });
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
    const runner = makeRunner({
      result: (_config, signal) => {
        capturedSignal = signal;
        return new Promise<never>(() => {});
      },
    });
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
    const runner = makeRunner({ result: () => new Promise<never>(() => {}) });
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
    const runner = makeRunner({
      result: (_config, _signal, manifest) => {
        capturedManifest = manifest;
        return Promise.resolve(COMPLETED_RESULT);
      },
    });
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
    const runner = makeRunner();
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
    const runner = makeRunner();
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-default',
      displayName: 'Piscina',
      runner,
      bus: createTestBus(),
    });

    await provider.provision(makeProvisionRequest(), new AbortController().signal);

    expect(runner.runWithReadiness).toHaveBeenCalledOnce();
  });

  // ── Outcome submission ────────────────────────────────────

  it('submits a completed result through the bus after the runner resolves', async () => {
    const bus = createTestBus();
    const submissions: Array<{ executionAttemptId: string; executionId: string; result: unknown }> = [];
    bus.on(WorkerSubjects.control.outcome.submit, (ctx) => {
      submissions.push({ ...ctx.payload });
      ctx.setResult({ decision: 'accepted' });
    });

    const runner = makeRunner();
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
    bus.on(WorkerSubjects.control.outcome.submit, (ctx) => {
      submissions.push({ ...ctx.payload });
      ctx.setResult({ decision: 'accepted' });
    });

    const runner = makeRunner({ result: () => Promise.reject(new Error('workflow exploded')) });
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
    bus.on(WorkerSubjects.control.outcome.submit, (ctx) => {
      callCount++;
      submissions.push({ ...ctx.payload });
      if (callCount <= 1) {
        throw new Error('Transient local failure');
      }
      ctx.setResult({ decision: 'accepted' });
    });

    const runner = makeRunner();
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

    const runner = makeRunner();
    const provider = new PiscinaThinWorkflowProvider({
      id: 'piscina-default',
      displayName: 'Piscina',
      runner,
      bus,
      // Use minimal retry delays so the test completes quickly.
      outcomeRetry: { maxRetries: 1, baseDelayMs: 10, maxDelayMs: 20, deadlineMs: 1_000 },
    });

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { handle } = await provider.provision(makeProvisionRequest(), new AbortController().signal);
    const observerError = new Error('observer failed');
    const laterObserver = vi.fn();
    handle.observeInfrastructureConclusion?.(() => {
      throw observerError;
    });
    handle.observeInfrastructureConclusion?.(laterObserver);

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
    expect(laterObserver).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalledWith(
      '[PiscinaThinWorkflowProvider] Infrastructure-conclusion observer failed:',
      observerError,
    );

    consoleSpy.mockRestore();
  });
});
