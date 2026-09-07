import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeTestInstruction } from '../testing/attempt-fixtures.js';
import { sql } from 'drizzle-orm';
import {
  RECOVERY_EVIDENCE_LIMITS,
  type ExecutionAttemptOperationKind,
  type ExecutionAttemptInstruction,
  type WorkflowRunResult,
} from '@makaio/contracts';
import { createTempDb, type TestDbContext } from '@makaio/test-utils/drizzle-harness';
import { createDatabaseClient } from '@makaio/storage-drizzle/client';
import type {
  BeginProvisioningInput,
  ExecutionAttemptRecord,
  ExecutionAttemptRepository,
  OutcomeCodec,
} from '../index.js';
import { RuntimeOutcomeFenceMismatchError, type ReportOperationInput } from '../execution-attempt-repository.js';
import { DuplicateExecutionAttemptError } from '../index.js';
import {
  counterCodec,
  generationCounterCodec,
  roundingCounterCodec,
  type CounterOutcome,
  type GenerationCounterOutcome,
} from './counter-outcome.js';
import { urlOutcomeCodec } from './url-outcome.js';
import { bytesOutcomeCodec } from './bytes-outcome.js';
import { createSqliteAttemptRepository } from '../testing/sqlite.js';
import {
  INITIAL_ATTEMPT_CONTROL_STATE,
  TEST_PROVIDER_ID,
  TEST_PROVISIONER_INCARNATION_ID,
  createInMemoryAttemptRepository,
  leaseAt,
  makeBeginProvisioningInput,
  makeEvidence,
  makeProcessLossProof,
  makeTestAllocationRef,
  makeTestWorkflowResult,
  type ProvisioningClaimGrantor,
  workflowRunResultOutcomeCodec,
} from '../testing/index.js';
import type { ProviderOperationClaim } from '../provider-operation.js';

/**
 * One realization of the port under test, together with its teardown.
 *
 * The port is a specification, so a rule that only one realization obeys is a
 * rule the specification does not actually have. Everything in this suite is
 * asserted against every realization the package ships.
 * @typeParam TOutcome - Owner-specific outcome type committed per attempt.
 */
interface RealizationHarness<TOutcome> {
  /** Repository exposing the full port surface. */
  readonly repository: Required<ExecutionAttemptRepository<TOutcome>>;
  /** Independent controller sharing the same durable state. */
  readonly peer: Required<ExecutionAttemptRepository<TOutcome>>;
  /**
   * Write an attempt's committed outcome text behind the port's back.
   *
   * The only way to produce durable state the port itself cannot create: a
   * stored text the injected codec rejects, which is what corruption or a
   * codec changed under an existing row looks like on read.
   * @param executionAttemptId - Attempt whose stored outcome text to replace.
   * @param text - Durable text to store.
   */
  readonly writeStoredOutcomeText: (executionAttemptId: string, text: string) => Promise<void>;
  /**
   * Seed the legacy absence of a bootstrap deadline without changing other facts.
   * @param executionAttemptId - Attempt whose deadline to clear.
   */
  readonly clearStoredBootstrapDeadline: (executionAttemptId: string) => Promise<void>;
  /** Release whatever the realization holds open. */
  readonly dispose: () => void | Promise<void>;
}

/**
 * Build one realization around an owner-injected codec.
 *
 * Generic rather than bound to `WorkflowRunResult` so the outcome cases below
 * can drive the same two realizations with a non-workflow outcome type.
 */
interface RealizationFactory {
  /**
   * @param codec - Owner-injected codec the realization validates outcomes with.
   * @returns The realization and its teardown.
   * @typeParam TOutcome - Owner-specific outcome type committed per attempt.
   */
  <TOutcome>(codec: OutcomeCodec<TOutcome>): Promise<RealizationHarness<TOutcome>>;
}

const REALIZATIONS: ReadonlyArray<readonly [string, RealizationFactory]> = [
  [
    'in-memory',
    async (codec) => {
      const repository = createInMemoryAttemptRepository(codec);
      return {
        repository,
        peer: createInMemoryAttemptRepository(codec, repository),
        writeStoredOutcomeText: async (executionAttemptId, text) => {
          repository.committedOutcomes.set(executionAttemptId, text);
        },
        clearStoredBootstrapDeadline: async (executionAttemptId) => {
          const attempt = repository.attempts.get(executionAttemptId);
          if (!attempt) throw new Error('Missing test attempt');
          repository.attempts.set(executionAttemptId, { ...attempt, bootstrapDeadlineAt: null });
        },
        dispose: () => {},
      };
    },
  ],
  [
    'sqlite',
    async (codec) => {
      const context: TestDbContext = await createTempDb('execution-attempt-parity');
      const secondary = await createDatabaseClient({ url: `file:${context.dbPath}` });
      return {
        repository: await createSqliteAttemptRepository(context.db, codec),
        peer: await createSqliteAttemptRepository(secondary.db, codec),
        writeStoredOutcomeText: async (executionAttemptId, text) => {
          await context.exec(
            sql`UPDATE test_execution_attempt SET workflow_result = ${text}
              WHERE execution_attempt_id = ${executionAttemptId}`,
          );
        },
        clearStoredBootstrapDeadline: async (executionAttemptId) => {
          await context.exec(sql`UPDATE test_execution_attempt SET bootstrap_deadline_at = NULL
            WHERE execution_attempt_id = ${executionAttemptId}`);
        },
        dispose: async () => {
          await secondary.close();
          context.cleanup();
        },
      };
    },
  ],
];

/**
 * One owner outcome type the commitment cases are asserted against.
 *
 * `TOutcome` is a type parameter of the port, so a rule the port owes is owed
 * for whatever outcome an owner injects a codec for — not only for the
 * workflow adapter's own result.
 * @typeParam TOutcome - Owner-specific outcome type committed per attempt.
 */
interface OutcomeVariant<TOutcome> {
  /** Codec the realization is built with. */
  readonly codec: OutcomeCodec<TOutcome>;
  /**
   * Build one of two unequal outcomes.
   * @param executionId - Execution the outcome belongs to, where the type carries one.
   * @param seed - `0` for the outcome a case commits, `1` for a competing one.
   * @returns The outcome to submit.
   */
  readonly makeOutcome: (executionId: string, seed: 0 | 1) => TOutcome;
}

const WORKFLOW_OUTCOME_VARIANT: OutcomeVariant<WorkflowRunResult> = {
  codec: workflowRunResultOutcomeCodec,
  makeOutcome: (executionId, seed) => makeTestWorkflowResult(executionId, seed === 0 ? 'completed' : 'failed'),
};

// Seed `0` is the number `0`: a committed outcome a truthiness probe reads as
// absence, which is what makes this variant the presence check's witness.
const COUNTER_OUTCOME_VARIANT: OutcomeVariant<CounterOutcome> = {
  codec: counterCodec,
  makeOutcome: (_executionId, seed) => seed,
};

let sequence = 0;

/**
 * Allocate a fresh execution and attempt identifier pair.
 * @returns Unique execution and attempt identifiers.
 */
function nextIds(): { readonly executionId: string; readonly executionAttemptId: string } {
  sequence += 1;
  return { executionId: `parity-exec-${sequence}`, executionAttemptId: `parity-attempt-${sequence}` };
}

/**
 * Create an attempt and win its provisioning claim.
 * @param repository - Repository under test.
 * @param ids - Execution and attempt identifiers to use.
 * @param overrides - Begin-provisioning fields to replace, such as the lifetime.
 * @returns The claim the winning begin issued.
 * @throws When provisioning does not start.
 */
async function startAttempt(
  repository: Required<ExecutionAttemptRepository<WorkflowRunResult>>,
  ids: { readonly executionId: string; readonly executionAttemptId: string },
  overrides: Partial<BeginProvisioningInput> = {},
): Promise<ProviderOperationClaim> {
  await repository.createAttempt({ bootstrapTimeoutMs: 60_000, ...ids, instruction: makeTestInstruction() });
  const grantor: ProvisioningClaimGrantor = repository;
  const decision = await grantor.beginProvisioning(
    makeBeginProvisioningInput(ids.executionAttemptId, ids.executionId, overrides),
  );
  if (decision.kind !== 'started') throw new Error(`Expected provisioning to start, got '${decision.kind}'`);
  return decision.claim;
}

/** Runtime incarnation the control-state cases register unless they need a second one. */
const RUNTIME_INCARNATION_ID = 'runtime-incarnation-1';

/**
 * Create a ready scratch attempt with a required Preparation operation.
 * @param repository - Real repository under test.
 * @returns Successful report input for its admitted Preparation.
 */
async function preparationAttempt(
  repository: Required<ExecutionAttemptRepository<WorkflowRunResult>>,
): Promise<ReportOperationInput> {
  const ids = nextIds();
  await repository.createAttempt({
    bootstrapTimeoutMs: 60_000,
    ...ids,
    instruction: makeTestInstruction({
      workspace: { provisioning: 'create', custody: 'disposable', sourceRoots: [], setup: [] },
    }),
  });
  const provisioning = await repository.beginProvisioning(
    makeBeginProvisioningInput(ids.executionAttemptId, ids.executionId),
  );
  if (provisioning.kind !== 'started') throw new Error('Expected provisioning');
  await repository.recordAllocation({ claim: provisioning.claim, allocationRef: makeTestAllocationRef() });
  const runtimeGeneration = await registerTestRuntime(repository, ids);
  await proveTestReadiness(repository, ids, runtimeGeneration);
  const operationId = await admitTestOperation(repository, ids, runtimeGeneration, 'workspace-preparation', 'prepare');
  return {
    ...ids,
    operationId,
    runtimeGeneration,
    result: { kind: 'workspace-prepared', binding: { workspaceRoot: '/scratch/first', sourceRoots: [] } },
  };
}

/**
 * Create an attempt, win its provisioning claim, and record an allocation.
 * @param repository - Repository under test.
 * @param ids - Execution and attempt identifiers to use.
 * @returns The claim the winning begin issued.
 * @throws When provisioning does not start or the allocation is not recorded.
 */
async function allocateAttempt(
  repository: Required<ExecutionAttemptRepository<WorkflowRunResult>>,
  ids: { readonly executionId: string; readonly executionAttemptId: string },
): Promise<ProviderOperationClaim> {
  const claim = await startAttempt(repository, ids);
  const decision = await repository.recordAllocation({ claim, allocationRef: makeTestAllocationRef() });
  if (decision.kind !== 'recorded') throw new Error(`Expected the allocation to be recorded, got '${decision.kind}'`);
  return claim;
}

/**
 * Register a runtime incarnation as the attempt's endpoint.
 * @param repository - Repository under test.
 * @param ids - Execution and attempt identifiers to use.
 * @param runtimeIncarnationId - Incarnation to register.
 * @returns The generation the repository allocated.
 * @throws When the registration is refused.
 */
async function registerTestRuntime(
  repository: Required<ExecutionAttemptRepository<WorkflowRunResult>>,
  ids: { readonly executionId: string; readonly executionAttemptId: string },
  runtimeIncarnationId: string = RUNTIME_INCARNATION_ID,
): Promise<number> {
  const decision = await repository.registerRuntime({ ...ids, runtimeIncarnationId });
  if (decision.kind !== 'registered') throw new Error(`Expected the runtime to register, got '${decision.kind}'`);
  return decision.runtimeGeneration;
}

/**
 * Prove readiness for a registered generation.
 * @param repository - Repository under test.
 * @param ids - Execution and attempt identifiers to use.
 * @param runtimeGeneration - Generation the proof belongs to.
 * @returns The instant the repository accepted.
 * @throws When readiness is refused.
 */
