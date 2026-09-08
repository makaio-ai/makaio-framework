import { describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createRestartableTempDb, createTempDb } from '@makaio/test-utils/drizzle-harness';
import { getRawSqlExecutor } from '@makaio/storage-drizzle';
import { createDatabaseClient } from '@makaio/storage-drizzle/client';
import type {
  ExecutionAttemptRecord,
  ExecutionAttemptRepository,
  ReportOperationInput,
} from '../execution-attempt-repository.js';
import type {
  ExecutionAttemptRepositoryContractFactory,
  RecoverableAttemptsSeed,
} from '../testing/conformance/types.js';
import { runExecutionAttemptRepositoryContract } from '../testing/conformance.js';
import { createSqliteAttemptRepository } from '../testing/sqlite.js';
import {
  INITIAL_ATTEMPT_CONTROL_STATE,
  TEST_PROVIDER_ID,
  TEST_PROVISIONER_INCARNATION_ID,
  createInMemoryAttemptRepository,
  makeEvidence,
  makeBeginProvisioningInput,
  makeTestInstruction,
  makeTestAllocationRef,
  makeTestWorkflowResult,
  workflowRunResultOutcomeCodec,
} from '../testing/index.js';
import {
  nextIds,
  TEST_BOOTSTRAP_TIMEOUT_MS,
  preparationAttempt,
  registerTestRuntime,
  proveTestReadiness,
  admitTestOperation,
} from '../testing/conformance/attempt-helpers.js';

/**
 * Create complete allocated candidates before the fixture restores shared recovery eligibility.
 * @param repository - Reference repository whose public lifecycle builds the candidates.
 * @param input - Ordered candidate identifiers and their shared owner.
 * @typeParam TOutcome - Owner-defined outcome type of the reference repository.
 */
async function createRecoverySeedCandidates<TOutcome>(
  repository: Required<ExecutionAttemptRepository<TOutcome>>,
  input: RecoverableAttemptsSeed,
): Promise<void> {
  for (const entry of input.entries) {
    const ids = { executionId: input.executionId, executionAttemptId: entry.executionAttemptId };
    await repository.createAttempt({
      ...ids,
      instruction: makeTestInstruction(),
      bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
    });
    const provisioning = await repository.beginProvisioning(
      makeBeginProvisioningInput(ids.executionAttemptId, ids.executionId),
    );
    if (provisioning.kind !== 'started') throw new Error('Expected provisioning for recovery fixture');
    const allocation = await repository.recordAllocation({
      claim: provisioning.claim,
      allocationRef: makeTestAllocationRef(),
    });
    if (allocation.kind !== 'recorded') throw new Error('Expected allocation for recovery fixture');
  }
}

const MEMORY_FACTORY = {
  name: 'in-memory',
  async create(codec) {
    // Public configuration methods may read their receiver; the callable suite
    // must preserve it across deferred setup and every outcome-codec group.
    expect(this.name).toBe('in-memory');
    const repository = createInMemoryAttemptRepository(codec);
    return {
      repository,
      peer: createInMemoryAttemptRepository(codec, repository),
      writeStoredOutcomeText: async (executionAttemptId, text) => {
        repository.committedOutcomes.set(executionAttemptId, text);
      },
      setClaimExpiry: async (executionAttemptId, claimExpiresAt) => {
        const attempt = repository.attempts.get(executionAttemptId);
        if (!attempt) throw new Error(`Attempt ${executionAttemptId} does not exist`);
        repository.attempts.set(executionAttemptId, { ...attempt, claimExpiresAt });
      },
      clearStoredBootstrapDeadline: async (executionAttemptId) => {
        const attempt = repository.attempts.get(executionAttemptId);
        if (!attempt) throw new Error('Missing test attempt');
        repository.attempts.set(executionAttemptId, { ...attempt, bootstrapDeadlineAt: null });
      },
      seedRecoverableAttempts: async (input) => {
        await createRecoverySeedCandidates(repository, input);
        // Restore eligibility only after replacement has finished clearing predecessors.
        for (const entry of input.entries) {
          const attempt = repository.attempts.get(entry.executionAttemptId);
          if (!attempt) throw new Error(`Attempt ${entry.executionAttemptId} does not exist`);
          repository.attempts.set(entry.executionAttemptId, {
            ...attempt,
            createdAt: entry.createdAt,
            claimable: true,
            claimExpiresAt: null,
          });
        }
      },
      dispose: () => {},
    };
  },
} satisfies ExecutionAttemptRepositoryContractFactory;

const SQLITE_FACTORY = {
  name: 'sqlite',
  async create(codec) {
    const store = createRestartableTempDb(`execution-attempt-parity-${this.name}`);
    try {
      const db = await store.connect();
      const secondary = await store.connect();
      const repository = await createSqliteAttemptRepository(db, codec);
      return {
        repository,
        peer: await createSqliteAttemptRepository(secondary, codec),
        writeStoredOutcomeText: async (executionAttemptId, text) => {
          await getRawSqlExecutor(db).run(sql`UPDATE test_execution_attempt SET workflow_result = ${text}
            WHERE execution_attempt_id = ${executionAttemptId}`);
        },
        setClaimExpiry: async (executionAttemptId, claimExpiresAt) => {
          await getRawSqlExecutor(db).run(sql`UPDATE test_execution_attempt SET claim_expires_at = ${claimExpiresAt}
            WHERE execution_attempt_id = ${executionAttemptId}`);
        },
        clearStoredBootstrapDeadline: async (executionAttemptId) => {
          await getRawSqlExecutor(db).run(sql`UPDATE test_execution_attempt SET bootstrap_deadline_at = NULL
            WHERE execution_attempt_id = ${executionAttemptId}`);
        },
        seedRecoverableAttempts: async (input) => {
          await createRecoverySeedCandidates(repository, input);
          for (const entry of input.entries) {
            await getRawSqlExecutor(db).run(sql`UPDATE test_execution_attempt
              SET created_at = ${entry.createdAt}, claimable = 1, claim_expires_at = NULL
              WHERE execution_attempt_id = ${entry.executionAttemptId}`);
          }
        },
        dispose: store.close,
      };
    } catch (setupError) {
      try {
        await store.close();
      } catch (cleanupError) {
        throw new AggregateError([setupError, cleanupError], 'Repository setup and cleanup both failed');
      }
      throw setupError;
    }
  },
} satisfies ExecutionAttemptRepositoryContractFactory;

