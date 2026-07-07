/**
 * Shared behavioral test suite for session event storage handlers.
 *
 * Both the Drizzle and memory backends implement the same contract
 * (SessionEventStorageSubjects). This module defines the shared
 * behavioral tests so each backend only needs to provide its setup
 * function and test backend-specific concerns separately.
 */
import { describe, it, expect } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import type { MakaioSessionEvent } from '@makaio/contracts';
import { SessionEventStorageSubjects } from '../namespace.js';
import { createEvent } from './shared.js';

/**
 * Optional hooks that a backend can provide to prepare for individual tests.
 * For example, the Drizzle backend needs to insert a session row before
 * inserting events due to FK constraints.
 */
export interface EventStorageBehaviorHooks {
  /** Called before tests that need a session to exist. */
  ensureSession?: (sessionId: string) => Promise<void>;
}

/**
 * Registers shared behavioral tests for any SessionEventStorage backend.
 *
 * Call this inside a `describe()` block after the backend's beforeEach/afterEach
 * lifecycle is configured. The hooks parameter allows the backend to perform
 * setup like inserting FK-required session rows.
 * @param hooks - Optional lifecycle hooks for backend-specific setup
 */
export function describeEventStorageBehavior(hooks: EventStorageBehaviorHooks = {}): void {
  const ensureSession = hooks.ensureSession ?? (() => Promise.resolve());

  describe('append', () => {
    it('round-trips agent.added without adapterSessionId (idle fork start)', async () => {
      await ensureSession('session-idle');

      // Construct the event manually to omit adapterSessionId — the persisted schema
      // must accept this shape ever since adapterSessionId was made optional to support
      // unconfirmed idle fork starts.
      const event: MakaioSessionEvent = {
        sessionId: 'session-idle',
        eventId: 'evt-idle-fork',
        timestamp: 1,
        type: 'agent.added',
        payload: {
          sessionId: 'session-idle',
          agentId: 'agent-1',
          adapterId: 'test-adapter',
          adapterName: 'Test Adapter',
          // adapterSessionId intentionally absent
        },
      };

      const appendResult = await MakaioBus.request(SessionEventStorageSubjects.append, { event });
      expect(appendResult.success).toBe(true);

      const { events } = await MakaioBus.request(SessionEventStorageSubjects.getEvents, {
        sessionId: 'session-idle',
      });

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('agent.added');
      expect(events[0].eventId).toBe('evt-idle-fork');
      const payload = events[0].payload as { adapterSessionId?: string };
      expect(payload.adapterSessionId).toBeUndefined();
    });
  });

  describe('getEvents', () => {
    it('should support cursor-based pagination', async () => {
      await ensureSession('session-1');

      for (let i = 0; i < 5; i++) {
        await MakaioBus.request(SessionEventStorageSubjects.append, {
          event: createEvent({ sessionId: 'session-1', type: 'user_message.sent' }),
        });
      }

      const page1 = await MakaioBus.request(SessionEventStorageSubjects.getEvents, {
        sessionId: 'session-1',
        options: { limit: 2 },
      });

      expect(page1.events).toHaveLength(2);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await MakaioBus.request(SessionEventStorageSubjects.getEvents, {
        sessionId: 'session-1',
        options: { limit: 2, after: page1.nextCursor ?? undefined },
      });

      expect(page2.events).toHaveLength(2);
      expect(page2.nextCursor).not.toBeNull();

      const page3 = await MakaioBus.request(SessionEventStorageSubjects.getEvents, {
        sessionId: 'session-1',
        options: { limit: 2, after: page2.nextCursor ?? undefined },
      });

      expect(page3.events).toHaveLength(1);
      expect(page3.nextCursor).toBeNull();
    });

    it('should filter by types', async () => {
      await ensureSession('session-1');

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
        options: { types: ['user_message.sent', 'turn.completed'] },
      });

      expect(result.events).toHaveLength(2);
      expect(result.events.map((e) => e.type)).toEqual(['user_message.sent', 'turn.completed']);
    });

    it('should return empty for unknown session', async () => {
      const result = await MakaioBus.request(SessionEventStorageSubjects.getEvents, {
        sessionId: 'unknown-session',
      });

      expect(result.events).toHaveLength(0);
      expect(result.nextCursor).toBeNull();
    });

    it('should not return events from other sessions', async () => {
      await ensureSession('session-1');
      await ensureSession('session-2');

      await MakaioBus.request(SessionEventStorageSubjects.append, {
        event: createEvent({ sessionId: 'session-1', type: 'user_message.sent' }),
      });
      await MakaioBus.request(SessionEventStorageSubjects.append, {
        event: createEvent({ sessionId: 'session-2', type: 'user_message.sent' }),
      });

      const result = await MakaioBus.request(SessionEventStorageSubjects.getEvents, {
        sessionId: 'session-1',
      });

      expect(result.events).toHaveLength(1);
      expect(result.events[0].sessionId).toBe('session-1');
    });

    it('should return events in descending order when order=desc', async () => {
      await ensureSession('session-1');

      const eventIds = ['evt-1', 'evt-2', 'evt-3'];
      for (const eventId of eventIds) {
        await MakaioBus.request(SessionEventStorageSubjects.append, {
          event: createEvent({ sessionId: 'session-1', type: 'user_message.sent', eventId }),
        });
      }

      const result = await MakaioBus.request(SessionEventStorageSubjects.getEvents, {
        sessionId: 'session-1',
        options: { order: 'desc' },
      });

      expect(result.events).toHaveLength(3);
      expect(result.events[0].eventId).toBe('evt-3');
      expect(result.events[1].eventId).toBe('evt-2');
      expect(result.events[2].eventId).toBe('evt-1');
    });

    it('should support cursor-based pagination with descending order', async () => {
      await ensureSession('session-1');

      for (let i = 1; i <= 5; i++) {
        await MakaioBus.request(SessionEventStorageSubjects.append, {
          event: createEvent({
            sessionId: 'session-1',
            type: 'user_message.sent',
            eventId: `evt-${i}`,
          }),
        });
      }

      const page1 = await MakaioBus.request(SessionEventStorageSubjects.getEvents, {
        sessionId: 'session-1',
        options: { limit: 2, order: 'desc' },
      });

      expect(page1.events).toHaveLength(2);
      expect(page1.events[0].eventId).toBe('evt-5');
      expect(page1.events[1].eventId).toBe('evt-4');
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await MakaioBus.request(SessionEventStorageSubjects.getEvents, {
        sessionId: 'session-1',
        options: { limit: 2, order: 'desc', after: page1.nextCursor ?? undefined },
      });

      expect(page2.events).toHaveLength(2);
      expect(page2.events[0].eventId).toBe('evt-3');
      expect(page2.events[1].eventId).toBe('evt-2');
      expect(page2.nextCursor).not.toBeNull();

      const page3 = await MakaioBus.request(SessionEventStorageSubjects.getEvents, {
        sessionId: 'session-1',
        options: { limit: 2, order: 'desc', after: page2.nextCursor ?? undefined },
      });

      expect(page3.events).toHaveLength(1);
      expect(page3.events[0].eventId).toBe('evt-1');
      expect(page3.nextCursor).toBeNull();
    });
  });

  describe('getByIds', () => {
    it('should retrieve events by IDs', async () => {
      await ensureSession('session-1');

      const event1 = createEvent({ sessionId: 'session-1', type: 'agent.added', eventId: 'evt-1' });
      const event2 = createEvent({ sessionId: 'session-1', type: 'user_message.sent', eventId: 'evt-2' });
      const event3 = createEvent({ sessionId: 'session-1', type: 'turn.completed', eventId: 'evt-3' });

      await MakaioBus.request(SessionEventStorageSubjects.append, { event: event1 });
      await MakaioBus.request(SessionEventStorageSubjects.append, { event: event2 });
      await MakaioBus.request(SessionEventStorageSubjects.append, { event: event3 });

      const result = await MakaioBus.request(SessionEventStorageSubjects.getByIds, {
        sessionId: 'session-1',
        eventIds: ['evt-1', 'evt-3'],
      });

      expect(result.events.map((e) => e.eventId).sort()).toEqual(['evt-1', 'evt-3']);
    });

    it('should return empty array for no matching IDs', async () => {
      await ensureSession('session-1');

      const result = await MakaioBus.request(SessionEventStorageSubjects.getByIds, {
        sessionId: 'session-1',
        eventIds: ['evt-unknown'],
      });

      expect(result.events).toHaveLength(0);
    });

    it('should return empty array for unknown session', async () => {
      const result = await MakaioBus.request(SessionEventStorageSubjects.getByIds, {
        sessionId: 'unknown-session',
        eventIds: ['evt-1'],
      });

      expect(result.events).toHaveLength(0);
    });

    it('should not return events from other sessions', async () => {
      await ensureSession('session-1');
      await ensureSession('session-2');

      const event1 = createEvent({ sessionId: 'session-1', type: 'agent.added', eventId: 'evt-1' });
      const event2 = createEvent({ sessionId: 'session-2', type: 'user_message.sent', eventId: 'evt-2' });

      await MakaioBus.request(SessionEventStorageSubjects.append, { event: event1 });
      await MakaioBus.request(SessionEventStorageSubjects.append, { event: event2 });

      const result = await MakaioBus.request(SessionEventStorageSubjects.getByIds, {
        sessionId: 'session-1',
        eventIds: ['evt-1', 'evt-2'],
      });

      expect(result.events).toHaveLength(1);
      expect(result.events[0].eventId).toBe('evt-1');
    });
  });

  describe('deleteBySession', () => {
    it('should delete all events by sessionId and return deletedCount', async () => {
      await ensureSession('session-1');

      await MakaioBus.request(SessionEventStorageSubjects.append, {
        event: createEvent({ sessionId: 'session-1', type: 'agent.added' }),
      });
      await MakaioBus.request(SessionEventStorageSubjects.append, {
        event: createEvent({ sessionId: 'session-1', type: 'user_message.sent' }),
      });

      const deleteResult = await MakaioBus.request(SessionEventStorageSubjects.deleteBySession, {
        sessionId: 'session-1',
      });

      expect(deleteResult.success).toBe(true);
      expect(deleteResult.deletedCount).toBe(2);

      const getResult = await MakaioBus.request(SessionEventStorageSubjects.getEvents, {
        sessionId: 'session-1',
      });

      expect(getResult.events).toHaveLength(0);
    });

    it('should return 0 for non-existent session', async () => {
      const result = await MakaioBus.request(SessionEventStorageSubjects.deleteBySession, {
        sessionId: 'unknown-session',
      });

      expect(result.success).toBe(true);
      expect(result.deletedCount).toBe(0);
    });

    it('should not affect events from other sessions', async () => {
      await ensureSession('session-1');
      await ensureSession('session-2');

      await MakaioBus.request(SessionEventStorageSubjects.append, {
        event: createEvent({ sessionId: 'session-1', type: 'user_message.sent' }),
      });
      await MakaioBus.request(SessionEventStorageSubjects.append, {
        event: createEvent({ sessionId: 'session-2', type: 'user_message.sent' }),
      });

      await MakaioBus.request(SessionEventStorageSubjects.deleteBySession, {
        sessionId: 'session-1',
      });

      const result = await MakaioBus.request(SessionEventStorageSubjects.getEvents, {
        sessionId: 'session-2',
      });

      expect(result.events).toHaveLength(1);
    });
  });
}