async function proveTestReadiness(
  repository: Required<ExecutionAttemptRepository<WorkflowRunResult>>,
  ids: { readonly executionId: string; readonly executionAttemptId: string },
  runtimeGeneration: number,
): Promise<string> {
  const decision = await repository.markRuntimeReady({ ...ids, runtimeGeneration, readyAt: new Date().toISOString() });
  if (decision.kind !== 'ready') throw new Error(`Expected readiness to be accepted, got '${decision.kind}'`);
  return decision.acceptedAt;
}

/**
 * Admit one operation through the attempt's start gate.
 * @param repository - Repository under test.
 * @param ids - Execution and attempt identifiers to use.
 * @param runtimeGeneration - Generation the admission is fenced against.
 * @param operationKind - Kind of operation to admit.
 * @param admissionKey - Idempotency key for the admission.
 * @returns The identifier the repository minted.
 * @throws When the admission is refused.
 */
async function admitTestOperation(
  repository: Required<ExecutionAttemptRepository<WorkflowRunResult>>,
  ids: { readonly executionId: string; readonly executionAttemptId: string },
  runtimeGeneration: number,
  operationKind: ExecutionAttemptOperationKind,
  admissionKey: string,
): Promise<string> {
  const decision = await repository.admitOperation({ ...ids, operationKind, admissionKey, runtimeGeneration });
  if (decision.kind !== 'admitted') throw new Error(`Expected the operation to be admitted, got '${decision.kind}'`);
  return decision.operationId;
}

/**
 * Bring an attempt all the way to a proven runtime endpoint.
 * @param repository - Repository under test.
 * @param ids - Execution and attempt identifiers to use.
 * @returns The generation the proven runtime holds.
 * @throws When any step of the handshake is refused.
 */
async function readyAttempt(
  repository: Required<ExecutionAttemptRepository<WorkflowRunResult>>,
  ids: { readonly executionId: string; readonly executionAttemptId: string },
): Promise<number> {
  await allocateAttempt(repository, ids);
  const runtimeGeneration = await registerTestRuntime(repository, ids);
  await proveTestReadiness(repository, ids, runtimeGeneration);
  return runtimeGeneration;
}

