import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getRawSqlExecutor } from '@makaio/storage-drizzle';
import { createRestartableTempDb } from '@makaio/test-utils/drizzle-harness';
import { createSqliteAttemptRepository } from '../testing/sqlite.js';
import { makeTestInstruction, workflowRunResultOutcomeCodec } from '../testing/index.js';

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
      const replacement = await createSqliteAttemptRepository(await store.connect(), workflowRunResultOutcomeCodec);
      expect(await replacement.readCancellation('attempt')).toEqual(intent);
      expect(await replacement.getAttemptControlState('attempt')).toMatchObject({ operationStartGate: 'closed' });
    } finally {
      await store.close();
    }
  });
});
