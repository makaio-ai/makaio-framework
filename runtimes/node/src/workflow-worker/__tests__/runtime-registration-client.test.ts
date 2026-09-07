import { describe, expect, it, vi } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import {
  ExecutionAttemptNamespace,
  ExecutionAttemptSubjects,
  type ExecutionAttemptOperationAdmitResponse,
  type ExecutionAttemptOperationDelivery,
  type ExecutionAttemptRuntimeRegisterResponse,
} from '@makaio/contracts';
import {
  admitWorkflowRunOperation,
  installOperationDeliveryEndpoint,
  OperationAdmissionRefusedError,
  registerAndAdmitWorkflowRun,
  registerWorkerRuntime,
  RuntimeRegistrationRefusedError,
} from '../runtime-registration-client.js';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Build an isolated bus that knows the ExecutionAttempt namespace.
 *
 * A fresh instance rather than the process-wide `MakaioBus`, so the responders
 * and endpoints of one case cannot reach another.
 * @returns Bus carrying the `execution-attempt` namespace.
 */
function createRuntimeBus(): IMakaioBus {
  const bus = createBusInstance();
  bus.registerNamespace(ExecutionAttemptNamespace);
  return bus;
}

/**
 * Fake the authority's registration gate on the runtime's own bus.
 *
 * The real gate takes its identity from the authenticated attempt peer and
 * cannot be reached by a local request; a plain responder is enough to pin what
 * the client does with each decision.
 * @param bus - Bus the responder is installed on.
 * @param responses - Decisions the responder answers with, in order; the last one repeats.
 * @returns Recorded register payloads, in call order.
 */
function respondToRegister(
  bus: IMakaioBus,
  ...responses: readonly [ExecutionAttemptRuntimeRegisterResponse, ...ExecutionAttemptRuntimeRegisterResponse[]]
): Array<{ executionAttemptId: string; runtimeIncarnationId: string }> {
  const requests: Array<{ executionAttemptId: string; runtimeIncarnationId: string }> = [];
  bus.on(ExecutionAttemptSubjects.runtime.register, (ctx) => {
    requests.push({ ...ctx.payload });
    // The last response answers every request past the scripted ones.
    ctx.setResult(responses[Math.min(requests.length, responses.length) - 1]!);
  });
  return requests;
}

/**
 * Fake the authority's admission gate on the runtime's own bus.
 * @param bus - Bus the responder is installed on.
 * @param response - Decision the responder answers with.
 * @returns Recorded admit payloads, in call order.
 */
function respondToAdmit(
  bus: IMakaioBus,
  response: ExecutionAttemptOperationAdmitResponse,
): Array<{ executionAttemptId: string; operationKind: string; admissionKey: string; runtimeGeneration: number }> {
  const requests: Array<{
    executionAttemptId: string;
    operationKind: string;
    admissionKey: string;
    runtimeGeneration: number;
  }> = [];
  bus.on(ExecutionAttemptSubjects.operation.admit, (ctx) => {
    requests.push({ ...ctx.payload });
    ctx.setResult(response);
  });
  return requests;
}

/** Incarnation the endpoint cases install unless they need a second one. */
const INCARNATION = 'inc-1';

/**
 * Build one delivery payload.
 * @param executionAttemptId - Attempt the delivery is addressed to.
 * @param operationKind - Kind of operation being delivered.
 * @param overrides - Incarnation or generation to address, when not the defaults.
 * @returns Delivery payload as the authority sends it.
 */
function makeDelivery(
  executionAttemptId: string,
  operationKind: ExecutionAttemptOperationDelivery['operationKind'],
  overrides: { readonly runtimeIncarnationId?: string; readonly runtimeGeneration?: number } = {},
): ExecutionAttemptOperationDelivery {
  return {
    executionAttemptId,
    runtimeIncarnationId: overrides.runtimeIncarnationId ?? INCARNATION,
    operationId: `op-${executionAttemptId}`,
    operationKind,
    runtimeGeneration: overrides.runtimeGeneration ?? 1,
  };
}

/**
 * Install an endpoint for one attempt, already bound to generation 1.
 * @param bus - Bus the endpoint is installed on.
 * @param executionAttemptId - Attempt the endpoint answers for.
 * @param handlers - Handlers for the deliverable kinds.
 * @returns The installed endpoint.
 */
async function installBoundEndpoint(
  bus: IMakaioBus,
  executionAttemptId: string,
  handlers: Parameters<typeof installOperationDeliveryEndpoint>[2],
): Promise<Awaited<ReturnType<typeof installOperationDeliveryEndpoint>>> {
  return installOperationDeliveryEndpoint(
    bus,
    { executionAttemptId, runtimeIncarnationId: INCARNATION, runtimeGeneration: 1 },
    handlers,
  );
}