describe.each(REALIZATIONS)('execution attempt port parity (%s)', (_realization, createHarness) => {
  let harness: RealizationHarness<WorkflowRunResult>;

  beforeAll(async () => {
    harness = await createHarness(workflowRunResultOutcomeCodec);
  });

  afterAll(async () => {
    await harness.dispose();
  });

  it('captures creation and bootstrap deadline from exactly one clock observation', async () => {
    const ids = nextIds();
    const instant = Date.parse('2026-09-07T10:00:00.000Z');
    const clock = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(instant)
      .mockReturnValue(instant + 1_000);
    let record: ExecutionAttemptRecord;
    try {
      record = await harness.repository.createAttempt({
        ...ids,
        instruction: makeTestInstruction(),
        bootstrapTimeoutMs: 12_345,
      });
    } finally {
      clock.mockRestore();
    }
    expect(record.createdAt).toBe('2026-09-07T10:00:00.000Z');
    expect(record.bootstrapDeadlineAt).toBe('2026-09-07T10:00:12.345Z');
    expect(await harness.peer.getActiveAttempt(ids.executionId, ids.executionAttemptId)).toEqual(record);
  });

  it.each([
    0,
    -1,
    0.5,
    NaN,
    Infinity,
    -Infinity,
    Number.MAX_SAFE_INTEGER,
    8_640_000_000_000_000,
  ])('rejects invalid or overflowing bootstrap budget %s before moving the active pointer', async (bootstrapTimeoutMs) => {
    const original = nextIds();
    const record = await harness.repository.createAttempt({
      ...original,
      instruction: makeTestInstruction(),
      bootstrapTimeoutMs: 60_000,
    });
    const invalid = { executionId: original.executionId, executionAttemptId: nextIds().executionAttemptId };
    await expect(
      harness.peer.createAttempt({ ...invalid, instruction: makeTestInstruction(), bootstrapTimeoutMs }),
    ).rejects.toThrow(RangeError);
    expect(await harness.repository.getActiveAttempt(original.executionId, original.executionAttemptId)).toEqual(
      record,
    );
    expect(await harness.repository.readBootstrapStartState(invalid)).toBeNull();
    expect(await harness.peer.readBootstrapStartState(original)).toMatchObject({
      active: true,
      operationStartGate: 'open',
    });
  });

  it('reads coherent bootstrap facts through provisioning, allocation, termination and settlement', async () => {
    const ids = nextIds();
    expect(await harness.repository.readBootstrapStartState(ids)).toBeNull();
    const claim = await startAttempt(harness.repository, ids);
    const pending = await harness.peer.readBootstrapStartState(ids);
    expect(pending).toEqual({
      settled: false,
      active: true,
      allocated: false,
      allocationTerminated: false,
      operationStartGate: 'open',
      bootstrapDeadlineAt: expect.any(String),
    });
    expect(await harness.peer.readBootstrapStartState({ ...ids, executionId: 'wrong-owner' })).toBeNull();
    await harness.repository.recordAllocation({ claim, allocationRef: makeTestAllocationRef() });
    expect(await harness.peer.readBootstrapStartState(ids)).toEqual({ ...pending, allocated: true });
    await harness.repository.recordAllocationTerminated({ claim, evidence: makeEvidence() });
    expect(await harness.peer.readBootstrapStartState(ids)).toEqual({
      ...pending,
      allocated: true,
      allocationTerminated: true,
    });
    await harness.repository.recordInfrastructureFailure({ claim, executionId: ids.executionId });
    expect(await harness.peer.readBootstrapStartState(ids)).toEqual({
      ...pending,
      allocated: true,
      allocationTerminated: true,
      settled: true,
      operationStartGate: 'closed',
    });
  });

  it('reports supersession without hiding the historical allocation or changing its deadline', async () => {
    const ids = nextIds();
    await allocateAttempt(harness.repository, ids);
    const previous = await harness.peer.readBootstrapStartState(ids);
    const replacement = { executionId: ids.executionId, executionAttemptId: nextIds().executionAttemptId };
    await harness.repository.createAttempt({
      ...replacement,
      instruction: makeTestInstruction(),
      bootstrapTimeoutMs: 1,
    });
    expect(await harness.peer.readBootstrapStartState(ids)).toEqual({
      ...previous,
      active: false,
      operationStartGate: 'closed',
    });
    expect(await harness.peer.readBootstrapStartState(replacement)).toMatchObject({
      active: true,
      allocated: false,
      operationStartGate: 'open',
    });
  });

  it.each([
    'pending',
    'allocated',
    'settled',
  ] as const)('keeps legacy %s attempts readable without extending bootstrap', async (status) => {
    const ids = nextIds();
    if (status === 'pending') {
      await harness.repository.createAttempt({
        ...ids,
        instruction: makeTestInstruction(),
        bootstrapTimeoutMs: 60_000,
      });
    } else {
      await allocateAttempt(harness.repository, ids);
    }
    if (status === 'settled') {
      await harness.repository.commitOutcome({
        ...ids,
        result: harness.repository.canonicalizeOutcome(makeTestWorkflowResult(ids.executionId, 'completed')),
      });
    }
    await harness.clearStoredBootstrapDeadline(ids.executionAttemptId);
    expect(await harness.peer.readBootstrapStartState(ids)).toMatchObject({
      bootstrapDeadlineAt: null,
      settled: status === 'settled',
      allocated: status !== 'pending',
    });
    expect(await harness.peer.getActiveAttempt(ids.executionId, ids.executionAttemptId)).toMatchObject({
      bootstrapDeadlineAt: null,
      status,
    });
    expect(await harness.peer.getInstruction(ids)).toEqual(makeTestInstruction());
    if (status === 'allocated') {
      expect(
        (await harness.peer.recovery.getRecoverableAttempts(ids.executionId)).find(
          (attempt) => attempt.executionAttemptId === ids.executionAttemptId,
        ),
      ).toMatchObject({ bootstrapDeadlineAt: null });
    }
  });

  it('checks runtime generation at commit without rejecting historical canonical duplicates', async () => {
    const ids = nextIds();
    const runtimeGeneration = await readyAttempt(harness.repository, ids);
    const result = harness.repository.canonicalizeOutcome(makeTestWorkflowResult(ids.executionId, 'failed'));
    const staleSubmission = { ...ids, result, runtimeFence: { runtimeGeneration, operationId: null } };
    // Validation may have finished on one controller before a second controller
    // replaces the runtime. Only the commit's own durable read decides.
    const replacementGeneration = await registerTestRuntime(harness.peer, ids, 'replacement-before-commit');
    await expect(harness.repository.commitOutcome(staleSubmission)).rejects.toThrow(RuntimeOutcomeFenceMismatchError);
    expect(await harness.peer.getActiveAttempt(ids.executionId, ids.executionAttemptId)).toMatchObject({
      settlementKind: null,
      runtimeGeneration: replacementGeneration,
    });
    expect(
      await harness.peer.commitOutcome({
        ...ids,
        result,
        runtimeFence: { runtimeGeneration: replacementGeneration, operationId: null },
      }),
    ).toMatchObject({ kind: 'accepted' });
    expect(await harness.repository.commitOutcome(staleSubmission)).toMatchObject({ kind: 'duplicate' });
    expect(
      await harness.repository.commitOutcome({
        ...staleSubmission,
        result: harness.repository.canonicalizeOutcome(makeTestWorkflowResult(ids.executionId, 'completed')),
      }),
    ).toEqual({ kind: 'conflict' });
  });

  it('checks the active operation atomically before a new runtime outcome is committed', async () => {
    const ids = nextIds();
    const runtimeGeneration = await readyAttempt(harness.repository, ids);
    const result = harness.repository.canonicalizeOutcome(makeTestWorkflowResult(ids.executionId, 'completed'));
    const operationId = await admitTestOperation(harness.peer, ids, runtimeGeneration, 'workload-invocation', 'invoke');
    for (const staleOperationId of [null, 'another-operation']) {
      await expect(
        harness.repository.commitOutcome({
          ...ids,
          result,
          runtimeFence: { runtimeGeneration, operationId: staleOperationId },
        }),
      ).rejects.toThrow(RuntimeOutcomeFenceMismatchError);
    }
    expect(await harness.peer.getActiveAttempt(ids.executionId, ids.executionAttemptId)).toMatchObject({
      settlementKind: null,
      activeOperationId: operationId,
    });
    expect(
      await harness.repository.commitOutcome({ ...ids, result, runtimeFence: { runtimeGeneration, operationId } }),
    ).toMatchObject({ kind: 'accepted' });
  });

  it('preserves superseded-attempt precedence over a stale runtime fence', async () => {
    const ids = nextIds();
    const runtimeGeneration = await readyAttempt(harness.repository, ids);
    await harness.peer.createAttempt({
      bootstrapTimeoutMs: 60_000,
      ...ids,
      executionAttemptId: `${ids.executionAttemptId}-replacement`,
      instruction: makeTestInstruction(),
    });
    expect(
      await harness.repository.commitOutcome({
        ...ids,
        result: harness.repository.canonicalizeOutcome(makeTestWorkflowResult(ids.executionId)),
        runtimeFence: { runtimeGeneration: runtimeGeneration + 1, operationId: null },
      }),
    ).toEqual({ kind: 'fenced' });
  });

  it('snapshots its instruction without retaining or freezing owner input', async () => {
    const ids = nextIds();
    const instruction = makeTestInstruction({ workload: { kind: 'test', version: '1', input: { value: 'original' } } });
    await harness.repository.createAttempt({ bootstrapTimeoutMs: 60_000, ...ids, instruction });
    instruction.workload.input = { value: 'changed' };
    expect(await harness.repository.getInstruction(ids)).toMatchObject({ workload: { input: { value: 'original' } } });
    const stored = await harness.repository.getInstruction(ids);
    expect(Object.isFrozen(stored?.workload.input)).toBe(true);
    expect(await harness.repository.getInstruction({ ...ids, executionId: 'other-owner' })).toBeNull();
    expect(await harness.repository.getInstruction({ ...ids, executionAttemptId: 'missing' })).toBeNull();
    const invalid = { ...instruction, revision: '' } satisfies ExecutionAttemptInstruction;
    await expect(
      harness.repository.createAttempt({
        bootstrapTimeoutMs: 60_000,
        executionId: ids.executionId,
        executionAttemptId: `${ids.executionAttemptId}-invalid`,
        instruction: invalid,
      }),
    ).rejects.toThrow();
    expect(await harness.repository.getActiveAttempt(ids.executionId, ids.executionAttemptId)).not.toBeNull();
  });

  it('admits a workspace-less invocation without inventing a preparation result', async () => {
    const ids = nextIds();
    const runtimeGeneration = await readyAttempt(harness.repository, ids);
    expect(
      await harness.repository.admitOperation({
        ...ids,
        runtimeGeneration,
        operationKind: 'workspace-preparation',
        admissionKey: 'unneeded',
      }),
    ).toEqual({ kind: 'preparation-not-required' });
    expect(
      await harness.repository.admitOperation({
        ...ids,
        runtimeGeneration,
        operationKind: 'workload-invocation',
        admissionKey: 'invoke',
      }),
    ).toMatchObject({ kind: 'admitted' });
  });

  it('requires a preparation result and replays its receipt after invocation and settlement', async () => {
    const repository = harness.repository;
    const report = await preparationAttempt(repository);
    expect(await repository.completeOperation(report)).toEqual({ kind: 'result-required' });
    expect(await repository.reportOperation(report)).toEqual({ kind: 'accepted', binding: report.result.binding });
    const record = await repository.getActiveAttempt(report.executionId, report.executionAttemptId);
    expect(record).toMatchObject({
      activeOperationId: null,
      lastCompletedOperationId: report.operationId,
      preparationReceipts: [
        { operationId: report.operationId, runtimeGeneration: report.runtimeGeneration, result: report.result },
      ],
    });
    expect(
      await repository.admitOperation({
        ...report,
        operationKind: 'workspace-preparation',
        admissionKey: 'prepare-again',
      }),
    ).toEqual({ kind: 'preparation-already-completed' });
    const invocation = await repository.admitOperation({
      ...report,
      operationKind: 'workload-invocation',
      admissionKey: 'invoke',
    });
    expect(invocation.kind).toBe('admitted');
    expect(await repository.reportOperation(report)).toEqual({ kind: 'duplicate', binding: report.result.binding });
    if (invocation.kind !== 'admitted') throw new Error('Expected Invocation');
    expect(await repository.completeOperation({ ...report, operationId: invocation.operationId })).toEqual({
      kind: 'result-required',
    });
    await repository.commitOutcome({
      ...report,
      result: repository.canonicalizeOutcome(makeTestWorkflowResult(report.executionId, 'completed')),
    });
    expect(await repository.reportOperation(report)).toEqual({ kind: 'duplicate', binding: report.result.binding });
    expect((await repository.getActiveAttempt(report.executionId, report.executionAttemptId))?.activeOperationId).toBe(
      invocation.operationId,
    );
  });

  it('acknowledges historical receipts without preparing the replacement runtime', async () => {
    const repository = harness.repository;
    const report = await preparationAttempt(repository);
    await repository.reportOperation(report);
    const runtimeGeneration = await registerTestRuntime(repository, report, 'replacement');
    await proveTestReadiness(repository, report, runtimeGeneration);
    expect(await repository.reportOperation(report)).toEqual({ kind: 'duplicate', binding: report.result.binding });
    expect(
      await repository.reportOperation({
        ...report,
        result: { ...report.result, binding: { workspaceRoot: '/changed', sourceRoots: [] } },
      }),
    ).toEqual({ kind: 'conflict' });
    expect(await repository.reportOperation({ ...report, operationId: 'unaccepted-old-operation' })).toEqual({
      kind: 'stale-generation',
    });
    expect(
      await repository.admitOperation({
        ...report,
        runtimeGeneration,
        operationKind: 'workload-invocation',
        admissionKey: 'invoke-replacement',
      }),
    ).toEqual({ kind: 'preparation-required' });
    const operationId = await admitTestOperation(
      repository,
      report,
      runtimeGeneration,
      'workspace-preparation',
      'prepare-replacement',
    );
    const replacementReport = {
      ...report,
      runtimeGeneration,
      operationId,
      result: { ...report.result, binding: { workspaceRoot: '/scratch/replacement', sourceRoots: [] } },
    };
    expect(await repository.reportOperation(replacementReport)).toEqual({
      kind: 'accepted',
      binding: replacementReport.result.binding,
    });
    expect(await repository.reportOperation(report)).toEqual({ kind: 'duplicate', binding: report.result.binding });
    expect(
      (await repository.getActiveAttempt(report.executionId, report.executionAttemptId))?.preparationReceipts,
    ).toHaveLength(2);
    expect(
      await repository.admitOperation({
        ...report,
        runtimeGeneration,
        operationKind: 'workload-invocation',
        admissionKey: 'invoke-replacement',
      }),
    ).toMatchObject({ kind: 'admitted' });
  });

  it('rejects a reused attempt identifier without touching the existing attempt', async () => {
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    const allocationRef = makeTestAllocationRef();
    await harness.repository.recordAllocation({ claim, allocationRef });
    await harness.repository.recordAllocationTerminated({ claim, evidence: makeEvidence() });
    await harness.repository.recordInfrastructureFailure({ claim, executionId: ids.executionId });

    // The port names the error, so a caller can tell a reused identifier from
    // a storage fault without matching on whichever text its store produced.
    await expect(
      harness.repository.createAttempt({ bootstrapTimeoutMs: 60_000, ...ids, instruction: makeTestInstruction() }),
    ).rejects.toThrow(DuplicateExecutionAttemptError);
    await expect(
      harness.repository.createAttempt({ bootstrapTimeoutMs: 60_000, ...ids, instruction: makeTestInstruction() }),
    ).rejects.toMatchObject({
      executionAttemptId: ids.executionAttemptId,
    });

    // Everything a fresh `pending` record would have discarded is still here.
    const stored = await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);
    expect(stored?.status).toBe('settled');
    expect(stored?.settlementKind).toBe('infrastructure-failure');
    expect(stored?.allocationRef).toEqual(allocationRef);
    expect(stored?.providerId).toBe(TEST_PROVIDER_ID);
  });

  it('fences only the allocated attempt superseded for its execution', async () => {
    const first = nextIds();
    const firstClaim = await startAttempt(harness.repository, first);
    await harness.repository.recordAllocation({ claim: firstClaim, allocationRef: makeTestAllocationRef() });
    const unrelated = nextIds();
    const unrelatedClaim = await startAttempt(harness.repository, unrelated);
    await harness.repository.recordAllocation({ claim: unrelatedClaim, allocationRef: makeTestAllocationRef() });

    const replacement = { executionId: first.executionId, executionAttemptId: `${first.executionAttemptId}-next` };
    await harness.repository.createAttempt({
      bootstrapTimeoutMs: 60_000,
      ...replacement,
      instruction: makeTestInstruction(),
    });

    expect(await harness.repository.recovery.getAttemptWithAllocation(first.executionAttemptId)).toMatchObject({
      status: 'allocated',
      claimable: false,
    });
    expect(await harness.repository.recovery.getAttemptWithAllocation(unrelated.executionAttemptId)).toMatchObject({
      status: 'allocated',
      claimable: true,
    });
  });

  it('compares allocation references by value, not by member order', async () => {
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    // `providerData` is opaque provider-owned data, so its member order is an
    // artifact of however the provider built it — and of whether the store
    // round-tripped it. Neither may decide a durable outcome.
    await harness.repository.recordAllocation({
      claim,
      allocationRef: makeTestAllocationRef(TEST_PROVIDER_ID, { machineId: 'parity-order', region: 'ord' }),
    });
    const reordered = makeTestAllocationRef(TEST_PROVIDER_ID, { region: 'ord', machineId: 'parity-order' });

    // A replay carrying the same members in another order is a replay.
    expect(await harness.repository.recordAllocation({ claim, allocationRef: reordered })).toMatchObject({
      kind: 'duplicate',
    });
    // And the same reordering is still a current view for the CAS, so
    // correlation is not rejected for a difference that is not one.
    expect(
      await harness.repository.recovery.evolveAllocationRef({
        claim,
        executionId: ids.executionId,
        currentRef: reordered,
        nextRef: makeTestAllocationRef(TEST_PROVIDER_ID, { machineId: 'parity-order', region: 'ord', jobId: 7 }),
      }),
    ).toEqual({ kind: 'evolved' });

    // A genuinely different member value is still a conflict, so the
    // comparison did not become blind to content.
    expect(
      await harness.repository.recordAllocation({
        claim,
        allocationRef: makeTestAllocationRef(TEST_PROVIDER_ID, { machineId: 'somewhere-else' }),
      }),
    ).toMatchObject({ kind: 'conflict' });
  });

  it('keeps only the newest active allocation recoverable for an execution', async () => {
    const executionId = `parity-recovery-order-${(sequence += 1)}`;
    const created: string[] = [];
    for (const suffix of ['c', 'b', 'a']) {
      const executionAttemptId = `${executionId}-${suffix}`;
      const claim = await startAttempt(harness.repository, { executionId, executionAttemptId });
      await harness.repository.recordAllocation({
        claim,
        allocationRef: makeTestAllocationRef(TEST_PROVIDER_ID, { machineId: suffix }),
      });
      created.push(executionAttemptId);
    }

    const recoverable = await harness.repository.recovery.getRecoverableAttempts(executionId);

    expect(recoverable.map((attempt) => attempt.executionAttemptId)).toEqual([created.at(-1)]);
  });

  it('refuses an evolution whose references name different providers', async () => {
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    const currentRef = makeTestAllocationRef(TEST_PROVIDER_ID, { machineId: 'parity-1' });
    await harness.repository.recordAllocation({ claim, allocationRef: currentRef });

    await expect(
      harness.repository.recovery.evolveAllocationRef({
        claim,
        executionId: ids.executionId,
        currentRef,
        nextRef: makeTestAllocationRef('a-different-provider', { machineId: 'parity-1' }),
      }),
    ).rejects.toThrow('must keep one provider');

    const stored = await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);
    expect(stored?.allocationRef).toEqual(currentRef);
  });

  it('settles infrastructure only after termination is durably confirmed', async () => {
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    const allocationRef = makeTestAllocationRef();
    await harness.repository.recordAllocation({ claim, allocationRef });

    // The claim is current and the attempt owns an allocation, so nothing but
    // the missing transition stands between this caller and a settlement.
    const premature = await harness.repository.recordInfrastructureFailure({ claim, executionId: ids.executionId });
    const unsettled = await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);
    const stillControlling = await harness.repository.getProviderOperation(ids.executionAttemptId);

    expect(premature).toEqual({ kind: 'not-terminated' });
    expect(unsettled?.status).toBe('allocated');
    expect(unsettled?.settlementKind ?? null).toBeNull();
    expect(stillControlling?.obligation).toBe('allocation-control');

    // Recording the termination is what makes the very same call succeed, so
    // the refusal above was about the missing evidence and nothing else.
    const termination = await harness.repository.recordAllocationTerminated({
      claim,
      evidence: makeEvidence({ summary: 'provider reported the allocation terminated' }),
    });
    const settlement = await harness.repository.recordInfrastructureFailure({ claim, executionId: ids.executionId });

    expect(termination).toEqual({ kind: 'recorded' });
    expect(settlement).toEqual({ kind: 'recorded' });
    const settled = await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);
    expect(settled?.settlementKind).toBe('infrastructure-failure');
    // The evidence that authorized the settlement outlives it on the closed
    // operation, which is what a later reader has to be able to inspect.
    const closed = await harness.repository.getProviderOperation(ids.executionAttemptId);
    expect(closed?.obligation).toBe('terminal-convergence');
    expect(closed?.lastFailure?.summary).toBe('provider reported the allocation terminated');
  });

  it('refuses an allocation reference that names a provider other than the attempt own', async () => {
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    const foreignRef = makeTestAllocationRef('a-different-provider', { machineId: 'foreign-1' });

    await expect(harness.repository.recordAllocation({ claim, allocationRef: foreignRef })).rejects.toThrow(
      'is bound to',
    );
    await expect(
      harness.repository.recovery.recordDiscoveredAllocation({ claim, allocationRef: foreignRef }),
    ).rejects.toThrow('is bound to');

    // Neither call may leave the attempt pointing at infrastructure the bound
    // provider never created.
    const stored = await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);
    expect(stored?.allocationRef).toBeNull();
    expect(stored?.status).toBe('provisioning');
    expect((await harness.repository.getProviderOperation(ids.executionAttemptId))?.obligation).toBe(
      'provisioning-resolution',
    );

    // The attempt's own provider is accepted through the same call, so the
    // rejection was about the binding rather than about the reference shape.
    expect(await harness.repository.recordAllocation({ claim, allocationRef: makeTestAllocationRef() })).toEqual({
      kind: 'recorded',
    });
  });

  it('refuses a foreign allocation reference even from a fenced claim', async () => {
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    // Fence the claim, so ownership alone would answer `stale`. A caller bug
    // must not become an outcome just because the caller also lost the race.
    const takeover = await harness.repository.takeOverProviderOperation({
      executionAttemptId: ids.executionAttemptId,
      ownerId: 'parity-remediator',
      observedAt: leaseAt(3_600_000),
      leaseExpiresAt: leaseAt(7_200_000),
    });
    expect(takeover.kind).toBe('claimed');

    await expect(
      harness.repository.recordAllocation({
        claim,
        allocationRef: makeTestAllocationRef('a-different-provider', { machineId: 'foreign-2' }),
      }),
    ).rejects.toThrow('is bound to');

    // The same fenced claim with a well-bound reference is answered rather
    // than thrown, which is what makes the rejection about the payload.
    expect(await harness.repository.recordAllocation({ claim, allocationRef: makeTestAllocationRef() })).toEqual({
      kind: 'stale',
    });
  });

  it('refuses an allocation reference the contract forbids, before any mutation', async () => {
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);

    await expect(
      // A blank provider identifier is exactly what the contract schema
      // exists to reject, and rejecting it on the way in is what keeps a
      // realization from storing it and only failing on some later read.
      harness.repository.recordAllocation({ claim, allocationRef: { ...makeTestAllocationRef(), providerId: '' } }),
    ).rejects.toThrow();

    const stored = await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);
    expect(stored?.status).toBe('provisioning');
    expect(stored?.allocationRef).toBeNull();
  });

  it('never lets a caller mutate durable evidence after the call returned', async () => {
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    const providerData: Record<string, unknown> = { machineId: 'parity-owned' };
    await harness.repository.recordAllocation({
      claim,
      allocationRef: makeTestAllocationRef(TEST_PROVIDER_ID, providerData),
    });

    // The caller still holds its own object. Changing it must not be a way to
    // rewrite durable evidence with no claim and no repository transition.
    providerData.machineId = 'mutated-after-the-fact';

    const stored = await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);
    expect(stored?.allocationRef?.providerData).toEqual({ machineId: 'parity-owned' });
  });

  it('closes pre-allocation debt only on proof naming the attempt own provisioner', async () => {
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids, {
      allocationLifetime: 'provisioner-process-bound',
      provisionerIncarnationId: 'provisioner-A',
    });

    // Proof about some other process says nothing about this attempt, however
    // convincing it is about that process.
    const foreign = await harness.repository.recordProvisionerIncarnationLost({
      claim,
      executionId: ids.executionId,
      proof: makeProcessLossProof('provisioner-B'),
    });
    const stillOpen = await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);

    const own = await harness.repository.recordProvisionerIncarnationLost({
      claim,
      executionId: ids.executionId,
      proof: makeProcessLossProof('provisioner-A'),
    });
    const settled = await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);
    const closed = await harness.repository.getProviderOperation(ids.executionAttemptId);

    expect(foreign).toEqual({ kind: 'incarnation-mismatch', provisionerIncarnationId: 'provisioner-A' });
    expect(stillOpen?.settlementKind ?? null).toBeNull();
    expect(own).toEqual({ kind: 'recorded' });
    // No allocation was ever recorded, so the attempt ends `abandoned` rather
    // than as an infrastructure failure it could not have suffered.
    expect(settled?.status).toBe('settled');
    expect(settled?.settlementKind).toBe('abandoned');
    expect(settled?.allocationRef).toBeNull();
    expect(settled?.claimable ?? false).toBe(false);
    // Settling closes the operation in the same transaction, and the proof's
    // own evidence is what the closed record retains.
    expect(closed?.ownerId).toBeNull();
    expect(closed?.token).toBeNull();
    expect(closed?.lastFailure?.summary).toBe('supervisor observed the provisioner process exit');
    // Nothing was ever allocated, so the obligation never advances either.
    expect(closed?.obligation).toBe('provisioning-resolution');
  });

  it('refuses a loss proof for an attempt whose allocation outlives its provisioner', async () => {
    const ids = nextIds();
    // The fixture default lifetime is `provider-managed`: such an allocation
    // survives the provisioning process, so losing that process proves nothing.
    const claim = await startAttempt(harness.repository, ids);

    const refusal = await harness.repository.recordProvisionerIncarnationLost({
      claim,
      executionId: ids.executionId,
      proof: makeProcessLossProof(TEST_PROVISIONER_INCARNATION_ID),
    });

    expect(refusal).toEqual({ kind: 'not-process-bound', allocationLifetime: 'provider-managed' });
    const stored = await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);
    expect(stored?.settlementKind ?? null).toBeNull();
    expect(stored?.status).toBe('provisioning');
  });

  it('refuses a loss proof once the attempt owns an allocation', async () => {
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids, {
      allocationLifetime: 'provisioner-process-bound',
      provisionerIncarnationId: 'provisioner-A',
    });
    const allocationRef = makeTestAllocationRef();
    await harness.repository.recordAllocation({ claim, allocationRef });

    const refusal = await harness.repository.recordProvisionerIncarnationLost({
      claim,
      executionId: ids.executionId,
      proof: makeProcessLossProof('provisioner-A'),
    });

    // A known allocation is converged by terminating it, not by closing the
    // attempt out from under the reference the operation still owns.
    expect(refusal).toEqual({ kind: 'allocated', allocationRef });
    const stored = await harness.repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);
    expect(stored?.settlementKind ?? null).toBeNull();
    expect(stored?.allocationRef).toEqual(allocationRef);
  });

  it('rejects malformed evidence before it consults ownership', async () => {
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    // Fence the claim, so the ownership guard alone would answer `stale` for
    // every write below. Whichever guard runs first is therefore observable.
    const takeover = await harness.repository.takeOverProviderOperation({
      executionAttemptId: ids.executionAttemptId,
      ownerId: 'parity-remediator',
      observedAt: leaseAt(3_600_000),
      leaseExpiresAt: leaseAt(7_200_000),
    });
    expect(takeover.kind).toBe('claimed');

    // Over-long by the contract's own bound: a caller bug, not an outcome.
    const malformed = makeEvidence({ summary: 'x'.repeat(RECOVERY_EVIDENCE_LIMITS.summary + 1) });
    const { executionId } = ids;

    await expect(
      harness.repository.recordProvisioningAbsent({ claim, executionId, evidence: malformed }),
    ).rejects.toThrow();
    await expect(
      harness.repository.recordProviderOperationUncertainty({ claim, evidence: malformed }),
    ).rejects.toThrow();
    await expect(harness.repository.recordAllocationTerminated({ claim, evidence: malformed })).rejects.toThrow();
    await expect(harness.repository.handoffProviderOperation({ claim, evidence: malformed })).rejects.toThrow();
    await expect(
      harness.repository.recordProvisionerIncarnationLost({
        claim,
        executionId,
        proof: makeProcessLossProof(TEST_PROVISIONER_INCARNATION_ID, malformed),
      }),
    ).rejects.toThrow();

    // The same stale claim with contract-valid evidence is answered rather
    // than thrown, which is what makes the rejections above about the payload.
    expect(await harness.repository.recordProvisioningAbsent({ claim, executionId, evidence: makeEvidence() })).toEqual(
      {
        kind: 'stale',
      },
    );
    const untouched = await harness.repository.getProviderOperation(ids.executionAttemptId);
    expect(untouched?.failureCount).toBe(0);
    expect(untouched?.lastFailure).toBeNull();
    expect(untouched?.ownerId).toBe('parity-remediator');
  });

  it('preserves an evidence timestamp verbatim while canonicalizing an ordered one', async () => {
    const ids = nextIds();
    const claim = await startAttempt(harness.repository, ids);
    // A provider in a different zone reports the instant it observed, in the
    // offset form the evidence contract accepts on purpose.
    const observedAt = '2026-07-27T12:00:00.000+02:00';
    const leaseExpiresAt = '2026-07-27T13:30:00+02:00';

    await harness.repository.recordProviderOperationUncertainty({ claim, evidence: makeEvidence({ observedAt }) });
    const renewal = await harness.repository.renewProviderOperationClaim({ claim, leaseExpiresAt });
    const operation = await harness.repository.getProviderOperation(ids.executionAttemptId);

    // Evidence is a public contract value its producer authored: the port
    // retains and reports it, and never orders by it, so rewriting the field
    // would change what the provider said for no benefit.
    expect(operation?.lastFailure?.observedAt).toBe(observedAt);
    // A lease deadline is the opposite: the port compares it, so it is stored
    // as the canonical instant regardless of how the caller spelled it.
    expect(operation?.leaseExpiresAt).toBe('2026-07-27T11:30:00.000Z');
    expect(renewal.kind === 'claimed' ? renewal.claim.leaseExpiresAt : null).toBe('2026-07-27T11:30:00.000Z');
  });

  // ───────────────────────────────────────────────────────────
  // Runtime registration and operation admission.
  //
  // Every case below is one of the races the port has to answer the same way
  // on both realizations: what happens when two callers reach the same durable
  // fact at once, and what a process that lost its own memory reads back.
  // ───────────────────────────────────────────────────────────

  it('never refuses a worker outcome that races an admission', async () => {
    const ids = nextIds();
    const runtimeGeneration = await readyAttempt(harness.repository, ids);
    const result = makeTestWorkflowResult(ids.executionId);

    const [admission, commit] = await Promise.all([
      harness.repository.admitOperation({
        ...ids,
        operationKind: 'workflow-run',
        admissionKey: 'run-against-outcome',
        runtimeGeneration,
      }),
      harness.repository.commitOutcome({ ...ids, result: harness.repository.canonicalizeOutcome(result) }),
    ]);

    // Admission never gates the canonical answer: whichever order the two
    // reach durable state in, the worker's outcome is accepted and the
    // admission is either in before the settlement or refused by it.
    expect(commit).toEqual({
      kind: 'accepted',
      outcome: result,
      text: harness.repository.canonicalizeOutcome(result).text,
    });
    expect(['admitted', 'resolved']).toContain(admission.kind);
  });

  it('advances the runtime generation once for two concurrent reports of one incarnation', async () => {
    const ids = nextIds();
    await allocateAttempt(harness.repository, ids);
    const report = { ...ids, runtimeIncarnationId: RUNTIME_INCARNATION_ID };

    const decisions = await Promise.all([
      harness.repository.registerRuntime(report),
      harness.repository.registerRuntime(report),
    ]);

    // The incarnation identifier is the registration idempotency key, so the
    // second report is a replay rather than a second endpoint.
    expect(decisions.map((decision) => decision.kind).sort()).toEqual(['duplicate', 'registered']);
    expect(decisions).toContainEqual({ kind: 'duplicate', runtimeGeneration: 1, runtimeReadyAt: null });
    expect(await harness.repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
      runtimeGeneration: 1,
      runtimeIncarnationId: RUNTIME_INCARNATION_ID,
      runtimeReadyAt: null,
    });
  });

  it('allocates one generation per incarnation when two race for the endpoint', async () => {
    const ids = nextIds();
    await allocateAttempt(harness.repository, ids);

    const decisions = await Promise.all([
      harness.repository.registerRuntime({ ...ids, runtimeIncarnationId: 'runtime-incarnation-a' }),
      harness.repository.registerRuntime({ ...ids, runtimeIncarnationId: 'runtime-incarnation-b' }),
    ]);

    // Two incarnations claiming one attempt is an anomaly the generation exists
    // for: each registration allocates its own, so the later one fences the
    // earlier one instead of sharing its fence.
    const generations = decisions.flatMap((decision) =>
      decision.kind === 'registered' ? [decision.runtimeGeneration] : [],
    );
    expect(generations.sort()).toEqual([1, 2]);
    // Exactly one incarnation owns the endpoint afterwards, with no readiness
    // inherited from the one it displaced.
    expect(await harness.repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
      runtimeGeneration: 2,
      runtimeReadyAt: null,
      activeOperationId: null,
    });
  });

  it('refuses a completion fenced against a superseded generation', async () => {
    const ids = nextIds();
    const first = await readyAttempt(harness.repository, ids);
    const probe = await admitTestOperation(harness.repository, ids, first, 'runtime-probe', 'probe-1');
    expect(
      await harness.repository.completeOperation({
        executionAttemptId: ids.executionAttemptId,
        operationId: probe,
        runtimeGeneration: first,
      }),
    ).toEqual({ kind: 'completed' });

    const second = await registerTestRuntime(harness.repository, ids, 'runtime-incarnation-2');
    await proveTestReadiness(harness.repository, ids, second);
    const running = await admitTestOperation(harness.repository, ids, second, 'workflow-run', 'run-1');

    // The superseded runtime answering for an operation it never owned changes
    // nothing: the fence is what tells the two incarnations apart.
    expect(
      await harness.repository.completeOperation({
        executionAttemptId: ids.executionAttemptId,
        operationId: running,
        runtimeGeneration: first,
      }),
    ).toEqual({ kind: 'stale-generation' });
    expect(await harness.repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
      activeOperationId: running,
      activeOperationGeneration: second,
      lastCompletedOperationId: probe,
    });
  });

  it('answers two concurrent admissions of one key with the operation it admitted once', async () => {
    const ids = nextIds();
    const runtimeGeneration = await readyAttempt(harness.repository, ids);
    const command = {
      ...ids,
      operationKind: 'workflow-run',
      admissionKey: 'run-key',
      runtimeGeneration,
    } as const;

    const decisions = await Promise.all([
      harness.repository.admitOperation(command),
      harness.repository.admitOperation(command),
    ]);

    expect(decisions.map((decision) => decision.kind).sort()).toEqual(['admitted', 'duplicate']);
    // The retry receives the identifier the first admission was given, which is
    // the only way a caller that lost the reply learns which operation it got.
    const operationIds = decisions.flatMap((decision) =>
      decision.kind === 'admitted' || decision.kind === 'duplicate' ? [decision.operationId] : [],
    );
    expect(operationIds).toHaveLength(2);
    expect(new Set(operationIds).size).toBe(1);
  });

  it('answers an admission on a settled attempt as resolved, over a closed gate', async () => {
    const ids = nextIds();
    const runtimeGeneration = await readyAttempt(harness.repository, ids);
    await harness.repository.commitOutcome({
      ...ids,
      result: harness.repository.canonicalizeOutcome(makeTestWorkflowResult(ids.executionId)),
    });

    expect(
      await harness.repository.admitOperation({
        ...ids,
        operationKind: 'workflow-run',
        admissionKey: 'after-settlement',
        runtimeGeneration,
      }),
    ).toEqual({ kind: 'resolved' });
    // The gate is closed underneath that answer; `resolved` wins because it
    // says why, and the gate only says that it happened.
    expect(await harness.repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
      operationStartGate: 'closed',
    });
  });

  it('refuses an admission while another operation occupies the attempt', async () => {
    const ids = nextIds();
    const runtimeGeneration = await readyAttempt(harness.repository, ids);
    const running = await admitTestOperation(harness.repository, ids, runtimeGeneration, 'workflow-run', 'run-1');

    expect(
      await harness.repository.admitOperation({
        ...ids,
        operationKind: 'workflow-run',
        admissionKey: 'run-2',
        runtimeGeneration,
      }),
    ).toEqual({ kind: 'operation-active', operationId: running });
  });

  it('refuses a completion for another operation and replays the matching one as duplicate', async () => {
    const ids = nextIds();
    const runtimeGeneration = await readyAttempt(harness.repository, ids);
    const running = await admitTestOperation(harness.repository, ids, runtimeGeneration, 'workflow-run', 'run-1');
    const complete = async (operationId: string): Promise<unknown> =>
      harness.repository.completeOperation({
        executionAttemptId: ids.executionAttemptId,
        operationId,
        runtimeGeneration,
      });

    expect(await complete('operation-nobody-admitted')).toEqual({ kind: 'mismatch', activeOperationId: running });
    expect(await complete(running)).toEqual({ kind: 'completed' });
    // The replay is answered from the last completion, because the active
    // operation it names is gone by then.
    expect(await complete(running)).toEqual({ kind: 'duplicate' });
    expect(await harness.repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
      activeOperationId: null,
      activeOperationKind: null,
      activeOperationKey: null,
      activeOperationGeneration: null,
      lastCompletedOperationId: running,
    });
  });

  it('closes the superseded attempt gate in the transaction that moves the pointer', async () => {
    const first = nextIds();
    const runtimeGeneration = await readyAttempt(harness.repository, first);
    const replacement = { executionId: first.executionId, executionAttemptId: `${first.executionAttemptId}-next` };

    await harness.repository.createAttempt({
      bootstrapTimeoutMs: 60_000,
      ...replacement,
      instruction: makeTestInstruction(),
    });

    expect(await harness.repository.getAttemptControlState(first.executionAttemptId)).toMatchObject({
      operationStartGate: 'closed',
    });
    // The new attempt opens its own gate rather than inheriting anything.
    expect(await harness.repository.getAttemptControlState(replacement.executionAttemptId)).toMatchObject({
      operationStartGate: 'open',
      runtimeGeneration: 0,
    });
    // The fence outranks the gate in the refusal order, so what the superseded
    // attempt reports is why it can never admit again, not merely that it
    // cannot.
    expect(
      await harness.repository.admitOperation({
        ...first,
        operationKind: 'workflow-run',
        admissionKey: 'after-supersession',
        runtimeGeneration,
      }),
    ).toEqual({ kind: 'fenced' });
  });

  it('closes the start gate of the pending attempt it abandons', async () => {
    const ids = nextIds();
    await harness.repository.createAttempt({ bootstrapTimeoutMs: 60_000, ...ids, instruction: makeTestInstruction() });

    expect(await harness.repository.abandonPendingAttempt(ids.executionAttemptId, ids.executionId)).toEqual({
      kind: 'abandoned',
    });
    // Abandonment is a terminal settlement and owes the same gate close every
    // other one does, however early it arrives: an attempt whose answer is
    // already fixed never starts work again.
    expect(await harness.repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
      operationStartGate: 'closed',
    });
  });

  it('reports the control state a process that lost its own memory recovers from', async () => {
    const ids = nextIds();
    const runtimeGeneration = await readyAttempt(harness.repository, ids);
    const running = await admitTestOperation(harness.repository, ids, runtimeGeneration, 'workflow-run', 'run-key');

    const control = await harness.repository.getAttemptControlState(ids.executionAttemptId);
    expect(control).toMatchObject({
      runtimeGeneration,
      runtimeIncarnationId: RUNTIME_INCARNATION_ID,
      operationStartGate: 'open',
      activeOperationId: running,
      activeOperationKind: 'workflow-run',
      activeOperationKey: 'run-key',
      activeOperationGeneration: runtimeGeneration,
      lastCompletedOperationId: null,
    });
    expect(control?.runtimeReadyAt).not.toBeNull();
    // Recovery re-presents the key it recorded rather than admitting again.
    expect(
      await harness.repository.admitOperation({
        ...ids,
        operationKind: 'workflow-run',
        admissionKey: 'run-key',
        runtimeGeneration,
      }),
    ).toEqual({
      kind: 'duplicate',
      operationId: running,
      runtimeGeneration,
      admittedAt: control?.activeOperationAdmittedAt,
    });
    expect(control?.activeOperationAdmittedAt).toEqual(expect.any(String));
  });

  it('refuses a registration while an operation occupies the attempt', async () => {
    const ids = nextIds();
    const runtimeGeneration = await readyAttempt(harness.repository, ids);
    const running = await admitTestOperation(harness.repository, ids, runtimeGeneration, 'workflow-run', 'run-1');

    // Advancing the generation here would fence the running operation's own
    // completion, so the operation in the way is reported instead.
    expect(await harness.repository.registerRuntime({ ...ids, runtimeIncarnationId: 'runtime-incarnation-2' })).toEqual(
      { kind: 'operation-active', operationId: running },
    );
  });

  it('replays registration and readiness during a workload, but fences a stale readiness report first', async () => {
    const ids = nextIds();
    const runtimeGeneration = await readyAttempt(harness.repository, ids);
    await admitTestOperation(harness.repository, ids, runtimeGeneration, 'workflow-run', 'replay-workload');
    const before = await harness.repository.getAttemptControlState(ids.executionAttemptId);

    expect(await harness.repository.registerRuntime({ ...ids, runtimeIncarnationId: RUNTIME_INCARNATION_ID })).toEqual({
      kind: 'duplicate',
      runtimeGeneration,
      runtimeReadyAt: before?.runtimeReadyAt,
    });
    expect(
      await harness.repository.markRuntimeReady({ ...ids, runtimeGeneration, readyAt: new Date().toISOString() }),
    ).toEqual({ kind: 'duplicate', acceptedAt: before?.runtimeReadyAt });
    expect(
      await harness.repository.markRuntimeReady({
        ...ids,
        runtimeGeneration: runtimeGeneration + 1,
        readyAt: new Date().toISOString(),
      }),
    ).toEqual({ kind: 'stale-generation' });
    expect(await harness.repository.getAttemptControlState(ids.executionAttemptId)).toEqual(before);
  });

  it('reports settlement before replaying the last completed operation', async () => {
    const ids = nextIds();
    const runtimeGeneration = await readyAttempt(harness.repository, ids);
    const operationId = await admitTestOperation(
      harness.repository,
      ids,
      runtimeGeneration,
      'workflow-run',
      'complete',
    );
    const completion = { executionAttemptId: ids.executionAttemptId, operationId, runtimeGeneration };
    expect(await harness.repository.completeOperation(completion)).toEqual({ kind: 'completed' });
    expect(await harness.repository.completeOperation(completion)).toEqual({ kind: 'duplicate' });
    const settlement = await harness.repository.commitOutcome({
      ...ids,
      result: harness.repository.canonicalizeOutcome(makeTestWorkflowResult(ids.executionId)),
    });
    expect(settlement.kind).toBe('accepted');
    expect(await harness.repository.completeOperation(completion)).toEqual({ kind: 'resolved' });
  });

  it('admits the bounded probe before readiness and refuses every other kind', async () => {
    const ids = nextIds();
    await allocateAttempt(harness.repository, ids);
    const runtimeGeneration = await registerTestRuntime(harness.repository, ids);

    expect(
      await harness.repository.admitOperation({
        ...ids,
        operationKind: 'workflow-run',
        admissionKey: 'run-before-readiness',
        runtimeGeneration,
      }),
    ).toEqual({ kind: 'not-ready' });
    // The probe is what proves readiness, so requiring readiness of it would
    // make readiness unreachable.
    const probe = await admitTestOperation(harness.repository, ids, runtimeGeneration, 'runtime-probe', 'probe-1');
    expect(await harness.repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
      activeOperationId: probe,
      activeOperationKind: 'runtime-probe',
      runtimeReadyAt: null,
    });
  });

  it('refuses readiness while an operation occupies the attempt', async () => {
    const ids = nextIds();
    await allocateAttempt(harness.repository, ids);
    const runtimeGeneration = await registerTestRuntime(harness.repository, ids);
    const probe = await admitTestOperation(harness.repository, ids, runtimeGeneration, 'runtime-probe', 'probe-1');

    expect(
      await harness.repository.markRuntimeReady({ ...ids, runtimeGeneration, readyAt: new Date().toISOString() }),
    ).toEqual({ kind: 'operation-active', operationId: probe });
  });

  it('refuses readiness for an attempt superseded after its probe completed', async () => {
    const ids = nextIds();
    await allocateAttempt(harness.repository, ids);
    const runtimeGeneration = await registerTestRuntime(harness.repository, ids);
    const probe = await admitTestOperation(harness.repository, ids, runtimeGeneration, 'runtime-probe', 'probe-1');
    expect(
      await harness.repository.completeOperation({
        executionAttemptId: ids.executionAttemptId,
        operationId: probe,
        runtimeGeneration,
      }),
    ).toEqual({ kind: 'completed' });

    // A newer attempt for the same execution moves the active pointer between
    // the probe's completion and the readiness write. The generation still
    // matches, so only the active-attempt fence can see the endpoint is gone.
    await allocateAttempt(harness.repository, {
      executionId: ids.executionId,
      executionAttemptId: `${ids.executionAttemptId}-successor`,
    });

    expect(
      await harness.repository.markRuntimeReady({ ...ids, runtimeGeneration, readyAt: new Date().toISOString() }),
    ).toEqual({ kind: 'fenced' });
    expect(await harness.repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
      runtimeGeneration,
      runtimeReadyAt: null,
      activeOperationId: null,
      operationStartGate: 'closed',
    });
  });

  it('clears readiness when a new incarnation takes the endpoint', async () => {
    const ids = nextIds();
    const first = await readyAttempt(harness.repository, ids);
    const second = await registerTestRuntime(harness.repository, ids, 'runtime-incarnation-2');

    expect(second).toBe(first + 1);
    // Readiness was proven by the incarnation this one replaces, and says
    // nothing about the new one.
    expect(await harness.repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
      runtimeGeneration: second,
      runtimeIncarnationId: 'runtime-incarnation-2',
      runtimeReadyAt: null,
    });

    await proveTestReadiness(harness.repository, ids, second);
    const running = await admitTestOperation(harness.repository, ids, second, 'workflow-run', 'run-1');
    // A third incarnation arriving mid-operation is refused, however ready the
    // attempt was a moment ago.
    expect(await harness.repository.registerRuntime({ ...ids, runtimeIncarnationId: 'runtime-incarnation-3' })).toEqual(
      { kind: 'operation-active', operationId: running },
    );
  });

  it('answers resolved for a settled attempt that still carries a leftover operation', async () => {
    const ids = nextIds();
    const runtimeGeneration = await readyAttempt(harness.repository, ids);
    const running = await admitTestOperation(harness.repository, ids, runtimeGeneration, 'workflow-run', 'run-1');

    const commit = await harness.repository.commitOutcome({
      ...ids,
      result: harness.repository.canonicalizeOutcome(makeTestWorkflowResult(ids.executionId)),
    });

    expect(commit.kind).toBe('accepted');
    // The settlement keeps the active operation on purpose: it is what lets a
    // late completion learn that nobody is waiting for it any more.
    expect(await harness.repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
      activeOperationId: running,
      operationStartGate: 'closed',
    });
    // The precedence that matters: `resolved` outranks `operation-active`, so
    // neither caller is told to wait for an operation nothing will complete.
    expect(await harness.repository.registerRuntime({ ...ids, runtimeIncarnationId: 'runtime-incarnation-2' })).toEqual(
      { kind: 'resolved' },
    );
    expect(
      await harness.repository.admitOperation({
        ...ids,
        operationKind: 'workflow-run',
        admissionKey: 'after-settlement',
        runtimeGeneration,
      }),
    ).toEqual({ kind: 'resolved' });
    expect(
      await harness.repository.completeOperation({
        executionAttemptId: ids.executionAttemptId,
        operationId: running,
        runtimeGeneration,
      }),
    ).toEqual({ kind: 'resolved' });
  });

  it('refuses registration and admission once the allocation is confirmed terminated, before settlement', async () => {
    const ids = nextIds();
    const claim = await allocateAttempt(harness.repository, ids);
    const runtimeGeneration = await registerTestRuntime(harness.repository, ids);
    await proveTestReadiness(harness.repository, ids, runtimeGeneration);

    // Termination is durable on the operation row before the attempt settles;
    // in that window the attempt still carries its allocation reference while
    // nothing can run on it any more.
    const termination = await harness.repository.recordAllocationTerminated({
      claim,
      evidence: makeEvidence({ summary: 'provider reported the allocation terminated' }),
    });
    expect(termination).toEqual({ kind: 'recorded' });
    expect(await harness.repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
      runtimeGeneration,
      operationStartGate: 'open',
    });

    expect(await harness.repository.registerRuntime({ ...ids, runtimeIncarnationId: 'runtime-incarnation-2' })).toEqual(
      { kind: 'not-allocated' },
    );
    expect(
      await harness.repository.admitOperation({
        ...ids,
        operationKind: 'workflow-run',
        admissionKey: 'after-termination',
        runtimeGeneration,
      }),
    ).toEqual({ kind: 'not-allocated' });
    // Nothing moved: the generation the dead allocation held is still the
    // current one, and no operation occupies the attempt.
    expect(await harness.repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
      runtimeGeneration,
      runtimeIncarnationId: RUNTIME_INCARNATION_ID,
      activeOperationId: null,
    });

    // Settlement then takes over with its own answer.
    const settlement = await harness.repository.recordInfrastructureFailure({ claim, executionId: ids.executionId });
    expect(settlement).toEqual({ kind: 'recorded' });
    expect(await harness.repository.registerRuntime({ ...ids, runtimeIncarnationId: 'runtime-incarnation-2' })).toEqual(
      { kind: 'resolved' },
    );
  });

  it('refuses readiness once the allocation is confirmed terminated, even after the probe completed', async () => {
    const ids = nextIds();
    const claim = await allocateAttempt(harness.repository, ids);
    const runtimeGeneration = await registerTestRuntime(harness.repository, ids);
    const probe = await admitTestOperation(harness.repository, ids, runtimeGeneration, 'runtime-probe', 'probe-1');

    // Termination lands while the probe is in flight. The probe still
    // completes — completion is claim-independent — but the readiness it
    // would prove belongs to an allocation nothing can run on any more.
    expect(
      await harness.repository.recordAllocationTerminated({
        claim,
        evidence: makeEvidence({ summary: 'provider reported the allocation terminated' }),
      }),
    ).toEqual({ kind: 'recorded' });
    expect(
      await harness.repository.completeOperation({
        executionAttemptId: ids.executionAttemptId,
        operationId: probe,
        runtimeGeneration,
      }),
    ).toEqual({ kind: 'completed' });

    expect(
      await harness.repository.markRuntimeReady({ ...ids, runtimeGeneration, readyAt: new Date().toISOString() }),
    ).toEqual({ kind: 'not-allocated' });
    expect(await harness.repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
      runtimeGeneration,
      runtimeReadyAt: null,
      activeOperationId: null,
    });
  });

  it('reclaims a probe orphaned by a dead handshake when a new incarnation registers', async () => {
    const ids = nextIds();
    await allocateAttempt(harness.repository, ids);
    const firstGeneration = await registerTestRuntime(harness.repository, ids);
    const orphan = await admitTestOperation(harness.repository, ids, firstGeneration, 'runtime-probe', 'probe-1');
    expect(await harness.repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
      activeOperationId: orphan,
      activeOperationKind: 'runtime-probe',
    });

    // The handshake that admitted the probe never completed it. The next
    // incarnation takes the endpoint anyway: the probe is the authority's own
    // operation, not workload, and the new generation clears it.
    const registration = await harness.repository.registerRuntime({
      ...ids,
      runtimeIncarnationId: 'runtime-incarnation-2',
    });
    expect(registration).toEqual({ kind: 'registered', runtimeGeneration: firstGeneration + 1 });
    expect(await harness.repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
      runtimeGeneration: firstGeneration + 1,
      runtimeIncarnationId: 'runtime-incarnation-2',
      runtimeReadyAt: null,
      activeOperationId: null,
      activeOperationKind: null,
      activeOperationKey: null,
      activeOperationGeneration: null,
    });

    // The dead handshake's own completion is now fenced out rather than
    // completing something the attempt no longer runs.
    expect(
      await harness.repository.completeOperation({
        executionAttemptId: ids.executionAttemptId,
        operationId: orphan,
        runtimeGeneration: firstGeneration,
      }),
    ).toEqual({ kind: 'not-active' });
  });

  it('does not reclaim a workload operation when a new incarnation registers', async () => {
    const ids = nextIds();
    const runtimeGeneration = await readyAttempt(harness.repository, ids);
    const running = await admitTestOperation(harness.repository, ids, runtimeGeneration, 'workflow-run', 'run-1');

    expect(await harness.repository.registerRuntime({ ...ids, runtimeIncarnationId: 'runtime-incarnation-2' })).toEqual(
      { kind: 'operation-active', operationId: running },
    );
    expect(await harness.repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
      runtimeGeneration,
      activeOperationId: running,
      activeOperationKind: 'workflow-run',
    });
  });
});

