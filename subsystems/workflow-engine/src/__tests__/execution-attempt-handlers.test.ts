import { createBusContext, createBusInstance } from '@makaio/bus-core';
import {
  ExecutionAttemptNamespace,
  ExecutionAttemptOutcomeSchema,
  ExecutionAttemptSubjects,
  type ExecutionAttemptInstruction,
  type ExecutionAttemptOutcome,
  type ExecutionAttemptOutcomeSubmitRequest,
} from '@makaio/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionAttemptAuthority } from '../execution-attempt-authority.js';
import { registerExecutionAttemptHandlers } from '../execution-attempt-handlers.js';
import type { OutcomeConvergenceInput } from '../outcome-convergence.js';
import { createInMemoryAttemptRepository } from '../testing/in-memory-attempt-repository.js';
import { driveTestAttemptToAllocated, makeTestInstruction } from '../testing/attempt-fixtures.js';
import { AttemptGateTransport, attemptPeer } from './execution-attempt-gate-harness.js';

const OWNER = 'generic-owner';
const binding = { workspaceRoot: '/workspace/attempt', sourceRoots: [{ id: 'primary', path: '/workspace/attempt' }] };

/**
 * Build a real generic Authority and bus; only the owner's external effects are represented in memory.
 * @param beforeDecode - Optional asynchronous owner lookup used to exercise slot changes before commit.
 * @returns An isolated ingress fixture with explicit owner convergence observations.
 */
function createHarness(beforeDecode?: () => Promise<void>) {
  const repository = createInMemoryAttemptRepository<ExecutionAttemptOutcome>({
    parse: (input) => ExecutionAttemptOutcomeSchema.parse(input),
    serialize: (outcome) => JSON.stringify(outcome),
  });
  const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 60_000 });
  const bus = createBusInstance({ context: createBusContext() });
  bus.registerNamespace(ExecutionAttemptNamespace);
  const transport = new AttemptGateTransport();
  bus.registerTransport(transport);
  const observations = {
    calls: [] as OutcomeConvergenceInput<ExecutionAttemptOutcome>[],
    failNext: false,
    committedBeforeConverge: false,
  };
  const cleanup = registerExecutionAttemptHandlers(bus, {
    authority,
    decodeOutcome: async ({ instruction, outcome }) => {
      if (instruction.workload.kind !== 'test-workload') throw new Error('Unexpected owner adapter');
      await beforeDecode?.();
      return outcome;
    },
    convergence: {
      async converge(input) {
        observations.calls.push(input);
        observations.committedBeforeConverge = repository.committedOutcomes.has(input.executionAttemptId);
        if (observations.failNext) {
          observations.failNext = false;
          throw new Error('Owner convergence temporarily unavailable');
        }
        return 'projected';
      },
    },
  });
  return { repository, authority, transport, observations, cleanup };
}

/**
 * Prepare a registered Runtime without a workflow engine or WorkflowRunResult.
 * @param harness - Generic fixture under test.
 * @param instruction - Assignment to freeze before dispatch.
 * @returns Attempt and Runtime identity used by remote requests.
 */
async function readyAttempt(harness: ReturnType<typeof createHarness>, instruction = makeTestInstruction()) {
  const { executionAttemptId } = await harness.authority.createAttempt(OWNER, instruction);
  await driveTestAttemptToAllocated(harness.authority, executionAttemptId, OWNER);
  const registration = await harness.authority.registerRuntime({
    executionAttemptId,
    executionId: OWNER,
    runtimeIncarnationId: 'runtime-1',
  });
  if (registration.kind !== 'registered') throw new Error(`Registration refused: ${registration.kind}`);
  const { runtimeGeneration } = registration;
  const readiness = await harness.authority.markRuntimeReady({
    executionAttemptId,
    executionId: OWNER,
    runtimeGeneration,
    readyAt: new Date().toISOString(),
  });
  if (readiness.kind !== 'ready') throw new Error(`Readiness refused: ${readiness.kind}`);
  return { executionAttemptId, runtimeGeneration };
}

