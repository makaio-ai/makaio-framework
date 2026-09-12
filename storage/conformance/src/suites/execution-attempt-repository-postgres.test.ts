/**
 * PostgreSQL conformance for the public execution-attempt repository adapter.
 *
 * The harness owns the isolation schema and its migration pool. Every
 * repository controller below uses a separately opened sibling pool, which is
 * the process-equivalent boundary this port must support.
 */
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createPostgresExecutionAttemptRepository } from '@makaio/storage-pg';
import {
  driveTestAttemptToAllocated,
  makeBeginProvisioningInput,
  makeTestInstruction,
  makeTestWorkflowResult,
  workflowRunResultOutcomeCodec,
} from '@makaio/subsystem-workflow-engine/testing';
import {
  runExecutionAttemptRepositoryContract,
  type ExecutionAttemptRepositoryContractFactory,
  type RecoverableAttemptsSeed,
} from '@makaio/subsystem-workflow-engine/testing/conformance';
import type {
  ExecutionAttemptRepository,
  OutcomeCodec,
} from '@makaio/subsystem-workflow-engine/execution-attempt-repository';
import type { SiblingClient } from '../harness/config.js';
import { describeStorageConformance } from '../harness/env.js';
import { useSuiteDatabaseContext } from '../harness/suite-context.js';

const BOOTSTRAP_TIMEOUT_MS = 60_000;

/**
 * Close every repository-owned pool, retaining every failure for diagnosis.
 * @param pools - Sibling pools opened exclusively for repository controllers.
 */
async function closeRepositoryPools(pools: readonly SiblingClient[]): Promise<void> {
  const results = await Promise.allSettled(pools.map((pool) => pool.close()));
  const failures = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Execution-attempt repository pool cleanup failed');
  }
}

/**
 * Seed fully allocated recovery candidates through the public port before
 * restoring their shared recovery eligibility with the narrowly scoped hook.
 * @param repository - Public repository used to create each valid candidate.
 * @param input - Ordered recovery candidates and their shared execution owner.
 */
async function createRecoverySeedCandidates<TOutcome>(
  repository: Required<ExecutionAttemptRepository<TOutcome>>,
  input: RecoverableAttemptsSeed,
): Promise<void> {
  for (const entry of input.entries) {
    await repository.createAttempt({
      executionId: input.executionId,
      executionAttemptId: entry.executionAttemptId,
      instruction: makeTestInstruction(),
      bootstrapTimeoutMs: BOOTSTRAP_TIMEOUT_MS,
    });
    await driveTestAttemptToAllocated(repository, entry.executionAttemptId, input.executionId);
  }
}

