import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ExecutionAttemptSubjects,
  type ExecutionAttemptOperationDelivery,
  type ExecutionAttemptOperationReceipt,
  type ExecutionAttemptRuntimeReadyEvent,
} from '@makaio/contracts';
import { registerRuntimeRegistrationHandler, RUNTIME_PROBE_DELIVERY_TIMEOUT_MS } from '../runtime-registration.js';
import { makeTestWorkflowResult } from '../testing/index.js';
import {
  allocateAttempt,
  attemptPeer,
  createAttemptGateHarness,
  type AttemptGateHarness,
} from './execution-attempt-gate-harness.js';

const REGISTER = ExecutionAttemptSubjects.runtime.register;
const INCARNATION = 'runtime-incarnation-1';

describe('runtime registration handler', () => {
  let harness: AttemptGateHarness;
  let cleanups: Array<() => void>;
  let deliveries: ExecutionAttemptOperationDelivery[];
  let readyEvents: ExecutionAttemptRuntimeReadyEvent[];

  beforeEach(() => {
    harness = createAttemptGateHarness();
    cleanups = [];
    deliveries = [];
    readyEvents = [];
    cleanups.push(
      harness.bus.on(ExecutionAttemptSubjects.runtime.ready, (ctx) => {
        readyEvents.push(ctx.payload);
      }),
    );
  });

  afterEach(() => {
    for (const cleanup of cleanups) cleanup();
  });

  /**
   * Register the gate under test.
   * @param probeDeliveryTimeoutMs - Optional probe budget override.
   */
  function installGate(probeDeliveryTimeoutMs?: number): void {
    cleanups.push(
      registerRuntimeRegistrationHandler(harness.bus, {
        bus: harness.bus,
        authority: harness.authority,
        ...(probeDeliveryTimeoutMs === undefined ? {} : { probeDeliveryTimeoutMs }),
      }),
    );
  }

  /**
   * Install a probe responder, exactly as a live runtime would.
   * @param receipt - Receipt the responder returns, or `never` to answer nothing.
   */
  function installProbeResponder(receipt: ExecutionAttemptOperationReceipt | 'never'): void {
    cleanups.push(
      harness.bus.on(ExecutionAttemptSubjects.operation.deliver, async (ctx) => {
        deliveries.push(ctx.payload);
        if (receipt === 'never') return new Promise<never>(() => {});
        ctx.setResult(receipt);
        return undefined;
      }),
    );
  }

  /**
   * Send one registration report as the attempt's authenticated runtime.
   * @param executionAttemptId - Attempt the runtime claims.
   * @param executionId - Execution claim the peer carries.
   * @param overrides - Payload or peer identity overrides.
   * @returns The registration decision the gate replied with.
   */
  async function register(
    executionAttemptId: string,
    executionId: string,
    overrides: { readonly payloadAttemptId?: string; readonly runtimeIncarnationId?: string } = {},
  ): Promise<{ result?: unknown; error?: { message: string } }> {
    const response = await harness.transport.requestAs(
      REGISTER.$meta.namespace,
      REGISTER.subject as string,
      {
        executionAttemptId: overrides.payloadAttemptId ?? executionAttemptId,
        runtimeIncarnationId: overrides.runtimeIncarnationId ?? INCARNATION,
      },
      attemptPeer(executionAttemptId, executionId),
    );
    return response;
  }

  it('pins the production probe budget strictly below the bus request default', () => {
    expect(RUNTIME_PROBE_DELIVERY_TIMEOUT_MS).toBe(10_000);
    expect(RUNTIME_PROBE_DELIVERY_TIMEOUT_MS).toBeLessThan(60_000);
  });

  it('proves the endpoint, persists the completion, and only then publishes readiness', async () => {
    const executionId = 'exec-ready';
    const attemptId = await allocateAttempt(harness, executionId);
    installGate();
    installProbeResponder({ receipt: 'completed' });

    const response = await register(attemptId, executionId);

    expect(response.result).toEqual({ decision: 'ready', runtimeGeneration: 1 });
    // The probe was delivered under the generation registration allocated, and
    // it never reached the pool as an admitted operation.
    expect(deliveries).toEqual([
      {
        executionAttemptId: attemptId,
        runtimeIncarnationId: INCARNATION,
        operationId: expect.any(String),
        operationKind: 'runtime-probe',
        runtimeGeneration: 1,
      },
    ]);
    const state = await harness.authority.getAttemptControlState(attemptId);
    expect(state).toMatchObject({
      runtimeGeneration: 1,
      runtimeIncarnationId: INCARNATION,
      runtimeReadyAt: expect.any(String),
      // Step 5 freed the attempt before readiness was announced.
      activeOperationId: null,
      lastCompletedOperationId: deliveries[0]!.operationId,
    });
    expect(readyEvents).toEqual([
      { executionAttemptId: attemptId, runtimeGeneration: 1, acceptedAt: state!.runtimeReadyAt },
    ]);
  });

  it('accepts a duplicate probe receipt as proof', async () => {
    const executionId = 'exec-duplicate-receipt';
    const attemptId = await allocateAttempt(harness, executionId);
    installGate();
    installProbeResponder({ receipt: 'duplicate' });

    const response = await register(attemptId, executionId);

    expect(response.result).toEqual({ decision: 'ready', runtimeGeneration: 1 });
    expect(readyEvents).toHaveLength(1);
  });

  it('refuses with probe-failed on a refused receipt, leaving readiness unproven', async () => {
    const executionId = 'exec-refused-receipt';
    const attemptId = await allocateAttempt(harness, executionId);
    installGate();
    installProbeResponder({ receipt: 'refused', refusalReason: 'stale-generation' });

    const response = await register(attemptId, executionId);

    expect(response.result).toEqual({ decision: 'refused', runtimeGeneration: 0, refusalReason: 'probe-failed' });
    expect(readyEvents).toEqual([]);
    // The slot the probe occupied is released with the refusal, so a later
    // incarnation is not told to wait for a probe nobody will answer.
    expect(await harness.authority.getAttemptControlState(attemptId)).toMatchObject({
      runtimeGeneration: 1,
      runtimeReadyAt: null,
      activeOperationId: null,
      lastCompletedOperationId: deliveries[0]!.operationId,
    });
  });

  it('refuses with probe-failed when the delivery times out', async () => {
    const executionId = 'exec-probe-timeout';
    const attemptId = await allocateAttempt(harness, executionId);
    installGate(25);
    installProbeResponder('never');

    const response = await register(attemptId, executionId);

    expect(response.result).toEqual({ decision: 'refused', runtimeGeneration: 0, refusalReason: 'probe-failed' });
    expect(deliveries).toHaveLength(1);
    expect(readyEvents).toEqual([]);
    expect(await harness.authority.getAttemptControlState(attemptId)).toMatchObject({
      runtimeReadyAt: null,
      activeOperationId: null,
    });
  });

  it('refuses with probe-failed when no runtime answers the delivery at all', async () => {
    const executionId = 'exec-no-responder';
    const attemptId = await allocateAttempt(harness, executionId);
    installGate();

    const response = await register(attemptId, executionId);

    expect(response.result).toEqual({ decision: 'refused', runtimeGeneration: 0, refusalReason: 'probe-failed' });
    expect(readyEvents).toEqual([]);
    expect(await harness.authority.getAttemptControlState(attemptId)).toMatchObject({ activeOperationId: null });
  });

  it('refuses with probe-failed when another operation took the slot before the completion', async () => {
    const executionId = 'exec-completion-refused';
    const attemptId = await allocateAttempt(harness, executionId);
    installGate();
    // The responder answers the probe only after it made the probe's own
    // completion impossible: it completes the probe itself and admits a second
    // probe under another key, so the gate's completion finds the wrong
    // operation active.
    cleanups.push(
      harness.bus.on(ExecutionAttemptSubjects.operation.deliver, async (ctx) => {
        deliveries.push(ctx.payload);
        const { operationId, runtimeGeneration } = ctx.payload;
        await harness.authority.completeOperation({ executionAttemptId: attemptId, operationId, runtimeGeneration });
        const interloper = await harness.authority.admitOperation({
          executionAttemptId: attemptId,
          executionId,
          operationKind: 'runtime-probe',
          admissionKey: 'probe:interloper',
          runtimeGeneration,
        });
        if (interloper.kind !== 'admitted')
          throw new Error(`Expected the interloper to be admitted, got '${interloper.kind}'`);
        ctx.setResult({ receipt: 'completed' });
      }),
    );

    const response = await register(attemptId, executionId);

    expect(response.result).toEqual({ decision: 'refused', runtimeGeneration: 0, refusalReason: 'probe-failed' });
    expect(readyEvents).toEqual([]);
    expect(await harness.authority.getAttemptControlState(attemptId)).toMatchObject({
      runtimeReadyAt: null,
      activeOperationKey: 'probe:interloper',
    });
  });

  it('refuses with probe-failed when the attempt was superseded before readiness became durable', async () => {
    const executionId = 'exec-readiness-fenced';
    const attemptId = await allocateAttempt(harness, executionId);
    installGate();
    // The responder supersedes the attempt while the probe is in flight: the
    // completion is still owed and accepted, but readiness is fenced.
    cleanups.push(
      harness.bus.on(ExecutionAttemptSubjects.operation.deliver, async (ctx) => {
        deliveries.push(ctx.payload);
        await allocateAttempt(harness, executionId);
        ctx.setResult({ receipt: 'completed' });
      }),
    );

    const response = await register(attemptId, executionId);

    expect(response.result).toEqual({ decision: 'refused', runtimeGeneration: 0, refusalReason: 'probe-failed' });
    expect(readyEvents).toEqual([]);
    expect(await harness.authority.getAttemptControlState(attemptId)).toMatchObject({
      runtimeGeneration: 1,
      runtimeReadyAt: null,
      activeOperationId: null,
      operationStartGate: 'closed',
    });
  });

  it('replies duplicate for a ready incarnation, announcing readiness again without re-delivering the probe', async () => {
    const executionId = 'exec-already-ready';
    const attemptId = await allocateAttempt(harness, executionId);
    installGate();
    installProbeResponder({ receipt: 'completed' });

    await register(attemptId, executionId);
    const replay = await register(attemptId, executionId);

    expect(replay.result).toEqual({ decision: 'duplicate', runtimeGeneration: 1 });
    // One delivery across both passes; the durable readiness is announced by
    // each pass that finds it, so a first announcement that failed after
    // persistence is repaired by the replay.
    expect(deliveries).toHaveLength(1);
    const state = await harness.authority.getAttemptControlState(attemptId);
    expect(readyEvents).toEqual([
      { executionAttemptId: attemptId, runtimeGeneration: 1, acceptedAt: state!.runtimeReadyAt },
      { executionAttemptId: attemptId, runtimeGeneration: 1, acceptedAt: state!.runtimeReadyAt },
    ]);
  });

  it('repairs an announcement that failed after readiness was persisted', async () => {
    const executionId = 'exec-announcement-failed';
    const attemptId = await allocateAttempt(harness, executionId);
    installGate();
    installProbeResponder({ receipt: 'completed' });
    // A consumer that throws fails the emit, and with it the whole first pass —
    // after readiness became durable.
    let failOnce = true;
    cleanups.push(
      harness.bus.on(ExecutionAttemptSubjects.runtime.ready, () => {
        if (failOnce) {
          failOnce = false;
          throw new Error('consumer failed');
        }
      }),
    );

    const first = await register(attemptId, executionId);
    const retry = await register(attemptId, executionId);

    expect(first.error?.message).toContain('consumer failed');
    expect(retry.result).toEqual({ decision: 'duplicate', runtimeGeneration: 1 });
    // Both passes announced; the second is the one the consumers acted on.
    expect(readyEvents).toHaveLength(2);
    expect(deliveries).toHaveLength(1);
  });

  it('announces nothing for a generation that was superseded before the announcement', async () => {
    const executionId = 'exec-announcement-fenced';
    const attemptId = await allocateAttempt(harness, executionId);
    installGate();
    // The responder lets a second incarnation register while the first pass is
    // still between its probe receipt and its announcement: readiness becomes
    // durable for generation 1, then generation 2 is allocated and clears it.
    // The first pass must not announce generation 1 as ready after that.
    let interposed = false;
    cleanups.push(
      harness.bus.on(ExecutionAttemptSubjects.operation.deliver, async (ctx) => {
        deliveries.push(ctx.payload);
        ctx.setResult({ receipt: 'completed' });
      }),
    );
    const markRuntimeReady = harness.authority.markRuntimeReady.bind(harness.authority);
    harness.authority.markRuntimeReady = async (input) => {
      const readiness = await markRuntimeReady(input);
      if (!interposed) {
        interposed = true;
        await harness.authority.registerRuntime({
          executionAttemptId: attemptId,
          executionId,
          runtimeIncarnationId: 'runtime-incarnation-2',
        });
      }
      return readiness;
    };

    const response = await register(attemptId, executionId);

    // The first pass proved generation 1 and replies so; the announcement is
    // fenced by the durable record, which now holds generation 2, unready.
    expect(response.result).toEqual({ decision: 'ready', runtimeGeneration: 1 });
    expect(readyEvents).toEqual([]);
    expect(await harness.authority.getAttemptControlState(attemptId)).toMatchObject({
      runtimeGeneration: 2,
      runtimeIncarnationId: 'runtime-incarnation-2',
      runtimeReadyAt: null,
    });
  });

  it('completes the handshake for a duplicate that never proved readiness', async () => {
    const executionId = 'exec-crashed-before-ready';
    const attemptId = await allocateAttempt(harness, executionId);
    installGate();

    // First pass: the endpoint registered but no runtime answered the probe,
    // so the attempt holds the incarnation with `runtimeReadyAt` still null.
    const crashed = await register(attemptId, executionId);
    expect(crashed.result).toMatchObject({ decision: 'refused', refusalReason: 'probe-failed' });
    expect(await harness.authority.getAttemptControlState(attemptId)).toMatchObject({
      runtimeIncarnationId: INCARNATION,
      runtimeReadyAt: null,
    });

    installProbeResponder({ receipt: 'completed' });
    const retry = await register(attemptId, executionId);

    // The replay is answered `duplicate` by the repository, and the gate treats
    // it exactly as a fresh registration: same generation, probe re-run. The
    // first pass released its unanswered probe, so the retry admits a new one.
    expect(retry.result).toEqual({ decision: 'ready', runtimeGeneration: 1 });
    expect(deliveries).toHaveLength(1);
    expect(readyEvents).toEqual([
      { executionAttemptId: attemptId, runtimeGeneration: 1, acceptedAt: expect.any(String) },
    ]);
  });

  it('answers a settled attempt with resolved', async () => {
    const executionId = 'exec-settled';
    const attemptId = await allocateAttempt(harness, executionId);
    await harness.authority.commitOutcome(
      attemptId,
      executionId,
      harness.authority.canonicalizeOutcome(makeTestWorkflowResult(executionId)),
    );
    installGate();
    installProbeResponder({ receipt: 'completed' });

    const response = await register(attemptId, executionId);

    expect(response.result).toEqual({ decision: 'refused', runtimeGeneration: 0, refusalReason: 'resolved' });
    expect(deliveries).toEqual([]);
    expect(readyEvents).toEqual([]);
  });

  it('answers an attempt that owns no allocation with not-allocated', async () => {
    const executionId = 'exec-unallocated';
    const { executionAttemptId } = await harness.authority.createAttempt(executionId);
    installGate();
    installProbeResponder({ receipt: 'completed' });

    const response = await register(executionAttemptId, executionId);

    expect(response.result).toEqual({ decision: 'refused', runtimeGeneration: 0, refusalReason: 'not-allocated' });
    expect(deliveries).toEqual([]);
  });

  it('answers a superseded attempt with fenced', async () => {
    const executionId = 'exec-fenced';
    const attemptId = await allocateAttempt(harness, executionId);
    await allocateAttempt(harness, executionId);
    installGate();
    installProbeResponder({ receipt: 'completed' });

    const response = await register(attemptId, executionId);

    expect(response.result).toEqual({ decision: 'refused', runtimeGeneration: 0, refusalReason: 'fenced' });
    expect(deliveries).toEqual([]);
  });

  it('answers an unknown attempt with not-found', async () => {
    installGate();
    installProbeResponder({ receipt: 'completed' });

    const response = await register('attempt-that-never-existed', 'exec-missing');

    expect(response.result).toEqual({ decision: 'refused', runtimeGeneration: 0, refusalReason: 'not-found' });
  });

  it('refuses a malformed report before the gate is consulted', async () => {
    const executionId = 'exec-malformed';
    const attemptId = await allocateAttempt(harness, executionId);
    installGate();
    installProbeResponder({ receipt: 'completed' });
    const registerRuntime = vi.spyOn(harness.authority, 'registerRuntime');

    // An empty incarnation identifier is refused by the gate's own parse: the
    // bus validates a request where it is sent, and not at all in production.
    const response = await harness.transport.requestAs(
      REGISTER.$meta.namespace,
      REGISTER.subject as string,
      { executionAttemptId: attemptId, runtimeIncarnationId: '' },
      attemptPeer(attemptId, executionId),
    );

    expect(response.result).toBeUndefined();
    expect(response.error?.message).toBeDefined();
    expect(registerRuntime).not.toHaveBeenCalled();
    expect(deliveries).toEqual([]);
    expect(readyEvents).toEqual([]);
    const control = await harness.authority.getAttemptControlState(attemptId);
    expect(control?.runtimeGeneration).toBe(0);
  });

  it('refuses a report whose payload names another attempt than the peer', async () => {
    const executionId = 'exec-wrong-peer';
    const attemptId = await allocateAttempt(harness, executionId);
    const otherAttemptId = await allocateAttempt(harness, 'exec-wrong-peer-other');
    installGate();
    installProbeResponder({ receipt: 'completed' });

    const response = await register(attemptId, executionId, { payloadAttemptId: otherAttemptId });

    expect(response.error?.message).toContain('does not match authenticated peer identity');
    expect(response.result).toBeUndefined();
    expect(deliveries).toEqual([]);
    expect(readyEvents).toEqual([]);
  });

  it('refuses a report from an unauthenticated caller', async () => {
    const executionId = 'exec-unauthenticated';
    const attemptId = await allocateAttempt(harness, executionId);
    installGate();

    const response = await harness.transport.requestAs(
      REGISTER.$meta.namespace,
      REGISTER.subject as string,
      { executionAttemptId: attemptId, runtimeIncarnationId: INCARNATION },
      { kind: 'test-identity', id: attemptId, authenticated: true },
    );

    expect(response.error?.message).toContain('authenticated workflow-execution-attempt peer');
    expect(readyEvents).toEqual([]);
  });
});
