import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDatabaseClient } from '@makaio/storage-drizzle/client';
import { getRawSqlExecutor } from '@makaio/storage-drizzle';
import { ExecutionAttemptAuthority } from '../execution-attempt-authority.js';
import { DuplicateExecutionAttemptError, type OutcomeCodec } from '../execution-attempt-repository.js';
import { submitAttemptOutcome } from '../outcome-convergence.js';
import { makeTestInstruction } from '../testing/attempt-fixtures.js';
import { createSqliteAttemptRepository } from '../testing/sqlite.js';

const ResultSchema = z.object({ count: z.number(), details: z.object({ note: z.string() }) });
type Result = z.infer<typeof ResultSchema>;
const codec: OutcomeCodec<Result> = {
  parse: (input) => ResultSchema.parse(input),
  serialize: (outcome) => JSON.stringify(outcome, null, 2),
};
const request = { executionId: 'owner', requestKey: 'initial-demand', instruction: makeTestInstruction() };

/** Create a test store whose file outlives all original connection handles. */
async function createRecoveryStore() {
  const directory = await mkdtemp(join(tmpdir(), 'makaio-owner-recovery-'));
  const url = `file:${join(directory, 'attempts.db')}`;
  const clients: Awaited<ReturnType<typeof createDatabaseClient>>[] = [];
  const closeConnections = async () => {
    const results = await Promise.allSettled(clients.splice(0).map((client) => client.close()));
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length > 0) throw new AggregateError(failures.map((failure) => failure.reason));
  };
  return {
    async connect(bootstrapTimeoutMs = 60_000) {
      const client = await createDatabaseClient({ url });
      clients.push(client);
      const repository = await createSqliteAttemptRepository(client.db, codec);
      return {
        repository,
        authority: new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs }),
        raw: getRawSqlExecutor(client.db),
      };
    },
    closeConnections,
    async dispose() {
      try {
        await closeConnections();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

describe('durable owner request recovery', () => {
  let store: Awaited<ReturnType<typeof createRecoveryStore>>;
  beforeEach(async () => {
    store = await createRecoveryStore();
  });
  afterEach(async () => {
    await store.dispose();
  });

  it('recovers a lost response after closing every original handle and preserves the first deadline', async () => {
    const first = await store.connect();
    const peer = await store.connect();
    // Neither response is needed to repeat the owner's persisted demand.
    const decisions = await Promise.all([
      first.authority.ensureAttempt(request),
      peer.authority.ensureAttempt(request),
    ]);
    expect(decisions.map((decision) => decision.kind).sort()).toEqual(['created', 'replayed']);
    const original = decisions[0];
    if (original.kind === 'conflict') throw new Error('Unexpected initial conflict');
    await store.closeConnections();

    const restarted = await store.connect(Number.MAX_SAFE_INTEGER);
    const replay = await restarted.authority.ensureAttempt(request);
    expect(replay).toEqual({ kind: 'replayed', attempt: original.attempt });
    expect(
      await restarted.repository.readAttemptSettlement({
        executionId: request.executionId,
        executionAttemptId: original.attempt.executionAttemptId,
      }),
    ).toMatchObject({ kind: 'unsettled', isCurrentAttempt: true });
    expect(await restarted.raw.all(sql`SELECT execution_attempt_id FROM test_execution_attempt`)).toHaveLength(1);
  });

  it('recovers a committed but unconverged non-workflow result without another worker submission', async () => {
    const original = await store.connect();
    const ensured = await original.authority.ensureAttempt(request);
    if (ensured.kind === 'conflict') throw new Error('Unexpected initial conflict');
    const identity = { executionId: request.executionId, executionAttemptId: ensured.attempt.executionAttemptId };
    const outcome = { count: 3, details: { note: 'durable result' } };
    await expect(
      submitAttemptOutcome(
        {
          authority: original.authority,
          convergence: {
            async converge() {
              throw new Error('Owner unavailable after commit');
            },
          },
        },
        { ...identity, outcome },
      ),
    ).rejects.toThrow('Owner unavailable after commit');
    await store.closeConnections();

    const restarted = await store.connect();
    const recovered = await restarted.authority.readAttemptSettlement(identity);
    expect(recovered).toMatchObject({
      kind: 'outcome',
      isCurrentAttempt: true,
      result: { text: codec.serialize(outcome), outcome },
    });
    if (recovered.kind !== 'outcome') throw new Error('Expected durable outcome');
    recovered.result.outcome.details.note = 'caller mutation';
    expect(await restarted.authority.readAttemptSettlement(identity)).toMatchObject({
      kind: 'outcome',
      result: { text: codec.serialize(outcome), outcome },
    });
    expect(await restarted.authority.ensureAttempt(request)).toMatchObject({
      kind: 'replayed',
      attempt: { ...identity, status: 'settled' },
    });
  });

  it('rolls back creation, predecessor fencing and pointer movement when binding persistence fails', async () => {
    const { repository, raw } = await store.connect();
    const predecessor = await repository.createAttempt({
      ...request,
      executionAttemptId: 'old',
      bootstrapTimeoutMs: 60_000,
    });
    await raw.run(
      sql.raw(`CREATE TRIGGER reject_owner_request BEFORE INSERT ON test_execution_attempt_request
      BEGIN SELECT RAISE(ABORT, 'binding persistence failed'); END`),
    );
    const input = { ...request, executionAttemptId: 'new', bootstrapTimeoutMs: 60_000 };
    // The driver may wrap trigger errors; the contract is atomic rollback, not driver text.
    await expect(repository.ensureAttempt(input)).rejects.toThrow();
    expect(
      await repository.readAttemptSettlement({ executionId: request.executionId, executionAttemptId: 'old' }),
    ).toEqual({ kind: 'unsettled', attempt: predecessor, isCurrentAttempt: true });
    expect(await raw.all(sql`SELECT * FROM test_execution_attempt_request`)).toEqual([]);
    expect(await raw.all(sql`SELECT execution_attempt_id FROM test_execution_attempt`)).toEqual([
      { execution_attempt_id: 'old' },
    ]);
    await raw.run(sql.raw('DROP TRIGGER reject_owner_request'));
    await expect(repository.ensureAttempt(input)).resolves.toMatchObject({ kind: 'created' });
  });

  it('does not consume the request or fence a predecessor when the candidate identity collides', async () => {
    const { repository } = await store.connect();
    const original = await repository.createAttempt({
      ...request,
      executionAttemptId: 'existing',
      bootstrapTimeoutMs: 60_000,
    });
    await expect(
      repository.ensureAttempt({ ...request, executionAttemptId: 'existing', bootstrapTimeoutMs: 60_000 }),
    ).rejects.toBeInstanceOf(DuplicateExecutionAttemptError);
    expect(
      await repository.readAttemptSettlement({ executionId: request.executionId, executionAttemptId: 'existing' }),
    ).toEqual({ kind: 'unsettled', attempt: original, isCurrentAttempt: true });
    await expect(
      repository.ensureAttempt({ ...request, executionAttemptId: 'fresh', bootstrapTimeoutMs: 60_000 }),
    ).resolves.toMatchObject({ kind: 'created' });
  });

  it.each(['missing', 'wrong-owner'])('rejects a %s request binding without recreating it', async (corruption) => {
    const { repository, raw } = await store.connect();
    if (corruption === 'wrong-owner') {
      await repository.createAttempt({
        ...request,
        executionId: 'other-owner',
        executionAttemptId: 'bound',
        bootstrapTimeoutMs: 60_000,
      });
    }
    // Deliberately corrupt only this private fixture, not the public conformance harness.
    await raw.run(sql.raw('PRAGMA foreign_keys = OFF'));
    await raw.run(sql`INSERT INTO test_execution_attempt_request (execution_id, request_key, execution_attempt_id)
      VALUES (${request.executionId}, ${request.requestKey}, ${'bound'})`);
    await raw.run(sql.raw('PRAGMA foreign_keys = ON'));
    await expect(
      repository.ensureAttempt({ ...request, executionAttemptId: 'must-not-exist', bootstrapTimeoutMs: 60_000 }),
    ).rejects.toThrow('Corrupt execution attempt request binding');
    expect(
      await raw.all(sql`SELECT * FROM test_execution_attempt WHERE execution_attempt_id = ${'must-not-exist'}`),
    ).toEqual([]);
  });

  it.each([
    { status: 'pending', settlement: 'outcome', text: null },
    { status: 'pending', settlement: null, text: '{"count":1,"details":{"note":"bad tuple"}}' },
    { status: 'settled', settlement: null, text: null },
    { status: 'settled', settlement: 'outcome', text: null },
    { status: 'settled', settlement: 'abandoned', text: '{"count":1,"details":{"note":"bad tuple"}}' },
  ])('does not hide contradictory settlement facts: $status / $settlement / $text', async ({
    status,
    settlement,
    text,
  }) => {
    const { repository, raw } = await store.connect();
    await repository.ensureAttempt({ ...request, executionAttemptId: 'attempt', bootstrapTimeoutMs: 60_000 });
    await raw.run(sql`UPDATE test_execution_attempt SET status = ${status}, settlement_kind = ${settlement}, workflow_result = ${text}
      WHERE execution_attempt_id = ${'attempt'}`);
    await expect(
      repository.readAttemptSettlement({ executionId: request.executionId, executionAttemptId: 'attempt' }),
    ).rejects.toThrow('Corrupt execution attempt settlement facts');
  });
});
