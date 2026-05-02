import { describe, it, expect } from 'vitest';
import { TurnTracker, type TurnEvent, type TurnTrackerOptions } from '@makaio/ai-adapters-core';

/** Test record type simulating Claude Code JSONL format. */
interface TestRecord {
  type: 'user' | 'assistant' | 'system';
  sessionId: string;
  message?: { content?: Array<{ type: 'text' | 'thinking' | 'tool_use' }> };
}

/**
 * Create default tracker options for testing.
 * @param overrides - Optional overrides to merge with defaults
 */
function createTestOptions(overrides?: Partial<TurnTrackerOptions<TestRecord>>): TurnTrackerOptions<TestRecord> {
  return {
    detectTurnStart: (record) => record.type === 'user',
    detectTurnComplete: (record) =>
      record.type === 'assistant' && record.message?.content?.some((b) => b.type === 'text') === true,
    getSessionId: (record) => record.sessionId,
    ...overrides,
  };
}

/**
 * Create a deterministic turn ID generator for testing.
 * @param prefix - Prefix for generated IDs (default: 'turn')
 */
function createDeterministicIdGenerator(prefix = 'turn'): (sessionId: string) => string {
  let counter = 0;
  return (sessionId: string) => `${prefix}-${sessionId}-${++counter}`;
}

