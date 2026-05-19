import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { buildSessionContext } from '../build-context.js';
import {
  createCleanupTracker,
  mockGetEvents,
  mockGetMessage,
  createMessage,
  messageEvent,
  turnStartedEvent,
  turnCompletedEvent,
  squashEvent,
} from './test-helpers.js';
import { SessionEventStorageSubjects } from '../../session-events/namespace.js';

describe('buildSessionContext', () => {
  const cleanup = createCleanupTracker();

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  afterEach(() => {
    cleanup.runAll();
  });

  describe('single session without squash', () => {
    it('should return messages referenced by session events', async () => {
      const msg1 = createMessage('msg-1', 'user', 'Hello');
      const msg2 = createMessage('msg-2', 'assistant', 'Hi there');

      mockGetEvents(cleanup, 'session-1', [
        messageEvent('msg-1', 1000, { role: 'user' }),
        messageEvent('msg-2', 2000, { role: 'assistant' }),
      ]);
      mockGetMessage(cleanup, 'msg-1', msg1);
      mockGetMessage(cleanup, 'msg-2', msg2);

      const result = await buildSessionContext(MakaioBus, { sessionId: 'session-1' });

      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].messageId).toBe('msg-1');
      expect(result.messages[1].messageId).toBe('msg-2');
      expect(result.hasSquashBoundary).toBe(false);
      expect(result.sessionChain).toEqual(['session-1']);
    });

    it('should skip non-message events', async () => {
      const msg1 = createMessage('msg-1', 'user', 'Hello');

      mockGetEvents(cleanup, 'session-1', [
        turnStartedEvent('turn-1', 500),
        messageEvent('msg-1', 1000, { role: 'user' }),
        turnCompletedEvent('turn-1', 1500),
      ]);
      mockGetMessage(cleanup, 'msg-1', msg1);

      const result = await buildSessionContext(MakaioBus, { sessionId: 'session-1' });

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].messageId).toBe('msg-1');
    });
  });

  describe('single session with squash boundary', () => {
    it('should replace prior messages with squash summary', async () => {
      const msg1 = createMessage('msg-1', 'user', 'Old message 1');
      const msg2 = createMessage('msg-2', 'assistant', 'Old message 2');
      const msg3 = createMessage('msg-3', 'user', 'New message after squash');

      mockGetEvents(cleanup, 'session-1', [
        messageEvent('msg-1', 1000, { role: 'user' }),
        messageEvent('msg-2', 2000, { role: 'assistant' }),
        squashEvent('squash-1', '{"summary": "Previous context compressed"}', 3000),
        messageEvent('msg-3', 4000, { role: 'user' }),
      ]);
      mockGetMessage(cleanup, 'msg-1', msg1);
      mockGetMessage(cleanup, 'msg-2', msg2);
      mockGetMessage(cleanup, 'msg-3', msg3);

      const result = await buildSessionContext(MakaioBus, { sessionId: 'session-1' });

      // Should have squash summary + msg3, NOT msg1/msg2
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].contentText).toContain('Previous context compressed');
      expect(result.messages[1].messageId).toBe('msg-3');
      expect(result.hasSquashBoundary).toBe(true);
    });

    it('should handle multiple squash events (last one wins)', async () => {
      const msg1 = createMessage('msg-1', 'user', 'After second squash');

      mockGetEvents(cleanup, 'session-1', [
        squashEvent('squash-1', '{"summary": "First squash"}', 1000),
        squashEvent('squash-2', '{"summary": "Second squash"}', 2000),
        messageEvent('msg-1', 3000, { role: 'user' }),
      ]);
      mockGetMessage(cleanup, 'msg-1', msg1);

      const result = await buildSessionContext(MakaioBus, { sessionId: 'session-1' });

      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].contentText).toContain('Second squash');
      expect(result.messages[1].messageId).toBe('msg-1');
    });
  });

  describe('pagination and truncation', () => {
    it('should paginate through multiple pages when nextCursor is present', async () => {
      const msg1 = createMessage('msg-1', 'user', 'Message 1');
      const msg2 = createMessage('msg-2', 'assistant', 'Message 2');
      const msg3 = createMessage('msg-3', 'user', 'Message 3');
      const seenAfters: Array<string | undefined> = [];

      // Mock getEvents to return two pages
      let callCount = 0;
      const handler = MakaioBus.on(
        SessionEventStorageSubjects.getEvents,
        (ctx) => {
          callCount++;
          seenAfters.push(ctx.payload.options?.after);
          if (callCount === 1) {
            // First page with cursor
            ctx.setResult({
              events: [
                messageEvent('msg-1', 1000, { role: 'user' }),
                messageEvent('msg-2', 2000, { role: 'assistant' }),
              ],
              nextCursor: 'cursor-to-page-2',
            });
          } else {
            // Second page without cursor
            ctx.setResult({
              events: [messageEvent('msg-3', 3000, { role: 'user' })],
              nextCursor: null,
            });
          }
        },
        { filter: { sessionId: 'session-1' } },
      );
      cleanup.add(handler);

      mockGetMessage(cleanup, 'msg-1', msg1);
      mockGetMessage(cleanup, 'msg-2', msg2);
      mockGetMessage(cleanup, 'msg-3', msg3);

      const result = await buildSessionContext(MakaioBus, { sessionId: 'session-1' });

      expect(result.messages).toHaveLength(3);
      expect(result.messages[0].messageId).toBe('msg-1');
      expect(result.messages[1].messageId).toBe('msg-2');
      expect(result.messages[2].messageId).toBe('msg-3');
      expect(result.truncated).toBe(false);
      expect(seenAfters).toEqual([undefined, 'cursor-to-page-2']);
    });

    it('should not set truncated flag when no nextCursor and under limit', async () => {
      const msg1 = createMessage('msg-1', 'user', 'Message 1');

      mockGetEvents(cleanup, 'session-1', [messageEvent('msg-1', 1000, { role: 'user' })]);
      mockGetMessage(cleanup, 'msg-1', msg1);

      const result = await buildSessionContext(MakaioBus, { sessionId: 'session-1' });

      expect(result.messages).toHaveLength(1);
      expect(result.truncated).toBe(false);
    });

    it('should respect the limit option and set truncated flag', async () => {
      const msg1 = createMessage('msg-1', 'user', 'Message 1');
      const msg2 = createMessage('msg-2', 'assistant', 'Message 2');
      const msg3 = createMessage('msg-3', 'user', 'Message 3');

      mockGetEvents(cleanup, 'session-1', [
        messageEvent('msg-1', 1000, { role: 'user' }),
        messageEvent('msg-2', 2000, { role: 'assistant' }),
        messageEvent('msg-3', 3000, { role: 'user' }),
      ]);
      mockGetMessage(cleanup, 'msg-1', msg1);
      mockGetMessage(cleanup, 'msg-2', msg2);
      mockGetMessage(cleanup, 'msg-3', msg3);

      const result = await buildSessionContext(MakaioBus, {
        sessionId: 'session-1',
        limit: 2,
      });

      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].messageId).toBe('msg-1');
      expect(result.messages[1].messageId).toBe('msg-2');
      expect(result.truncated).toBe(true);
    });

    it('should set truncated when limit is reached even if no more events exist', async () => {
      const msg1 = createMessage('msg-1', 'user', 'Message 1');
      const msg2 = createMessage('msg-2', 'assistant', 'Message 2');

      mockGetEvents(cleanup, 'session-1', [
        messageEvent('msg-1', 1000, { role: 'user' }),
        messageEvent('msg-2', 2000, { role: 'assistant' }),
      ]);
      mockGetMessage(cleanup, 'msg-1', msg1);
      mockGetMessage(cleanup, 'msg-2', msg2);

      const result = await buildSessionContext(MakaioBus, {
        sessionId: 'session-1',
        limit: 2,
      });

      expect(result.messages).toHaveLength(2);
      // Truncated is true because we hit the limit and broke early
      expect(result.truncated).toBe(true);
    });

    it('should set truncated when limit is less than available messages', async () => {
      const msg1 = createMessage('msg-1', 'user', 'Message 1');

      mockGetEvents(cleanup, 'session-1', [
        messageEvent('msg-1', 1000, { role: 'user' }),
        messageEvent('msg-2', 2000, { role: 'assistant' }),
      ]);
      mockGetMessage(cleanup, 'msg-1', msg1);

      const result = await buildSessionContext(MakaioBus, {
        sessionId: 'session-1',
        limit: 1,
      });

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].messageId).toBe('msg-1');
      expect(result.truncated).toBe(true);
    });
  });
});
