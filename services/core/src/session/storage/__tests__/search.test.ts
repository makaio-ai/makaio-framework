/**
 * Tests for FTS5 search handler.
 *
 * Uses content-backed FTS5 that auto-syncs with messages table via triggers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { MakaioBus } from '@makaio/bus-core';
import { installMessagesFtsTestSchema } from '../../testing/storage-test-schema.js';
import { SessionStorageSubjects } from '../namespace.js';
import { createTestDb, type TestDbContext } from './shared.js';

describe('search', () => {
  let ctx: TestDbContext;
  let exec: TestDbContext['exec'];

  beforeEach(async () => {
    ctx = await createTestDb();
    exec = ctx.exec;

    await installMessagesFtsTestSchema(ctx.db);

    // Create session and turn
    await exec(sql`
      INSERT INTO sessions (session_id, created_at, last_activity_at, status, title, metadata)
      VALUES (
        'session-1',
        1000,
        2000,
        'active',
        'Authentication Flow',
        '{"correlationId":"issue-117","labels":["downstream"]}'
      )
    `);

    await exec(sql`
      INSERT INTO turns (turn_id, session_id, started_at, status)
      VALUES ('turn-1', 'session-1', 1000, 'completed')
    `);

    // Insert messages (FTS auto-syncs via triggers)
    await exec(sql`
      INSERT INTO messages (message_id, turn_id, session_id, role, content_text, timestamp)
      VALUES
        ('msg-1', 'turn-1', 'session-1', 'user', 'How do I implement JWT authentication?', 1001),
        ('msg-2', 'turn-1', 'session-1', 'assistant', 'Here is how you implement JWT tokens...', 1002)
    `);
  });

  afterEach(() => ctx.cleanup());

  it('should find sessions by content', async () => {
    const result = await MakaioBus.request(SessionStorageSubjects.search, {
      query: 'JWT authentication',
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].sessionId).toBe('session-1');
    expect(result.sessions[0].metadata).toEqual({
      correlationId: 'issue-117',
      labels: ['downstream'],
    });
  });

  it('should return empty for no matches', async () => {
    const result = await MakaioBus.request(SessionStorageSubjects.search, {
      query: 'nonexistent topic',
    });

    expect(result).toMatchObject({ sessions: [], total: 0 });
  });

  it('should support partial word matching with wildcard', async () => {
    const result = await MakaioBus.request(SessionStorageSubjects.search, {
      query: 'authent*',
    });

    expect(result.sessions).toHaveLength(1);
  });

  it('should return empty for empty query', async () => {
    const result = await MakaioBus.request(SessionStorageSubjects.search, {
      query: '',
    });

    expect(result.sessions).toHaveLength(0);
  });

  it('should return empty for whitespace-only query', async () => {
    const result = await MakaioBus.request(SessionStorageSubjects.search, {
      query: '   ',
    });

    expect(result.sessions).toHaveLength(0);
  });

  it('should respect limit parameter', async () => {
    // Create another session with turn and message
    await exec(sql`
      INSERT INTO sessions (session_id, created_at, last_activity_at, status, title)
      VALUES ('session-2', 2000, 3000, 'active', 'Token Management')
    `);
    await exec(sql`
      INSERT INTO turns (turn_id, session_id, started_at, status)
      VALUES ('turn-2', 'session-2', 2000, 'completed')
    `);
    await exec(sql`
      INSERT INTO messages (message_id, turn_id, session_id, role, content_text, timestamp)
      VALUES ('msg-3', 'turn-2', 'session-2', 'user', 'How do JWT tokens expire?', 2001)
    `);

    const result = await MakaioBus.request(SessionStorageSubjects.search, {
      query: 'JWT',
      limit: 1,
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.total).toBe(2);
  });

  it('should filter search results by status', async () => {
    await exec(sql`
      INSERT INTO sessions (session_id, created_at, last_activity_at, status, title)
      VALUES ('session-2', 2000, 3000, 'archived', 'Archived JWT Notes')
    `);
    await exec(sql`
      INSERT INTO turns (turn_id, session_id, started_at, status)
      VALUES ('turn-2', 'session-2', 2000, 'completed')
    `);
    await exec(sql`
      INSERT INTO messages (message_id, turn_id, session_id, role, content_text, timestamp)
      VALUES ('msg-3', 'turn-2', 'session-2', 'user', 'JWT cleanup checklist', 2001)
    `);

    const result = await MakaioBus.request(SessionStorageSubjects.search, {
      query: 'JWT',
      status: 'active',
    });

    expect(result.total).toBe(1);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].sessionId).toBe('session-1');
  });

  it('should pick first inserted user message preview when timestamps collide', async () => {
    await exec(sql`
      INSERT INTO sessions (session_id, created_at, last_activity_at, status, title)
      VALUES ('session-collision', 4000, 5000, 'active', 'Collision Session')
    `);
    await exec(sql`
      INSERT INTO turns (turn_id, session_id, started_at, status)
      VALUES ('turn-collision', 'session-collision', 4000, 'completed')
    `);
    await exec(sql`
      INSERT INTO messages (message_id, turn_id, session_id, role, content_text, timestamp)
      VALUES
        ('msg-collision-a', 'turn-collision', 'session-collision', 'user', 'Collision first', 5001),
        ('msg-collision-b', 'turn-collision', 'session-collision', 'user', 'Collision second', 5001)
    `);

    const result = await MakaioBus.request(SessionStorageSubjects.search, {
      query: 'Collision',
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].sessionId).toBe('session-collision');
    expect(result.sessions[0].preview?.firstUserMessage).toBe('Collision first');
  });
});