describe('TurnTracker', () => {
  describe('basic state transitions', () => {
    it('should start in idle state for new sessions', () => {
      const tracker = new TurnTracker(createTestOptions());
      expect(tracker.getState('session-1')).toBe('idle');
      expect(tracker.hasActiveTurn('session-1')).toBe(false);
      expect(tracker.getCurrentTurnId('session-1')).toBeUndefined();
    });

    it('should emit turn.started when transitioning idle to active', () => {
      const tracker = new TurnTracker(createTestOptions({ generateTurnId: createDeterministicIdGenerator() }));
      const events = tracker.processRecord({ type: 'user', sessionId: 'session-1' });

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: 'turn.started', sessionId: 'session-1', turnId: 'turn-session-1-1' });
      expect(tracker.getState('session-1')).toBe('active');
      expect(tracker.getCurrentTurnId('session-1')).toBe('turn-session-1-1');
    });

    it('should emit turn.completed when transitioning active to idle', () => {
      const tracker = new TurnTracker(createTestOptions({ generateTurnId: createDeterministicIdGenerator() }));
      tracker.processRecord({ type: 'user', sessionId: 'session-1' });

      const events = tracker.processRecord({
        type: 'assistant',
        sessionId: 'session-1',
        message: { content: [{ type: 'text' }] },
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: 'turn.completed', sessionId: 'session-1', turnId: 'turn-session-1-1' });
      expect(tracker.getState('session-1')).toBe('idle');
      expect(tracker.getCurrentTurnId('session-1')).toBeUndefined();
    });

    it('should not emit events for non-boundary records or turn.completed when idle', () => {
      const tracker = new TurnTracker(createTestOptions());

      // System message is not a turn boundary
      expect(tracker.processRecord({ type: 'system', sessionId: 'session-1' })).toHaveLength(0);
      expect(tracker.getState('session-1')).toBe('idle');

      // Assistant response without starting turn first
      const assistantEvents = tracker.processRecord({
        type: 'assistant',
        sessionId: 'session-1',
        message: { content: [{ type: 'text' }] },
      });
      expect(assistantEvents).toHaveLength(0);
    });
  });

  describe('implicit turn completion', () => {
    it('should implicitly complete previous turn when new turn starts', () => {
      const tracker = new TurnTracker(createTestOptions({ generateTurnId: createDeterministicIdGenerator() }));
      tracker.processRecord({ type: 'user', sessionId: 'session-1' });

      // User sends another message without assistant completing
      const events = tracker.processRecord({ type: 'user', sessionId: 'session-1' });

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ type: 'turn.completed', sessionId: 'session-1', turnId: 'turn-session-1-1' });
      expect(events[1]).toEqual({ type: 'turn.started', sessionId: 'session-1', turnId: 'turn-session-1-2' });
    });
  });

  describe('multi-session support', () => {
    it('should track state independently per session', () => {
      const tracker = new TurnTracker(createTestOptions({ generateTurnId: createDeterministicIdGenerator() }));

      tracker.processRecord({ type: 'user', sessionId: 'session-1' });
      tracker.processRecord({ type: 'user', sessionId: 'session-2' });
      expect(tracker.getState('session-1')).toBe('active');
      expect(tracker.getState('session-2')).toBe('active');

      tracker.processRecord({
        type: 'assistant',
        sessionId: 'session-1',
        message: { content: [{ type: 'text' }] },
      });
      expect(tracker.getState('session-1')).toBe('idle');
      expect(tracker.getState('session-2')).toBe('active');
      expect(tracker.getCurrentTurnId('session-2')).toBe('turn-session-2-2');
    });

    it('should return all tracked session IDs', () => {
      const tracker = new TurnTracker(createTestOptions());
      tracker.processRecord({ type: 'user', sessionId: 'session-a' });
      tracker.processRecord({ type: 'user', sessionId: 'session-b' });
      tracker.processRecord({ type: 'user', sessionId: 'session-c' });

      const sessions = tracker.getTrackedSessions();
      expect(sessions).toHaveLength(3);
      expect(sessions).toContain('session-a');
      expect(sessions).toContain('session-b');
      expect(sessions).toContain('session-c');
    });
  });

  describe('full conversation flow', () => {
    it('should handle multiple turns correctly ignoring non-completing messages', () => {
      const tracker = new TurnTracker(createTestOptions({ generateTurnId: createDeterministicIdGenerator() }));
      const allEvents: TurnEvent[] = [];

      // Turn 1: User asks, assistant responds with thinking then text
      allEvents.push(...tracker.processRecord({ type: 'user', sessionId: 'session-1' }));
      allEvents.push(
        ...tracker.processRecord({
          type: 'assistant',
          sessionId: 'session-1',
          message: { content: [{ type: 'thinking' }] },
        }),
      );
      allEvents.push(
        ...tracker.processRecord({
          type: 'assistant',
          sessionId: 'session-1',
          message: { content: [{ type: 'text' }] },
        }),
      );

      // Turn 2: User follows up, assistant uses tool then responds
      allEvents.push(...tracker.processRecord({ type: 'user', sessionId: 'session-1' }));
      allEvents.push(
        ...tracker.processRecord({
          type: 'assistant',
          sessionId: 'session-1',
          message: { content: [{ type: 'tool_use' }] },
        }),
      );
      allEvents.push(
        ...tracker.processRecord({
          type: 'assistant',
          sessionId: 'session-1',
          message: { content: [{ type: 'text' }] },
        }),
      );

      expect(allEvents).toEqual([
        { type: 'turn.started', sessionId: 'session-1', turnId: 'turn-session-1-1' },
        { type: 'turn.completed', sessionId: 'session-1', turnId: 'turn-session-1-1' },
        { type: 'turn.started', sessionId: 'session-1', turnId: 'turn-session-1-2' },
        { type: 'turn.completed', sessionId: 'session-1', turnId: 'turn-session-1-2' },
      ]);
    });
  });

  describe('reset operations', () => {
    it('should reset specific session state', () => {
      const tracker = new TurnTracker(createTestOptions());
      tracker.processRecord({ type: 'user', sessionId: 'session-1' });
      tracker.processRecord({ type: 'user', sessionId: 'session-2' });

      expect(tracker.resetSession('session-1')).toBe(true);
      expect(tracker.getState('session-1')).toBe('idle');
      expect(tracker.getState('session-2')).toBe('active');
      expect(tracker.resetSession('non-existent')).toBe(false);
    });

    it('should reset all session state', () => {
      const tracker = new TurnTracker(createTestOptions());
      tracker.processRecord({ type: 'user', sessionId: 'session-1' });
      tracker.processRecord({ type: 'user', sessionId: 'session-2' });

      tracker.resetAll();
      expect(tracker.getState('session-1')).toBe('idle');
      expect(tracker.getState('session-2')).toBe('idle');
      expect(tracker.getTrackedSessions()).toHaveLength(0);
    });
  });

  describe('forceCompleteTurn', () => {
    it('should complete an active turn and return the event', () => {
      const tracker = new TurnTracker(createTestOptions({ generateTurnId: createDeterministicIdGenerator() }));
      tracker.processRecord({ type: 'user', sessionId: 'session-1' });

      const event = tracker.forceCompleteTurn('session-1');

      expect(event).toEqual({ type: 'turn.completed', sessionId: 'session-1', turnId: 'turn-session-1-1' });
      expect(tracker.getState('session-1')).toBe('idle');
      expect(tracker.getCurrentTurnId('session-1')).toBeUndefined();
    });

    it('should return undefined when no active turn or non-existent session', () => {
      const tracker = new TurnTracker(createTestOptions());
      expect(tracker.forceCompleteTurn('session-1')).toBeUndefined();
      expect(tracker.forceCompleteTurn('non-existent')).toBeUndefined();
    });
  });

  describe('custom detection functions', () => {
    it('should support custom turn start detection', () => {
      const tracker = new TurnTracker<TestRecord>({
        detectTurnStart: (record) =>
          record.type === 'assistant' && record.message?.content?.some((b) => b.type === 'tool_use') === true,
        detectTurnComplete: (record) =>
          record.type === 'assistant' && record.message?.content?.some((b) => b.type === 'text') === true,
        getSessionId: (record) => record.sessionId,
      });

      expect(tracker.processRecord({ type: 'user', sessionId: 'session-1' })).toHaveLength(0);
      const events = tracker.processRecord({
        type: 'assistant',
        sessionId: 'session-1',
        message: { content: [{ type: 'tool_use' }] },
      });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('turn.started');
    });

    it('should support records with different session ID field', () => {
      interface CustomRecord {
        type: string;
        ctx: { id: string };
      }
      const tracker = new TurnTracker<CustomRecord>({
        detectTurnStart: (record) => record.type === 'start',
        detectTurnComplete: (record) => record.type === 'end',
        getSessionId: (record) => record.ctx.id,
      });

      const events = tracker.processRecord({ type: 'start', ctx: { id: 'custom-session' } });
      expect(events).toHaveLength(1);
      expect(events[0].sessionId).toBe('custom-session');
    });
  });

  describe('turn ID generation', () => {
    it('should use crypto.randomUUID() by default', () => {
      const tracker = new TurnTracker(createTestOptions());
      const events = tracker.processRecord({ type: 'user', sessionId: 'session-1' });

      expect(events).toHaveLength(1);
      // UUID v4 format check
      expect(events[0].turnId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    it('should use custom turn ID generator when provided', () => {
      let counter = 0;
      const tracker = new TurnTracker(
        createTestOptions({ generateTurnId: (sessionId) => `${sessionId}::turn::${++counter}` }),
      );

      const events1 = tracker.processRecord({ type: 'user', sessionId: 'session-1' });
      tracker.processRecord({
        type: 'assistant',
        sessionId: 'session-1',
        message: { content: [{ type: 'text' }] },
      });
      const events2 = tracker.processRecord({ type: 'user', sessionId: 'session-1' });

      expect(events1[0].turnId).toBe('session-1::turn::1');
      expect(events2[0].turnId).toBe('session-1::turn::2');
    });
  });

  describe('edge cases', () => {
    it('should handle empty content array and missing message field', () => {
      const tracker = new TurnTracker(createTestOptions());
      tracker.processRecord({ type: 'user', sessionId: 'session-1' });

      expect(
        tracker.processRecord({
          type: 'assistant',
          sessionId: 'session-1',
          message: { content: [] },
        }),
      ).toHaveLength(0);
      expect(tracker.getState('session-1')).toBe('active');

      expect(tracker.processRecord({ type: 'assistant', sessionId: 'session-1' })).toHaveLength(0);
      expect(tracker.getState('session-1')).toBe('active');
    });

    it('should handle record that is both start and complete (start wins)', () => {
      const tracker = new TurnTracker<TestRecord>({
        detectTurnStart: () => true,
        detectTurnComplete: () => true,
        getSessionId: (record) => record.sessionId,
        generateTurnId: createDeterministicIdGenerator(),
      });

      const events = tracker.processRecord({ type: 'user', sessionId: 'session-1' });

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('turn.started');
      expect(tracker.getState('session-1')).toBe('active');
    });
  });
});
