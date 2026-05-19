/**
 * Tests for SessionLogger transform and lifecycle functionality.
 *
 * Verifies that SessionLogger correctly handles:
 * - Transform function for PII redaction
 * - Skipping persistence when transform returns null
 * - Stop method for cleanup
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
import { SessionLogger, type EventTransform, registerMemorySessionEventStorage } from '@makaio/services-core/session';
import { getStoredEvents, waitForAsync } from '@makaio/services-core/session/orchestrator-testing';

describe('SessionLogger transform', () => {
  let storageCleanup: () => void;
  let sessionLogger: SessionLogger;

  beforeEach(() => {
    // Register in-memory storage to capture persisted events
    storageCleanup = registerMemorySessionEventStorage(MakaioBus);
  });

  afterEach(() => {
    // Clean up in reverse order
    sessionLogger?.destroy();
    storageCleanup();
  });

  /**
   * Transform that redacts messageId on turn.started events and passes others through.
   * @param event - Session event to transform
   */
  const redactTurnStartedMessageId: EventTransform = (event) => {
    if (event.type === 'turn.started') {
      return {
        ...event,
        payload: {
          ...event.payload,
          messageId: '[REDACTED]',
        },
      };
    }
    return event;
  };

  describe('transform', () => {
    it('should apply transform to events', async () => {
      sessionLogger = new SessionLogger(MakaioBus, { transform: redactTurnStartedMessageId });

      const sessionId = 'session-transform-test';

      await MakaioBus.emit(SessionSubjects.turn.started, {
        sessionId,
        turnId: 'turn-123',
        turnNumber: 1,
        messageId: 'msg-456',
        agentIds: ['agent-1'],
      });

      await waitForAsync();

      const events = await getStoredEvents(sessionId);
      expect(events).toHaveLength(1);

      const event = events[0];
      if (event.type === 'turn.started') {
        // messageId should be redacted
        expect(event.payload.messageId).toBe('[REDACTED]');
        // Other fields should be preserved
        expect(event.payload.sessionId).toBe(sessionId);
        expect(event.payload.turnId).toBe('turn-123');
      }
    });

    it('should not transform events that do not match', async () => {
      sessionLogger = new SessionLogger(MakaioBus, { transform: redactTurnStartedMessageId });

      const sessionId = 'session-no-transform-test';

      // Emit agent.added (should not be transformed)
      await MakaioBus.emit(SessionSubjects.agent.added, {
        sessionId,
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterName: 'Test Adapter',
        adapterSessionId: 'adapter-session-1',
        role: 'lead',
      });

      await waitForAsync();

      const events = await getStoredEvents(sessionId);
      expect(events).toHaveLength(1);

      const event = events[0];
      if (event.type === 'agent.added') {
        // All fields should be preserved as-is
        expect(event.payload.agentId).toBe('agent-1');
        expect(event.payload.adapterId).toBe('adapter-1');
        expect(event.payload.adapterName).toBe('Test Adapter');
      }
    });
  });

  describe('skip persistence', () => {
    it('should skip persistence when transform returns null', async () => {
      // Create SessionLogger that skips certain events
      sessionLogger = new SessionLogger(MakaioBus, {
        transform: (event) => {
          // Skip agent.added events
          if (event.type === 'agent.added') {
            return null;
          }
          return event;
        },
      });

      const sessionId = 'session-skip-test';

      // Emit agent.added (should be skipped)
      await MakaioBus.emit(SessionSubjects.agent.added, {
        sessionId,
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterName: 'Test',
        adapterSessionId: 'adapter-session-1',
      });

      // Emit turn.started (should be persisted)
      await MakaioBus.emit(SessionSubjects.turn.started, {
        sessionId,
        turnId: 'turn-123',
        turnNumber: 1,
        messageId: 'msg-456',
        agentIds: ['agent-1'],
      });

      await waitForAsync();

      const events = await getStoredEvents(sessionId);
      // Only turn.started should be persisted
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('turn.started');
    });

    it('should skip all events when transform always returns null', async () => {
      // Create SessionLogger that skips all events
      sessionLogger = new SessionLogger(MakaioBus, {
        transform: () => null,
      });

      const sessionId = 'session-skip-all-test';

      await MakaioBus.emit(SessionSubjects.agent.added, {
        sessionId,
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterName: 'Test',
        adapterSessionId: 'adapter-session-1',
      });

      await MakaioBus.emit(SessionSubjects.turn.started, {
        sessionId,
        turnId: 'turn-123',
        turnNumber: 1,
        messageId: 'msg-456',
        agentIds: ['agent-1'],
      });

      await waitForAsync();

      const events = await getStoredEvents(sessionId);
      expect(events).toHaveLength(0);
    });
  });

  describe('stop method', () => {
    it('should stop persisting events after stop is called', async () => {
      sessionLogger = new SessionLogger(MakaioBus);

      const sessionId = 'session-stop-test';

      // Emit event before stop
      await MakaioBus.emit(SessionSubjects.turn.started, {
        sessionId,
        turnId: 'turn-1',
        turnNumber: 1,
        messageId: 'msg-1',
        agentIds: ['agent-1'],
      });

      await waitForAsync();

      // Stop the logger
      sessionLogger.destroy();

      // Emit event after stop
      await MakaioBus.emit(SessionSubjects.turn.started, {
        sessionId,
        turnId: 'turn-2',
        turnNumber: 2,
        messageId: 'msg-2',
        agentIds: ['agent-1'],
      });

      await waitForAsync();

      const events = await getStoredEvents(sessionId);
      // Only the first event should be persisted
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('turn.started');
      if (events[0].type === 'turn.started') {
        expect(events[0].payload.turnId).toBe('turn-1');
      }
    });

    it('should be safe to call stop multiple times', async () => {
      sessionLogger = new SessionLogger(MakaioBus);

      // Stop multiple times should not throw
      sessionLogger.destroy();
      sessionLogger.destroy();
      sessionLogger.destroy();

      // Should complete without error
      expect(true).toBe(true);
    });
  });
});
