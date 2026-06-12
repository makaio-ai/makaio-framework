/**
 * Tests for list handler with includePreview option.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { MakaioBus } from '@makaio/bus-core';
import { SessionStorageSubjects } from '../namespace.js';
import { createTestDb, type TestDbContext } from './shared.js';

describe('list with includePreview', () => {
  let ctx: TestDbContext;
  let exec: TestDbContext['exec'];

  beforeEach(async () => {
    ctx = await createTestDb();
    exec = ctx.exec;

    // Create messages table for conversation content
    await exec(sql`
      CREATE TABLE IF NOT EXISTS messages (
        message_id TEXT PRIMARY KEY,
        turn_id TEXT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content_text TEXT NOT NULL,
        blocks TEXT NOT NULL DEFAULT '[]',
        agent_id TEXT,
        adapter_session_id TEXT,
        adapter_message_id TEXT,
        timestamp INTEGER NOT NULL,
        edit_of TEXT,
        origin TEXT
      )
    `);
  });

  afterEach(() => ctx.cleanup());

  it('should return sessions with title when available', async () => {
    // Create session with title
    await exec(sql`
      INSERT INTO sessions (session_id, created_at, last_activity_at, status, title)
      VALUES ('session-1', 1000, 2000, 'active', 'My Test Session')
    `);

    const result = await MakaioBus.request(SessionStorageSubjects.list, {
      includePreview: true,
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      sessionId: 'session-1',
      title: 'My Test Session',
      preview: {
        messageCount: 0,
        firstUserMessage: null,
      },
    });
  });

  it('should include first user message in preview', async () => {
    // Create session without title
    await exec(sql`
      INSERT INTO sessions (session_id, created_at, last_activity_at, status)
      VALUES ('session-2', 1000, 2000, 'active')
    `);

    // Add user message
    await exec(sql`
      INSERT INTO messages (message_id, session_id, role, content_text, timestamp)
      VALUES ('msg-1', 'session-2', 'user', 'Hello world!', 1500)
    `);

    const result = await MakaioBus.request(SessionStorageSubjects.list, {
      includePreview: true,
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      sessionId: 'session-2',
      title: undefined,
      preview: {
        messageCount: 1,
        firstUserMessage: 'Hello world!',
      },
    });
  });

  it('should order by lastActivityAt descending', async () => {
    await exec(sql`
      INSERT INTO sessions (session_id, created_at, last_activity_at, status, title)
      VALUES
        ('old-session', 1000, 1000, 'active', 'Old'),
        ('new-session', 2000, 3000, 'active', 'New')
    `);

    const result = await MakaioBus.request(SessionStorageSubjects.list, {
      includePreview: true,
    });

    expect(result.sessions[0].sessionId).toBe('new-session');
    expect(result.sessions[1].sessionId).toBe('old-session');
  });

  it('should support pagination', async () => {
    // Create 5 sessions
    for (let i = 1; i <= 5; i++) {
      await exec(sql`
        INSERT INTO sessions (session_id, created_at, last_activity_at, status, title)
        VALUES (${`session-${i}`}, ${i * 1000}, ${i * 1000}, 'active', ${`Session ${i}`})
      `);
    }

    const page1 = await MakaioBus.request(SessionStorageSubjects.list, {
      limit: 2,
      offset: 0,
      includePreview: true,
    });
    expect(page1.sessions).toHaveLength(2);
    expect(page1.total).toBe(5);

    const page2 = await MakaioBus.request(SessionStorageSubjects.list, {
      limit: 2,
      offset: 2,
      includePreview: true,
    });
    expect(page2.sessions).toHaveLength(2);
  });

  it('should scope preview and counts to paginated sessions only', async () => {
    await exec(sql`
      INSERT INTO sessions (session_id, created_at, last_activity_at, status, title)
      VALUES
        ('page-session-1', 1000, 3000, 'active', 'Page 1'),
        ('page-session-2', 1000, 2000, 'active', 'Page 2'),
        ('off-page-session', 1000, 1000, 'active', 'Off Page')
    `);

    await exec(sql`
      INSERT INTO messages (message_id, session_id, role, content_text, timestamp)
      VALUES
        ('p1-user-1', 'page-session-1', 'user', 'Preview for page session 1', 1100),
        ('p2-user-1', 'page-session-2', 'user', 'Preview for page session 2', 1200),
        ('off-user-1', 'off-page-session', 'user', 'Should not leak into page', 1300),
        ('off-user-2', 'off-page-session', 'assistant', 'Assistant content', 1400)
    `);

    const result = await MakaioBus.request(SessionStorageSubjects.list, {
      includePreview: true,
      limit: 1,
      offset: 0,
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.sessionId).toBe('page-session-1');
    expect(result.sessions[0]?.preview).toEqual({
      messageCount: 1,
      firstUserMessage: 'Preview for page session 1',
    });
  });

  it('should filter by status', async () => {
    await exec(sql`
      INSERT INTO sessions (session_id, created_at, last_activity_at, status, title)
      VALUES
        ('active-session', 1000, 1000, 'active', 'Active'),
        ('closed-session', 2000, 2000, 'closed', 'Closed')
    `);

    const activeOnly = await MakaioBus.request(SessionStorageSubjects.list, {
      status: 'active',
      includePreview: true,
    });
    expect(activeOnly.sessions).toHaveLength(1);
    expect(activeOnly.sessions[0].sessionId).toBe('active-session');

    const closedOnly = await MakaioBus.request(SessionStorageSubjects.list, {
      status: 'closed',
      includePreview: true,
    });
    expect(closedOnly.sessions).toHaveLength(1);
    expect(closedOnly.sessions[0].sessionId).toBe('closed-session');

    const all = await MakaioBus.request(SessionStorageSubjects.list, {
      status: 'all',
      includePreview: true,
    });
    expect(all.sessions).toHaveLength(2);
  });

  it('should not include preview when includePreview is false', async () => {
    await exec(sql`
      INSERT INTO sessions (session_id, created_at, last_activity_at, status, title)
      VALUES ('session-1', 1000, 2000, 'active', 'My Test Session')
    `);

    const result = await MakaioBus.request(SessionStorageSubjects.list, {
      includePreview: false,
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].preview).toBeUndefined();
  });
});
