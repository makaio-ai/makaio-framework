import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { sql } from 'drizzle-orm';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import { MakaioBus } from '@makaio/bus-core';
import { SessionEventStorageSubjects } from '../namespace.js';
import { createEvent, createTestDb, insertTestSession } from './shared.js';
import { describeEventStorageBehavior } from './event-storage-behavior.js';

describe('registerDrizzleSessionEventStorage', () => {
  let cleanup: () => void;
  let db: MakaioDatabase;

  beforeEach(async () => {
    const ctx = await createTestDb();
    db = ctx.db;
    cleanup = ctx.cleanup;
  });

  afterEach(() => cleanup());

  // Shared behavioral tests (pagination, getByIds, deleteBySession, etc.)
  describeEventStorageBehavior({
    ensureSession: (sessionId) => insertTestSession(db, sessionId),
  });

  describe('append', () => {
    it('should persist event to SQLite', async () => {
      // Create session first (FK constraint)
      await insertTestSession(db, 'session-1');

      const event = createEvent({
        sessionId: 'session-1',
        type: 'user_message.sent',
        content: 'Hello world',
      });

      const result = await MakaioBus.request(SessionEventStorageSubjects.append, { event });
      expect(result.success).toBe(true);

      // Verify in database
      const retrieved = await MakaioBus.request(SessionEventStorageSubjects.getEvents, {
        sessionId: 'session-1',
      });
      expect(retrieved.events).toHaveLength(1);
      expect(retrieved.events[0].eventId).toBe(event.eventId);
    });

    it('should persist branch.created payload fields', async () => {
      await insertTestSession(db, 'session-1');

      const event = createEvent({
        sessionId: 'session-1',
        type: 'branch.created',
        messageId: 'msg-fork-point',
      });

      const result = await MakaioBus.request(SessionEventStorageSubjects.append, { event });
      expect(result.success).toBe(true);

      const retrieved = await MakaioBus.request(SessionEventStorageSubjects.getEvents, {
        sessionId: 'session-1',
      });

      expect(retrieved.events).toHaveLength(1);
      const persisted = retrieved.events[0];
      if (persisted.type !== 'branch.created') {
        throw new Error(`Unexpected event type: ${persisted.type}`);
      }
      if (event.type !== 'branch.created') {
        throw new Error(`Unexpected input event type: ${event.type}`);
      }
      expect(persisted.payload).toEqual({
        childSessionId: event.payload.childSessionId,
        sessionId: 'session-1',
        parentSessionId: 'session-1',
        kind: 'fork',
        forkPointMessageId: 'msg-fork-point',
      });
    });
  });

  describe('getEvents', () => {
    it('should retrieve events by sessionId in append order (by id)', async () => {
      await insertTestSession(db, 'session-1');

      // Insert events with decreasing timestamps to verify ordering is by id, not timestamp
      const events = [
        createEvent({ sessionId: 'session-1', type: 'agent.added', timestamp: 3000 }),
        createEvent({ sessionId: 'session-1', type: 'user_message.sent', timestamp: 2000 }),
        createEvent({ sessionId: 'session-1', type: 'user_message.acknowledged', timestamp: 1000 }),
      ];

      for (const event of events) {
        await MakaioBus.request(SessionEventStorageSubjects.append, { event });
      }

      const result = await MakaioBus.request(SessionEventStorageSubjects.getEvents, {
        sessionId: 'session-1',
      });

      expect(result.events).toHaveLength(3);
      // Order should be by insertion (id), not by timestamp
      expect(result.events.map((e) => e.type)).toEqual([
        'agent.added',
        'user_message.sent',
        'user_message.acknowledged',
      ]);
    });

    it('should NOT return totalCount (unlike memory handler)', async () => {
      await insertTestSession(db, 'session-1');

      await MakaioBus.request(SessionEventStorageSubjects.append, {
        event: createEvent({ sessionId: 'session-1', type: 'agent.added' }),
      });
      await MakaioBus.request(SessionEventStorageSubjects.append, {
        event: createEvent({ sessionId: 'session-1', type: 'user_message.sent' }),
      });

      const result = await MakaioBus.request(SessionEventStorageSubjects.getEvents, {
        sessionId: 'session-1',
      });

      expect(result.events).toHaveLength(2);
      // Drizzle handler explicitly omits totalCount for performance
      expect(result.totalCount).toBeUndefined();
    });

    it('should return all events when no pagination is used', async () => {
      await insertTestSession(db, 'session-1');

      for (let i = 0; i < 3; i++) {
        await MakaioBus.request(SessionEventStorageSubjects.append, {
          event: createEvent({ sessionId: 'session-1', type: 'user_message.sent' }),
        });
      }

      const result = await MakaioBus.request(SessionEventStorageSubjects.getEvents, {
        sessionId: 'session-1',
      });

      expect(result.events).toHaveLength(3);
      expect(result.nextCursor).toBeNull();
    });

    it('should return nextCursor null when exactly at limit', async () => {
      await insertTestSession(db, 'session-1');

      for (let i = 0; i < 2; i++) {
        await MakaioBus.request(SessionEventStorageSubjects.append, {
          event: createEvent({ sessionId: 'session-1', type: 'user_message.sent' }),
        });
      }

      const result = await MakaioBus.request(SessionEventStorageSubjects.getEvents, {
        sessionId: 'session-1',
        options: { limit: 2 },
      });

      expect(result.events).toHaveLength(2);
      expect(result.nextCursor).toBeNull();
    });
  });

  describe('extractContentText', () => {
    it('should extract text content from user_message.sent with string content', async () => {
      await insertTestSession(db, 'session-1');

      await MakaioBus.request(SessionEventStorageSubjects.append, {
        event: createEvent({
          sessionId: 'session-1',
          type: 'user_message.sent',
          content: 'Hello, this is a test message',
        }),
      });

      const results = (
        (await db.all(sql`SELECT type, content_text FROM session_events`)) as { type: unknown; content_text: unknown }[]
      ).map((r) => ({
        type: String(r.type),
        content_text: r.content_text as string | null,
      }));

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        type: 'user_message.sent',
        content_text: 'Hello, this is a test message',
      });
    });

    it('should extract text content from user_message.sent with structured Message format', async () => {
      await insertTestSession(db, 'session-1');

      await MakaioBus.request(SessionEventStorageSubjects.append, {
        event: createEvent({
          sessionId: 'session-1',
          type: 'user_message.sent',
          content: {
            blocks: [
              { type: 'text', content: 'First paragraph' },
              { type: 'text', content: 'Second paragraph' },
            ],
          },
        }),
      });

      const allRows = (await db.all(sql`SELECT content_text FROM session_events`)) as { content_text: unknown }[];
      const contentText = allRows[0].content_text as string;

      expect(contentText).toBe('First paragraph\nSecond paragraph');
    });

    it('should extract contentText from plugin summary payloads', async () => {
      await insertTestSession(db, 'session-1');

      await MakaioBus.request(SessionEventStorageSubjects.append, {
        event: createEvent({
          sessionId: 'session-1',
          type: 'timeline.summary',
        }),
      });

      const allRows = (await db.all(sql`SELECT content_text FROM session_events`)) as { content_text: unknown }[];
      const contentText = allRows[0].content_text as string;

      expect(contentText).toBe('Test summary');
    });

    it('should return null contentText for structural events', async () => {
      await insertTestSession(db, 'session-1');

      const structuralTypes = [
        'agent.added',
        'user_message.acknowledged',
        'user_message.completed',
        'turn.started',
        'turn.completed',
        'branch.created',
        'branch.merged',
        'squash',
      ] as const;

      for (const type of structuralTypes) {
        await MakaioBus.request(SessionEventStorageSubjects.append, {
          event: createEvent({ sessionId: 'session-1', type }),
        });
      }

      const results = (
        (await db.all(sql`SELECT type, content_text FROM session_events ORDER BY id`)) as {
          type: unknown;
          content_text: unknown;
        }[]
      ).map((r) => ({
        type: String(r.type),
        content_text: r.content_text as string | null,
      }));

      expect(results).toHaveLength(structuralTypes.length);
      for (const result of results) {
        expect(result.content_text).toBeNull();
      }
    });
  });

  describe('metadata extraction', () => {
    it('should extract agentId from agent.added events', async () => {
      await insertTestSession(db, 'session-1');

      const event = createEvent({
        sessionId: 'session-1',
        type: 'agent.added',
        agentId: 'test-agent-123',
        adapterId: 'test-adapter-456',
      });
      await MakaioBus.request(SessionEventStorageSubjects.append, { event });

      const allRows = (await db.all(sql`SELECT agent_id, adapter_id FROM session_events`)) as {
        agent_id: unknown;
        adapter_id: unknown;
      }[];
      const row = allRows[0];

      expect(row.agent_id).toBe('test-agent-123');
      expect(row.adapter_id).toBe('test-adapter-456');
    });

    it('should extract turnId and originatingMessageId from user_message events', async () => {
      await insertTestSession(db, 'session-1');

      const event = createEvent({
        sessionId: 'session-1',
        type: 'user_message.sent',
        turnId: 'turn-abc',
        messageId: 'msg-xyz',
      });
      await MakaioBus.request(SessionEventStorageSubjects.append, { event });

      const allRows = (await db.all(sql`SELECT turn_id, originating_message_id FROM session_events`)) as {
        turn_id: unknown;
        originating_message_id: unknown;
      }[];
      const row = allRows[0];

      expect(row.turn_id).toBe('turn-abc');
      expect(row.originating_message_id).toBe('msg-xyz');
    });
  });

  describe('getByIds', () => {
    it('should preserve chronological order by timestamp', async () => {
      await insertTestSession(db, 'session-1');

      // Insert events with specific timestamps (out of order insertion)
      const event1 = createEvent({ sessionId: 'session-1', type: 'agent.added', eventId: 'evt-1', timestamp: 3000 });
      const event2 = createEvent({
        sessionId: 'session-1',
        type: 'user_message.sent',
        eventId: 'evt-2',
        timestamp: 1000,
      });
      const event3 = createEvent({ sessionId: 'session-1', type: 'turn.completed', eventId: 'evt-3', timestamp: 2000 });

      await MakaioBus.request(SessionEventStorageSubjects.append, { event: event1 });
      await MakaioBus.request(SessionEventStorageSubjects.append, { event: event2 });
      await MakaioBus.request(SessionEventStorageSubjects.append, { event: event3 });

      const result = await MakaioBus.request(SessionEventStorageSubjects.getByIds, {
        sessionId: 'session-1',
        eventIds: ['evt-1', 'evt-2', 'evt-3'],
      });

      // Should be ordered by timestamp (ascending)
      expect(result.events.map((e) => e.eventId)).toEqual(['evt-2', 'evt-3', 'evt-1']);
    });
  });
});