// ─────────────────────────────────────────────────────────────
// Outcome commitment, per realization and per owner outcome type
// ─────────────────────────────────────────────────────────────

/**
 * Assert the outcome decisions one realization owes for one outcome type.
 *
 * Defined as a function rather than a `describe.each` row so each outcome type
 * keeps its own `TOutcome` instead of collapsing into a union, and so the
 * cases that never touch an outcome are not re-run once per outcome type.
 * @param realization - Name of the realization under test.
 * @param createHarness - Factory that builds it around a codec.
 * @param outcomeName - Name of the outcome type under test.
 * @param variant - Codec and outcome builder for that type.
 * @typeParam TOutcome - Owner-specific outcome type committed per attempt.
 */
function defineOutcomeParity<TOutcome>(
  realization: string,
  createHarness: RealizationFactory,
  outcomeName: string,
  variant: OutcomeVariant<TOutcome>,
): void {
  describe(`execution attempt outcome parity (${realization}, ${outcomeName})`, () => {
    let harness: RealizationHarness<TOutcome>;

    beforeAll(async () => {
      harness = await createHarness(variant.codec);
    });

    afterAll(async () => {
      await harness.dispose();
    });

    it('commits an outcome, reports the stored one on replay, and conflicts on a different one', async () => {
      const ids = nextIds();
      await harness.repository.createAttempt({
        bootstrapTimeoutMs: 60_000,
        ...ids,
        instruction: makeTestInstruction(),
      });
      const result = variant.makeOutcome(ids.executionId, 0);

      const storedText = harness.repository.canonicalizeOutcome(result).text;
      const accepted = await harness.repository.commitOutcome({
        ...ids,
        result: harness.repository.canonicalizeOutcome(result),
      });

      expect(accepted).toEqual({ kind: 'accepted', outcome: result, text: storedText });
      // Presence, not truthiness, decides that an outcome is already
      // committed: the counter variant commits `0` here, and a realization
      // that probed the stored value for truthiness would answer `accepted` a
      // second time. The reported outcome is the stored one, which for a
      // durable realization means it came back through the codec rather than
      // straight out of the column.
      const replay = await harness.repository.commitOutcome({
        ...ids,
        result: harness.repository.canonicalizeOutcome(variant.makeOutcome(ids.executionId, 0)),
      });
      expect(replay).toEqual({ kind: 'duplicate', outcome: result, text: storedText });

      const competing = await harness.repository.commitOutcome({
        ...ids,
        result: harness.repository.canonicalizeOutcome(variant.makeOutcome(ids.executionId, 1)),
      });
      expect(competing).toEqual({ kind: 'conflict' });
    });
  });
}

