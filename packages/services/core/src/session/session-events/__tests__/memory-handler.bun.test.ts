import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { registerMemorySessionEventStorage } from '../memory-handler.js';
import { SessionEventStorageSubjects } from '../namespace.js';
import { createEvent } from './shared.js';
import { describeEventStorageBehavior } from './event-storage-behavior.js';

describe('registerMemorySessionEventStorage', () => {
  let cleanup: () => void;

  beforeEach(() => {
    cleanup = registerMemorySessionEventStorage(MakaioBus);
  });

  afterEach(() => {
    cleanup();
  });

  // Shared behavioral tests (pagination, getByIds, deleteBySession, etc.)
  describeEventStorageBehavior();

  describe('append', () => {
    it('should append event to storage', async () => {
      const event = createEvent({
        sessionId: 'session-1',
        type: 'user_message.sent',
      });

      const result = await MakaioBus.request(SessionEventStorageSubjects.append, { event });

      expect(result.success).toBe(true);
    });
  });

  describe('getEvents', () => {
    it('should retrieve events by sessionId in append order', async () => {
      const events = [
        createEvent({ sessionId: 'session-1', type: 'agent.added' }),
        createEvent({ sessionId: 'session-1', type: 'user_message.sent' }),
        createEvent({ sessionId: 'session-1', type: 'user_message.acknowledged' }),
        createEvent({ sessionId: 'session-1', type: 'user_message.completed' }),
        createEvent({ sessionId: 'session-1', type: 'turn.completed' }),
      ];

      for (const event of events) {
        await MakaioBus.request(SessionEventStorageSubjects.append, { event });
      }

      const result = await MakaioBus.request(SessionEventStorageSubjects.getEvents, {
        sessionId: 'session-1',
      });

      expect(result.events).toHaveLength(5);
      expect(result.events[0].type).toBe('agent.added');
      expect(result.events[1].type).toBe('user_message.sent');
      expect(result.events[2].type).toBe('user_message.acknowledged');
      expect(result.events[3].type).toBe('user_message.completed');
      expect(result.events[4].type).toBe('turn.completed');
      expect(result.nextCursor).toBeNull();
    });

    it('should return totalCount', async () => {
      await MakaioBus.request(SessionEventStorageSubjects.append, {
        event: createEvent({ sessionId: 'session-1', type: 'agent.added' }),
      });
      await MakaioBus.request(SessionEventStorageSubjects.append, {
        event: createEvent({ sessionId: 'session-1', type: 'user_message.sent' }),
      });
      await MakaioBus.request(SessionEventStorageSubjects.append, {
        event: createEvent({ sessionId: 'session-1', type: 'turn.completed' }),
      });

      const result = await MakaioBus.request(SessionEventStorageSubjects.getEvents, {
        sessionId: 'session-1',
      });

      expect(result.totalCount).toBe(3);
    });

    it('should return empty for unknown session with totalCount 0', async () => {
      const result = await MakaioBus.request(SessionEventStorageSubjects.getEvents, {
        sessionId: 'unknown',
      });

      expect(result.events).toHaveLength(0);
      expect(result.nextCursor).toBeNull();
      expect(result.totalCount).toBe(0);
    });

    it.each([
      // seqIds are 1, 2, 3 — cursor 100 is past the newest, so asc returns nothing
      { desc: 'out-of-range cursor ascending', options: { after: '100' } },
      // seqIds start at 1 — cursor 0 is before the oldest, so desc returns nothing
      { desc: 'cursor before oldest seqId descending', options: { order: 'desc' as const, after: '0' } },
    ])('should return empty result for $desc', async ({ options }) => {
      for (let i = 1; i <= 3; i++) {
        await MakaioBus.request(SessionEventStorageSubjects.append, {
          event: createEvent({
            sessionId: 'session-1',
            type: 'user_message.sent',
            eventId: `evt-${i}`,
          }),
        });
      }

      const result = await MakaioBus.request(SessionEventStorageSubjects.getEvents, {
        sessionId: 'session-1',
        options,
      });

      expect(result.events).toHaveLength(0);
      expect(result.nextCursor).toBeNull();
      expect(result.totalCount).toBe(3);
    });
  });

  describe('deleteBySession', () => {
    it('should remove deleted session events', async () => {
      const event1 = createEvent({ sessionId: 'session-1', type: 'user_message.sent', eventId: 'evt-1' });
      const event2 = createEvent({ sessionId: 'session-1', type: 'turn.completed', eventId: 'evt-2' });
      const event3 = createEvent({ sessionId: 'session-2', type: 'user_message.sent', eventId: 'evt-3' });

      await MakaioBus.request(SessionEventStorageSubjects.append, { event: event1 });
      await MakaioBus.request(SessionEventStorageSubjects.append, { event: event2 });
      await MakaioBus.request(SessionEventStorageSubjects.append, { event: event3 });

      await MakaioBus.request(SessionEventStorageSubjects.deleteBySession, { sessionId: 'session-1' });

      const result = await MakaioBus.request(SessionEventStorageSubjects.getEvents, {
        sessionId: 'session-1',
      });

      expect(result.events).toHaveLength(0);

      const session2Result = await MakaioBus.request(SessionEventStorageSubjects.getEvents, {
        sessionId: 'session-2',
      });
      expect(session2Result.events).toHaveLength(1);
      expect(session2Result.events[0].eventId).toBe('evt-3');
    });
  });

  describe('getByIds', () => {
    it('should handle empty eventIds array', async () => {
      const event1 = createEvent({ sessionId: 'session-1', type: 'agent.added', eventId: 'evt-1' });

      await MakaioBus.request(SessionEventStorageSubjects.append, { event: event1 });

      const result = await MakaioBus.request(SessionEventStorageSubjects.getByIds, {
        sessionId: 'session-1',
        eventIds: [],
      });

      expect(result.events).toHaveLength(0);
    });
  });
});
