/**
 * Tests for session lifecycle event persistence (session_events rows).
 *
 * Covers the public contract that replaced the former SessionLogger class:
 * - registerSessionLifecycleEventWriters persists agent.added and
 *   branch.created rows from bus subscriptions
 * - emitSessionTurnStarted persists the turn.started row and emits the
 *   canonical session.turn.started event (persist-before-emit)
 * - branch.merged / squash emissions produce NO rows from the writers
 *   (merge-handler / compress-handler own that persistence with stable
 *   eventIds)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { SessionEventStorageSubjects, SessionSubjects } from '@makaio/contracts';
import {
  emitSessionTurnStarted,
  registerSessionLifecycleEventWriters,
  registerMemorySessionEventStorage,
} from '@makaio/services-core/session';
import { getStoredEvents, waitForAsync } from '@makaio/services-core/session/orchestrator-testing';

describe('session lifecycle event writers', () => {
  let storageCleanup: () => void;
  let writersCleanup: () => void;

  beforeEach(() => {
    // Register in-memory storage to capture persisted events
    storageCleanup = registerMemorySessionEventStorage(MakaioBus);
    writersCleanup = registerSessionLifecycleEventWriters(MakaioBus);
  });

  afterEach(() => {
    // Clean up in reverse order
    writersCleanup();
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

  describe('branch.created event', () => {
    it('should persist branch.created audit rows', async () => {
      const sessionId = 'session-branch-created-test';

      await MakaioBus.emit(SessionSubjects.branch.created, {
        sessionId,
        childSessionId: 'child-1',
        parentSessionId: sessionId,
        kind: 'fork',
      });

      await waitForAsync();

      const events = await getStoredEvents(sessionId);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('branch.created');
      if (events[0].type === 'branch.created') {
        expect(events[0].payload.childSessionId).toBe('child-1');
        expect(events[0].payload.parentSessionId).toBe(sessionId);
      }
    });

    it('does not reject branch.created when audit persistence fails', async () => {
      storageCleanup();
      storageCleanup = () => undefined;
      const appendAttempts: unknown[] = [];
      const failingStorageCleanup = MakaioBus.on(SessionEventStorageSubjects.append, (ctx) => {
        appendAttempts.push(ctx.payload);
        throw new Error('session event unavailable');
      });

      await expect(
        MakaioBus.emit(SessionSubjects.branch.created, {
          sessionId: 'session-branch-audit-fail',
          childSessionId: 'child-1',
          parentSessionId: 'session-branch-audit-fail',
          kind: 'fork',
        }),
      ).resolves.toBeUndefined();

      expect(appendAttempts).toHaveLength(1);
      failingStorageCleanup();
    });
  });

  describe('branch.merged / squash exclusion', () => {
    it('produces NO rows for branch.merged and squash (owned by their handlers)', async () => {
      const sessionId = 'session-merged-squash-test';

      await MakaioBus.emit(SessionSubjects.branch.merged, {
        sessionId,
        childSessionId: 'child-1',
        parentSessionId: sessionId,
      });
      await MakaioBus.emit(SessionSubjects.squash, {
        sessionId,
        summaryJson: '{"summary":"compressed"}',
      });

      await waitForAsync();

      const events = await getStoredEvents(sessionId);
      expect(events).toHaveLength(0);
    });
  });

  describe('emitSessionTurnStarted', () => {
    it('persists the turn.started row and emits session.turn.started', async () => {
      const sessionId = 'session-turn-started-test';
      const received: unknown[] = [];
      const cleanup = MakaioBus.on(SessionSubjects.turn.started, (ctx) => {
        received.push(ctx.payload);
      });

      await emitSessionTurnStarted(MakaioBus, {
        sessionId,
        turnId: 'turn-123',
        turnNumber: 1,
        messageId: 'msg-456',
        agentIds: ['agent-1', 'agent-2'],
        ingestionMarker: 'live',
      });

      await waitForAsync();
      cleanup();

      const events = await getStoredEvents(sessionId);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('turn.started');
      if (events[0].type === 'turn.started') {
        expect(events[0].payload.turnId).toBe('turn-123');
        expect(events[0].payload.turnNumber).toBe(1);
        expect(events[0].payload.messageId).toBe('msg-456');
        expect(events[0].payload.agentIds).toEqual(['agent-1', 'agent-2']);
        expect(events[0].payload.ingestionMarker).toBe('live');
      }

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        sessionId,
        turnId: 'turn-123',
        turnNumber: 1,
        ingestionMarker: 'live',
      });
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

  describe('cleanup', () => {
    it('stops persisting after the writers cleanup runs', async () => {
      const sessionId = 'session-writer-cleanup-test';

      writersCleanup();
      // Replace with a noop so the afterEach cleanup stays safe.
      writersCleanup = (): void => undefined;

      await MakaioBus.emit(SessionSubjects.agent.added, {
        sessionId,
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterName: 'Test',
        adapterSessionId: 'adapter-session-1',
      });

      await waitForAsync();

      const events = await getStoredEvents(sessionId);
      expect(events).toHaveLength(0);
    });
  });
});