for (const [realization, createHarness] of REALIZATIONS) {
  defineOutcomeParity(realization, createHarness, 'workflow run result', WORKFLOW_OUTCOME_VARIANT);
  defineOutcomeParity(realization, createHarness, 'counter', COUNTER_OUTCOME_VARIANT);
}

// ─────────────────────────────────────────────────────────────
// Normalizing codec
//
// Not a `defineOutcomeParity` variant, because that block's contract is that
// a committed outcome comes back as it was submitted. A codec is allowed to
// normalize while serializing, and this block states what the port owes then:
// the durable value decides, in every realization.
// ─────────────────────────────────────────────────────────────

describe.each(
  REALIZATIONS,
)('execution attempt outcome parity (%s, normalizing codec)', (_realization, createHarness) => {
  let harness: RealizationHarness<CounterOutcome>;

  beforeAll(async () => {
    harness = await createHarness(roundingCounterCodec);
  });

  afterAll(async () => {
    await harness.dispose();
  });

  it('commits, replays, and conflicts on the truncated counter the codec persists', async () => {
    const ids = nextIds();
    await harness.repository.createAttempt({ bootstrapTimeoutMs: 60_000, ...ids, instruction: makeTestInstruction() });

    // The column holds `1`, so `1` is what the attempt committed — a
    // realization reporting the submitted `1.2` would report an outcome no
    // reload ever yields, and the owner would converge on it.
    const accepted = await harness.repository.commitOutcome({
      ...ids,
      result: harness.repository.canonicalizeOutcome(1.2),
    });
    expect(accepted).toEqual({ kind: 'accepted', outcome: 1, text: '{"counter":1}' });

    // A different submission with the same durable form is the same answer
    // replayed, so it owes `duplicate` — comparing the submitted values would
    // make this a `conflict` and reject a worker's honest retry.
    const replay = await harness.repository.commitOutcome({
      ...ids,
      result: harness.repository.canonicalizeOutcome(1.7),
    });
    // The text is the *stored* one, which the retry's own rendering also
    // happens to equal here — the truncating codec renders `1.2` and `1.7`
    // alike.
    expect(replay).toEqual({ kind: 'duplicate', outcome: 1, text: '{"counter":1}' });

    // Normalization narrows what counts as the same outcome; it does not
    // dissolve the distinction. `2.5` persists as `2`, which is a second,
    // different answer for an attempt that already has one.
    const competing = await harness.repository.commitOutcome({
      ...ids,
      result: harness.repository.canonicalizeOutcome(2.5),
    });
    expect(competing).toEqual({ kind: 'conflict' });
  });
});

