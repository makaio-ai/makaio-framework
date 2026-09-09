import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getRawSqlExecutor } from '@makaio/storage-drizzle';
import { createRestartableTempDb } from '@makaio/test-utils/drizzle-harness';
import { createSqliteAttemptRepository } from '../testing/sqlite.js';
import { makeTestInstruction, makeTestWorkflowResult, workflowRunResultOutcomeCodec } from '../testing/index.js';

describe('SQLite cancellation durability', () => {
  it('reloads intent after reconnecting and rolls back intent if closing the start gate fails', async () => {
    const store = createRestartableTempDb('attempt-cancellation-durability');
    try {
      const db = await store.connect();
      const repository = await createSqliteAttemptRepository(db, workflowRunResultOutcomeCodec);
      await repository.createAttempt({
        executionId: 'owner',
        executionAttemptId: 'attempt',
        instruction: makeTestInstruction(),
        bootstrapTimeoutMs: 60_000,
      });
      const executor = getRawSqlExecutor(db);
      await executor.run(
        sql.raw(`CREATE TRIGGER reject_cancel_gate BEFORE UPDATE OF operation_start_gate
        ON test_execution_attempt BEGIN SELECT RAISE(ABORT, 'gate write rejected'); END`),
      );
      await expect(repository.requestCancellation({ executionId: 'owner' })).rejects.toThrow();
      expect(await repository.readCancellation('attempt')).toBeNull();
      expect(await repository.getAttemptControlState('attempt')).toMatchObject({ operationStartGate: 'open' });
      await executor.run(sql.raw('DROP TRIGGER reject_cancel_gate'));
      await repository.requestCancellation({ executionId: 'owner', reason: 'operator' });
      const intent = await repository.readCancellation('attempt');
      expect(intent).toMatchObject({ requestKey: expect.any(String), controlRevision: 1, reason: 'operator' });
      await store.closeConnections();
      const replacement = await createSqliteAttemptRepository(await store.connect(), workflowRunResultOutcomeCodec);
      expect(await replacement.readCancellation('attempt')).toEqual(intent);
      expect(await replacement.getAttemptControlState('attempt')).toMatchObject({ operationStartGate: 'closed' });
    } finally {
      await store.close();
    }
  });

  it('rolls back an exact receipt with admission closure and replays the original receipt after restart', async () => {
    const store = createRestartableTempDb('attempt-exact-cancellation-durability');
    try {
      const db = await store.connect();
      const repository = await createSqliteAttemptRepository(db, workflowRunResultOutcomeCodec);
      const ids = { executionId: 'owner', executionAttemptId: 'attempt' };
      await repository.createAttempt({ ...ids, instruction: makeTestInstruction(), bootstrapTimeoutMs: 60_000 });
      const executor = getRawSqlExecutor(db);
      await executor.run(
        sql.raw(`CREATE TRIGGER reject_exact_cancel_gate BEFORE UPDATE OF operation_start_gate
        ON test_execution_attempt BEGIN SELECT RAISE(ABORT, 'gate write rejected'); END`),
      );
      const input = { ...ids, requestKey: 'operator-request', reason: 'operator' };
      await expect(repository.requestAttemptCancellation(input)).rejects.toThrow();
      expect(await repository.readCancellation(ids.executionAttemptId)).toBeNull();
      expect(await repository.getAttemptControlState(ids.executionAttemptId)).toMatchObject({
        operationStartGate: 'open',
      });
      await executor.run(sql.raw('DROP TRIGGER reject_exact_cancel_gate'));
      const accepted = await repository.requestAttemptCancellation(input);
      expect(accepted.kind).toBe('accepted');
      const receipt = await repository.readCancellation(ids.executionAttemptId);
      await store.closeConnections();
      const restarted = await createSqliteAttemptRepository(await store.connect(), workflowRunResultOutcomeCodec);
      expect(await restarted.requestAttemptCancellation(input)).toEqual({ kind: 'replayed', intent: receipt });
      expect(await restarted.requestAttemptCancellation({ ...input, reason: 'different' })).toEqual({
        kind: 'conflict',
      });
      expect(await restarted.readCancellation(ids.executionAttemptId)).toEqual(receipt);
    } finally {
      await store.close();
    }
  });

  it('rolls back outcome evidence together and preserves the accepted observation across later cancellation and restart', async () => {
    const store = createRestartableTempDb('attempt-outcome-control-durability');
    try {
      const db = await store.connect();
      const repository = await createSqliteAttemptRepository(db, workflowRunResultOutcomeCodec);
      const ids = { executionId: 'owner', executionAttemptId: 'attempt' };
      await repository.createAttempt({ ...ids, instruction: makeTestInstruction(), bootstrapTimeoutMs: 60_000 });
      const result = repository.canonicalizeOutcome(makeTestWorkflowResult(ids.executionId));
      const executor = getRawSqlExecutor(db);
      await executor.run(
        sql.raw(`CREATE TRIGGER reject_outcome_settlement BEFORE UPDATE OF settlement_kind
        ON test_execution_attempt BEGIN SELECT RAISE(ABORT, 'settlement write rejected'); END`),
      );
      await expect(repository.commitOutcome({ ...ids, result })).rejects.toThrow();
      expect(
        await executor.all(sql`SELECT workflow_result, outcome_control_observation FROM test_execution_attempt
        WHERE execution_attempt_id = ${ids.executionAttemptId}`),
      ).toEqual([{ workflow_result: null, outcome_control_observation: null }]);
      await executor.run(sql.raw('DROP TRIGGER reject_outcome_settlement'));
      const accepted = await repository.commitOutcome({ ...ids, result });
      expect(accepted).toMatchObject({
        kind: 'accepted',
        controlObservation: { controlRevision: 0, cancellation: null },
      });
      await repository.requestCancellation({ executionId: ids.executionId, reason: 'cleanup' });
      await store.closeConnections();
      const restarted = await createSqliteAttemptRepository(await store.connect(), workflowRunResultOutcomeCodec);
      expect(await restarted.commitOutcome({ ...ids, result })).toEqual({ ...accepted, kind: 'duplicate' });
      expect(await restarted.readAttemptSettlement(ids)).toMatchObject({
        kind: 'outcome',
        controlObservation: { controlRevision: 0, cancellation: null },
      });
      expect(await restarted.readCancellation(ids.executionAttemptId)).toMatchObject({ controlRevision: 1 });
    } finally {
      await store.close();
    }
  });

  it('assigns stable correlation to legacy cancellations without inventing legacy outcome ordering', async () => {
    const store = createRestartableTempDb('attempt-legacy-control-durability');
    try {
      const db = await store.connect();
      const repository = await createSqliteAttemptRepository(db, workflowRunResultOutcomeCodec);
      const ids = { executionId: 'owner', executionAttemptId: 'attempt' };
      await repository.createAttempt({ ...ids, instruction: makeTestInstruction(), bootstrapTimeoutMs: 60_000 });
      const result = repository.canonicalizeOutcome(makeTestWorkflowResult(ids.executionId));
      await repository.commitOutcome({ ...ids, result });
      const executor = getRawSqlExecutor(db);
      // Recreate the old durable column shapes, preserving a real committed outcome.
      await executor.run(sql.raw('ALTER TABLE test_execution_attempt DROP COLUMN outcome_control_observation'));
      await executor.run(sql.raw('DROP TABLE test_execution_attempt_cancellation'));
      await executor.run(
        sql.raw(`CREATE TABLE test_execution_attempt_cancellation (
        execution_attempt_id TEXT PRIMARY KEY, requested_at TEXT NOT NULL, reason TEXT)`),
      );
      const requestedAt = '2026-09-09T00:00:00.000Z';
      await executor.run(sql`INSERT INTO test_execution_attempt_cancellation
        (execution_attempt_id, requested_at, reason) VALUES (${ids.executionAttemptId}, ${requestedAt}, ${'legacy'})`);
      await executor.run(sql`UPDATE test_execution_attempt SET operation_start_gate = 'closed'
        WHERE execution_attempt_id = ${ids.executionAttemptId}`);
      await store.closeConnections();
      const migrated = await createSqliteAttemptRepository(await store.connect(), workflowRunResultOutcomeCodec);
      const receipt = await migrated.readCancellation(ids.executionAttemptId);
      expect(receipt).toEqual({ requestKey: expect.any(String), controlRevision: 1, requestedAt, reason: 'legacy' });
      expect(await migrated.commitOutcome({ ...ids, result })).toMatchObject({
        kind: 'duplicate',
        controlObservation: null,
      });
      expect(await migrated.readAttemptSettlement(ids)).toMatchObject({ kind: 'outcome', controlObservation: null });
      await migrated.requestCancellation({ executionId: ids.executionId, reason: 'later cleanup' });
      await store.closeConnections();
      const restarted = await createSqliteAttemptRepository(await store.connect(), workflowRunResultOutcomeCodec);
      expect(await restarted.readCancellation(ids.executionAttemptId)).toEqual(receipt);
      expect(await restarted.readAttemptSettlement(ids)).toMatchObject({ kind: 'outcome', controlObservation: null });
    } finally {
      await store.close();
    }
  });

  it('reloads the exact cancellation observation captured before outcome commit', async () => {
    const store = createRestartableTempDb('attempt-cancel-before-outcome');
    try {
      const repository = await createSqliteAttemptRepository(await store.connect(), workflowRunResultOutcomeCodec);
      const ids = { executionId: 'owner', executionAttemptId: 'attempt' };
      await repository.createAttempt({ ...ids, instruction: makeTestInstruction(), bootstrapTimeoutMs: 60_000 });
      await repository.requestAttemptCancellation({ ...ids, requestKey: 'cancel-first', reason: 'operator' });
      const cancellation = await repository.readCancellation(ids.executionAttemptId);
      const result = repository.canonicalizeOutcome(makeTestWorkflowResult(ids.executionId));
      const accepted = await repository.commitOutcome({ ...ids, result });
      const controlObservation = { controlRevision: 1, cancellation };
      expect(accepted).toMatchObject({ kind: 'accepted', controlObservation });
      await store.closeConnections();
      const restarted = await createSqliteAttemptRepository(await store.connect(), workflowRunResultOutcomeCodec);
      expect(await restarted.commitOutcome({ ...ids, result })).toEqual({ ...accepted, kind: 'duplicate' });
      expect(await restarted.readAttemptSettlement(ids)).toMatchObject({ kind: 'outcome', controlObservation });
    } finally {
      await store.close();
    }
  });
});
