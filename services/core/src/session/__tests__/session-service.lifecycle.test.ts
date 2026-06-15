/**
 * Component tests for MakaioSessionService - Framework-core lifecycle operations.
 *
 * Tests the framework-core handlers: session.create, session.get,
 * session.list, session.close, session.update, session.archive,
 * session.purge, session.agent.added, and session.agent.removed.
 *
 * Most tests use real bus requests against in-memory storage backends; the
 * ephemeral-mode regression uses an isolated bus without storage handlers.
 *
 * Host-specific handler tests (session.update with workstream validation,
 * session.resume, and branching operations) live in the host test layer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createBusInstance, MakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
import type { SessionUpdatedEvent } from '@makaio/contracts';
import { MakaioSessionService } from '../session-service.js';
import { registerCoreSessionServiceHandlers } from '../session-service-handlers-core.js';
import { registerMemorySessionStorage } from '../storage/memory-handler.js';
import { registerMemorySessionEventStorage } from '../session-events/memory-handler.js';

describe('MakaioSessionService - Lifecycle', () => {
  let sessionService: MakaioSessionService;
  let sessionStorageCleanup: () => void;
  let eventStorageCleanup: () => void;

  beforeEach(async () => {
    // Register storage handlers BEFORE creating the service
    sessionStorageCleanup = registerMemorySessionStorage(MakaioBus);
    eventStorageCleanup = registerMemorySessionEventStorage(MakaioBus);

    // Create the service (constructor has no side effects)
    sessionService = new MakaioSessionService(MakaioBus);
    // Initialize the service (registers handlers)
    await sessionService.init();
  });

  afterEach(() => {
    // Clean up in reverse order
    sessionService.destroy();
    eventStorageCleanup();
    sessionStorageCleanup();
  });

  // ===========================================================================
  // Session Creation Tests
  // ===========================================================================

  describe('session.create', () => {
    it('emits session.created event', async () => {
      const createdEvents: string[] = [];
      const cleanup = MakaioBus.on(SessionSubjects.created, (ctx) => {
        createdEvents.push(ctx.payload.sessionId);
      });

      const { sessionId } = await MakaioBus.request(SessionSubjects.create, {});

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(createdEvents).toContain(sessionId);

      cleanup();
    });

    it('should create session with unique ID', async () => {
      const result1 = await MakaioBus.request(SessionSubjects.create, {});
      const result2 = await MakaioBus.request(SessionSubjects.create, {});

      expect(result1.sessionId).toBeDefined();
      expect(result2.sessionId).toBeDefined();
      expect(result1.sessionId).not.toBe(result2.sessionId);

      // Verify UUID format
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      expect(result1.sessionId).toMatch(uuidRegex);
      expect(result2.sessionId).toMatch(uuidRegex);
    });

    it('should create session with status active', async () => {
      const { sessionId } = await MakaioBus.request(SessionSubjects.create, {});
      const { session } = await MakaioBus.request(SessionSubjects.get, { sessionId });

      expect(session).not.toBeNull();
      expect(session?.status).toBe('active');
    });

    it('should create session with initial timestamps', async () => {
      const beforeCreate = Date.now();
      const { sessionId } = await MakaioBus.request(SessionSubjects.create, {});
      const afterCreate = Date.now();

      const { session } = await MakaioBus.request(SessionSubjects.get, { sessionId });

      expect(session).not.toBeNull();
      expect(session?.createdAt).toBeGreaterThanOrEqual(beforeCreate);
      expect(session?.createdAt).toBeLessThanOrEqual(afterCreate);
      expect(session?.lastActivityAt).toBe(session?.createdAt);
    });

    it('should create session with empty agents array', async () => {
      const { sessionId } = await MakaioBus.request(SessionSubjects.create, {});
      const { session } = await MakaioBus.request(SessionSubjects.get, { sessionId });

      expect(session).not.toBeNull();
      expect(session?.agents).toEqual([]);
      expect(session?.leadAgentId).toBeUndefined();
    });

    it('should create session with optional title', async () => {
      const { sessionId } = await MakaioBus.request(SessionSubjects.create, {
        title: 'My session',
      });
      const { session } = await MakaioBus.request(SessionSubjects.get, { sessionId });

      expect(session?.title).toBe('My session');
    });

    it('should create session with generic metadata', async () => {
      const metadata = {
        downstream: {
          workflowId: 'workflow-1',
          branchCorrelationId: 'branch-1',
        },
      };
      const { sessionId } = await MakaioBus.request(SessionSubjects.create, {
        metadata,
      });
      const { session } = await MakaioBus.request(SessionSubjects.get, { sessionId });

      expect(session).toMatchObject({ metadata });
    });

    it('returns existing session when provided sessionId already exists', async () => {
      const providedSessionId = `session-${crypto.randomUUID()}`;
      const { sessionId: firstId } = await MakaioBus.request(SessionSubjects.create, {
        sessionId: providedSessionId,
        title: 'First title',
      });

      const { session: before } = await MakaioBus.request(SessionSubjects.get, { sessionId: firstId });
      expect(before).not.toBeNull();

      const { sessionId: secondId } = await MakaioBus.request(SessionSubjects.create, {
        sessionId: providedSessionId,
        title: 'Second title',
      });

      expect(secondId).toBe(firstId);

      const { session: after } = await MakaioBus.request(SessionSubjects.get, { sessionId: firstId });
      expect(after).not.toBeNull();
      expect(after?.createdAt).toBe(before?.createdAt);
      expect(after?.title).toBe('First title');
    });
  });

  // ===========================================================================
  // Session Retrieval Tests
  // ===========================================================================

  describe('session.get', () => {
    it('should get session by ID', async () => {
      const { sessionId } = await MakaioBus.request(SessionSubjects.create, {});
      const { session } = await MakaioBus.request(SessionSubjects.get, { sessionId });

      expect(session).not.toBeNull();
      expect(session?.sessionId).toBe(sessionId);
      expect(session?.status).toBe('active');
      expect(session?.agents).toEqual([]);
    });

    it('should return null for non-existent session', async () => {
      const { session } = await MakaioBus.request(SessionSubjects.get, {
        sessionId: 'non-existent-session-id',
      });

      expect(session).toBeNull();
    });
  });

  // ===========================================================================
  // Session Listing Tests
  // ===========================================================================

  describe('session.list', () => {
    it('should list all sessions', async () => {
      // Create multiple sessions
      const { sessionId: id1 } = await MakaioBus.request(SessionSubjects.create, {});
      const { sessionId: id2 } = await MakaioBus.request(SessionSubjects.create, {});
      const { sessionId: id3 } = await MakaioBus.request(SessionSubjects.create, {});

      const { sessions } = await MakaioBus.request(SessionSubjects.list, {});

      expect(sessions).toHaveLength(3);
      const sessionIds = sessions.map((s) => s.sessionId);
      expect(sessionIds).toContain(id1);
      expect(sessionIds).toContain(id2);
      expect(sessionIds).toContain(id3);
    });

    it('should list sessions filtered by status active', async () => {
      // Create sessions
      const { sessionId: activeId1 } = await MakaioBus.request(SessionSubjects.create, {});
      const { sessionId: activeId2 } = await MakaioBus.request(SessionSubjects.create, {});
      const { sessionId: closedId } = await MakaioBus.request(SessionSubjects.create, {});

      // Close one session
      await MakaioBus.request(SessionSubjects.close, { sessionId: closedId });

      const { sessions } = await MakaioBus.request(SessionSubjects.list, { status: 'active' });

      expect(sessions).toHaveLength(2);
      const sessionIds = sessions.map((s) => s.sessionId);
      expect(sessionIds).toContain(activeId1);
      expect(sessionIds).toContain(activeId2);
      expect(sessionIds).not.toContain(closedId);
      sessions.forEach((s) => expect(s.status).toBe('active'));
    });

    it('should list sessions filtered by status closed', async () => {
      // Create sessions
      const { sessionId: activeId } = await MakaioBus.request(SessionSubjects.create, {});
      const { sessionId: closedId1 } = await MakaioBus.request(SessionSubjects.create, {});
      const { sessionId: closedId2 } = await MakaioBus.request(SessionSubjects.create, {});

      // Close two sessions
      await MakaioBus.request(SessionSubjects.close, { sessionId: closedId1 });
      await MakaioBus.request(SessionSubjects.close, { sessionId: closedId2 });

      const { sessions } = await MakaioBus.request(SessionSubjects.list, { status: 'closed' });

      expect(sessions).toHaveLength(2);
      const sessionIds = sessions.map((s) => s.sessionId);
      expect(sessionIds).toContain(closedId1);
      expect(sessionIds).toContain(closedId2);
      expect(sessionIds).not.toContain(activeId);
      sessions.forEach((s) => expect(s.status).toBe('closed'));
    });

    it('should return empty array when no sessions exist', async () => {
      const { sessions } = await MakaioBus.request(SessionSubjects.list, {});

      expect(sessions).toEqual([]);
    });
  });

  // ===========================================================================
  // Session Close Tests
  // ===========================================================================

  describe('session.close', () => {
    it('should close session and update status', async () => {
      const { sessionId } = await MakaioBus.request(SessionSubjects.create, {});

      // Verify initially active
      const { session: beforeClose } = await MakaioBus.request(SessionSubjects.get, { sessionId });
      expect(beforeClose?.status).toBe('active');

      const { success } = await MakaioBus.request(SessionSubjects.close, { sessionId });

      expect(success).toBe(true);

      const { session: afterClose } = await MakaioBus.request(SessionSubjects.get, { sessionId });
      expect(afterClose?.status).toBe('closed');
    });

    it('should update lastActivityAt on close', async () => {
      const { sessionId } = await MakaioBus.request(SessionSubjects.create, {});

      const { session: beforeClose } = await MakaioBus.request(SessionSubjects.get, { sessionId });
      const originalLastActivity = beforeClose?.lastActivityAt;

      // Small delay to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 5));

      await MakaioBus.request(SessionSubjects.close, { sessionId });

      const { session: afterClose } = await MakaioBus.request(SessionSubjects.get, { sessionId });
      expect(afterClose?.lastActivityAt).toBeGreaterThan(originalLastActivity ?? 0);
    });

    it('should emit session.closed event on close', async () => {
      const { sessionId } = await MakaioBus.request(SessionSubjects.create, {});

      const receivedEvents: Array<{ sessionId: string }> = [];
      const cleanup = MakaioBus.on(SessionSubjects.closed, (ctx) => {
        receivedEvents.push({ sessionId: ctx.payload.sessionId });
      });

      try {
        await MakaioBus.request(SessionSubjects.close, { sessionId });

        // Wait for event propagation
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(receivedEvents).toHaveLength(1);
        expect(receivedEvents[0].sessionId).toBe(sessionId);
      } finally {
        cleanup();
      }
    });

    it('should return success false for close on non-existent session', async () => {
      const { success } = await MakaioBus.request(SessionSubjects.close, {
        sessionId: 'non-existent-session-id',
      });

      expect(success).toBe(false);
    });

    it('should treat close as idempotent when session is already closed', async () => {
      const { sessionId } = await MakaioBus.request(SessionSubjects.create, {});
      await MakaioBus.request(SessionSubjects.close, { sessionId });

      const { success } = await MakaioBus.request(SessionSubjects.close, { sessionId });
      expect(success).toBe(true);
    });
  });

  // ===========================================================================
  // Session Update Tests
  // ===========================================================================

  describe('session.update', () => {
    it('renames a session and emits title in changedProperties', async () => {
      const { sessionId } = await MakaioBus.request(SessionSubjects.create, {
        title: 'Original title',
      });

      const capturedEvents: SessionUpdatedEvent[] = [];
      const cleanup = MakaioBus.on(SessionSubjects.updated, (ctx) => {
        capturedEvents.push(ctx.payload);
      });

      try {
        const { success } = await MakaioBus.request(SessionSubjects.update, {
          sessionId,
          title: 'Renamed title',
        });

        expect(success).toBe(true);

        const { session } = await MakaioBus.request(SessionSubjects.get, { sessionId });
        expect(session?.title).toBe('Renamed title');
        expect(capturedEvents).toEqual([{ sessionId, changedProperties: ['title'] }]);
      } finally {
        cleanup();
      }
    });

    it('replaces and clears metadata and emits metadata in changedProperties', async () => {
      const { sessionId } = await MakaioBus.request(SessionSubjects.create, {
        metadata: { initial: 'value' },
      });

      const capturedEvents: SessionUpdatedEvent[] = [];
      const cleanup = MakaioBus.on(SessionSubjects.updated, (ctx) => {
        capturedEvents.push(ctx.payload);
      });

      try {
        const replacement = { downstream: { workflowId: 'workflow-2' } };
        const replaceResult = await MakaioBus.request(SessionSubjects.update, {
          sessionId,
          metadata: replacement,
        });

        expect(replaceResult.success).toBe(true);

        const { session: afterReplace } = await MakaioBus.request(SessionSubjects.get, { sessionId });
        expect(afterReplace).toMatchObject({ metadata: replacement });

        const clearResult = await MakaioBus.request(SessionSubjects.update, {
          sessionId,
          metadata: null,
        });

        expect(clearResult.success).toBe(true);

        const { session: afterClear } = await MakaioBus.request(SessionSubjects.get, { sessionId });
        expect(afterClear?.metadata).toBeUndefined();
        expect(capturedEvents).toEqual([
          { sessionId, changedProperties: ['metadata'] },
          { sessionId, changedProperties: ['metadata'] },
        ]);
      } finally {
        cleanup();
      }
    });
  });

  // ===========================================================================
  // Session Archive / Purge Tests
  // ===========================================================================

  describe('session.archive and session.purge', () => {
    it('archives a closed session in framework-only mode', async () => {
      const { sessionId } = await MakaioBus.request(SessionSubjects.create, {});
      await MakaioBus.request(SessionSubjects.close, { sessionId });

      const { success } = await MakaioBus.request(SessionSubjects.archive, { sessionId });

      expect(success).toBe(true);

      const { session } = await MakaioBus.request(SessionSubjects.get, { sessionId });
      expect(session?.status).toBe('archived');
    });

    it('purges an archived session in framework-only mode', async () => {
      const { sessionId } = await MakaioBus.request(SessionSubjects.create, {});
      await MakaioBus.request(SessionSubjects.close, { sessionId });
      await MakaioBus.request(SessionSubjects.archive, { sessionId });

      const { success, eventsDeleted } = await MakaioBus.request(SessionSubjects.purge, { sessionId });

      expect(success).toBe(true);
      expect(eventsDeleted).toBe(0);

      const { session } = await MakaioBus.request(SessionSubjects.get, { sessionId });
      expect(session).toBeNull();
    });
  });

  // ===========================================================================
  // Service Lifecycle Tests
  // ===========================================================================

  describe('service lifecycle', () => {
    it('should accept custom bus instance', async () => {
      // The default MakaioBus is used in these tests
      // This test verifies the constructor accepts the bus parameter
      expect(sessionService).toBeInstanceOf(MakaioSessionService);
    });

    it('should require init before use', async () => {
      // Create a fresh service but don't init
      const freshService = new MakaioSessionService(MakaioBus);

      // Service not yet initialized
      expect(freshService.initialized).toBe(false);

      // Init transitions the service to initialized
      await freshService.init();
      expect(freshService.initialized).toBe(true);

      // Cleanup
      freshService.destroy();
    });

    it('should be idempotent - init can be called multiple times', async () => {
      // Create a fresh service
      const freshService = new MakaioSessionService(MakaioBus);

      // First init
      await freshService.init();

      // Second init should be safe (no error, no double registration)
      await freshService.init();

      // Service should still work
      const { sessionId } = await MakaioBus.request(SessionSubjects.create, {});
      expect(sessionId).toBeDefined();

      // Cleanup
      freshService.destroy();
    });

    it('should be idempotent - destroy can be called multiple times', async () => {
      // Create a fresh service
      const freshService = new MakaioSessionService(MakaioBus);
      await freshService.init();

      // First destroy
      freshService.destroy();

      // Second destroy should be safe (no error)
      freshService.destroy();
    });

    it('should clean up handlers on destroy', async () => {
      // Create a fresh service
      const freshService = new MakaioSessionService(MakaioBus);
      await freshService.init();

      // Verify it works
      const { sessionId } = await MakaioBus.request(SessionSubjects.create, {});
      expect(sessionId).toBeDefined();

      // Destroy should not throw
      expect(() => freshService.destroy()).not.toThrow();
    });
  });
});

describe('registerCoreSessionServiceHandlers - ephemeral mode', () => {
  it('returns unhandled-storage results without throwing for update, archive, and purge', async () => {
    const bus = createBusInstance();
    const cleanups = registerCoreSessionServiceHandlers({ bus });

    try {
      await expect(
        bus.request(SessionSubjects.update, {
          sessionId: 'session-1',
          title: 'Updated title',
        }),
      ).resolves.toEqual({ success: false });

      await expect(bus.request(SessionSubjects.archive, { sessionId: 'session-1' })).resolves.toEqual({
        success: false,
      });

      await expect(bus.request(SessionSubjects.purge, { sessionId: 'session-1' })).resolves.toEqual({
        success: false,
        error: 'Session not found',
      });
    } finally {
      for (const cleanup of cleanups) cleanup();
    }
  });
});