// ─────────────────────────────────────────────────────────────
// Delivery endpoint
// ─────────────────────────────────────────────────────────────

describe('installOperationDeliveryEndpoint', () => {
  it('does not install an endpoint after bootstrap cancellation', async () => {
    const bus = createRuntimeBus();
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(
      installOperationDeliveryEndpoint(
        bus,
        { executionAttemptId: 'attempt-a', runtimeIncarnationId: INCARNATION },
        {},
        controller.signal,
      ),
    ).rejects.toThrow('cancelled');
    expect(bus.getContext().requestHandlers.get('execution-attempt.operation.deliver') ?? []).toHaveLength(0);
  });

  it('removes an installed endpoint if cancellation arrives before installation transfers ownership', async () => {
    const bus = createRuntimeBus();
    const controller = new AbortController();
    const installing = installOperationDeliveryEndpoint(
      bus,
      { executionAttemptId: 'attempt-a', runtimeIncarnationId: INCARNATION },
      {},
      controller.signal,
    );
    controller.abort(new Error('cancelled'));
    await expect(installing).rejects.toThrow('cancelled');
    expect(bus.getContext().requestHandlers.get('execution-attempt.operation.deliver') ?? []).toHaveLength(0);
  });

  it('answers the bounded runtime probe with a completed receipt before it knows its generation', async () => {
    const bus = createRuntimeBus();
    // Installed before registration, exactly as a runtime does: no generation
    // is bound yet, and the probe must still be answered.
    await installOperationDeliveryEndpoint(
      bus,
      { executionAttemptId: 'attempt-a', runtimeIncarnationId: INCARNATION },
      {},
    );

    const receipt = await bus.request(
      ExecutionAttemptSubjects.operation.deliver,
      makeDelivery('attempt-a', 'runtime-probe'),
    );

    expect(receipt).toEqual({ receipt: 'completed' });
  });

  it('refuses a delivery whose kind has no handler with unknown-kind', async () => {
    const bus = createRuntimeBus();
    await installBoundEndpoint(bus, 'attempt-a', {});

    const receipt = await bus.request(
      ExecutionAttemptSubjects.operation.deliver,
      makeDelivery('attempt-a', 'workflow-run'),
    );

    expect(receipt).toEqual({ receipt: 'refused', refusalReason: 'unknown-kind' });
  });

  it('answers a handled kind with the handler receipt', async () => {
    const bus = createRuntimeBus();
    const seen: ExecutionAttemptOperationDelivery[] = [];
    await installBoundEndpoint(bus, 'attempt-a', {
      'workflow-run': (delivery) => {
        seen.push(delivery);
        return { receipt: 'refused', refusalReason: 'stale-generation' };
      },
    });

    const receipt = await bus.request(
      ExecutionAttemptSubjects.operation.deliver,
      makeDelivery('attempt-a', 'workflow-run'),
    );

    expect(receipt).toEqual({ receipt: 'refused', refusalReason: 'stale-generation' });
    expect(seen).toEqual([makeDelivery('attempt-a', 'workflow-run')]);
  });

  it('ignores a delivery addressed to another attempt', async () => {
    const bus = createRuntimeBus();
    const seenByA: ExecutionAttemptOperationDelivery[] = [];
    const seenByB: ExecutionAttemptOperationDelivery[] = [];
    await installBoundEndpoint(bus, 'attempt-a', {
      'workflow-run': (delivery) => {
        seenByA.push(delivery);
        return { receipt: 'completed' };
      },
    });
    await installBoundEndpoint(bus, 'attempt-b', {
      'workflow-run': (delivery) => {
        seenByB.push(delivery);
        return { receipt: 'duplicate' };
      },
    });

    const receipt = await bus.request(
      ExecutionAttemptSubjects.operation.deliver,
      makeDelivery('attempt-b', 'workflow-run'),
    );

    // The filter miss on A's endpoint auto-advances the dispatch chain to B's.
    expect(receipt).toEqual({ receipt: 'duplicate' });
    expect(seenByA).toEqual([]);
    expect(seenByB).toEqual([makeDelivery('attempt-b', 'workflow-run')]);
  });

  it('ignores a delivery addressed to another incarnation of its own attempt', async () => {
    const bus = createRuntimeBus();
    const seenByStale: ExecutionAttemptOperationDelivery[] = [];
    const seenByCurrent: ExecutionAttemptOperationDelivery[] = [];
    // The stale incarnation is still connected when its successor registers —
    // the situation a probe must never be satisfied by the wrong process.
    await installBoundEndpoint(bus, 'attempt-a', {
      'workflow-run': (delivery) => {
        seenByStale.push(delivery);
        return { receipt: 'completed' };
      },
    });
    await installOperationDeliveryEndpoint(
      bus,
      { executionAttemptId: 'attempt-a', runtimeIncarnationId: 'inc-2', runtimeGeneration: 2 },
      {
        'workflow-run': (delivery) => {
          seenByCurrent.push(delivery);
          return { receipt: 'duplicate' };
        },
      },
    );

    const probe = await bus.request(
      ExecutionAttemptSubjects.operation.deliver,
      makeDelivery('attempt-a', 'runtime-probe', { runtimeIncarnationId: 'inc-2', runtimeGeneration: 2 }),
    );
    const run = await bus.request(
      ExecutionAttemptSubjects.operation.deliver,
      makeDelivery('attempt-a', 'workflow-run', { runtimeIncarnationId: 'inc-2', runtimeGeneration: 2 }),
    );

    expect(probe).toEqual({ receipt: 'completed' });
    expect(run).toEqual({ receipt: 'duplicate' });
    expect(seenByStale).toEqual([]);
    expect(seenByCurrent).toHaveLength(1);
  });

  it('refuses a non-probe delivery with stale-generation until the accepted generation is bound', async () => {
    const bus = createRuntimeBus();
    const seen: ExecutionAttemptOperationDelivery[] = [];
    const endpoint = await installOperationDeliveryEndpoint(
      bus,
      { executionAttemptId: 'attempt-a', runtimeIncarnationId: INCARNATION },
      {
        'workflow-run': (delivery) => {
          seen.push(delivery);
          return { receipt: 'completed' };
        },
      },
    );

    const unbound = await bus.request(
      ExecutionAttemptSubjects.operation.deliver,
      makeDelivery('attempt-a', 'workflow-run', { runtimeGeneration: 3 }),
    );
    endpoint.bindGeneration(3);
    const stale = await bus.request(
      ExecutionAttemptSubjects.operation.deliver,
      makeDelivery('attempt-a', 'workflow-run', { runtimeGeneration: 2 }),
    );
    const current = await bus.request(
      ExecutionAttemptSubjects.operation.deliver,
      makeDelivery('attempt-a', 'workflow-run', { runtimeGeneration: 3 }),
    );

    expect(unbound).toEqual({ receipt: 'refused', refusalReason: 'stale-generation' });
    expect(stale).toEqual({ receipt: 'refused', refusalReason: 'stale-generation' });
    expect(current).toEqual({ receipt: 'completed' });
    expect(seen).toHaveLength(1);
  });

  it('removes the endpoint on cleanup, idempotently', async () => {
    const bus = createRuntimeBus();
    const endpoint = await installBoundEndpoint(bus, 'attempt-a', {});
    endpoint.cleanup();
    endpoint.cleanup();

    await expect(
      bus.request(ExecutionAttemptSubjects.operation.deliver, makeDelivery('attempt-a', 'runtime-probe')),
    ).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────

describe('registerWorkerRuntime', () => {
  it('returns the allocated generation on a ready decision', async () => {
    const bus = createRuntimeBus();
    const requests = respondToRegister(bus, { decision: 'ready', runtimeGeneration: 3 });

    const generation = await registerWorkerRuntime(bus, {
      executionAttemptId: 'attempt-a',
      runtimeIncarnationId: 'inc-1',
    });

    expect(generation).toBe(3);
    expect(requests).toEqual([{ executionAttemptId: 'attempt-a', runtimeIncarnationId: 'inc-1' }]);
  });

  it('treats a duplicate decision as ready and returns the stored generation', async () => {
    const bus = createRuntimeBus();
    respondToRegister(bus, { decision: 'duplicate', runtimeGeneration: 7 });

    const generation = await registerWorkerRuntime(bus, {
      executionAttemptId: 'attempt-a',
      runtimeIncarnationId: 'inc-1',
    });

    expect(generation).toBe(7);
  });

  it('throws a typed error carrying the refusal reason', async () => {
    const bus = createRuntimeBus();
    respondToRegister(bus, { decision: 'refused', runtimeGeneration: 0, refusalReason: 'probe-failed' });

    const failure = await registerWorkerRuntime(bus, {
      executionAttemptId: 'attempt-a',
      runtimeIncarnationId: 'inc-1',
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RuntimeRegistrationRefusedError);
    const refusal = failure as RuntimeRegistrationRefusedError;
    expect(refusal.refusalReason).toBe('probe-failed');
    expect(refusal.executionAttemptId).toBe('attempt-a');
    expect(refusal.name).toBe('RuntimeRegistrationRefusedError');
  });

  it('rejects a registration response the contract does not know', async () => {
    const bus = createRuntimeBus();
    // The bus validates a response where it is received and not at all in
    // production; the request is stubbed so the malformed answer reaches the
    // client the way a version-skewed authority's would.
    vi.spyOn(bus, 'request').mockResolvedValue({ decision: 'unknown', runtimeGeneration: 3 } as never);

    await expect(
      registerWorkerRuntime(bus, { executionAttemptId: 'attempt-a', runtimeIncarnationId: 'inc-1' }),
    ).rejects.toThrow(/Malformed 'execution-attempt\.runtime\.register' response/);
  });

  it('reports a fenced refusal as its own reason', async () => {
    const bus = createRuntimeBus();
    respondToRegister(bus, { decision: 'refused', runtimeGeneration: 0, refusalReason: 'fenced' });

    await expect(
      registerWorkerRuntime(bus, { executionAttemptId: 'attempt-a', runtimeIncarnationId: 'inc-1' }),
    ).rejects.toMatchObject({ refusalReason: 'fenced' });
  });

  it('does not retry not-allocated; allocation visibility belongs to the bootstrap barrier', async () => {
    const bus = createRuntimeBus();
    // The pool records the allocation a moment after the runtime started; the
    // first report lands before that record and the second after it.
    const requests = respondToRegister(
      bus,
      { decision: 'refused', runtimeGeneration: 0, refusalReason: 'not-allocated' },
      { decision: 'ready', runtimeGeneration: 1 },
    );

    await expect(
      registerWorkerRuntime(bus, {
        executionAttemptId: 'attempt-a',
        runtimeIncarnationId: 'inc-1',
      }),
    ).rejects.toMatchObject({ refusalReason: 'not-allocated' });
    expect(requests).toHaveLength(1);
  });

  it('immediately reports a missing allocation', async () => {
    const bus = createRuntimeBus();
    const requests = respondToRegister(bus, {
      decision: 'refused',
      runtimeGeneration: 0,
      refusalReason: 'not-allocated',
    });

    await expect(
      registerWorkerRuntime(bus, {
        executionAttemptId: 'attempt-a',
        runtimeIncarnationId: 'inc-1',
      }),
    ).rejects.toMatchObject({ refusalReason: 'not-allocated' });
    expect(requests).toHaveLength(1);
  });

  it('does not retry any other refusal', async () => {
    const bus = createRuntimeBus();
    const requests = respondToRegister(bus, {
      decision: 'refused',
      runtimeGeneration: 0,
      refusalReason: 'operation-active',
    });

    await expect(
      registerWorkerRuntime(bus, { executionAttemptId: 'attempt-a', runtimeIncarnationId: 'inc-1' }),
    ).rejects.toMatchObject({ refusalReason: 'operation-active' });
    expect(requests).toHaveLength(1);
  });

  it('does not send registration when the signal is already aborted', async () => {
    const bus = createRuntimeBus();
    respondToRegister(bus, { decision: 'refused', runtimeGeneration: 0, refusalReason: 'not-allocated' });
    const controller = new AbortController();
    controller.abort(new Error('worker stopped'));
    const registration = registerWorkerRuntime(bus, {
      executionAttemptId: 'attempt-a',
      runtimeIncarnationId: 'inc-1',
      signal: controller.signal,
    });

    await expect(registration).rejects.toThrow('worker stopped');
  });
});

// ─────────────────────────────────────────────────────────────
// Register-and-admit
// ─────────────────────────────────────────────────────────────

describe('registerAndAdmitWorkflowRun', () => {
  it('registers, binds the accepted generation onto the endpoint, then admits under the incarnation key', async () => {
    const bus = createRuntimeBus();
    const registrations = respondToRegister(bus, { decision: 'ready', runtimeGeneration: 4 });
    const admissions = respondToAdmit(bus, { decision: 'admitted', operationId: 'op-run' });
    const endpoint = await installOperationDeliveryEndpoint(
      bus,
      { executionAttemptId: 'attempt-a', runtimeIncarnationId: 'inc-1' },
      { 'workflow-run': () => ({ receipt: 'completed' }) },
    );

    const admitted = await registerAndAdmitWorkflowRun(bus, {
      executionAttemptId: 'attempt-a',
      runtimeIncarnationId: 'inc-1',
      endpoint,
    });

    expect(admitted).toEqual({ runtimeGeneration: 4, operationId: 'op-run' });
    expect(registrations).toEqual([{ executionAttemptId: 'attempt-a', runtimeIncarnationId: 'inc-1' }]);
    expect(admissions).toEqual([
      {
        executionAttemptId: 'attempt-a',
        operationKind: 'workflow-run',
        admissionKey: 'workflow-run:inc-1',
        runtimeGeneration: 4,
      },
    ]);
    // The endpoint now fences deliveries against the accepted generation.
    expect(
      await bus.request(
        ExecutionAttemptSubjects.operation.deliver,
        makeDelivery('attempt-a', 'workflow-run', { runtimeIncarnationId: 'inc-1', runtimeGeneration: 4 }),
      ),
    ).toEqual({ receipt: 'completed' });
  });

  it('does not admit when registration is refused', async () => {
    const bus = createRuntimeBus();
    respondToRegister(bus, { decision: 'refused', runtimeGeneration: 0, refusalReason: 'fenced' });
    const admissions = respondToAdmit(bus, { decision: 'admitted', operationId: 'op-run' });
    const endpoint = await installOperationDeliveryEndpoint(
      bus,
      { executionAttemptId: 'attempt-a', runtimeIncarnationId: 'inc-1' },
      {},
    );

    await expect(
      registerAndAdmitWorkflowRun(bus, { executionAttemptId: 'attempt-a', runtimeIncarnationId: 'inc-1', endpoint }),
    ).rejects.toBeInstanceOf(RuntimeRegistrationRefusedError);
    expect(admissions).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// Admission
// ─────────────────────────────────────────────────────────────

describe('admitWorkflowRunOperation', () => {
  it('admits the workflow run under the caller key and fence', async () => {
    const bus = createRuntimeBus();
    const requests = respondToAdmit(bus, { decision: 'admitted', operationId: 'op-1' });

    const operationId = await admitWorkflowRunOperation(bus, {
      executionAttemptId: 'attempt-a',
      runtimeGeneration: 3,
      admissionKey: 'run:attempt-a',
    });

    expect(operationId).toBe('op-1');
    expect(requests).toEqual([
      {
        executionAttemptId: 'attempt-a',
        operationKind: 'workflow-run',
        admissionKey: 'run:attempt-a',
        runtimeGeneration: 3,
      },
    ]);
  });

  it('yields the existing operation on a duplicate decision', async () => {
    const bus = createRuntimeBus();
    respondToAdmit(bus, { decision: 'duplicate', operationId: 'op-existing' });

    const operationId = await admitWorkflowRunOperation(bus, {
      executionAttemptId: 'attempt-a',
      runtimeGeneration: 3,
      admissionKey: 'run:attempt-a',
    });

    expect(operationId).toBe('op-existing');
  });

  it('throws a typed error carrying the refusal reason', async () => {
    const bus = createRuntimeBus();
    respondToAdmit(bus, { decision: 'refused', refusalReason: 'not-ready' });

    const failure = await admitWorkflowRunOperation(bus, {
      executionAttemptId: 'attempt-a',
      runtimeGeneration: 3,
      admissionKey: 'run:attempt-a',
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OperationAdmissionRefusedError);
    const refusal = failure as OperationAdmissionRefusedError;
    expect(refusal.refusalReason).toBe('not-ready');
    expect(refusal.executionAttemptId).toBe('attempt-a');
    expect(refusal.admissionKey).toBe('run:attempt-a');
    expect(refusal.name).toBe('OperationAdmissionRefusedError');
  });

  it('rejects an admission response the contract does not know, so no work starts', async () => {
    const bus = createRuntimeBus();
    vi.spyOn(bus, 'request').mockResolvedValue({ decision: 'unknown', operationId: 'x' } as never);

    await expect(
      admitWorkflowRunOperation(bus, {
        executionAttemptId: 'attempt-a',
        runtimeGeneration: 3,
        admissionKey: 'run:attempt-a',
      }),
    ).rejects.toThrow(/Malformed 'execution-attempt\.operation\.admit' response/);
  });

  it('throws when an admitted decision names no operation', async () => {
    const bus = createRuntimeBus();
    respondToAdmit(bus, { decision: 'admitted' });

    await expect(
      admitWorkflowRunOperation(bus, {
        executionAttemptId: 'attempt-a',
        runtimeGeneration: 3,
        admissionKey: 'run:attempt-a',
      }),
    ).rejects.toThrow(/named no operation/);
  });
});
