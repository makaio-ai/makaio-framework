import { describe, expect, it } from 'vitest';
import { createTempDb } from '@makaio/test-utils/drizzle-harness';
import { createDatabaseClient } from '@makaio/storage-drizzle/client';
import { ExecutionAttemptAuthority } from '../execution-attempt-authority.js';
import { createSqliteAttemptRepository } from '../testing/sqlite.js';
import {
  driveTestAttemptToAllocated,
  makeTestInstruction,
  workflowRunResultOutcomeCodec,
} from '../testing/attempt-fixtures.js';

describe('bootstrap authorization across durable Authority restart', () => {
  it('reads allocation after reopening SQLite and preserves the original deadline', async () => {
    const context = await createTempDb('bootstrap-start');
    const repository = await createSqliteAttemptRepository(context.db, workflowRunResultOutcomeCodec);
    const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 60_000 });
    const record = await authority.createAttempt('owner', makeTestInstruction());
    await driveTestAttemptToAllocated(authority, record.executionAttemptId, 'owner');
    const reopened = await createDatabaseClient({ url: `file:${context.dbPath}` });
    try {
      const nextRepository = await createSqliteAttemptRepository(reopened.db, workflowRunResultOutcomeCodec);
      const nextAuthority = new ExecutionAttemptAuthority(nextRepository, { bootstrapTimeoutMs: 1 });
      const identity = { executionId: 'owner', executionAttemptId: record.executionAttemptId };
      await expect(
        nextAuthority.awaitBootstrapStart(identity, {
          signal: new AbortController().signal,
          deadline: Date.now() + 35_000,
        }),
      ).resolves.toEqual({ status: 'permitted' });
      expect((await nextRepository.readBootstrapStartState(identity))?.bootstrapDeadlineAt).toBe(
        record.bootstrapDeadlineAt,
      );
    } finally {
      await reopened.close();
      context.cleanup();
    }
  });
});
