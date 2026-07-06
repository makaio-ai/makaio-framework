/**
 * Tests for the session lifecycle event transform.
 *
 * Verifies that the shared lifecycle persistence helpers correctly handle:
 * - Transform function for PII redaction
 * - Skipping persistence when transform returns null
 * - Writer cleanup
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
import {
  appendSessionLifecycleEvent,
  registerSessionLifecycleEventWriters,
  registerMemorySessionEventStorage,
  type EventTransform,
} from '@makaio/services-core/session';
import { getStoredEvents, waitForAsync } from '@makaio/services-core/session/orchestrator-testing';

describe('session lifecycle event transform', () => {
  let storageCleanup: () => void;
  let writersCleanup: (() => void) | undefined;

  beforeEach(() => {
    // Register in-memory storage to capture persisted events
    storageCleanup = registerMemorySessionEventStorage(MakaioBus);
  });

  afterEach(() => {
    // Clean up in reverse order
    writersCleanup?.();
    writersCleanup = undefined;
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

  describe('transform on appendSessionLifecycleEvent', () => {
    it('should apply transform to persisted events', async () => {
      const sessionId = 'session-transform-test';

      await appendSessionLifecycleEvent(
        MakaioBus,
        {
          type: 'turn.started',
          sessionId,
          payload: {
            sessionId,
            turnId: 'turn-123',
            turnNumber: 1,
            messageId: 'msg-456',
            agentIds: ['agent-1'],
          },
        },
        redactTurnStartedMessageId,
      );

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

    it('should skip persistence when transform returns null', async () => {
      const sessionId = 'session-append-skip-test';

      await appendSessionLifecycleEvent(
        MakaioBus,
        {
          type: 'turn.started',
          sessionId,
          payload: { sessionId, turnId: 'turn-1', turnNumber: 1, messageId: 'msg-1', agentIds: ['agent-1'] },
        },
        () => null,
      );

      const events = await getStoredEvents(sessionId);
      expect(events).toHaveLength(0);
    });
  });

  describe('transform on subscription writers', () => {
    it('should not transform events that do not match', async () => {
      writersCleanup = registerSessionLifecycleEventWriters(MakaioBus, redactTurnStartedMessageId);

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

    it('should skip persistence when transform returns null', async () => {
      // Register writers that skip agent.added events
      writersCleanup = registerSessionLifecycleEventWriters(MakaioBus, (event) => {
        if (event.type === 'agent.added') {
          return null;
        }
        return event;
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

      // Emit branch.created (should be persisted)
      await MakaioBus.emit(SessionSubjects.branch.created, {
        sessionId,
        childSessionId: 'child-1',
        parentSessionId: sessionId,
        kind: 'fork',
      });

      await waitForAsync();

      const events = await getStoredEvents(sessionId);
      // Only branch.created should be persisted
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('branch.created');
    });

    it('should skip all events when transform always returns null', async () => {
      writersCleanup = registerSessionLifecycleEventWriters(MakaioBus, () => null);

      const sessionId = 'session-skip-all-test';

      await MakaioBus.emit(SessionSubjects.agent.added, {
        sessionId,
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterName: 'Test',
        adapterSessionId: 'adapter-session-1',
      });

      await MakaioBus.emit(SessionSubjects.branch.created, {
        sessionId,
        childSessionId: 'child-1',
        parentSessionId: sessionId,
        kind: 'fork',
      });

      await waitForAsync();

      const events = await getStoredEvents(sessionId);
      expect(events).toHaveLength(0);
    });
  });

  describe('writer cleanup', () => {
    it('should stop persisting events after cleanup is called', async () => {
      const cleanup = registerSessionLifecycleEventWriters(MakaioBus);

      const sessionId = 'session-stop-test';

      // Emit event before cleanup
      await MakaioBus.emit(SessionSubjects.agent.added, {
        sessionId,
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterName: 'Test',
        adapterSessionId: 'adapter-session-1',
      });

      await waitForAsync();

      // Stop the writers
      cleanup();

      // Emit event after cleanup
      await MakaioBus.emit(SessionSubjects.agent.added, {
        sessionId,
        agentId: 'agent-2',
        adapterId: 'adapter-2',
        adapterName: 'Test',
        adapterSessionId: 'adapter-session-2',
      });

      await waitForAsync();

      const events = await getStoredEvents(sessionId);
      // Only the first event should be persisted
      expect(events).toHaveLength(1);
      if (events[0].type === 'agent.added') {
        expect(events[0].payload.agentId).toBe('agent-1');
      }
    });

    it('should be safe to call cleanup multiple times', () => {
      const cleanup = registerSessionLifecycleEventWriters(MakaioBus);

      expect(() => {
        cleanup();
        cleanup();
        cleanup();
      }).not.toThrow();
    });
  });
});
