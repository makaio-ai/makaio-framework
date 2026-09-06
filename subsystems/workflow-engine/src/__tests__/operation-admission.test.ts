import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ExecutionAttemptSubjects,
  type ExecutionAttemptOperationAdmittedEvent,
  type ExecutionAttemptOperationKind,
} from '@makaio/contracts';
import { registerOperationAdmissionHandler } from '../operation-admission.js';
import { makeTestWorkflowResult } from '../testing/index.js';
import {
  allocateAttempt,
  attemptPeer,
  createAttemptGateHarness,
  type AttemptGateHarness,
} from './execution-attempt-gate-harness.js';

const ADMIT = ExecutionAttemptSubjects.operation.admit;
const INCARNATION = 'runtime-incarnation-1';

describe('operation admission handler', () => {
  let harness: AttemptGateHarness;
  let cleanups: Array<() => void>;
  let admittedEvents: ExecutionAttemptOperationAdmittedEvent[];

  beforeEach(() => {
    harness = createAttemptGateHarness();
    cleanups = [];
    admittedEvents = [];
    cleanups.push(
      harness.bus.on(ExecutionAttemptSubjects.operation.admitted, (ctx) => {
        admittedEvents.push(ctx.payload);
      }),
    );
    cleanups.push(registerOperationAdmissionHandler(harness.bus, { bus: harness.bus, authority: harness.authority }));
  });

  afterEach(() => {
    for (const cleanup of cleanups) cleanup();
  });

  /**
   * Drive one attempt to a proven runtime endpoint without the gate handler.
   *
   * Admission of every kind but `runtime-probe` requires proven readiness, and
   * this suite is about the admission gate rather than about how readiness was
   * reached, so it is written straight through the authority.
   * @param executionId - Owner the attempt belongs to.
   * @returns The ready attempt's identifier and its runtime generation.
   * @throws When registration or readiness is refused.
   */
  async function readyAttempt(executionId: string): Promise<{ attemptId: string; runtimeGeneration: number }> {
    const attemptId = await allocateAttempt(harness, executionId);
    const registration = await harness.authority.registerRuntime({
      executionAttemptId: attemptId,
      executionId,
      runtimeIncarnationId: INCARNATION,
    });
    if (registration.kind !== 'registered') {
      throw new Error(`Expected the runtime to register, got '${registration.kind}'`);
    }
    const readiness = await harness.authority.markRuntimeReady({
      executionAttemptId: attemptId,
      executionId,
      runtimeGeneration: registration.runtimeGeneration,
      readyAt: new Date().toISOString(),
    });
    if (readiness.kind !== 'ready') throw new Error(`Expected readiness, got '${readiness.kind}'`);
    return { attemptId, runtimeGeneration: registration.runtimeGeneration };
  }

  /**
   * Send one admission command as the attempt's authenticated runtime.
   * @param attemptId - Attempt the peer is authenticated for.
   * @param executionId - Execution claim the peer carries.
   * @param command - Kind, idempotency key, and fence to present.
   * @param payloadAttemptId - Attempt named in the payload, when it must differ from the peer's.
   * @returns The response message the gate produced.
   */
  async function admit(
    attemptId: string,
    executionId: string,
    command: {
      readonly operationKind: ExecutionAttemptOperationKind;
      readonly admissionKey: string;
      readonly runtimeGeneration: number;
    },
    payloadAttemptId?: string,
  ): Promise<{ result?: unknown; error?: { message: string } }> {
    return harness.transport.requestAs(
      ADMIT.$meta.namespace,
      ADMIT.subject as string,
      { executionAttemptId: payloadAttemptId ?? attemptId, ...command },
      attemptPeer(attemptId, executionId),
    );
  }

  it('admits a workflow run and announces it to the pool', async () => {
    const executionId = 'admit-workflow-run';
    const { attemptId, runtimeGeneration } = await readyAttempt(executionId);

    const response = await admit(attemptId, executionId, {
      operationKind: 'workflow-run',
      admissionKey: 'run-1',
      runtimeGeneration,
    });

    expect(response.result).toEqual({ decision: 'admitted', operationId: expect.any(String) });
    const operationId = (response.result as { operationId: string }).operationId;
    expect(admittedEvents).toEqual([
      {
        executionAttemptId: attemptId,
        operationId,
        operationKind: 'workflow-run',
        runtimeGeneration,
        admittedAt: expect.any(String),
      },
    ]);
    expect(await harness.authority.getAttemptControlState(attemptId)).toMatchObject({
      activeOperationId: operationId,
      activeOperationKind: 'workflow-run',
      activeOperationKey: 'run-1',
      activeOperationGeneration: runtimeGeneration,
    });
  });

  it('refuses a runtime probe on the public gate as a protocol violation', async () => {
    const executionId = 'admit-probe';
    const attemptId = await allocateAttempt(harness, executionId);
    const registration = await harness.authority.registerRuntime({
      executionAttemptId: attemptId,
      executionId,
      runtimeIncarnationId: INCARNATION,
    });
    if (registration.kind !== 'registered') throw new Error('Expected the runtime to register');

    const response = await admit(attemptId, executionId, {
      operationKind: 'runtime-probe',
      admissionKey: `probe:${INCARNATION}`,
      runtimeGeneration: registration.runtimeGeneration,
    });

    // The probe is admitted only by runtime registration, which also completes
    // it. Admitted here it would occupy the attempt's single slot with an
    // operation no subject can complete, so the gate refuses it before the
    // authority sees it — no admission, no announcement.
    expect(response.error?.message).toContain("does not accept 'runtime-probe'");
    expect(response.result).toBeUndefined();
    expect(admittedEvents).toEqual([]);
    expect(await harness.authority.getAttemptControlState(attemptId)).toMatchObject({ activeOperationId: null });
  });

  it('answers a repeated admission key with duplicate and announces the admission again', async () => {
    const executionId = 'admit-duplicate';
    const { attemptId, runtimeGeneration } = await readyAttempt(executionId);
    const command = { operationKind: 'workflow-run' as const, admissionKey: 'run-1', runtimeGeneration };

    const first = await admit(attemptId, executionId, command);
    const retry = await admit(attemptId, executionId, command);

    const operationId = (first.result as { operationId: string }).operationId;
    expect(retry.result).toEqual({ decision: 'duplicate', operationId });
    // The durable admission is announced by each pass that finds it, with the
    // generation and the instant it was admitted under — the replay names the
    // original admission, not the retry; consumers collapse the repeat.
    expect(admittedEvents).toHaveLength(2);
    expect(admittedEvents[1]).toEqual(admittedEvents[0]);
    expect(admittedEvents[1]).toMatchObject({ operationId, operationKind: 'workflow-run', runtimeGeneration });
    expect(await harness.authority.getAttemptControlState(attemptId)).toMatchObject({
      activeOperationAdmittedAt: admittedEvents[0]!.admittedAt,
    });
  });

  it('repairs an announcement that failed after the admission was persisted', async () => {
    const executionId = 'admit-announcement-failed';
    const { attemptId, runtimeGeneration } = await readyAttempt(executionId);
    const command = { operationKind: 'workflow-run' as const, admissionKey: 'run-1', runtimeGeneration };
    let failOnce = true;
    cleanups.push(
      harness.bus.on(ExecutionAttemptSubjects.operation.admitted, () => {
        if (failOnce) {
          failOnce = false;
          throw new Error('consumer failed');
        }
      }),
    );

    const first = await admit(attemptId, executionId, command);
    const retry = await admit(attemptId, executionId, command);

    expect(first.error?.message).toContain('consumer failed');
    expect(retry.result).toEqual({ decision: 'duplicate', operationId: expect.any(String) });
    expect(admittedEvents).toHaveLength(2);
  });

  it.each([
    {
      label: 'not-ready',
      refusalReason: 'not-ready',
      command: { operationKind: 'workflow-run' as const, admissionKey: 'run-1' },
      /**
       * Allocate and register, but never prove readiness.
       * @param executionId - Owner the attempt belongs to.
       * @returns The attempt identifier and the generation to fence against.
       */
      seed: async (executionId: string) => {
        const attemptId = await allocateAttempt(harness, executionId);
        const registration = await harness.authority.registerRuntime({
          executionAttemptId: attemptId,
          executionId,
          runtimeIncarnationId: INCARNATION,
        });
        if (registration.kind !== 'registered') throw new Error('Expected the runtime to register');
        return { attemptId, runtimeGeneration: registration.runtimeGeneration };
      },
    },
    {
      label: 'not-allocated',
      refusalReason: 'not-allocated',
      command: { operationKind: 'workflow-run' as const, admissionKey: 'run-1' },
      /**
       * Create an attempt that owns no allocation.
       * @param executionId - Owner the attempt belongs to.
       * @returns The attempt identifier and an arbitrary fence.
       */
      seed: async (executionId: string) => {
        const { executionAttemptId } = await harness.authority.createAttempt(executionId);
        return { attemptId: executionAttemptId, runtimeGeneration: 1 };
      },
    },
    {
      label: 'stale-generation',
      refusalReason: 'stale-generation',
      command: { operationKind: 'workflow-run' as const, admissionKey: 'run-1' },
      /**
       * Prove readiness, then fence one generation behind the current one.
       * @param executionId - Owner the attempt belongs to.
       * @returns The attempt identifier and a superseded generation.
       */
      seed: async (executionId: string) => {
        const { attemptId, runtimeGeneration } = await readyAttempt(executionId);
        return { attemptId, runtimeGeneration: runtimeGeneration + 1 };
      },
    },
  ])('refuses an admission with $label', async ({ refusalReason, command, seed }) => {
    const executionId = `admit-${refusalReason}`;
    const { attemptId, runtimeGeneration } = await seed(executionId);

    const response = await admit(attemptId, executionId, { ...command, runtimeGeneration });

    expect(response.result).toEqual({ decision: 'refused', refusalReason });
    expect(admittedEvents).toEqual([]);
  });

  it('refuses a second operation while one is active', async () => {
    const executionId = 'admit-occupied';
    const { attemptId, runtimeGeneration } = await readyAttempt(executionId);
    await admit(attemptId, executionId, {
      operationKind: 'workflow-run',
      admissionKey: 'run-1',
      runtimeGeneration,
    });

    const second = await admit(attemptId, executionId, {
      operationKind: 'workflow-run',
      admissionKey: 'run-2',
      runtimeGeneration,
    });

    expect(second.result).toEqual({ decision: 'refused', refusalReason: 'operation-active' });
    expect(admittedEvents).toHaveLength(1);
  });

  it('answers a settled attempt with resolved, over its closed gate', async () => {
    const executionId = 'admit-settled';
    const { attemptId, runtimeGeneration } = await readyAttempt(executionId);
    await harness.authority.commitOutcome(
      attemptId,
      executionId,
      harness.authority.canonicalizeOutcome(makeTestWorkflowResult(executionId)),
    );

    const response = await admit(attemptId, executionId, {
      operationKind: 'workflow-run',
      admissionKey: 'run-after-settlement',
      runtimeGeneration,
    });

    expect(response.result).toEqual({ decision: 'refused', refusalReason: 'resolved' });
    expect(admittedEvents).toEqual([]);
  });

  it('answers a superseded attempt with fenced', async () => {
    const executionId = 'admit-fenced';
    const { attemptId, runtimeGeneration } = await readyAttempt(executionId);
    await allocateAttempt(harness, executionId);

    const response = await admit(attemptId, executionId, {
      operationKind: 'workflow-run',
      admissionKey: 'run-1',
      runtimeGeneration,
    });

    expect(response.result).toEqual({ decision: 'refused', refusalReason: 'fenced' });
    expect(admittedEvents).toEqual([]);
  });

  it('answers an unknown attempt with not-found', async () => {
    const response = await admit('attempt-that-never-existed', 'admit-missing', {
      operationKind: 'workflow-run',
      admissionKey: 'run-1',
      runtimeGeneration: 1,
    });

    expect(response.result).toEqual({ decision: 'refused', refusalReason: 'not-found' });
  });

  it('refuses a malformed command before the gate is consulted', async () => {
    const executionId = 'admit-malformed';
    const { attemptId, runtimeGeneration } = await readyAttempt(executionId);
    const admitOperation = vi.spyOn(harness.authority, 'admitOperation');

    // The bus validates a request where it is sent and not at all in
    // production; an unknown kind and an empty key must still not reach the
    // durable decision.
    const response = await harness.transport.requestAs(
      ADMIT.$meta.namespace,
      ADMIT.subject as string,
      { executionAttemptId: attemptId, operationKind: 'tear-down', admissionKey: '', runtimeGeneration },
      attemptPeer(attemptId, executionId),
    );

    expect(response.result).toBeUndefined();
    expect(response.error?.message).toBeDefined();
    expect(admitOperation).not.toHaveBeenCalled();
    expect(admittedEvents).toEqual([]);
    const control = await harness.authority.getAttemptControlState(attemptId);
    expect(control?.activeOperationId).toBeNull();
  });

  it('refuses a command whose payload names another attempt than the peer', async () => {
    const executionId = 'admit-wrong-peer';
    const { attemptId, runtimeGeneration } = await readyAttempt(executionId);
    const other = await readyAttempt('admit-wrong-peer-other');

    const response = await admit(
      attemptId,
      executionId,
      { operationKind: 'workflow-run', admissionKey: 'run-1', runtimeGeneration },
      other.attemptId,
    );

    expect(response.error?.message).toContain('does not match authenticated peer identity');
    expect(response.result).toBeUndefined();
    expect(admittedEvents).toEqual([]);
  });

  it('refuses a command from an unauthenticated caller', async () => {
    const executionId = 'admit-unauthenticated';
    const { attemptId, runtimeGeneration } = await readyAttempt(executionId);

    const response = await harness.transport.requestAs(
      ADMIT.$meta.namespace,
      ADMIT.subject as string,
      { executionAttemptId: attemptId, operationKind: 'workflow-run', admissionKey: 'run-1', runtimeGeneration },
      { kind: 'test-identity', id: attemptId, authenticated: true },
    );

    expect(response.error?.message).toContain('authenticated workflow-execution-attempt peer');
    expect(admittedEvents).toEqual([]);
  });
});