/**
 * Admit one of the fixed work operations through the real Authority.
 * @param harness - Generic fixture under test.
 * @param identity - Attempt and Runtime generation.
 * @param operationKind - Operation to admit.
 * @returns Its durable operation identifier.
 */
async function admit(
  harness: ReturnType<typeof createHarness>,
  identity: { executionAttemptId: string; runtimeGeneration: number },
  operationKind: 'workspace-preparation' | 'workload-invocation',
): Promise<string> {
  const decision = await harness.authority.admitOperation({
    ...identity,
    executionId: OWNER,
    operationKind,
    admissionKey: operationKind,
  });
  if (decision.kind !== 'admitted') throw new Error(`Admission refused: ${decision.kind}`);
  return decision.operationId;
}

describe('generic execution Attempt ingress', () => {
  let harness: ReturnType<typeof createHarness>;
  beforeEach(() => {
    harness = createHarness();
  });
  afterEach(() => {
    harness.cleanup();
    vi.restoreAllMocks();
  });

  /**
   * Submit a terminal result through the authenticated transport boundary.
   * @param request - Terminal report sent by the Runtime.
   * @returns The actual bus response.
   */
  function submit(request: ExecutionAttemptOutcomeSubmitRequest) {
    const subject = ExecutionAttemptSubjects.outcome.submit;
    return harness.transport.requestAs(
      subject.$meta.namespace,
      subject.subject as string,
      request,
      attemptPeer(request.executionAttemptId, OWNER),
    );
  }

  it('reads the frozen instruction, not subsequent owner input mutations', async () => {
    const instruction = makeTestInstruction();
    const identity = await readyAttempt(harness, instruction);
    instruction.revision = 'changed-after-dispatch';
    const subject = ExecutionAttemptSubjects.instruction.get;
    const response = await harness.transport.requestAs(
      subject.$meta.namespace,
      subject.subject as string,
      identity,
      attemptPeer(identity.executionAttemptId, OWNER),
    );
    expect(response.result).toMatchObject({ decision: 'found', instruction: { revision: '1' } });
    expect(response.error).toBeUndefined();
  });

  it('atomically accepts Preparation and permits Invocation without a readiness event', async () => {
    const instruction: ExecutionAttemptInstruction = makeTestInstruction({
      workspace: {
        provisioning: 'bind',
        custody: 'external',
        sourceRoots: [{ id: 'primary', path: '.' }],
        setup: [],
      },
    });
    const identity = await readyAttempt(harness, instruction);
    const operationId = await admit(harness, identity, 'workspace-preparation');
    const subject = ExecutionAttemptSubjects.operation.report;
    const request = { ...identity, operationId, result: { kind: 'workspace-prepared', binding } };
    const first = await harness.transport.requestAs(
      subject.$meta.namespace,
      subject.subject as string,
      request,
      attemptPeer(identity.executionAttemptId, OWNER),
    );
    expect(first.result).toEqual({ decision: 'accepted', binding });
    expect(await harness.authority.getAttemptControlState(identity.executionAttemptId)).toMatchObject({
      activeOperationId: null,
    });
    expect(harness.repository.attempts.get(identity.executionAttemptId)?.preparationReceipts).toHaveLength(1);
    const replay = await harness.transport.requestAs(
      subject.$meta.namespace,
      subject.subject as string,
      request,
      attemptPeer(identity.executionAttemptId, OWNER),
    );
    expect(replay.result).toEqual({ decision: 'duplicate', binding });
    expect(await admit(harness, identity, 'workload-invocation')).toEqual(expect.any(String));
    expect(harness.observations.calls).toEqual([]);
  });

  it('commits before convergence and retries lost ACKs without repeating Invocation', async () => {
    const identity = await readyAttempt(harness);
    const operationId = await admit(harness, identity, 'workload-invocation');
    const waiter = harness.authority.waitForOutcome(identity.executionAttemptId);
    let settled = false;
    void waiter?.then(() => {
      settled = true;
    });
    harness.observations.failNext = true;
    const request: ExecutionAttemptOutcomeSubmitRequest = {
      ...identity,
      operationId,
      outcome: { kind: 'workload-result', result: { count: 7 } },
    };
    const first = await submit(request);
    expect(first.error?.message).toContain('Owner convergence temporarily unavailable');
    expect(first.result).toBeUndefined();
    expect(harness.observations.committedBeforeConverge).toBe(true);
    expect(settled).toBe(false);
    expect(await harness.authority.getAttemptControlState(identity.executionAttemptId)).toMatchObject({
      operationStartGate: 'closed',
      activeOperationId: operationId,
    });
    const retry = await submit(request);
    expect(retry.result).toEqual({ decision: 'duplicate' });
    await expect(waiter).resolves.toEqual({
      outcome: request.outcome,
      controlObservation: { controlRevision: 0, cancellation: null },
      acceptance: 'projected',
    });
    expect(harness.observations.calls.map((call) => call.decision)).toEqual(['accepted', 'duplicate']);
  });

  it('accepts a missing-adapter startup failure before any operation exists', async () => {
    const identity = await readyAttempt(harness);
    const waiter = harness.authority.waitForOutcome(identity.executionAttemptId);
    const outcome = {
      kind: 'technical-failure',
      stage: 'startup',
      message: 'Required adapter is unavailable',
    } as const;
    const response = await submit({ ...identity, outcome });
    expect(response.result).toEqual({ decision: 'accepted' });
    await expect(waiter).resolves.toEqual({
      outcome,
      controlObservation: { controlRevision: 0, cancellation: null },
      acceptance: 'projected',
    });
  });

  it.each([
    'decode',
    'storage',
  ] as const)('propagates a genuine %s exception so the report can retry', async (failure) => {
    let failDecode = failure === 'decode';
    harness.cleanup();
    harness = createHarness(async () => {
      if (failDecode) throw new Error('Owner decoding unavailable');
    });
    const identity = await readyAttempt(harness);
    const operationId = await admit(harness, identity, 'workload-invocation');
    const waiter = harness.authority.waitForOutcome(identity.executionAttemptId);
    if (failure === 'storage') {
      vi.spyOn(harness.repository, 'commitOutcome').mockRejectedValueOnce(new Error('Outcome store unavailable'));
    }
    const request: ExecutionAttemptOutcomeSubmitRequest = {
      ...identity,
      operationId,
      outcome: { kind: 'workload-result', result: 3 },
    };
    const first = await submit(request);
    expect(first.error?.message).toContain('unavailable');
    expect(first.result).toBeUndefined();
    expect(harness.repository.committedOutcomes.size).toBe(0);
    expect(harness.authority.waitForOutcome(identity.executionAttemptId)).toBe(waiter);
    failDecode = false;
    expect((await submit(request)).result).toEqual({ decision: 'accepted' });
    await expect(waiter).resolves.toEqual({
      outcome: request.outcome,
      controlObservation: { controlRevision: 0, cancellation: null },
      acceptance: 'projected',
    });
  });

  it.each([
    'before work',
    'preparing',
    'prepared',
    'invoking',
  ] as const)('commits observed cancellation while %s and acknowledges an identical retry', async (stage) => {
    const instruction = makeTestInstruction(
      stage === 'preparing' || stage === 'prepared'
        ? { workspace: { provisioning: 'create', custody: 'disposable', sourceRoots: [], setup: [] } }
        : {},
    );
    const identity = await readyAttempt(harness, instruction);
    const waiter = harness.authority.waitForOutcome(identity.executionAttemptId);
    let operationId: string | undefined;
    if (stage === 'preparing' || stage === 'prepared') {
      operationId = await admit(harness, identity, 'workspace-preparation');
      if (stage === 'prepared') {
        const report = await harness.authority.reportOperation({
          ...identity,
          executionId: OWNER,
          operationId,
          result: { kind: 'workspace-prepared', binding: { workspaceRoot: '/scratch', sourceRoots: [] } },
        });
        expect(report.kind).toBe('accepted');
        operationId = undefined;
      }
    } else if (stage === 'invoking') {
      operationId = await admit(harness, identity, 'workload-invocation');
    }
    const request: ExecutionAttemptOutcomeSubmitRequest = {
      ...identity,
      ...(operationId === undefined ? {} : { operationId }),
      outcome: { kind: 'cancelled', reason: 'Cooperative work stopped' },
    };
    expect((await submit(request)).result).toEqual({ decision: 'accepted' });
    await expect(waiter).resolves.toEqual({
      outcome: request.outcome,
      controlObservation: { controlRevision: 0, cancellation: null },
      acceptance: 'projected',
    });
    expect((await submit(request)).result).toEqual({ decision: 'duplicate' });
    expect(harness.repository.committedOutcomes.size).toBe(1);
    expect(await harness.authority.getAttemptControlState(identity.executionAttemptId)).toMatchObject({
      operationStartGate: 'closed',
      activeOperationId: operationId ?? null,
    });
  });

  it('refuses cancellation with missing or stale active-operation correlation', async () => {
    const identity = await readyAttempt(harness);
    const operationId = await admit(harness, identity, 'workload-invocation');
    const outcome = { kind: 'cancelled' } as const;
    expect((await submit({ ...identity, outcome })).result).toEqual({ decision: 'fenced' });
    expect((await submit({ ...identity, operationId: 'stale-operation', outcome })).result).toEqual({
      decision: 'fenced',
    });
    expect(
      (await submit({ ...identity, runtimeGeneration: identity.runtimeGeneration + 1, operationId, outcome })).result,
    ).toEqual({ decision: 'fenced' });
    expect(harness.repository.committedOutcomes.size).toBe(0);
  });

  it('does not accept cancellation as completion of the Authority runtime probe', async () => {
    const identity = await readyAttempt(harness);
    const probe = await harness.authority.admitOperation({
      ...identity,
      executionId: OWNER,
      operationKind: 'runtime-probe',
      admissionKey: 'probe',
    });
    if (probe.kind !== 'admitted') throw new Error(`Probe admission refused: ${probe.kind}`);
    const response = await submit({ ...identity, operationId: probe.operationId, outcome: { kind: 'cancelled' } });
    expect(response.result).toEqual({ decision: 'fenced' });
    expect(harness.repository.committedOutcomes.size).toBe(0);
  });

  it('does not let a Preparation failure complete its operation before terminal commitment', async () => {
    const identity = await readyAttempt(
      harness,
      makeTestInstruction({
        workspace: {
          provisioning: 'create',
          custody: 'disposable',
          sourceRoots: [],
          setup: [],
        },
      }),
    );
    const operationId = await admit(harness, identity, 'workspace-preparation');
    const response = await submit({
      ...identity,
      operationId,
      outcome: { kind: 'technical-failure', stage: 'workspace-preparation', message: 'Setup failed' },
    });
    expect(response.result).toEqual({ decision: 'accepted' });
    expect(await harness.authority.getAttemptControlState(identity.executionAttemptId)).toMatchObject({
      operationStartGate: 'closed',
      activeOperationId: operationId,
    });
  });

  it.each([
    'runtime replacement',
    'operation admission',
  ] as const)('preserves the current Attempt when %s races asynchronous outcome decoding', async (change) => {
    const decoding = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    harness.cleanup();
    harness = createHarness(async () => {
      decoding.resolve();
      await release.promise;
    });
    const identity = await readyAttempt(harness);
    const waiter = harness.authority.waitForOutcome(identity.executionAttemptId);
    const startupFailure = { kind: 'technical-failure', stage: 'startup', message: 'Adapter lookup failed' } as const;
    const pending = submit({ ...identity, outcome: startupFailure });
    await decoding.promise;

    let currentRequest: ExecutionAttemptOutcomeSubmitRequest;
    if (change === 'runtime replacement') {
      const registration = await harness.authority.registerRuntime({
        executionAttemptId: identity.executionAttemptId,
        executionId: OWNER,
        runtimeIncarnationId: 'runtime-2',
      });
      expect(registration.kind).toBe('registered');
      if (registration.kind !== 'registered') throw new Error('Replacement Runtime did not register');
      currentRequest = { ...identity, runtimeGeneration: registration.runtimeGeneration, outcome: startupFailure };
    } else {
      const operationId = await admit(harness, identity, 'workload-invocation');
      currentRequest = { ...identity, operationId, outcome: { kind: 'workload-result', result: 8 } };
    }
    release.resolve();
    const staleResponse = await pending;
    expect(staleResponse.error).toBeUndefined();
    expect(staleResponse.result).toEqual({ decision: 'fenced' });
    expect(harness.repository.committedOutcomes.size).toBe(0);
    expect(harness.observations.calls).toEqual([]);
    expect(harness.authority.waitForOutcome(identity.executionAttemptId)).toBe(waiter);
    expect((await submit(currentRequest)).result).toEqual({ decision: 'accepted' });
    await expect(waiter).resolves.toEqual({
      outcome: currentRequest.outcome,
      controlObservation: { controlRevision: 0, cancellation: null },
      acceptance: 'projected',
    });
  });

  it('refuses an outcome for the wrong operation or Runtime generation before commitment', async () => {
    const identity = await readyAttempt(harness);
    const operationId = await admit(harness, identity, 'workload-invocation');
    const waiter = harness.authority.waitForOutcome(identity.executionAttemptId);
    const outcome = { kind: 'workload-result', result: 7 } as const;
    const wrongOperation = await submit({ ...identity, operationId: 'another-operation', outcome });
    expect(wrongOperation.result).toEqual({ decision: 'fenced' });
    expect(wrongOperation.error).toBeUndefined();
    const wrongGeneration = await submit({
      ...identity,
      runtimeGeneration: identity.runtimeGeneration + 1,
      operationId,
      outcome,
    });
    expect(wrongGeneration.result).toEqual({ decision: 'fenced' });
    expect(wrongGeneration.error).toBeUndefined();
    expect(harness.repository.committedOutcomes.size).toBe(0);
    expect(harness.authority.waitForOutcome(identity.executionAttemptId)).toBe(waiter);
    expect((await submit({ ...identity, operationId, outcome })).result).toEqual({ decision: 'accepted' });
    await expect(waiter).resolves.toEqual({
      outcome,
      controlObservation: { controlRevision: 0, cancellation: null },
      acceptance: 'projected',
    });
  });

  it('refuses foreign Attempt peers at all three generic request seams', async () => {
    const identity = await readyAttempt(harness);
    const requests = [
      { subject: ExecutionAttemptSubjects.instruction.get, payload: identity },
      {
        subject: ExecutionAttemptSubjects.operation.report,
        payload: { ...identity, operationId: 'operation', result: { kind: 'workspace-prepared', binding } },
      },
      {
        subject: ExecutionAttemptSubjects.outcome.submit,
        payload: { ...identity, outcome: { kind: 'technical-failure', stage: 'startup', message: 'Failure' } },
      },
    ];
    for (const { subject, payload } of requests) {
      const response = await harness.transport.requestAs(
        subject.$meta.namespace,
        subject.subject as string,
        payload,
        attemptPeer('foreign-attempt', 'foreign-owner'),
      );
      expect(response.error?.message).toContain('authenticated peer identity');
    }
    expect(harness.repository.committedOutcomes.size).toBe(0);
  });

  it('refuses a matching Attempt id whose authenticated owner is different', async () => {
    const identity = await readyAttempt(harness);
    const subject = ExecutionAttemptSubjects.instruction.get;
    const response = await harness.transport.requestAs(
      subject.$meta.namespace,
      subject.subject as string,
      identity,
      attemptPeer(identity.executionAttemptId, 'foreign-owner'),
    );
    expect(response.result).toEqual({ decision: 'refused', refusalReason: 'not-found' });
  });
});