for (const factory of [MEMORY_FACTORY, SQLITE_FACTORY]) {
  runExecutionAttemptRepositoryContract(factory);
  describe(`execution attempt reference bootstrap timing (${factory.name})`, () => {
    it('captures creation and bootstrap deadline from exactly one clock observation', async () => {
      const harness = await factory.create(workflowRunResultOutcomeCodec);
      try {
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
      } finally {
        await harness.dispose();
      }
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
    ])('rejects invalid or overflowing bootstrap budget %s with the reference RangeError', async (bootstrapTimeoutMs) => {
      const harness = await factory.create(workflowRunResultOutcomeCodec);
      try {
        await expect(
          harness.repository.createAttempt({
            ...nextIds(),
            instruction: makeTestInstruction(),
            bootstrapTimeoutMs,
          }),
        ).rejects.toThrow(RangeError);
      } finally {
        await harness.dispose();
      }
    });
  });
}

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

describe('provider-operation completion across SQLite restart', () => {
  it('retains early completion proof as recoverable debt until a restarted owner settles the attempt', async () => {
    const context = await createTempDb('provider-operation-early-proof-restart');
    let reopened: Awaited<ReturnType<typeof createDatabaseClient>> | undefined;
    try {
      const repository = await createSqliteAttemptRepository(context.db, workflowRunResultOutcomeCodec);
      const ids = nextIds();
      await repository.createAttempt({
        ...ids,
        instruction: makeTestInstruction(),
        bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
      });
      const provisioning = await repository.beginProvisioning(
        makeBeginProvisioningInput(ids.executionAttemptId, ids.executionId),
      );
      if (provisioning.kind !== 'started') throw new Error(`Expected provisioning, got '${provisioning.kind}'`);
      const evidence = makeEvidence({
        source: 'provider-restart-test',
        summary: 'provider cleanup completed before the owner persisted its answer',
      });
      expect(await repository.completeProviderOperation({ claim: provisioning.claim, evidence })).toEqual({
        kind: 'evidence-recorded',
      });

      await context.close();
      reopened = await createDatabaseClient({ url: `file:${context.dbPath}` });
      const restarted = await createSqliteAttemptRepository(reopened.db, workflowRunResultOutcomeCodec);
      const observedAt = new Date(Date.parse(provisioning.claim.leaseExpiresAt) + 1).toISOString();
      await expect(restarted.recovery.listOpenProviderOperations({ observedAt, limit: 1 })).resolves.toContainEqual({
        attempt: expect.objectContaining({ executionAttemptId: ids.executionAttemptId, settlementKind: null }),
        operation: expect.objectContaining({ completionEvidence: evidence }),
      });

      const outcome = restarted.canonicalizeOutcome(makeTestWorkflowResult(ids.executionId));
      expect(await restarted.commitOutcome({ ...ids, result: outcome })).toMatchObject({ kind: 'accepted' });
      await expect(restarted.recovery.listOpenProviderOperations({ observedAt, limit: 1 })).resolves.toEqual([]);
    } finally {
      await reopened?.close();
      context.cleanup();
    }
  });

  it('rediscovers settled but unfinished provider work after every original database handle closes', async () => {
    const context = await createTempDb('provider-operation-completion-restart');
    let reopened: Awaited<ReturnType<typeof createDatabaseClient>> | undefined;
    try {
      const repository = await createSqliteAttemptRepository(context.db, workflowRunResultOutcomeCodec);
      const ids = nextIds();
      await repository.createAttempt({
        ...ids,
        instruction: makeTestInstruction(),
        bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
      });
      const provisioning = await repository.beginProvisioning(
        makeBeginProvisioningInput(ids.executionAttemptId, ids.executionId),
      );
      if (provisioning.kind !== 'started') throw new Error(`Expected provisioning, got '${provisioning.kind}'`);
      expect(
        await repository.recordAllocation({ claim: provisioning.claim, allocationRef: makeTestAllocationRef() }),
      ).toEqual({ kind: 'recorded' });
      const outcome = repository.canonicalizeOutcome(makeTestWorkflowResult(ids.executionId));
      expect(await repository.commitOutcome({ ...ids, result: outcome })).toMatchObject({ kind: 'accepted' });

      // This is a process restart, not a second repository wrapper around a
      // live connection: every original client closes before the new Authority
      // can observe the durable provider obligation.
      await context.close();
      reopened = await createDatabaseClient({ url: `file:${context.dbPath}` });
      const restarted = await createSqliteAttemptRepository(reopened.db, workflowRunResultOutcomeCodec);
      expect(
        (
          await restarted.recovery.listOpenProviderOperations({
            observedAt: new Date(Date.parse(provisioning.claim.leaseExpiresAt) + 1).toISOString(),
            limit: 1,
          })
        ).map(({ attempt }) => attempt.executionAttemptId),
      ).toEqual([ids.executionAttemptId]);
    } finally {
      await reopened?.close();
      context.cleanup();
    }
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
