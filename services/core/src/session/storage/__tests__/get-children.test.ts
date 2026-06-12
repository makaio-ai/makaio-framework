/**
 * Tests for the getChildren handler.
 *
 * Focuses on fork-point translation: child sessions store the adapter message
 * ID of their fork point, and the handler must translate it to the Makaio
 * message ID of the parent session's copy — adapter message IDs are not
 * unique across sessions because forked sessions carry copies of ancestor
 * messages under the same adapter ID.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { MakaioBus } from '@makaio/bus-core';
import { installMessagesFtsTestSchema } from '../../testing/storage-test-schema.js';
import { SessionStorageSubjects } from '../namespace.js';
import { createTestDb, type TestDbContext } from './shared.js';

describe('getChildren', () => {
  let ctx: TestDbContext;
  let exec: TestDbContext['exec'];

  beforeEach(async () => {
    ctx = await createTestDb();
    exec = ctx.exec;

    await installMessagesFtsTestSchema(ctx.db);

    await exec(sql`
      INSERT INTO sessions (session_id, created_at, last_activity_at, status, parent_session_id, fork_point_message_id, branch_kind)
      VALUES
        ('parent-1', 1000, 1000, 'active', NULL, NULL, NULL),
        ('child-1', 2000, 2000, 'active', 'parent-1', 'adapter-msg-1', 'fork')
    `);
  });

  afterEach(() => ctx.cleanup());

  it('translates the fork point to the parent session message ID when other sessions carry copies of the adapter message', async () => {
    // The parent's copy is inserted first so an unscoped lookup would let the
    // child's copy (same adapter_message_id, later row) shadow it.
    await exec(sql`
      INSERT INTO messages (message_id, session_id, role, content_text, adapter_message_id, timestamp)
      VALUES
        ('parent-msg-1', 'parent-1', 'user', 'fork point message', 'adapter-msg-1', 1001),
        ('child-msg-1', 'child-1', 'user', 'fork point message', 'adapter-msg-1', 2001)
    `);

    const result = await MakaioBus.request(SessionStorageSubjects.getChildren, { sessionId: 'parent-1' });

    expect(result.children).toHaveLength(1);
    expect(result.children[0]).toMatchObject({
      sessionId: 'child-1',
      forkPointMessageId: 'parent-msg-1',
      branchKind: 'fork',
    });
  });

  it('falls back to the adapter message ID when the parent session has no matching message', async () => {
    // Only the child carries a copy of the fork-point message.
    await exec(sql`
      INSERT INTO messages (message_id, session_id, role, content_text, adapter_message_id, timestamp)
      VALUES ('child-msg-1', 'child-1', 'user', 'fork point message', 'adapter-msg-1', 2001)
    `);

    const result = await MakaioBus.request(SessionStorageSubjects.getChildren, { sessionId: 'parent-1' });

    expect(result.children).toHaveLength(1);
    expect(result.children[0].forkPointMessageId).toBe('adapter-msg-1');
  });

  it('returns empty children for a session without forks', async () => {
    const result = await MakaioBus.request(SessionStorageSubjects.getChildren, { sessionId: 'child-1' });

    expect(result.children).toEqual([]);
  });
});