// ─────────────────────────────────────────────────────────────
// Codec whose serialization is not a fixed point
//
// A codec is required to be deterministic and to make
// `parse(JSON.parse(serialize(o)))` succeed — not to serialize the result
// back to the same text. This block pins the rule that survives that freedom:
// an attempt is compared against the text it stored, never against a fresh
// serialization of what that text decodes to.
// ─────────────────────────────────────────────────────────────

describe.each(
  REALIZATIONS,
)('execution attempt outcome parity (%s, non-idempotent serialization)', (_realization, createHarness) => {
  let harness: RealizationHarness<GenerationCounterOutcome>;

  beforeAll(async () => {
    harness = await createHarness(generationCounterCodec);
  });

  afterAll(async () => {
    await harness.dispose();
  });

  it('replays an identical submission as duplicate against the text it stored', async () => {
    const ids = nextIds();
    await harness.repository.createAttempt({ bootstrapTimeoutMs: 60_000, ...ids, instruction: makeTestInstruction() });
    const submitted: GenerationCounterOutcome = { counter: 0, generation: 0 };

    // The determinism the port leans on: rendering one outcome twice yields
    // one text, which is what lets a retry be compared against the text an
    // earlier commit stored.
    expect(generationCounterCodec.serialize(submitted)).toBe(generationCounterCodec.serialize(submitted));

    // One serialization decides both facts: the column holds generation `1`
    // and the attempt therefore committed generation `1`.
    const rendering = harness.repository.canonicalizeOutcome(submitted);
    expect(rendering).toEqual({ text: '{"counter":0,"generation":1}', outcome: { counter: 0, generation: 1 } });
    const accepted = await harness.repository.commitOutcome({ ...ids, result: rendering });
    expect(accepted).toEqual({
      kind: 'accepted',
      outcome: { counter: 0, generation: 1 },
      text: '{"counter":0,"generation":1}',
    });

    // The worker's honest retry. Its submission would write the same text
    // the first commit wrote, so it is the same answer replayed. A
    // realization that re-serialized the committed generation `1` would
    // compare generation `2` against generation `1` and reject the retry as a
    // conflicting outcome, stranding the waiter it owes a settlement.
    const replay = await harness.repository.commitOutcome({
      ...ids,
      result: harness.repository.canonicalizeOutcome({ counter: 0, generation: 0 }),
    });
    expect(replay).toEqual({
      kind: 'duplicate',
      outcome: { counter: 0, generation: 1 },
      text: '{"counter":0,"generation":1}',
    });

    // A genuinely different submission still conflicts: comparing stored
    // texts narrows nothing beyond what the codec itself collapses.
    const competing = await harness.repository.commitOutcome({
      ...ids,
      result: harness.repository.canonicalizeOutcome({ counter: 4, generation: 0 }),
    });
    expect(competing).toEqual({ kind: 'conflict' });
  });
});

