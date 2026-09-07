import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestInstruction } from '../testing/attempt-fixtures.js';
import { sql, StringChunk, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { createDatabaseClient } from '@makaio/storage-drizzle/client';
import {
  brandDatabase,
  getRawSqlExecutor,
  type MakaioDatabase,
  type RawSqlExecutor,
  type RawSqlSession,
} from '@makaio/storage-drizzle';
import { createTempDb, type TestDbContext } from '@makaio/test-utils/drizzle-harness';
import type { WorkflowRunResult, ExecutionAttemptPreparationResult } from '@makaio/contracts';
import type { ExecutionAttemptRepository, ProviderOperationClaim } from '../index.js';
import { createSqliteAttemptRepository } from '../testing/sqlite.js';
import {
  TEST_OWNER_ID,
  TEST_PROVIDER_ID,
  TEST_PROVISIONER_INCARNATION_ID,
  leaseAt,
  makeBeginProvisioningInput,
  makeEvidence,
  makeProcessLossProof,
  makeTestAllocationRef,
  makeTestWorkflowResult,
  workflowRunResultOutcomeCodec,
} from '../testing/index.js';
import type { BeginProvisioningInput } from '../execution-attempt-repository.js';

/**
 * Two controllers over one database.
 *
 * `alpha` and `beta` are independent repository instances over independent
 * connections to the same file. Their transaction control is serialized by
 * database identity, while their state agreement still comes from durable rows.
 */
interface ContractHarness {
  readonly alpha: Required<ExecutionAttemptRepository<WorkflowRunResult>>;
  readonly beta: Required<ExecutionAttemptRepository<WorkflowRunResult>>;
  /** Primary handle, used to read raw rows the port deliberately does not expose. */
  readonly db: MakaioDatabase;
}

/** A raw `test_provider_operation` row, read outside the port. */
interface RawOperationRow extends Record<string, unknown> {
  readonly generation: number;
  readonly owner_id: string | null;
  readonly token: string | null;
  readonly lease_expires_at: string | null;
  readonly obligation: string;
  readonly failure_count: number;
  readonly last_failure: string | null;
}

/** A raw `test_execution_attempt` row, read outside the port. */
interface RawAttemptRow extends Record<string, unknown> {
  readonly execution_attempt_id: string;
  readonly instruction: string;
  readonly preparation_receipts: string;
  readonly claimable: number;
  readonly claim_expires_at: string | null;
  readonly settlement_kind: string | null;
  readonly workflow_result: string | null;
  readonly allocation_ref: string | null;
  readonly provider_id: string | null;
  readonly allocation_lifetime: string | null;
  readonly provisioner_incarnation_id: string | null;
  readonly runtime_generation: number;
  readonly runtime_incarnation_id: string | null;
  readonly runtime_ready_at: string | null;
  readonly operation_start_gate: string;
  readonly active_operation_id: string | null;
  readonly active_operation_kind: string | null;
  readonly active_operation_key: string | null;
  readonly active_operation_generation: number | null;
  readonly last_completed_operation_id: string | null;
}

let context: TestDbContext | undefined;
let secondaryClose: (() => void | Promise<void>) | undefined;
let harness: ContractHarness;
let sequence = 0;

/**
 * Allocate a fresh execution and attempt identifier pair.
 *
 * The suite shares one database across its tests on purpose: identifiers that
 * never repeat are what makes the shared tables order-independent rather than
 * a hidden dependency between cases.
 * @returns Unique execution and attempt identifiers.
 */
function nextIds(): { readonly executionId: string; readonly executionAttemptId: string } {
  sequence += 1;
  return { executionId: `exec-${sequence}`, executionAttemptId: `attempt-${sequence}` };
}

/**
 * Read the raw provider-operation row for an attempt.
 * @param executionAttemptId - Attempt whose operation row to read.
 * @returns The stored row.
 * @throws When no operation row exists.
 */
async function readRawOperation(executionAttemptId: string): Promise<RawOperationRow> {
  const rows = await getRawSqlExecutor(harness.db).all<RawOperationRow>(
    sql`SELECT * FROM test_provider_operation WHERE execution_attempt_id = ${executionAttemptId}`,
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`No provider operation stored for '${executionAttemptId}'`);
  return row;
}

/**
 * Read the raw attempt row for an attempt.
 * @param executionAttemptId - Attempt whose row to read.
 * @returns The stored row.
 * @throws When no attempt row exists.
 */
async function readRawAttempt(executionAttemptId: string): Promise<RawAttemptRow> {
  const rows = await getRawSqlExecutor(harness.db).all<RawAttemptRow>(
    sql`SELECT * FROM test_execution_attempt WHERE execution_attempt_id = ${executionAttemptId}`,
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`No attempt stored for '${executionAttemptId}'`);
  return row;
}

/**
 * Read which attempt the durable pointer currently names for an execution.
 * @param executionId - Execution whose pointer to read.
 * @returns The active attempt identifier, or `null` when none is set.
 */
async function readActivePointer(executionId: string): Promise<string | null> {
  const rows = await getRawSqlExecutor(harness.db).all<{ execution_attempt_id: string }>(
    sql`SELECT execution_attempt_id FROM test_active_execution_attempt WHERE execution_id = ${executionId}`,
  );
  return rows[0]?.execution_attempt_id ?? null;
}

/**
 * Create an attempt and win its provisioning claim through one controller.
 * @param repository - Controller that should hold the claim.
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
  const decision = await repository.beginProvisioning(
    makeBeginProvisioningInput(ids.executionAttemptId, ids.executionId, overrides),
  );
  if (decision.kind !== 'started') throw new Error(`Expected provisioning to start, got '${decision.kind}'`);
  return decision.claim;
}

/**
 * Create an attempt, win its claim through one controller, and allocate it.
 * @param repository - Controller that should hold the claim.
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
 * Bring an attempt to a proven runtime endpoint through one controller.
 * @param repository - Controller driving the handshake.
 * @param ids - Execution and attempt identifiers to use.
 * @returns The generation the proven runtime holds.
 * @throws When any step of the handshake is refused.
 */
async function readyAttempt(
  repository: Required<ExecutionAttemptRepository<WorkflowRunResult>>,
  ids: { readonly executionId: string; readonly executionAttemptId: string },
): Promise<number> {
  await allocateAttempt(repository, ids);
  const registration = await repository.registerRuntime({ ...ids, runtimeIncarnationId: 'runtime-incarnation-1' });
  if (registration.kind !== 'registered') {
    throw new Error(`Expected the runtime to register, got '${registration.kind}'`);
  }
  const readiness = await repository.markRuntimeReady({
    ...ids,
    runtimeGeneration: registration.runtimeGeneration,
    readyAt: new Date().toISOString(),
  });
  if (readiness.kind !== 'ready') throw new Error(`Expected readiness to be accepted, got '${readiness.kind}'`);
  return registration.runtimeGeneration;
}

describe('execution attempt repository contract (transactional SQLite)', () => {
  beforeAll(async () => {
    context = await createTempDb('execution-attempt-contract');
    const secondary = await createDatabaseClient({ url: `file:${context.dbPath}` });
    secondaryClose = secondary.close;
    harness = {
      alpha: await createSqliteAttemptRepository(context.db, workflowRunResultOutcomeCodec),
      beta: await createSqliteAttemptRepository(secondary.db, workflowRunResultOutcomeCodec),
      db: context.db,
    };
  });

  afterAll(async () => {
    await secondaryClose?.();
    // `cleanup` closes the primary connection and removes the database
    // together with the write-ahead log files WAL mode leaves beside it.
    context?.cleanup();
  });

  it('retains the creation-time deadline across allocation and a reopened connection', async () => {
    const ids = nextIds();
    const record = await harness.alpha.createAttempt({
      ...ids,
      instruction: makeTestInstruction(),
      bootstrapTimeoutMs: 7_321,
    });
    const provisioning = await harness.alpha.beginProvisioning(
      makeBeginProvisioningInput(ids.executionAttemptId, ids.executionId),
    );
    if (provisioning.kind !== 'started') throw new Error('Expected provisioning');
    await harness.alpha.recordAllocation({ claim: provisioning.claim, allocationRef: makeTestAllocationRef() });
    if (!context) throw new Error('Missing database context');
    const reopened = await createDatabaseClient({ url: `file:${context.dbPath}` });
    try {
      const repository = await createSqliteAttemptRepository(reopened.db, workflowRunResultOutcomeCodec);
      expect(await repository.readBootstrapStartState(ids)).toMatchObject({
        allocated: true,
        bootstrapDeadlineAt: record.bootstrapDeadlineAt,
      });
      expect(await repository.getActiveAttempt(ids.executionId, ids.executionAttemptId)).toMatchObject({
        createdAt: record.createdAt,
        bootstrapDeadlineAt: record.bootstrapDeadlineAt,
      });
      expect(
        (await repository.recovery.getRecoverableAttempts(ids.executionId)).find(
          (attempt) => attempt.executionAttemptId === ids.executionAttemptId,
        ),
      ).toMatchObject({ bootstrapDeadlineAt: record.bootstrapDeadlineAt });
    } finally {
      await reopened.close();
    }
  });

  it('reads bootstrap facts without decoding instruction, Preparation receipts or allocation payload', async () => {
    const ids = nextIds();
    await allocateAttempt(harness.alpha, ids);
    const original = await readRawAttempt(ids.executionAttemptId);
    await getRawSqlExecutor(harness.db).run(sql`UPDATE test_execution_attempt
      SET instruction = ${'invalid json'}, preparation_receipts = ${'invalid json'}, allocation_ref = ${'invalid json'}
      WHERE execution_attempt_id = ${ids.executionAttemptId}`);
    try {
      expect(await harness.beta.readBootstrapStartState(ids)).toMatchObject({
        active: true,
        allocated: true,
        settled: false,
      });
      expect(await harness.beta.readBootstrapStartState({ ...ids, executionId: 'foreign-owner' })).toBeNull();
    } finally {
      await getRawSqlExecutor(harness.db).run(sql`UPDATE test_execution_attempt
        SET instruction = ${original.instruction}, preparation_receipts = ${original.preparation_receipts}, allocation_ref = ${original.allocation_ref}
        WHERE execution_attempt_id = ${ids.executionAttemptId}`);
    }
  });

  it('opens a reference schema without the deadline column without resetting its existing attempts', async () => {
    const legacy = await createTempDb('bootstrap-legacy-schema');
    try {
      const repository = await createSqliteAttemptRepository(legacy.db, workflowRunResultOutcomeCodec);
      const pending = nextIds();
      const allocated = nextIds();
      const settled = nextIds();
      await repository.createAttempt({ ...pending, instruction: makeTestInstruction(), bootstrapTimeoutMs: 60_000 });
      await allocateAttempt(repository, allocated);
      await allocateAttempt(repository, settled);
      await repository.commitOutcome({
        ...settled,
        result: repository.canonicalizeOutcome(makeTestWorkflowResult(settled.executionId, 'completed')),
      });
      // Simulate the previous reference schema while preserving every other column and row.
      await legacy.exec(sql.raw('ALTER TABLE test_execution_attempt DROP COLUMN bootstrap_deadline_at'));
      const reopened = await createSqliteAttemptRepository(legacy.db, workflowRunResultOutcomeCodec);
      for (const [ids, status] of [
        [pending, 'pending'],
        [allocated, 'allocated'],
        [settled, 'settled'],
      ] as const) {
        expect(await reopened.getActiveAttempt(ids.executionId, ids.executionAttemptId)).toMatchObject({
          status,
          bootstrapDeadlineAt: null,
        });
        expect(await reopened.readBootstrapStartState(ids)).toMatchObject({
          bootstrapDeadlineAt: null,
          settled: status === 'settled',
        });
        expect(await reopened.getInstruction(ids)).toEqual(makeTestInstruction());
      }
      expect(await reopened.recovery.getRecoverableAttempts(allocated.executionId)).toEqual([
        expect.objectContaining({ ...allocated, bootstrapDeadlineAt: null }),
      ]);
    } finally {
      legacy.cleanup();
    }
  });

  // ───────────────────────────────────────────────────────────
  // Invariant 1 and 2: `started` is the sole authorization,
  // and exactly one controller can ever obtain it.
  // ───────────────────────────────────────────────────────────

  it('accepts Preparation once across connections and exposes receipt plus free slot together', async () => {
    const ids = nextIds();
    const instruction = makeTestInstruction({
      workspace: {
        provisioning: 'create',
        custody: 'disposable',
        sourceRoots: [],
        setup: [],
      },
    });
    await harness.alpha.createAttempt({ bootstrapTimeoutMs: 60_000, ...ids, instruction });
    expect(await harness.beta.getInstruction(ids)).toEqual(instruction);
    const provisioning = await harness.alpha.beginProvisioning(
      makeBeginProvisioningInput(ids.executionAttemptId, ids.executionId),
    );
    if (provisioning.kind !== 'started') throw new Error('Expected provisioning');
    await harness.alpha.recordAllocation({ claim: provisioning.claim, allocationRef: makeTestAllocationRef() });
    const runtime = await harness.alpha.registerRuntime({ ...ids, runtimeIncarnationId: 'preparation-runtime' });
    if (runtime.kind !== 'registered') throw new Error('Expected registration');
    const runtimeGeneration = runtime.runtimeGeneration;
    await harness.alpha.markRuntimeReady({ ...ids, runtimeGeneration, readyAt: new Date().toISOString() });
    expect(
      await harness.beta.admitOperation({
        ...ids,
        runtimeGeneration,
        operationKind: 'workload-invocation',
        admissionKey: 'early-invocation',
      }),
    ).toEqual({ kind: 'preparation-required' });
    const operation = await harness.alpha.admitOperation({
      ...ids,
      runtimeGeneration,
      operationKind: 'workspace-preparation',
      admissionKey: 'prepare',
    });
    if (operation.kind !== 'admitted') throw new Error('Expected Preparation admission');
    const result: ExecutionAttemptPreparationResult = {
      kind: 'workspace-prepared',
      binding: { workspaceRoot: '/scratch/durable', sourceRoots: [] },
    };
    const report = { ...ids, runtimeGeneration, operationId: operation.operationId, result };
    const decisions = await Promise.all([harness.alpha.reportOperation(report), harness.beta.reportOperation(report)]);
    expect(decisions.map((decision) => decision.kind).sort()).toEqual(['accepted', 'duplicate']);
    const row = await readRawAttempt(ids.executionAttemptId);
    expect(JSON.parse(row.preparation_receipts)).toEqual([
      { operationId: report.operationId, runtimeGeneration, result },
    ]);
    expect(row.active_operation_id).toBeNull();
    expect(row.last_completed_operation_id).toBe(report.operationId);
    expect(
      await harness.beta.admitOperation({
        ...ids,
        runtimeGeneration,
        operationKind: 'workload-invocation',
        admissionKey: 'invoke',
      }),
    ).toMatchObject({ kind: 'admitted' });
    expect(await harness.alpha.reportOperation(report)).toEqual({ kind: 'duplicate', binding: result.binding });
    expect(
      await harness.beta.reportOperation({
        ...report,
        result: { ...result, binding: { workspaceRoot: '/wrong', sourceRoots: [] } },
      }),
    ).toEqual({ kind: 'conflict' });
  });

  it('grants the provisioning claim to exactly one racing controller', async () => {
    const ids = nextIds();
    await harness.alpha.createAttempt({ bootstrapTimeoutMs: 60_000, ...ids, instruction: makeTestInstruction() });
    const input = makeBeginProvisioningInput(ids.executionAttemptId, ids.executionId);

    const decisions = await Promise.all([
      harness.alpha.beginProvisioning(input),
      harness.beta.beginProvisioning(input),
    ]);

    expect(decisions.map((decision) => decision.kind).sort()).toEqual(['already-provisioning', 'started']);
    // Durable state, not a local variable, is what refuses the second begin.
    const operation = await readRawOperation(ids.executionAttemptId);
    expect(operation.generation).toBe(1);
    expect(operation.obligation).toBe('provisioning-resolution');
  });

  it('invokes the provider at most once per attempt across both controllers', async () => {
    const ids = nextIds();
    await harness.alpha.createAttempt({ bootstrapTimeoutMs: 60_000, ...ids, instruction: makeTestInstruction() });
    const input = makeBeginProvisioningInput(ids.executionAttemptId, ids.executionId);
    let provisionCalls = 0;

    /**
     * Call the provider only when the durable decision authorizes it.
     * @param repository - Controller attempting the provider call.
     * @returns Whether this controller was authorized to call the provider.
     */
    const dispatch = async (repository: Required<ExecutionAttemptRepository<WorkflowRunResult>>): Promise<boolean> => {
      const decision = await repository.beginProvisioning(input);
      if (decision.kind !== 'started') return false;
      provisionCalls += 1;
      return true;
    };

    const authorized = await Promise.all([dispatch(harness.alpha), dispatch(harness.beta)]);
    // Every later begin, from either controller, is refused for good.
    const replays = [await dispatch(harness.alpha), await dispatch(harness.beta), await dispatch(harness.alpha)];

    expect(authorized.filter(Boolean)).toHaveLength(1);
    expect(replays).toEqual([false, false, false]);
    expect(provisionCalls).toBe(1);
  });

  it('fences a superseded allocated attempt without changing its claim expiry', async () => {
    const first = nextIds();
    const claim = await startAttempt(harness.alpha, first);
    await harness.alpha.recordAllocation({ claim, allocationRef: makeTestAllocationRef() });
    const claimExpiresAt = leaseAt(300_000);
    await getRawSqlExecutor(harness.db).run(
      sql`UPDATE test_execution_attempt
          SET claim_expires_at = ${claimExpiresAt}
          WHERE execution_attempt_id = ${first.executionAttemptId}`,
    );

    const replacement = { executionId: first.executionId, executionAttemptId: `${first.executionAttemptId}-next` };
    await harness.beta.createAttempt({
      bootstrapTimeoutMs: 60_000,
      ...replacement,
      instruction: makeTestInstruction(),
    });

    expect(await readActivePointer(first.executionId)).toBe(replacement.executionAttemptId);
    expect(await harness.alpha.recovery.getAttemptWithAllocation(first.executionAttemptId)).toMatchObject({
      status: 'allocated',
      claimable: false,
      claimExpiresAt,
    });
    expect(await harness.beta.recovery.getAttemptWithAllocation(replacement.executionAttemptId)).toMatchObject({
      status: 'pending',
      claimable: false,
      claimExpiresAt: null,
    });
  });

  // ───────────────────────────────────────────────────────────
  // Invariant 3: the provider binding is immutable.
  // ───────────────────────────────────────────────────────────

  it('binds provider, lifetime, and provisioner incarnation immutably', async () => {
    const ids = nextIds();
    await startAttempt(harness.alpha, ids);

    const rebind = await harness.beta.beginProvisioning(
      makeBeginProvisioningInput(ids.executionAttemptId, ids.executionId, {
        providerId: 'a-different-provider',
        allocationLifetime: 'provisioner-process-bound',
        provisionerIncarnationId: 'a-different-incarnation',
      }),
    );

    expect(rebind.kind).toBe('already-provisioning');
    const stored = await readRawAttempt(ids.executionAttemptId);
    expect(stored.provider_id).toBe(TEST_PROVIDER_ID);
    expect(stored.allocation_lifetime).toBe('provider-managed');
    expect(stored.provisioner_incarnation_id).toBe(TEST_PROVISIONER_INCARNATION_ID);
  });

  // ───────────────────────────────────────────────────────────
  // Claim lifecycle: renewal, takeover, handoff, stale rejection.
  // ───────────────────────────────────────────────────────────

  it('renews a lease without fencing the holder', async () => {
    const ids = nextIds();
    const claim = await startAttempt(harness.alpha, ids);
    const extended = leaseAt(120_000);

    const renewal = await harness.beta.renewProviderOperationClaim({ claim, leaseExpiresAt: extended });

    expect(renewal.kind).toBe('claimed');
    if (renewal.kind !== 'claimed') return;
    expect(renewal.claim.generation).toBe(claim.generation);
    expect(renewal.claim.token).toBe(claim.token);
    // The renewed claim still authorizes a write from the original holder.
    const stored = await readRawOperation(ids.executionAttemptId);
    expect(stored.lease_expires_at).toBe(new Date(extended).toISOString());
    expect(
      await harness.alpha.recordProviderOperationUncertainty({ claim: renewal.claim, evidence: makeEvidence() }),
    ).toEqual({ kind: 'recorded' });
  });

  it('refuses takeover while the lease is held and grants it once expired', async () => {
    const ids = nextIds();
    const claim = await startAttempt(harness.alpha, ids);

    const early = await harness.beta.takeOverProviderOperation({
      executionAttemptId: ids.executionAttemptId,
      ownerId: 'controller-incarnation-2',
      observedAt: leaseAt(0),
      leaseExpiresAt: leaseAt(60_000),
    });
    const late = await harness.beta.takeOverProviderOperation({
      executionAttemptId: ids.executionAttemptId,
      ownerId: 'controller-incarnation-2',
      observedAt: leaseAt(120_000),
      leaseExpiresAt: leaseAt(180_000),
    });

    expect(early.kind).toBe('stale');
    expect(late.kind).toBe('claimed');
    if (late.kind !== 'claimed') return;
    expect(late.claim.generation).toBe(claim.generation + 1);
    expect(late.claim.token).not.toBe(claim.token);
  });

  it('rejects every provider-side write from a superseded token', async () => {
    const ids = nextIds();
    const superseded = await startAttempt(harness.alpha, ids);
    const takeover = await harness.beta.takeOverProviderOperation({
      executionAttemptId: ids.executionAttemptId,
      ownerId: 'controller-incarnation-2',
      observedAt: leaseAt(120_000),
      leaseExpiresAt: leaseAt(180_000),
    });
    expect(takeover.kind).toBe('claimed');

    const refusals = await Promise.all([
      harness.alpha.recordProviderOperationUncertainty({ claim: superseded, evidence: makeEvidence() }),
      harness.alpha.recordAllocation({ claim: superseded, allocationRef: makeTestAllocationRef() }),
      harness.alpha.recordAllocationTerminated({ claim: superseded, evidence: makeEvidence() }),
      harness.alpha.handoffProviderOperation({ claim: superseded }),
      harness.alpha.recordProvisioningAbsent({
        claim: superseded,
        executionId: ids.executionId,
        evidence: makeEvidence(),
      }),
      harness.alpha.recordProvisionerIncarnationLost({
        claim: superseded,
        executionId: ids.executionId,
        proof: makeProcessLossProof(),
      }),
      harness.alpha.recordInfrastructureFailure({ claim: superseded, executionId: ids.executionId }),
    ]);

    expect(refusals.map((decision) => decision.kind)).toEqual([
      'stale',
      'stale',
      'stale',
      'stale',
      'stale',
      'stale',
      'stale',
    ]);
    const stored = await readRawAttempt(ids.executionAttemptId);
    expect(stored.allocation_ref).toBeNull();
    expect(stored.settlement_kind).toBeNull();
    expect((await readRawOperation(ids.executionAttemptId)).failure_count).toBe(0);
  });

  it('preserves generation and obligation across handoff and fences the released token', async () => {
    const ids = nextIds();
    const claim = await startAttempt(harness.alpha, ids);
    expect(await harness.alpha.recordAllocation({ claim, allocationRef: makeTestAllocationRef() })).toEqual({
      kind: 'recorded',
    });

    const handoff = await harness.alpha.handoffProviderOperation({ claim, evidence: makeEvidence() });
    const released = await readRawOperation(ids.executionAttemptId);

    expect(handoff).toEqual({ kind: 'recorded' });
    expect(released.generation).toBe(claim.generation);
    expect(released.obligation).toBe('allocation-control');
    expect(released.owner_id).toBeNull();
    expect(released.token).toBeNull();
    expect(released.lease_expires_at).toBeNull();

    // Unowned means takeover need not await the old lease, and the released
    // token is fenced the moment ownership is cleared.
    const takeover = await harness.beta.takeOverProviderOperation({
      executionAttemptId: ids.executionAttemptId,
      ownerId: 'controller-incarnation-2',
      observedAt: leaseAt(0),
      leaseExpiresAt: leaseAt(60_000),
    });
    expect(takeover.kind).toBe('claimed');
    if (takeover.kind !== 'claimed') return;
    expect(takeover.claim.generation).toBe(claim.generation + 1);
    expect(await harness.alpha.recordAllocationTerminated({ claim, evidence: makeEvidence() })).toEqual({
      kind: 'stale',
    });
    expect((await readRawOperation(ids.executionAttemptId)).obligation).toBe('allocation-control');
  });

  // ───────────────────────────────────────────────────────────
  // Invariant 7: termination is an explicit monotonic transition,
  // and `not-allocated` is not a staleness signal.
  // ───────────────────────────────────────────────────────────

  it('advances allocation-control to terminal-convergence and never regresses it', async () => {
    const ids = nextIds();
    const claim = await startAttempt(harness.alpha, ids);
    await harness.alpha.recordAllocation({ claim, allocationRef: makeTestAllocationRef() });

    const termination = await harness.beta.recordAllocationTerminated({ claim, evidence: makeEvidence() });
    const afterTermination = await readRawOperation(ids.executionAttemptId);
    // Uncertainty retains the obligation, so terminal convergence stands.
    await harness.alpha.recordProviderOperationUncertainty({ claim, evidence: makeEvidence() });
    const afterUncertainty = await readRawOperation(ids.executionAttemptId);
    // Repeating the termination cannot walk the obligation backwards either.
    const repeat = await harness.alpha.recordAllocationTerminated({ claim, evidence: makeEvidence() });

    expect(termination).toEqual({ kind: 'recorded' });
    expect(afterTermination.obligation).toBe('terminal-convergence');
    // A successful termination is not a failure.
    expect(afterTermination.failure_count).toBe(0);
    expect(afterUncertainty.obligation).toBe('terminal-convergence');
    expect(afterUncertainty.failure_count).toBe(1);
    expect(repeat).toEqual({ kind: 'recorded' });
    expect((await readRawOperation(ids.executionAttemptId)).obligation).toBe('terminal-convergence');
  });

  it('distinguishes a current claim with nothing to terminate from a fenced one', async () => {
    const ids = nextIds();
    const claim = await startAttempt(harness.alpha, ids);

    // Current claim, no allocation: the caller may pick another write path.
    const nothingToTerminate = await harness.alpha.recordAllocationTerminated({ claim, evidence: makeEvidence() });

    const takeover = await harness.beta.takeOverProviderOperation({
      executionAttemptId: ids.executionAttemptId,
      ownerId: 'controller-incarnation-2',
      observedAt: leaseAt(120_000),
      leaseExpiresAt: leaseAt(180_000),
    });
    expect(takeover.kind).toBe('claimed');
    // Fenced claim, same missing allocation: the caller must re-read instead.
    const fenced = await harness.alpha.recordAllocationTerminated({ claim, evidence: makeEvidence() });

    expect(nothingToTerminate).toEqual({ kind: 'not-allocated' });
    expect(fenced).toEqual({ kind: 'stale' });
    expect((await readRawOperation(ids.executionAttemptId)).obligation).toBe('provisioning-resolution');
  });

  // ───────────────────────────────────────────────────────────
  // Invariant 6: only a typed confirmed absence closes
  // pre-allocation debt.
  // ───────────────────────────────────────────────────────────

  it('settles the attempt as abandoned only on proven absence', async () => {
    const ids = nextIds();
    const claim = await startAttempt(harness.alpha, ids);

    // Uncertainty is not proof: the attempt stays open.
    await harness.alpha.recordProviderOperationUncertainty({ claim, evidence: makeEvidence() });
    const stillOpen = await readRawAttempt(ids.executionAttemptId);

    const absence = await harness.beta.recordProvisioningAbsent({
      claim,
      executionId: ids.executionId,
      evidence: makeEvidence({ summary: 'provider proved no allocation exists' }),
    });
    const settled = await readRawAttempt(ids.executionAttemptId);
    const closed = await readRawOperation(ids.executionAttemptId);

    expect(stillOpen.settlement_kind).toBeNull();
    expect(absence).toEqual({ kind: 'recorded' });
    expect(settled.settlement_kind).toBe('abandoned');
    expect(settled.claimable).toBe(0);
    // Settling closes the operation in the same transaction.
    expect(closed.owner_id).toBeNull();
    expect(closed.token).toBeNull();
    // The obligation never becomes terminal convergence: nothing was allocated.
    expect(closed.obligation).toBe('provisioning-resolution');
  });

  // ───────────────────────────────────────────────────────────
  // Invariant 8: proof naming the attempt's own provisioner
  // incarnation is the parallel closer for the one lifetime that
  // cannot be observed, and an expired lease is never such proof.
  // ───────────────────────────────────────────────────────────

  it('closes a process-bound attempt on its own incarnation, whatever its lease says', async () => {
    const ids = nextIds();
    // The lease is already expired at the moment the proof is presented. If
    // expiry were doing any of the work here, both calls below would agree.
    const claim = await startAttempt(harness.alpha, ids, {
      allocationLifetime: 'provisioner-process-bound',
      provisionerIncarnationId: 'provisioner-A',
      leaseExpiresAt: leaseAt(-60_000),
    });

    const ownProof = makeProcessLossProof('provisioner-A');
    const foreign = await harness.beta.recordProvisionerIncarnationLost({
      claim,
      executionId: ids.executionId,
      proof: makeProcessLossProof('provisioner-B'),
    });
    const stillOpen = await readRawAttempt(ids.executionAttemptId);
    const own = await harness.beta.recordProvisionerIncarnationLost({
      claim,
      executionId: ids.executionId,
      proof: ownProof,
    });
    const settled = await readRawAttempt(ids.executionAttemptId);
    const closed = await readRawOperation(ids.executionAttemptId);

    expect(foreign).toEqual({ kind: 'incarnation-mismatch', provisionerIncarnationId: 'provisioner-A' });
    expect(stillOpen.settlement_kind).toBeNull();
    expect(own).toEqual({ kind: 'recorded' });
    expect(settled.settlement_kind).toBe('abandoned');
    expect(settled.claimable).toBe(0);
    // Settling closes the operation in the same transaction, and the proof's
    // own evidence is the bounded record that survives on it.
    expect(closed.owner_id).toBeNull();
    expect(closed.token).toBeNull();
    expect(closed.obligation).toBe('provisioning-resolution');
    expect(closed.last_failure === null ? null : JSON.parse(closed.last_failure)).toEqual(ownProof.evidence);
  });

  it('lets exactly one of two racing loss proofs settle the attempt', async () => {
    const ids = nextIds();
    const claim = await startAttempt(harness.alpha, ids, {
      allocationLifetime: 'provisioner-process-bound',
      provisionerIncarnationId: 'provisioner-A',
    });
    const proof = makeProcessLossProof('provisioner-A');

    // Both controllers hold the same claim and neither is sequenced by the
    // test. Only a guard inside the write can tell them apart: the loser must
    // observe the settlement rather than re-apply it.
    const decisions = await Promise.all([
      harness.alpha.recordProvisionerIncarnationLost({ claim, executionId: ids.executionId, proof }),
      harness.beta.recordProvisionerIncarnationLost({ claim, executionId: ids.executionId, proof }),
    ]);

    expect(decisions.map((decision) => decision.kind).sort()).toEqual(['recorded', 'resolved']);
    expect((await readRawAttempt(ids.executionAttemptId)).settlement_kind).toBe('abandoned');
  });

  it('refuses a loss proof for a lifetime that outlives the provisioning process', async () => {
    const ids = nextIds();
    const claim = await startAttempt(harness.alpha, ids);

    const refusal = await harness.beta.recordProvisionerIncarnationLost({
      claim,
      executionId: ids.executionId,
      proof: makeProcessLossProof(),
    });

    expect(refusal).toEqual({ kind: 'not-process-bound', allocationLifetime: 'provider-managed' });
    expect((await readRawAttempt(ids.executionAttemptId)).settlement_kind).toBeNull();
  });

  it('refuses absence once an allocation is recorded', async () => {
    const ids = nextIds();
    const claim = await startAttempt(harness.alpha, ids);
    const allocationRef = makeTestAllocationRef();
    await harness.alpha.recordAllocation({ claim, allocationRef });

    const absence = await harness.beta.recordProvisioningAbsent({
      claim,
      executionId: ids.executionId,
      evidence: makeEvidence(),
    });

    expect(absence).toEqual({ kind: 'allocated', allocationRef });
    expect((await readRawAttempt(ids.executionAttemptId)).settlement_kind).toBeNull();
  });

  // ───────────────────────────────────────────────────────────
  // Invariant 5: worker outcome commitment carries no claim.
  // ───────────────────────────────────────────────────────────

  it('commits a worker outcome during a takeover, without any claim', async () => {
    const ids = nextIds();
    const claim = await startAttempt(harness.alpha, ids);
    await harness.alpha.recordAllocation({ claim, allocationRef: makeTestAllocationRef() });
    const result = makeTestWorkflowResult(ids.executionId, 'completed');

    // The remediator takes the operation over while the worker answers. The
    // worker never holds a claim, and never needs one.
    const [takeover, commit] = await Promise.all([
      harness.beta.takeOverProviderOperation({
        executionAttemptId: ids.executionAttemptId,
        ownerId: 'controller-incarnation-2',
        observedAt: leaseAt(120_000),
        leaseExpiresAt: leaseAt(180_000),
      }),
      harness.alpha.commitOutcome({ ...ids, result: harness.alpha.canonicalizeOutcome(result) }),
    ]);

    // Independent connections may reach the shared write gate in either
    // order. The takeover either wins ownership or observes the settlement.
    expect(['claimed', 'resolved']).toContain(takeover.kind);
    expect(commit).toEqual({ kind: 'accepted', outcome: result, text: harness.alpha.canonicalizeOutcome(result).text });
    const settled = await readRawAttempt(ids.executionAttemptId);
    expect(settled.settlement_kind).toBe('outcome');
    // A settled attempt leaves no owned operation behind, whoever took it.
    const operation = await readRawOperation(ids.executionAttemptId);
    expect(operation.owner_id).toBeNull();
    expect(operation.token).toBeNull();
  });

  it('returns the canonical result for an exact replay and conflicts on a different one', async () => {
    const ids = nextIds();
    await harness.alpha.createAttempt({ bootstrapTimeoutMs: 60_000, ...ids, instruction: makeTestInstruction() });
    const result = makeTestWorkflowResult(ids.executionId, 'completed');

    const accepted = await harness.alpha.commitOutcome({ ...ids, result: harness.alpha.canonicalizeOutcome(result) });
    // The replay is served by the other controller, from the stored row.
    const replay = await harness.beta.commitOutcome({
      ...ids,
      result: harness.beta.canonicalizeOutcome(makeTestWorkflowResult(ids.executionId, 'completed')),
    });
    const divergent = await harness.beta.commitOutcome({
      ...ids,
      result: harness.beta.canonicalizeOutcome(makeTestWorkflowResult(ids.executionId, 'failed')),
    });

    // Both decisions report the text the row holds: the first commit's.
    const storedText = harness.alpha.canonicalizeOutcome(result).text;
    expect(accepted).toEqual({ kind: 'accepted', outcome: result, text: storedText });
    expect(replay).toEqual({ kind: 'duplicate', outcome: result, text: storedText });
    expect(divergent).toEqual({ kind: 'conflict' });
    const stored = await readRawAttempt(ids.executionAttemptId);
    expect(stored.workflow_result === null ? null : JSON.parse(stored.workflow_result)).toEqual(result);
  });

  it('lets a terminal infrastructure settlement win the race against a late outcome', async () => {
    const ids = nextIds();
    const claim = await startAttempt(harness.alpha, ids);
    await harness.alpha.recordAllocation({ claim, allocationRef: makeTestAllocationRef() });
    await harness.alpha.recordAllocationTerminated({ claim, evidence: makeEvidence() });

    const failure = await harness.beta.recordInfrastructureFailure({ claim, executionId: ids.executionId });
    const lateOutcome = await harness.alpha.commitOutcome({
      ...ids,
      result: harness.alpha.canonicalizeOutcome(makeTestWorkflowResult(ids.executionId, 'completed')),
    });

    expect(failure).toEqual({ kind: 'recorded' });
    expect(lateOutcome).toEqual({ kind: 'conflict' });
    const settled = await readRawAttempt(ids.executionAttemptId);
    expect(settled.settlement_kind).toBe('infrastructure-failure');
    expect(settled.workflow_result).toBeNull();
  });

  // ───────────────────────────────────────────────────────────
  // Superseded attempts stay remediable without coming back.
  // ───────────────────────────────────────────────────────────

  it('keeps a superseded attempt remediable without reactivating it', async () => {
    const first = nextIds();
    const claim = await startAttempt(harness.alpha, first);
    // A retry supersedes the first attempt through the other controller.
    const second = { executionId: first.executionId, executionAttemptId: `${first.executionAttemptId}-retry` };
    await harness.beta.createAttempt({ bootstrapTimeoutMs: 60_000, ...second, instruction: makeTestInstruction() });

    const discovered = makeTestAllocationRef(TEST_PROVIDER_ID, { machineId: 'discovered-1' });
    const discovery = await harness.beta.recovery.recordDiscoveredAllocation({ claim, allocationRef: discovered });
    const termination = await harness.beta.recordAllocationTerminated({ claim, evidence: makeEvidence() });
    const settlement = await harness.beta.recordInfrastructureFailure({
      claim,
      executionId: first.executionId,
    });

    expect(discovery).toEqual({ kind: 'recorded' });
    expect(termination).toEqual({ kind: 'recorded' });
    expect(settlement).toEqual({ kind: 'recorded' });

    const superseded = await readRawAttempt(first.executionAttemptId);
    // Converging an old attempt never revives it.
    expect(superseded.claimable).toBe(0);
    expect(superseded.settlement_kind).toBe('infrastructure-failure');
    expect(await readActivePointer(first.executionId)).toBe(second.executionAttemptId);
    expect(await harness.alpha.getActiveAttempt(first.executionId, first.executionAttemptId)).toBeNull();
    expect(await harness.alpha.recovery.getRecoverableAttempts(first.executionId)).toEqual([]);
    // A worker answering for the superseded attempt is fenced, not accepted.
    expect(
      await harness.alpha.commitOutcome({
        ...first,
        result: harness.alpha.canonicalizeOutcome(makeTestWorkflowResult(first.executionId, 'completed')),
      }),
    ).toEqual({ kind: 'fenced' });
    // The attempt itself stays readable for remediation.
    const readBack = await harness.alpha.recovery.getAttemptWithAllocation(first.executionAttemptId);
    expect(readBack?.allocationRef).toEqual(discovered);
  });

  it('marks the active attempt bootstrap-claimable and a discovered allocation never', async () => {
    const active = nextIds();
    const activeClaim = await startAttempt(harness.alpha, active);
    await harness.alpha.recordAllocation({ claim: activeClaim, allocationRef: makeTestAllocationRef() });

    const discoveredIds = nextIds();
    const discoveredClaim = await startAttempt(harness.beta, discoveredIds);
    await harness.beta.recovery.recordDiscoveredAllocation({
      claim: discoveredClaim,
      allocationRef: makeTestAllocationRef(),
    });

    expect((await readRawAttempt(active.executionAttemptId)).claimable).toBe(1);
    expect((await readRawAttempt(discoveredIds.executionAttemptId)).claimable).toBe(0);
    const recoverable = await harness.beta.recovery.getRecoverableAttempts(active.executionId);
    expect(recoverable.map((record) => record.executionAttemptId)).toEqual([active.executionAttemptId]);
    expect(await harness.alpha.recovery.getRecoverableAttempts(discoveredIds.executionId)).toEqual([]);
  });

  // ───────────────────────────────────────────────────────────
  // Invariant 10: durable rows carry only bounded, non-secret evidence.
  // ───────────────────────────────────────────────────────────

  it('refuses to persist evidence with an over-long summary', async () => {
    const ids = nextIds();
    const claim = await startAttempt(harness.alpha, ids);

    await expect(
      harness.alpha.recordProviderOperationUncertainty({
        claim,
        // The durable record accepts only bounded evidence, so an over-long
        // summary must be rejected before anything is written.
        evidence: makeEvidence({ summary: 'x'.repeat(4_096) }),
      }),
    ).rejects.toThrow();

    const stored = await readRawOperation(ids.executionAttemptId);
    expect(stored.failure_count).toBe(0);
    expect(stored.last_failure).toBeNull();
  });

  it('stores only the bounded evidence fields the contract defines', async () => {
    const ids = nextIds();
    const claim = await startAttempt(harness.alpha, ids);
    const evidence = makeEvidence({ summary: 'provider returned no allocation', code: 'not-found' });

    await harness.alpha.recordProviderOperationUncertainty({ claim, evidence });

    const stored = await readRawOperation(ids.executionAttemptId);
    expect(stored.last_failure === null ? null : JSON.parse(stored.last_failure)).toEqual(evidence);
    // The fencing token is repository-issued and opaque, never a credential
    // handed in by a caller.
    expect(stored.token).not.toBe(TEST_OWNER_ID);
    expect(stored.token).toMatch(/^[0-9a-f-]{36}$/);
  });

  // ───────────────────────────────────────────────────────────
  // Cross-connection visibility of the whole record.
  // ───────────────────────────────────────────────────────────

  it('reads back every durable field through the other connection', async () => {
    const ids = nextIds();
    const claim = await startAttempt(harness.alpha, ids);
    const allocationRef = makeTestAllocationRef(TEST_PROVIDER_ID, { machineId: 'machine-7', region: 'ams' });
    await harness.alpha.recordAllocation({ claim, allocationRef });

    const attempt = await harness.beta.recovery.getAttemptWithAllocation(ids.executionAttemptId);
    const operation = await harness.beta.getProviderOperation(ids.executionAttemptId);

    expect(attempt).toMatchObject({
      executionAttemptId: ids.executionAttemptId,
      executionId: ids.executionId,
      status: 'allocated',
      allocationRef,
      providerId: TEST_PROVIDER_ID,
      allocationLifetime: 'provider-managed',
      provisionerIncarnationId: TEST_PROVISIONER_INCARNATION_ID,
      settlementKind: null,
      claimable: true,
    });
    expect(operation).toMatchObject({
      generation: claim.generation,
      ownerId: TEST_OWNER_ID,
      token: claim.token,
      obligation: 'allocation-control',
      failureCount: 0,
      lastFailure: null,
    });
  });

  it('recovers the control state of a running attempt through the other connection', async () => {
    const ids = nextIds();
    const runtimeGeneration = await readyAttempt(harness.alpha, ids);
    const admission = await harness.alpha.admitOperation({
      ...ids,
      operationKind: 'workflow-run',
      admissionKey: 'run-key',
      runtimeGeneration,
    });
    if (admission.kind !== 'admitted') throw new Error(`Expected the run to be admitted, got '${admission.kind}'`);

    // `beta` is a second repository over the same file: what a controller that
    // lost its own memory of the attempt reads after a process loss.
    const control = await harness.beta.getAttemptControlState(ids.executionAttemptId);

    expect(control).toMatchObject({
      runtimeGeneration,
      runtimeIncarnationId: 'runtime-incarnation-1',
      operationStartGate: 'open',
      activeOperationId: admission.operationId,
      activeOperationKind: 'workflow-run',
      activeOperationKey: 'run-key',
      activeOperationGeneration: runtimeGeneration,
      lastCompletedOperationId: null,
    });
    expect(control?.runtimeReadyAt).not.toBeNull();
    // The recovered key is answerable through the other connection too.
    expect(
      await harness.beta.admitOperation({
        ...ids,
        operationKind: 'workflow-run',
        admissionKey: 'run-key',
        runtimeGeneration,
      }),
    ).toEqual({
      kind: 'duplicate',
      operationId: admission.operationId,
      runtimeGeneration,
      admittedAt: control?.activeOperationAdmittedAt,
    });
  });

  it('rejects an allocation reference evolution that lost the race', async () => {
    const ids = nextIds();
    const claim = await startAttempt(harness.alpha, ids);
    const initial = makeTestAllocationRef(TEST_PROVIDER_ID, { machineId: 'machine-8' });
    await harness.alpha.recordAllocation({ claim, allocationRef: initial });
    const correlated = makeTestAllocationRef(TEST_PROVIDER_ID, { machineId: 'machine-8', jobId: 'job-1' });

    const evolved = await harness.alpha.recovery.evolveAllocationRef({
      claim,
      executionId: ids.executionId,
      currentRef: initial,
      nextRef: correlated,
    });
    // The second correlator still believes the original reference is stored.
    const lost = await harness.beta.recovery.evolveAllocationRef({
      claim,
      executionId: ids.executionId,
      currentRef: initial,
      nextRef: makeTestAllocationRef(TEST_PROVIDER_ID, { machineId: 'machine-8', jobId: 'job-2' }),
    });

    expect(evolved).toEqual({ kind: 'evolved' });
    expect(lost).toEqual({ kind: 'stale', storedRef: correlated });
  });

  it('lets exactly one of two racing evolutions win the compare-and-set', async () => {
    const ids = nextIds();
    const claim = await startAttempt(harness.alpha, ids);
    const initial = makeTestAllocationRef(TEST_PROVIDER_ID, { machineId: 'machine-9' });
    await harness.alpha.recordAllocation({ claim, allocationRef: initial });
    const first = makeTestAllocationRef(TEST_PROVIDER_ID, { machineId: 'machine-9', jobId: 'job-a' });
    const second = makeTestAllocationRef(TEST_PROVIDER_ID, { machineId: 'machine-9', jobId: 'job-b' });

    // Both correlators start from the same view and are never sequenced by
    // the test. Only a guard that is part of the write can tell them apart:
    // an unconditional update would report `evolved` twice and silently keep
    // whichever of the two committed last.
    const decisions = await Promise.all([
      harness.alpha.recovery.evolveAllocationRef({
        claim,
        executionId: ids.executionId,
        currentRef: initial,
        nextRef: first,
      }),
      harness.beta.recovery.evolveAllocationRef({
        claim,
        executionId: ids.executionId,
        currentRef: initial,
        nextRef: second,
      }),
    ]);

    expect(decisions.map((decision) => decision.kind).sort()).toEqual(['evolved', 'stale']);
    const winner = decisions[0].kind === 'evolved' ? first : second;
    const loser = decisions.find((decision) => decision.kind === 'stale');
    expect(loser).toEqual({ kind: 'stale', storedRef: winner });
    const stored = await readRawAttempt(ids.executionAttemptId);
    expect(stored.allocation_ref === null ? null : JSON.parse(stored.allocation_ref)).toEqual(winner);
  });

  it('refuses an evolution that would move the attempt to another provider', async () => {
    const ids = nextIds();
    const claim = await startAttempt(harness.alpha, ids);
    const initial = makeTestAllocationRef(TEST_PROVIDER_ID, { machineId: 'machine-10' });
    await harness.alpha.recordAllocation({ claim, allocationRef: initial });

    await expect(
      harness.alpha.recovery.evolveAllocationRef({
        claim,
        executionId: ids.executionId,
        currentRef: initial,
        nextRef: makeTestAllocationRef('a-different-provider', { machineId: 'machine-10' }),
      }),
    ).rejects.toThrow('must keep one provider');

    const stored = await readRawAttempt(ids.executionAttemptId);
    expect(stored.allocation_ref === null ? null : JSON.parse(stored.allocation_ref)).toEqual(initial);
  });

  it('rejects a reused attempt identifier instead of resurrecting the attempt', async () => {
    const ids = nextIds();
    const claim = await startAttempt(harness.alpha, ids);
    await harness.alpha.recordAllocation({ claim, allocationRef: makeTestAllocationRef() });
    await harness.alpha.recordAllocationTerminated({ claim, evidence: makeEvidence() });
    await harness.alpha.recordInfrastructureFailure({ claim, executionId: ids.executionId });

    await expect(
      harness.beta.createAttempt({ bootstrapTimeoutMs: 60_000, ...ids, instruction: makeTestInstruction() }),
    ).rejects.toThrow();

    // The settled attempt keeps everything a fresh `pending` record would
    // have discarded.
    const stored = await readRawAttempt(ids.executionAttemptId);
    expect(stored.settlement_kind).toBe('infrastructure-failure');
    expect(stored.allocation_ref).not.toBeNull();
    expect(stored.provider_id).toBe(TEST_PROVIDER_ID);
  });

  it('abandons a pending attempt exactly once and refuses it after provisioning began', async () => {
    const pending = nextIds();
    await harness.alpha.createAttempt({ bootstrapTimeoutMs: 60_000, ...pending, instruction: makeTestInstruction() });

    const abandonments = await Promise.all([
      harness.alpha.abandonPendingAttempt(pending.executionAttemptId, pending.executionId),
      harness.beta.abandonPendingAttempt(pending.executionAttemptId, pending.executionId),
    ]);

    const provisioning = nextIds();
    await startAttempt(harness.alpha, provisioning);
    const refused = await harness.beta.abandonPendingAttempt(provisioning.executionAttemptId, provisioning.executionId);

    expect(abandonments.map((decision) => decision.kind).sort()).toEqual(['abandoned', 'already-abandoned']);
    expect(refused).toEqual({ kind: 'provisioning' });
  });

  // ───────────────────────────────────────────────────────────
  // Invariant 6: the runtime endpoint and the operation start gate are
  // durable facts, agreed on by two independent connections.
  // ───────────────────────────────────────────────────────────

  it('accepts a worker outcome that races an admission on the other controller', async () => {
    const ids = nextIds();
    const runtimeGeneration = await readyAttempt(harness.alpha, ids);
    const result = makeTestWorkflowResult(ids.executionId, 'completed');

    const [admission, commit] = await Promise.all([
      harness.beta.admitOperation({
        ...ids,
        operationKind: 'workflow-run',
        admissionKey: 'run-against-outcome',
        runtimeGeneration,
      }),
      harness.alpha.commitOutcome({ ...ids, result: harness.alpha.canonicalizeOutcome(result) }),
    ]);

    // Admission never gates the canonical answer. Independent connections may
    // reach the shared write gate in either order, so the admission is either
    // in before the settlement or refused by it — never a refused outcome.
    expect(commit.kind).toBe('accepted');
    expect(['admitted', 'resolved']).toContain(admission.kind);
    const settled = await readRawAttempt(ids.executionAttemptId);
    expect(settled.settlement_kind).toBe('outcome');
    expect(settled.operation_start_gate).toBe('closed');
  });

  it('advances the runtime generation once for one incarnation reporting to both controllers', async () => {
    const ids = nextIds();
    await allocateAttempt(harness.alpha, ids);
    const report = { ...ids, runtimeIncarnationId: 'runtime-incarnation-1' };

    const decisions = await Promise.all([harness.alpha.registerRuntime(report), harness.beta.registerRuntime(report)]);

    expect(decisions.map((decision) => decision.kind).sort()).toEqual(['duplicate', 'registered']);
    // Durable state, not a local variable, is what makes the second report a
    // replay: the row carries the incarnation the first one stored.
    const row = await readRawAttempt(ids.executionAttemptId);
    expect(row.runtime_generation).toBe(1);
    expect(row.runtime_incarnation_id).toBe('runtime-incarnation-1');
    expect(row.runtime_ready_at).toBeNull();
  });

  it('allocates one generation per incarnation when two controllers register different ones', async () => {
    const ids = nextIds();
    await allocateAttempt(harness.alpha, ids);

    const decisions = await Promise.all([
      harness.alpha.registerRuntime({ ...ids, runtimeIncarnationId: 'runtime-incarnation-a' }),
      harness.beta.registerRuntime({ ...ids, runtimeIncarnationId: 'runtime-incarnation-b' }),
    ]);

    // Each registration allocates its own generation, so the later one fences
    // the earlier one rather than sharing its fence.
    const generations = decisions.flatMap((decision) =>
      decision.kind === 'registered' ? [decision.runtimeGeneration] : [],
    );
    expect(generations.sort()).toEqual([1, 2]);
    const row = await readRawAttempt(ids.executionAttemptId);
    expect(row.runtime_generation).toBe(2);
    expect(row.runtime_ready_at).toBeNull();
  });

  it('admits one operation for an admission key presented to both controllers', async () => {
    const ids = nextIds();
    const runtimeGeneration = await readyAttempt(harness.alpha, ids);
    const command = {
      ...ids,
      operationKind: 'workflow-run',
      admissionKey: 'run-key',
      runtimeGeneration,
    } as const;

    const decisions = await Promise.all([harness.alpha.admitOperation(command), harness.beta.admitOperation(command)]);

    expect(decisions.map((decision) => decision.kind).sort()).toEqual(['admitted', 'duplicate']);
    const operationIds = decisions.flatMap((decision) =>
      decision.kind === 'admitted' || decision.kind === 'duplicate' ? [decision.operationId] : [],
    );
    expect(new Set(operationIds).size).toBe(1);
    const row = await readRawAttempt(ids.executionAttemptId);
    expect(row.active_operation_id).toBe(operationIds[0]);
    expect(row.active_operation_key).toBe('run-key');
    expect(row.active_operation_generation).toBe(runtimeGeneration);
  });

  it('admits the probe before readiness and refuses a run, across both controllers', async () => {
    const ids = nextIds();
    await allocateAttempt(harness.alpha, ids);
    const registration = await harness.alpha.registerRuntime({ ...ids, runtimeIncarnationId: 'runtime-incarnation-1' });
    if (registration.kind !== 'registered')
      throw new Error(`Expected the runtime to register, got '${registration.kind}'`);

    const refused = await harness.beta.admitOperation({
      ...ids,
      operationKind: 'workflow-run',
      admissionKey: 'run-before-readiness',
      runtimeGeneration: registration.runtimeGeneration,
    });
    const probe = await harness.beta.admitOperation({
      ...ids,
      operationKind: 'runtime-probe',
      admissionKey: 'probe-1',
      runtimeGeneration: registration.runtimeGeneration,
    });

    expect(refused).toEqual({ kind: 'not-ready' });
    expect(probe.kind).toBe('admitted');
    const row = await readRawAttempt(ids.executionAttemptId);
    expect(row.runtime_ready_at).toBeNull();
    expect(row.active_operation_kind).toBe('runtime-probe');
  });

  it('answers resolved from both controllers for a settled attempt with a leftover operation', async () => {
    const ids = nextIds();
    const runtimeGeneration = await readyAttempt(harness.alpha, ids);
    const admission = await harness.alpha.admitOperation({
      ...ids,
      operationKind: 'workflow-run',
      admissionKey: 'run-1',
      runtimeGeneration,
    });
    if (admission.kind !== 'admitted')
      throw new Error(`Expected the operation to be admitted, got '${admission.kind}'`);
    await harness.alpha.commitOutcome({
      ...ids,
      result: harness.alpha.canonicalizeOutcome(makeTestWorkflowResult(ids.executionId, 'completed')),
    });

    // The settlement closes the gate and deliberately leaves the operation in
    // place, so `resolved` outranks `operation-active` for every later caller.
    const row = await readRawAttempt(ids.executionAttemptId);
    expect(row.operation_start_gate).toBe('closed');
    expect(row.active_operation_id).toBe(admission.operationId);
    expect(await harness.beta.registerRuntime({ ...ids, runtimeIncarnationId: 'runtime-incarnation-2' })).toEqual({
      kind: 'resolved',
    });
    expect(
      await harness.beta.admitOperation({
        ...ids,
        operationKind: 'workflow-run',
        admissionKey: 'after-settlement',
        runtimeGeneration,
      }),
    ).toEqual({ kind: 'resolved' });
    expect(
      await harness.beta.completeOperation({
        executionAttemptId: ids.executionAttemptId,
        operationId: admission.operationId,
        runtimeGeneration,
      }),
    ).toEqual({ kind: 'resolved' });
  });
});

/**
 * Literal text of a raw statement, ignoring its bound parameters.
 * @param query - Statement to inspect.
 * @returns The statement's literal fragments, concatenated.
 */
function statementText(query: SQL): string {
  return query.queryChunks.map((chunk) => (chunk instanceof StringChunk ? chunk.value.join('') : '')).join('');
}

/**
 * Open a real in-memory SQLite connection and return its statement surface.
 * @returns The connection's raw executor.
 */
function openConnection(): RawSqlExecutor {
  return getRawSqlExecutor(drizzle({ connection: { url: ':memory:' } }));
}

/**
 * Brand a fresh handle whose raw SQL executor is exactly `session`.
 *
 * The handle itself is a real but otherwise unused in-memory instance that
 * exists only to satisfy `MakaioDatabase`; the repository reaches storage
 * solely through the executor. Two handles built this way over one connection
 * are two distinct identities, so they do not share a write gate.
 * @param session - Statement surface every repository call goes through.
 * @returns A handle backed by that statement surface.
 */
function handleOver(session: RawSqlSession): MakaioDatabase {
  return brandDatabase(drizzle({ connection: { url: ':memory:' } }), 'sqlite', {
    dialect: 'sqlite',
    run: session.run,
    all: session.all,
    withSession: (fn) => fn(session),
  });
}

/**
 * Wrap a statement surface so transaction control does nothing.
 *
 * Every other statement still reaches the real SQLite connection; only
 * `BEGIN`, `COMMIT`, and `ROLLBACK` are swallowed. What the repository then
 * runs on is a store that does not take a write lock up front — the isolation
 * a host's Postgres implementation actually has under read-committed, and the
 * only condition under which "read the guard, then write unconditionally"
 * differs from a real compare-and-set.
 * @param inner - Statement surface reaching the real connection.
 * @returns The same surface, with no transactions.
 */
function withoutTransactionIsolation(inner: RawSqlSession): RawSqlSession {
  return {
    async run(query: SQL): Promise<{ rowsAffected: number }> {
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(statementText(query))) return { rowsAffected: 0 };
      return inner.run(query);
    },
    async all<TRow extends Record<string, unknown>>(query: SQL): Promise<TRow[]> {
      return inner.all<TRow>(query);
    },
  };
}

