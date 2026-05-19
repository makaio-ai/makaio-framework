/**
 * Tests for SessionLogger event persistence.
 *
 * Verifies that SessionLogger correctly persists LIFECYCLE events only:
 * - agent.added correlation events
 * - turn.started / turn.completed events
 *
 * NOTE: user_message.* events are NO LONGER persisted by SessionLogger.
 * Messages are now first-class entities stored via MessageStorageSubjects.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
import { SessionLogger, registerMemorySessionEventStorage } from '@makaio/services-core/session';
import { getStoredEvents, waitForAsync } from '@makaio/services-core/session/orchestrator-testing';

describe('SessionLogger', () => {
  let storageCleanup: () => void;
  let sessionLogger: SessionLogger;

  beforeEach(() => {
    // Register in-memory storage to capture persisted events
    storageCleanup = registerMemorySessionEventStorage(MakaioBus);
    // Create SessionLogger instance (subscribes to session events)
    sessionLogger = new SessionLogger(MakaioBus);
  });

  afterEach(() => {
    // Clean up in reverse order
    sessionLogger.destroy();
    storageCleanup();
  });

  describe('agent.added correlation event', () => {
    it('should persist agent.added correlation event', async () => {
      const sessionId = 'session-agent-added-test';
      const agentId = 'agent-123';
      const adapterId = 'adapter-456';
      const adapterName = 'Test Adapter';
      const adapterSessionId = 'adapter-session-789';

      await MakaioBus.emit(SessionSubjects.agent.added, {
        sessionId,
        agentId,
        adapterId,
        adapterName,
        adapterSessionId,
        role: 'lead',
      });

      await waitForAsync();

      const events = await getStoredEvents(sessionId);
      expect(events).toHaveLength(1);

      const event = events[0];
      expect(event.type).toBe('agent.added');
      expect(event.sessionId).toBe(sessionId);
      expect(event.eventId).toBeDefined();
      expect(event.timestamp).toBeDefined();

      // Verify payload structure
      if (event.type === 'agent.added') {
        expect(event.payload.sessionId).toBe(sessionId);
        expect(event.payload.agentId).toBe(agentId);
        expect(event.payload.adapterId).toBe(adapterId);
        expect(event.payload.adapterName).toBe(adapterName);
        expect(event.payload.adapterSessionId).toBe(adapterSessionId);
        expect(event.payload.role).toBe('lead');
      }
    });
  });

  // NOTE: user_message.* events are no longer persisted by SessionLogger
  // (normalized message model stores messages directly via MessageStorageSubjects)

  describe('turn.started event', () => {
    it('should persist turn.started with agentIds', async () => {
      const sessionId = 'session-turn-started-test';
      const turnId = 'turn-123';
      const messageId = 'msg-456';
      const agentIds = ['agent-1', 'agent-2', 'agent-3'];

      await MakaioBus.emit(SessionSubjects.turn.started, {
        sessionId,
        turnId,
        turnNumber: 1,
        messageId,
        agentIds,
      });

      await waitForAsync();

      const events = await getStoredEvents(sessionId);
      expect(events).toHaveLength(1);

      const event = events[0];
      expect(event.type).toBe('turn.started');
      expect(event.sessionId).toBe(sessionId);

      // Verify payload structure
      if (event.type === 'turn.started') {
        expect(event.payload.sessionId).toBe(sessionId);
        expect(event.payload.turnId).toBe(turnId);
        expect(event.payload.turnNumber).toBe(1);
        expect(event.payload.messageId).toBe(messageId);
        expect(event.payload.agentIds).toEqual(agentIds);
      }
    });
  });

  describe('turn.completed event', () => {
    it('should persist turn.completed with success', async () => {
      const sessionId = 'session-turn-completed-test';
      const turnId = 'turn-123';

      await MakaioBus.emit(SessionSubjects.turn.completed, {
        sessionId,
        turnId,
        turnNumber: 1,
        success: true,
      });

      await waitForAsync();

      const events = await getStoredEvents(sessionId);
      expect(events).toHaveLength(1);

      const event = events[0];
      expect(event.type).toBe('turn.completed');
      expect(event.sessionId).toBe(sessionId);

      // Verify payload structure
      if (event.type === 'turn.completed') {
        expect(event.payload.sessionId).toBe(sessionId);
        expect(event.payload.turnId).toBe(turnId);
        expect(event.payload.turnNumber).toBe(1);
        expect(event.payload.success).toBe(true);
        expect(event.payload.error).toBeUndefined();
      }
    });

    it('should persist turn.completed with error', async () => {
      const sessionId = 'session-turn-error-test';
      const turnId = 'turn-123';
      const errorMessage = 'All agents failed';

      await MakaioBus.emit(SessionSubjects.turn.completed, {
        sessionId,
        turnId,
        turnNumber: 1,
        success: false,
        error: errorMessage,
      });

      await waitForAsync();

      const events = await getStoredEvents(sessionId);
      expect(events).toHaveLength(1);

      const event = events[0];
      if (event.type === 'turn.completed') {
        expect(event.payload.turnNumber).toBe(1);
        expect(event.payload.success).toBe(false);
        expect(event.payload.error).toBe(errorMessage);
      }
    });
  });

  describe('event envelope', () => {
    it('should create event envelope with UUID eventId and timestamp', async () => {
      const sessionId = 'session-envelope-test';

      await MakaioBus.emit(SessionSubjects.agent.added, {
        sessionId,
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterName: 'Test',
        adapterSessionId: 'adapter-session-1',
      });

      await waitForAsync();

      const events = await getStoredEvents(sessionId);
      expect(events).toHaveLength(1);

      const event = events[0];
      // Verify eventId is a valid UUID format
      expect(event.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      // Verify timestamp is a recent number
      expect(typeof event.timestamp).toBe('number');
      expect(event.timestamp).toBeGreaterThan(Date.now() - 5000);
      expect(event.timestamp).toBeLessThanOrEqual(Date.now());
    });
  });
});