describeStorageConformance('execution-attempt repository postgres', (config) => {
  const describePostgres = config.dialect === 'postgres' ? describe : describe.skip;

  describePostgres('public PostgreSQL execution-attempt repository', () => {
    const getCtx = useSuiteDatabaseContext(config);
    const POSTGRES_FACTORY = {
      name: 'postgres',
      async create<TOutcome>(codec: OutcomeCodec<TOutcome>) {
        const ctx = getCtx();
        const pools: SiblingClient[] = [];
        try {
          const repositoryPool = await ctx.createSiblingClient();
          pools.push(repositoryPool);
          const peerPool = await ctx.createSiblingClient();
          pools.push(peerPool);

          const [repository, peer] = await Promise.all([
            createPostgresExecutionAttemptRepository(repositoryPool.db, codec),
            createPostgresExecutionAttemptRepository(peerPool.db, codec),
          ]);

          return {
            repository,
            peer,
            writeStoredOutcomeText: async (executionAttemptId, text) => {
              await repositoryPool.executor.run(sql`
                UPDATE execution_attempt
                SET outcome_text = ${text}
                WHERE execution_attempt_id = ${executionAttemptId}
              `);
            },
            setClaimExpiry: async (executionAttemptId, claimExpiresAt) => {
              await repositoryPool.executor.run(sql`
                UPDATE execution_attempt
                SET claim_expires_at = ${claimExpiresAt}
                WHERE execution_attempt_id = ${executionAttemptId}
              `);
            },
            clearStoredBootstrapDeadline: async (executionAttemptId) => {
              await repositoryPool.executor.run(sql`
                UPDATE execution_attempt
                SET bootstrap_deadline_at = NULL
                WHERE execution_attempt_id = ${executionAttemptId}
              `);
            },
            seedRecoverableAttempts: async (input) => {
              await createRecoverySeedCandidates(repository, input);
              for (const entry of input.entries) {
                await repositoryPool.executor.run(sql`
                  UPDATE execution_attempt
                  SET created_at = ${entry.createdAt}, claimable = 1, claim_expires_at = NULL
                  WHERE execution_attempt_id = ${entry.executionAttemptId}
                `);
              }
            },
            dispose: () => closeRepositoryPools(pools),
          };
        } catch (setupError) {
          try {
            await closeRepositoryPools(pools);
          } catch (cleanupError) {
            throw new AggregateError(
              [setupError, cleanupError],
              'Execution-attempt repository setup and cleanup both failed',
            );
          }
          throw setupError;
        }
      },
    } satisfies ExecutionAttemptRepositoryContractFactory;

    runExecutionAttemptRepositoryContract(POSTGRES_FACTORY);

    it('recovers a settled outcome and a separate open provider operation after every repository pool closes', async () => {
      const ctx = getCtx();
      const pools: SiblingClient[] = [];
      try {
        const writerPool = await ctx.createSiblingClient({ poolMax: 1 });
        pools.push(writerPool);
        const readerPool = await ctx.createSiblingClient({ poolMax: 1 });
        pools.push(readerPool);
        const [writer, reader] = await Promise.all([
          createPostgresExecutionAttemptRepository(writerPool.db, workflowRunResultOutcomeCodec),
          createPostgresExecutionAttemptRepository(readerPool.db, workflowRunResultOutcomeCodec),
        ]);
        const ids = {
          executionId: `postgres-reopen-execution-${crypto.randomUUID()}`,
          executionAttemptId: `postgres-reopen-attempt-${crypto.randomUUID()}`,
        };
        const created = await writer.createAttempt({
          ...ids,
          instruction: makeTestInstruction(),
          bootstrapTimeoutMs: BOOTSTRAP_TIMEOUT_MS,
        });
        await expect(reader.getActiveAttempt(ids.executionId, ids.executionAttemptId)).resolves.toEqual(created);

        const provisioning = await writer.beginProvisioning(
          makeBeginProvisioningInput(ids.executionAttemptId, ids.executionId),
        );
        if (provisioning.kind !== 'started') throw new Error(`Expected provisioning, got '${provisioning.kind}'`);
        const result = writer.canonicalizeOutcome(makeTestWorkflowResult(ids.executionId));
        await expect(writer.commitOutcome({ ...ids, result })).resolves.toMatchObject({
          kind: 'accepted',
          outcome: result.outcome,
          text: result.text,
        });

        const openIds = {
          executionId: `postgres-reopen-open-execution-${crypto.randomUUID()}`,
          executionAttemptId: `postgres-reopen-open-attempt-${crypto.randomUUID()}`,
        };
        await writer.createAttempt({
          ...openIds,
          instruction: makeTestInstruction(),
          bootstrapTimeoutMs: BOOTSTRAP_TIMEOUT_MS,
        });
        const openProvisioning = await writer.beginProvisioning(
          makeBeginProvisioningInput(openIds.executionAttemptId, openIds.executionId),
        );
        if (openProvisioning.kind !== 'started') {
          throw new Error(`Expected open provisioning, got '${openProvisioning.kind}'`);
        }

        await writerPool.close();
        await readerPool.close();
        const reopenedPool = await ctx.createSiblingClient({ poolMax: 1 });
        pools.push(reopenedPool);
        const reopened = await createPostgresExecutionAttemptRepository(reopenedPool.db, workflowRunResultOutcomeCodec);
        await expect(reopened.readAttemptSettlement(ids)).resolves.toMatchObject({
          kind: 'outcome',
          attempt: expect.objectContaining({
            ...ids,
            settlementKind: 'outcome',
          }),
          result,
        });
        await expect(
          reopened.recovery.listOpenProviderOperations({
            observedAt: new Date(Date.parse(openProvisioning.claim.leaseExpiresAt) + 1).toISOString(),
            limit: 10_000,
          }),
        ).resolves.toContainEqual(
          expect.objectContaining({
            attempt: expect.objectContaining(openIds),
            operation: expect.objectContaining(openProvisioning.claim),
          }),
        );
      } finally {
        await closeRepositoryPools(pools);
      }
    });
  });
});