describe('execution attempt repository contract (without write-lock isolation)', () => {
  it('lets exactly one of two interleaved evolutions win the compare-and-set', async () => {
    // Two handles over one connection, so the repositories do not share a
    // write gate and their transitions genuinely interleave: both read the
    // stored reference before either writes. A guard that lives only in
    // application code lets both report `evolved` and silently keeps whichever
    // committed last.
    const shared = withoutTransactionIsolation(openConnection());
    const alpha = await createSqliteAttemptRepository(handleOver(shared), workflowRunResultOutcomeCodec);
    const beta = await createSqliteAttemptRepository(handleOver(shared), workflowRunResultOutcomeCodec);

    const ids = { executionId: 'unisolated-exec', executionAttemptId: 'unisolated-attempt' };
    await alpha.createAttempt({ bootstrapTimeoutMs: 60_000, ...ids, instruction: makeTestInstruction() });
    const begun = await alpha.beginProvisioning(makeBeginProvisioningInput(ids.executionAttemptId, ids.executionId));
    if (begun.kind !== 'started') throw new Error(`Expected provisioning to start, got '${begun.kind}'`);
    const initial = makeTestAllocationRef(TEST_PROVIDER_ID, { machineId: 'unisolated' });
    await alpha.recordAllocation({ claim: begun.claim, allocationRef: initial });
    const first = makeTestAllocationRef(TEST_PROVIDER_ID, { machineId: 'unisolated', jobId: 'job-a' });
    const second = makeTestAllocationRef(TEST_PROVIDER_ID, { machineId: 'unisolated', jobId: 'job-b' });

    const decisions = await Promise.all([
      alpha.recovery.evolveAllocationRef({
        claim: begun.claim,
        executionId: ids.executionId,
        currentRef: initial,
        nextRef: first,
      }),
      beta.recovery.evolveAllocationRef({
        claim: begun.claim,
        executionId: ids.executionId,
        currentRef: initial,
        nextRef: second,
      }),
    ]);

    expect(decisions.map((decision) => decision.kind).sort()).toEqual(['evolved', 'stale']);
    const winner = decisions[0].kind === 'evolved' ? first : second;
    expect(decisions.find((decision) => decision.kind === 'stale')).toEqual({ kind: 'stale', storedRef: winner });
    expect((await alpha.recovery.getAttemptWithAllocation(ids.executionAttemptId))?.allocationRef).toEqual(winner);
  });

  it('lets exactly one of two interleaved admissions take the operation slot', async () => {
    // The same two-handles-over-one-connection setup: both repositories read
    // `active_operation_id IS NULL` before either writes. A guard that lived in
    // application code would admit both and silently keep whichever committed
    // last, which is two workers running one attempt.
    const shared = withoutTransactionIsolation(openConnection());
    const alpha = await createSqliteAttemptRepository(handleOver(shared), workflowRunResultOutcomeCodec);
    const beta = await createSqliteAttemptRepository(handleOver(shared), workflowRunResultOutcomeCodec);

    const ids = { executionId: 'unisolated-admit-exec', executionAttemptId: 'unisolated-admit-attempt' };
    await alpha.createAttempt({ bootstrapTimeoutMs: 60_000, ...ids, instruction: makeTestInstruction() });
    const begun = await alpha.beginProvisioning(makeBeginProvisioningInput(ids.executionAttemptId, ids.executionId));
    if (begun.kind !== 'started') throw new Error(`Expected provisioning to start, got '${begun.kind}'`);
    await alpha.recordAllocation({ claim: begun.claim, allocationRef: makeTestAllocationRef() });
    const registration = await alpha.registerRuntime({ ...ids, runtimeIncarnationId: 'runtime-incarnation-1' });
    if (registration.kind !== 'registered') {
      throw new Error(`Expected the runtime to register, got '${registration.kind}'`);
    }
    const { runtimeGeneration } = registration;
    const readiness = await alpha.markRuntimeReady({ ...ids, runtimeGeneration, readyAt: new Date().toISOString() });
    if (readiness.kind !== 'ready') throw new Error(`Expected readiness to be accepted, got '${readiness.kind}'`);

    const decisions = await Promise.all([
      alpha.admitOperation({ ...ids, operationKind: 'workflow-run', admissionKey: 'run-a', runtimeGeneration }),
      beta.admitOperation({ ...ids, operationKind: 'workflow-run', admissionKey: 'run-b', runtimeGeneration }),
    ]);

    expect(decisions.map((decision) => decision.kind).sort()).toEqual(['admitted', 'operation-active']);
    const admitted = decisions.find((decision) => decision.kind === 'admitted');
    const refused = decisions.find((decision) => decision.kind === 'operation-active');
    if (admitted?.kind !== 'admitted' || refused?.kind !== 'operation-active') {
      throw new Error('Expected exactly one admission and one refusal');
    }
    // The loser is told which operation took the slot, and it is the winner's.
    expect(refused.operationId).toBe(admitted.operationId);
    expect((await alpha.getAttemptControlState(ids.executionAttemptId))?.activeOperationId).toBe(admitted.operationId);
  });
});