// ─────────────────────────────────────────────────────────────
// Outcome type that cannot be structured-cloned
//
// The codec contract says what an outcome must survive: `serialize` and
// `parse`. It says nothing about `structuredClone`, so a realization that
// clones a submission on the way in rejects conforming owner outcomes.
// ─────────────────────────────────────────────────────────────

describe.each(
  REALIZATIONS,
)('execution attempt outcome parity (%s, non-cloneable outcome)', (_realization, createHarness) => {
  let harness: RealizationHarness<URL>;

  beforeAll(async () => {
    harness = await createHarness(urlOutcomeCodec);
  });

  afterAll(async () => {
    await harness.dispose();
  });

  it('commits and replays an outcome structuredClone would refuse', async () => {
    const ids = nextIds();
    await harness.repository.createAttempt({ bootstrapTimeoutMs: 60_000, ...ids, instruction: makeTestInstruction() });
    // Proof the type is outside `structuredClone`: the assertion below would
    // pass vacuously if a URL were cloneable after all.
    expect(() => structuredClone(new URL('https://outcome.test/a'))).toThrow();
    const submitted = new URL('https://outcome.test/a');

    const accepted = await harness.repository.commitOutcome({
      ...ids,
      result: harness.repository.canonicalizeOutcome(submitted),
    });

    expect(accepted.kind).toBe('accepted');
    const committed = accepted.kind === 'accepted' ? accepted.outcome : null;
    expect(committed?.href).toBe('https://outcome.test/a');
    // The identity witness: what the port reports came out of the codec, not
    // out of the caller's hand, so a submitter that mutates its own object
    // afterwards changes nothing the owner converges on.
    expect(committed).not.toBe(submitted);

    const replay = await harness.repository.commitOutcome({
      ...ids,
      result: harness.repository.canonicalizeOutcome(new URL('https://outcome.test/a')),
    });
    expect(replay.kind).toBe('duplicate');
    expect(replay.kind === 'duplicate' ? replay.outcome.href : null).toBe('https://outcome.test/a');

    const competing = await harness.repository.commitOutcome({
      ...ids,
      result: harness.repository.canonicalizeOutcome(new URL('https://outcome.test/b')),
    });
    expect(competing).toEqual({ kind: 'conflict' });
  });

  // A `URL` keeps its state in internal slots, so `Object.freeze` does not
  // make it immutable: assigning `pathname` still rewrites `href`. What keeps
  // a committed outcome stable is therefore not the freeze but the rule that
  // every read decodes the stored text again — a realization that handed out
  // one shared instance would report the mutation back to the next reader.
  it('reports a committed outcome no earlier reader can have mutated', async () => {
    const ids = nextIds();
    await harness.repository.createAttempt({ bootstrapTimeoutMs: 60_000, ...ids, instruction: makeTestInstruction() });

    const accepted = await harness.repository.commitOutcome({
      ...ids,
      result: harness.repository.canonicalizeOutcome(new URL('https://outcome.test/a')),
    });
    const first = accepted.kind === 'accepted' ? accepted.outcome : null;
    // Proof the outcome type is mutable through the freeze, so the assertion
    // below is not passing because the mutation silently failed.
    if (first !== null) first.pathname = '/mutated';
    expect(first?.href).toBe('https://outcome.test/mutated');

    const replay = await harness.repository.commitOutcome({
      ...ids,
      result: harness.repository.canonicalizeOutcome(new URL('https://outcome.test/a')),
    });

    expect(replay.kind).toBe('duplicate');
    const second = replay.kind === 'duplicate' ? replay.outcome : null;
    expect(second?.href).toBe('https://outcome.test/a');
    expect(second).not.toBe(first);
  });

  // The rendering's decoded value is what a caller validates before it
  // commits, and a mutable one it can change there. The `accepted` decision
  // must still report what the stored text yields — anything else hands the
  // owner a value no later read of the attempt ever produces.
  it('reports an accepted outcome decoded from the stored text, not the rendering the caller held', async () => {
    const ids = nextIds();
    await harness.repository.createAttempt({ bootstrapTimeoutMs: 60_000, ...ids, instruction: makeTestInstruction() });
    const rendering = harness.repository.canonicalizeOutcome(new URL('https://outcome.test/a'));
    // Exactly what a pre-commit validation is handed, mutated exactly where a
    // validator could mutate it. The assertion proves the mutation took, so
    // the ones below cannot pass vacuously.
    rendering.outcome.pathname = '/mutated';
    expect(rendering.outcome.href).toBe('https://outcome.test/mutated');
    expect(rendering.text).toBe('"https://outcome.test/a"');

    const accepted = await harness.repository.commitOutcome({ ...ids, result: rendering });

    expect(accepted.kind).toBe('accepted');
    expect(accepted.kind === 'accepted' ? accepted.outcome.href : null).toBe('https://outcome.test/a');
    // And the attempt holds the original, so the honest replay is a duplicate
    // rather than a conflict against a mutation nobody committed.
    const replay = await harness.repository.commitOutcome({
      ...ids,
      result: harness.repository.canonicalizeOutcome(new URL('https://outcome.test/a')),
    });
    expect(replay.kind).toBe('duplicate');
    expect(replay.kind === 'duplicate' ? replay.outcome.href : null).toBe('https://outcome.test/a');
  });

  // The read rule the port owes, and the one an owner boundary settles its
  // waiter from: the stored text is the only copy of an outcome no caller has
  // touched, and every decode of it is a value of its own.
  it('decodes a durable text into a fresh outcome on every call', async () => {
    const text = harness.repository.canonicalizeOutcome(new URL('https://outcome.test/a')).text;

    const decoded = harness.repository.decodeOutcome(text);

    expect(decoded.href).toBe('https://outcome.test/a');
    expect(decoded).not.toBe(harness.repository.decodeOutcome(text));
    // A text the codec refuses fails loudly rather than yielding an outcome.
    expect(() => harness.repository.decodeOutcome('5')).toThrow('UrlOutcome requires a URL or an absolute URL string');
  });
});

