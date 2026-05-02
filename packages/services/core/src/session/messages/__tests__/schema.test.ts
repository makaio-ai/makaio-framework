import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import { createTestMessageDb } from './shared.js';

describe('messages schema', () => {
  let cleanup: () => void;
  let db: MakaioDatabase;

  beforeEach(async () => {
    const ctx = await createTestMessageDb();
    db = ctx.db;
    cleanup = ctx.cleanup;
  });

  afterEach(() => cleanup());

  it('should allow null turnId for native imports', async () => {
    // Insert message without turnId
    await db.run(sql`
      INSERT INTO messages (message_id, session_id, role, content_text, blocks, timestamp)
      VALUES ('msg-1', 'session-1', 'user', 'Hello', '[]', ${Date.now()})
    `);

    const rows = await db.run(sql`SELECT * FROM messages WHERE message_id = 'msg-1'`);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].turn_id).toBeNull();
  });

  it('should still support turnId when provided', async () => {
    // Create a turn first
    await db.run(sql`INSERT INTO turns (turn_id, session_id) VALUES ('turn-1', 'session-1')`);

    // Insert message with turnId
    await db.run(sql`
      INSERT INTO messages (message_id, turn_id, session_id, role, content_text, blocks, timestamp)
      VALUES ('msg-2', 'turn-1', 'session-1', 'assistant', 'Hi there', '[]', ${Date.now()})
    `);

    const rows = await db.run(sql`SELECT * FROM messages WHERE message_id = 'msg-2'`);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].turn_id).toBe('turn-1');
  });

  it('should cascade delete messages when turn is deleted', async () => {
    // Create a turn
    await db.run(sql`INSERT INTO turns (turn_id, session_id) VALUES ('turn-2', 'session-1')`);

    // Insert message with turnId
    await db.run(sql`
      INSERT INTO messages (message_id, turn_id, session_id, role, content_text, blocks, timestamp)
      VALUES ('msg-3', 'turn-2', 'session-1', 'user', 'Test', '[]', ${Date.now()})
    `);

    // Delete the turn
    await db.run(sql`DELETE FROM turns WHERE turn_id = 'turn-2'`);

    // Message should be deleted via cascade
    const rows = await db.run(sql`SELECT * FROM messages WHERE message_id = 'msg-3'`);
    expect(rows.rows).toHaveLength(0);
  });

  it('should store adapterMessageId for CC message tracking', async () => {
    await db.run(sql`
      INSERT INTO messages (message_id, session_id, role, content_text, blocks, adapter_message_id, timestamp)
      VALUES ('msg-2', 'session-1', 'user', 'Hello', '[]', 'cc-uuid-123', ${Date.now()})
    `);

    const rows = await db.run(sql`SELECT * FROM messages WHERE message_id = 'msg-2'`);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].adapter_message_id).toBe('cc-uuid-123');
  });

  it('should allow querying by adapterMessageId for fork detection', async () => {
    const ts = Date.now();

    // Insert second session first (FK constraint)
    await db.run(sql`INSERT INTO sessions (session_id) VALUES ('session-2')`);

    await db.run(sql`
      INSERT INTO messages (message_id, session_id, role, content_text, blocks, adapter_message_id, timestamp)
      VALUES
        ('msg-a', 'session-1', 'user', 'Hello', '[]', 'shared-uuid', ${ts}),
        ('msg-b', 'session-2', 'user', 'Hello', '[]', 'shared-uuid', ${ts + 1})
    `);

    const rows = await db.run(sql`
      SELECT session_id FROM messages WHERE adapter_message_id = 'shared-uuid'
    `);
    expect(rows.rows).toHaveLength(2);
  });
});