describe('execution attempt repository contract (failed rollback)', () => {
  it('releases transaction ownership after a commit failure is rolled back', async () => {
    const inner = openConnection();
    let rejectCommit = true;
    const repository = await createSqliteAttemptRepository(
      handleOver({
        async run(query: SQL): Promise<{ rowsAffected: number }> {
          if (rejectCommit && /^\s*COMMIT\b/i.test(statementText(query))) {
            rejectCommit = false;
            throw new Error('the driver refused to commit');
          }
          return inner.run(query);
        },
        async all<TRow extends Record<string, unknown>>(query: SQL): Promise<TRow[]> {
          return inner.all<TRow>(query);
        },
      }),
      workflowRunResultOutcomeCodec,
    );

    await expect(
      repository.createAttempt({
        bootstrapTimeoutMs: 60_000,
        executionId: 'busy-exec',
        executionAttemptId: 'busy-attempt',
        instruction: makeTestInstruction(),
      }),
    ).rejects.toThrow('the driver refused to commit');
    await expect(
      repository.createAttempt({
        bootstrapTimeoutMs: 60_000,
        executionId: 'next-exec',
        executionAttemptId: 'next-attempt',
        instruction: makeTestInstruction(),
      }),
    ).resolves.toMatchObject({ executionAttemptId: 'next-attempt' });
  });

  it('retires the repository instead of reusing a connection it cannot roll back', async () => {
    const inner = openConnection();
    let refuseRollback = false;
    const repository = await createSqliteAttemptRepository(
      handleOver({
        async run(query: SQL): Promise<{ rowsAffected: number }> {
          if (refuseRollback && /^\s*ROLLBACK\b/i.test(statementText(query))) {
            throw new Error('the driver refused to roll back');
          }
          return inner.run(query);
        },
        async all<TRow extends Record<string, unknown>>(query: SQL): Promise<TRow[]> {
          return inner.all<TRow>(query);
        },
      }),
      workflowRunResultOutcomeCodec,
    );
    const ids = { executionId: 'rollback-exec', executionAttemptId: 'rollback-attempt' };
    await repository.createAttempt({ bootstrapTimeoutMs: 60_000, ...ids, instruction: makeTestInstruction() });

    // The reused identifier makes the insert fail inside the transaction, and
    // the rollback that should undo it fails too.
    refuseRollback = true;
    const failedTransition = repository.createAttempt({
      bootstrapTimeoutMs: 60_000,
      ...ids,
      instruction: makeTestInstruction(),
    });
    const queuedRead = repository.recovery.getAttemptWithAllocation(ids.executionAttemptId);
    await expect(failedTransition).rejects.toThrow('Transaction rollback failed');

    // The connection's transaction state is now unknown, so even work queued
    // before the rollback failure became visible must not run on it.
    await expect(queuedRead).rejects.toThrow('retired by a failed transaction rollback');
  });
});

describe('execution attempt repository contract (one unbranded handle)', () => {
  it('serializes two repositories built over the same unbranded connection', async () => {
    // A handle built straight on the driver carries no attached executor, so
    // every executor lookup synthesizes a fresh one. The handle is therefore
    // the only stable identity two repositories over one connection share —
    // and without sharing it they would both open a transaction on that one
    // connection.
    const db: MakaioDatabase = drizzle({ connection: { url: ':memory:' } });
    const alpha = await createSqliteAttemptRepository(db, workflowRunResultOutcomeCodec);
    const beta = await createSqliteAttemptRepository(db, workflowRunResultOutcomeCodec);
    const ids = { executionId: 'unbranded-exec', executionAttemptId: 'unbranded-attempt' };
    await alpha.createAttempt({ bootstrapTimeoutMs: 60_000, ...ids, instruction: makeTestInstruction() });
    const input = makeBeginProvisioningInput(ids.executionAttemptId, ids.executionId);

    const decisions = await Promise.all([alpha.beginProvisioning(input), beta.beginProvisioning(input)]);

    expect(decisions.map((decision) => decision.kind).sort()).toEqual(['already-provisioning', 'started']);
  });
});