// ─────────────────────────────────────────────────────────────
// Outcome type that cannot be frozen
//
// The codec contract says what an outcome must survive: `serialize` and
// `parse`. It says nothing about `Object.freeze`, which throws outright for a
// non-empty typed array — so a realization that freezes what a codec produced
// rejects conforming owner outcomes before any durable decision.
// ─────────────────────────────────────────────────────────────

describe.each(
  REALIZATIONS,
)('execution attempt outcome parity (%s, unfreezable outcome)', (_realization, createHarness) => {
  let harness: RealizationHarness<Uint8Array>;

  beforeAll(async () => {
    harness = await createHarness(bytesOutcomeCodec);
  });

  afterAll(async () => {
    await harness.dispose();
  });

  it('commits and replays an outcome Object.freeze would refuse', async () => {
    const ids = nextIds();
    await harness.repository.createAttempt({ bootstrapTimeoutMs: 60_000, ...ids, instruction: makeTestInstruction() });
    // Proof the type is outside `Object.freeze`: the assertions below would
    // pass vacuously if a populated typed array were freezable after all.
    expect(() => Object.freeze(Uint8Array.from([1, 2, 3]))).toThrow();
    const submitted = Uint8Array.from([1, 2, 3]);

    const rendering = harness.repository.canonicalizeOutcome(submitted);

    expect(rendering.text).toBe('[1,2,3]');
    const accepted = await harness.repository.commitOutcome({ ...ids, result: rendering });
    expect(accepted.kind).toBe('accepted');
    const committed = accepted.kind === 'accepted' ? accepted.outcome : null;
    expect(committed).toEqual(Uint8Array.from([1, 2, 3]));
    // The identity witness: what the port reports came out of the codec, not
    // out of the caller's hand.
    expect(committed).not.toBe(submitted);

    const replay = await harness.repository.commitOutcome({
      ...ids,
      result: harness.repository.canonicalizeOutcome(Uint8Array.from([1, 2, 3])),
    });
    expect(replay.kind).toBe('duplicate');
    expect(replay.kind === 'duplicate' ? replay.outcome : null).toEqual(Uint8Array.from([1, 2, 3]));

    const competing = await harness.repository.commitOutcome({
      ...ids,
      result: harness.repository.canonicalizeOutcome(Uint8Array.from([4])),
    });
    expect(competing).toEqual({ kind: 'conflict' });
  });
});

// ─────────────────────────────────────────────────────────────
// Stored outcome text the codec rejects
//
// Only reachable by writing the column behind the port's back, which is what
// durable corruption — or a codec changed under an existing row — looks like
// on read. The port owes the same answer in every realization: fail loudly,
// rather than report broken durable state as an ordinary caller conflict.
// ─────────────────────────────────────────────────────────────

describe.each(
  REALIZATIONS,
)('execution attempt outcome parity (%s, invalid stored outcome)', (_realization, createHarness) => {
  let harness: RealizationHarness<CounterOutcome>;

  beforeAll(async () => {
    harness = await createHarness(counterCodec);
  });

  afterAll(async () => {
    await harness.dispose();
  });

  it('throws instead of reporting conflict when the stored outcome does not parse', async () => {
    const ids = nextIds();
    await harness.repository.createAttempt({ bootstrapTimeoutMs: 60_000, ...ids, instruction: makeTestInstruction() });
    // Valid JSON the codec refuses, so the failure is the codec's and not
    // `JSON.parse` choking on a truncated write.
    await harness.writeStoredOutcomeText(ids.executionAttemptId, '"not-a-number"');

    // A submission that differs from the stored text: the branch that used to
    // answer `conflict` without ever consulting the codec.
    await expect(
      harness.repository.commitOutcome({ ...ids, result: harness.repository.canonicalizeOutcome(5) }),
    ).rejects.toThrow('CounterOutcome requires a numeric counter');
  });
});

describe('in-memory execution attempt seed contract', () => {
  it('admits and accepts Preparation when optional settlementKind is omitted', async () => {
    const ids = nextIds();
    const attempt: ExecutionAttemptRecord = {
      ...INITIAL_ATTEMPT_CONTROL_STATE,
      ...ids,
      instruction: makeTestInstruction({
        workspace: { provisioning: 'create', custody: 'disposable', sourceRoots: [], setup: [] },
      }),
      preparationReceipts: [],
      status: 'allocated',
      allocationRef: makeTestAllocationRef(),
      createdAt: new Date().toISOString(),
      bootstrapDeadlineAt: null,
      providerId: TEST_PROVIDER_ID,
      allocationLifetime: 'provider-managed',
      provisionerIncarnationId: TEST_PROVISIONER_INCARNATION_ID,
    };
    const repository = createInMemoryAttemptRepository(workflowRunResultOutcomeCodec, {
      attempts: new Map([[ids.executionAttemptId, attempt]]),
      activeAttempts: new Map([[ids.executionId, ids.executionAttemptId]]),
    });
    const runtimeGeneration = await registerTestRuntime(repository, ids);
    await proveTestReadiness(repository, ids, runtimeGeneration);
    const operationId = await admitTestOperation(
      repository,
      ids,
      runtimeGeneration,
      'workspace-preparation',
      'prepare',
    );
    const report: ReportOperationInput = {
      ...ids,
      operationId,
      runtimeGeneration,
      result: { kind: 'workspace-prepared', binding: { workspaceRoot: '/scratch/seeded', sourceRoots: [] } },
    };

    expect(repository.attempts.get(ids.executionAttemptId)).not.toHaveProperty('settlementKind');
    expect(await repository.reportOperation(report)).toEqual({ kind: 'accepted', binding: report.result.binding });
    expect(repository.attempts.get(ids.executionAttemptId)?.preparationReceipts).toEqual([
      { operationId, runtimeGeneration, result: report.result },
    ]);
  });

  it('still rejects an unreported Preparation result after outcome settlement', async () => {
    const repository = createInMemoryAttemptRepository(workflowRunResultOutcomeCodec);
    const report = await preparationAttempt(repository);
    await repository.commitOutcome({
      ...report,
      result: repository.canonicalizeOutcome(makeTestWorkflowResult(report.executionId, 'failed')),
    });

    expect(repository.attempts.get(report.executionAttemptId)?.settlementKind).toBe('outcome');
    expect(await repository.reportOperation(report)).toEqual({ kind: 'resolved' });
    expect(repository.attempts.get(report.executionAttemptId)?.preparationReceipts).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// Inconsistent durable state
//
// These states are only reachable by writing them directly, which the
// in-memory realization allows and a durable one does not. They pin down what
// the port owes when it meets them.
// ─────────────────────────────────────────────────────────────

describe('execution attempt port parity (inconsistent durable state)', () => {
  it('fences an outcome whose active attempt has no record behind it', async () => {
    const repository = createInMemoryAttemptRepository(workflowRunResultOutcomeCodec);
    repository.activeAttempts.set('ghost-exec', 'ghost-attempt');

    const decision = await repository.commitOutcome({
      executionId: 'ghost-exec',
      executionAttemptId: 'ghost-attempt',
      result: repository.canonicalizeOutcome(makeTestWorkflowResult('ghost-exec')),
    });

    // An accepted outcome obliges the caller to converge workflow state, so
    // it must never be the answer when no attempt exists to converge.
    expect(decision).toEqual({ kind: 'fenced' });
    expect(repository.committedOutcomes.size).toBe(0);
  });

  it('breaks a creation-instant tie by attempt identifier', async () => {
    const repository = createInMemoryAttemptRepository(workflowRunResultOutcomeCodec);
    // Two attempts created within one millisecond is reachable durably but not
    // reproducible through the port, so the tie is written directly here.
    const createdAt = new Date().toISOString();
    for (const executionAttemptId of ['tie-b', 'tie-a']) {
      repository.attempts.set(executionAttemptId, {
        ...INITIAL_ATTEMPT_CONTROL_STATE,
        executionAttemptId,
        executionId: 'tie-exec',
        instruction: makeTestInstruction(),
        preparationReceipts: [],
        status: 'allocated',
        allocationRef: makeTestAllocationRef(),
        createdAt,
        bootstrapDeadlineAt: null,
        providerId: TEST_PROVIDER_ID,
        allocationLifetime: 'provider-managed',
        provisionerIncarnationId: TEST_PROVISIONER_INCARNATION_ID,
        settlementKind: null,
        claimable: true,
        claimExpiresAt: null,
      });
    }

    const recoverable = await repository.recovery.getRecoverableAttempts('tie-exec');

    expect(recoverable.map((attempt) => attempt.executionAttemptId)).toEqual(['tie-a', 'tie-b']);
  });

  it('fails recovery on a selected attempt whose provider binding is incomplete', async () => {
    const repository = createInMemoryAttemptRepository(workflowRunResultOutcomeCodec);
    const inconsistent: ExecutionAttemptRecord = {
      ...INITIAL_ATTEMPT_CONTROL_STATE,
      executionAttemptId: 'partial-attempt',
      executionId: 'partial-exec',
      instruction: makeTestInstruction(),
      preparationReceipts: [],
      status: 'allocated',
      allocationRef: makeTestAllocationRef(),
      createdAt: new Date().toISOString(),
      bootstrapDeadlineAt: null,
      providerId: null,
      allocationLifetime: null,
      provisionerIncarnationId: null,
      settlementKind: null,
      claimable: true,
      claimExpiresAt: null,
    };
    repository.attempts.set(inconsistent.executionAttemptId, inconsistent);

    // Dropping the row would hide an allocated attempt from recovery, and
    // nobody would ever reclaim the infrastructure it still owns.
    await expect(repository.recovery.getRecoverableAttempts('partial-exec')).rejects.toThrow(
      'selected as recoverable but is not',
    );
  });
});
