/**
 * Shared behavioral test suite for session storage handlers.
 *
 * Both the Drizzle and memory backends implement the same contract
 * (SessionStorageSubjects). This module defines the shared behavioral
 * tests so each backend only needs to provide its setup and test
 * backend-specific concerns separately.
 */
import { describe, it, expect } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { SessionStorageSubjects } from '../namespace.js';
import { createSession } from './shared.js';

/**
 * Registers shared behavioral tests for any SessionStorage backend.
 *
 * Call this inside a `describe()` block after the backend's beforeEach/afterEach
 * lifecycle is configured.
 */
export function describeSessionStorageBehavior(): void {
  describe('list (with status filter)', () => {
    it('should list sessions filtered by status', async () => {
      const activeSession1 = createSession({ sessionId: 'active-1', status: 'active' });
      const activeSession2 = createSession({ sessionId: 'active-2', status: 'active' });
      const closedSession = createSession({ sessionId: 'closed-1', status: 'closed' });

      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: activeSession1.sessionId,
        session: activeSession1,
      });
      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: activeSession2.sessionId,
        session: activeSession2,
      });
      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: closedSession.sessionId,
        session: closedSession,
      });

      const activeResult = await MakaioBus.request(SessionStorageSubjects.list, {
        status: 'active',
      });
      expect(activeResult.sessions).toHaveLength(2);
      expect(activeResult.sessions.every((s) => s.status === 'active')).toBe(true);

      const closedResult = await MakaioBus.request(SessionStorageSubjects.list, {
        status: 'closed',
      });
      expect(closedResult.sessions).toHaveLength(1);
      expect(closedResult.sessions[0].sessionId).toBe('closed-1');

      const allResult = await MakaioBus.request(SessionStorageSubjects.list, {
        status: 'all',
      });
      expect(allResult.sessions).toHaveLength(3);
    });

    it('should return empty array when no sessions exist', async () => {
      const result = await MakaioBus.request(SessionStorageSubjects.list, {});

      expect(result.sessions).toHaveLength(0);
      expect(result.sessions).toEqual([]);
    });

    it('should list sessions filtered by archived status', async () => {
      const activeSession = createSession({ sessionId: 'active-1', status: 'active' });
      const closedSession = createSession({ sessionId: 'closed-1', status: 'closed' });
      const archivedSession = createSession({ sessionId: 'archived-1', status: 'archived' });

      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: activeSession.sessionId,
        session: activeSession,
      });
      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: closedSession.sessionId,
        session: closedSession,
      });
      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: archivedSession.sessionId,
        session: archivedSession,
      });

      const archivedResult = await MakaioBus.request(SessionStorageSubjects.list, {
        status: 'archived',
      });
      expect(archivedResult.sessions).toHaveLength(1);
      expect(archivedResult.sessions[0].sessionId).toBe('archived-1');
      expect(archivedResult.sessions[0].status).toBe('archived');
    });
  });

  describe('isOrchestrated', () => {
    it('should update orchestration marker via partial update', async () => {
      const session = createSession({ sessionId: 'update-orchestrated', isOrchestrated: false });

      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: session.sessionId,
        session,
      });

      const updateResult = await MakaioBus.request(SessionStorageSubjects.update, {
        sessionId: session.sessionId,
        isOrchestrated: true,
      });
      expect(updateResult.success).toBe(true);

      const afterUpdate = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: session.sessionId,
      });
      expect(afterUpdate.session?.isOrchestrated).toBe(true);
    });

    it('should reject set requests when nested and top-level sessionId disagree', async () => {
      await expect(
        MakaioBus.request(SessionStorageSubjects.set, {
          sessionId: 'top-level-session',
          session: createSession({
            sessionId: 'nested-session',
          }),
        }),
      ).rejects.toThrow(/session\.sessionId must match the top-level sessionId/i);
    });
  });

  describe('delete', () => {
    it('should delete session', async () => {
      const session = createSession({ sessionId: 'delete-test' });
      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: session.sessionId,
        session,
      });

      const beforeDelete = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: session.sessionId,
      });
      expect(beforeDelete.session).toEqual(session);

      const deleteResult = await MakaioBus.request(SessionStorageSubjects.delete, {
        sessionId: session.sessionId,
      });
      expect(deleteResult.success).toBe(true);

      const afterDelete = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: session.sessionId,
      });
      expect(afterDelete.session).toBeNull();
    });

    it('should succeed when deleting non-existent session', async () => {
      const result = await MakaioBus.request(SessionStorageSubjects.delete, {
        sessionId: 'non-existent',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('aside session storage visibility', () => {
    it('should keep aside sessions in generic list results', async () => {
      const rootSession = createSession({ sessionId: 'aside-filter-root' });
      const asideSession = createSession({
        sessionId: 'aside-filter-aside',
        parentSessionId: 'aside-filter-root',
        branchKind: 'aside',
      });

      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: rootSession.sessionId,
        session: rootSession,
      });
      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: asideSession.sessionId,
        session: asideSession,
      });

      const result = await MakaioBus.request(SessionStorageSubjects.list, {});
      expect(result.sessions.map((s) => s.sessionId)).toContain('aside-filter-aside');
      expect(result.sessions.map((s) => s.sessionId)).toContain('aside-filter-root');
    });

    it('should include aside sessions in generic status counts', async () => {
      const rootSession = createSession({ sessionId: 'aside-counts-root', status: 'active' });
      const asideSession = createSession({
        sessionId: 'aside-counts-aside',
        parentSessionId: 'aside-counts-root',
        branchKind: 'aside',
        status: 'active',
      });

      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: rootSession.sessionId,
        session: rootSession,
      });
      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: asideSession.sessionId,
        session: asideSession,
      });

      const counts = await MakaioBus.request(SessionStorageSubjects.getStatusCounts, {});
      expect(counts.active).toBe(2);
      expect(counts.all).toBe(2);
    });
  });

  describe('getByAdapterSessionId', () => {
    it('should return session by adapter session ID', async () => {
      const session = createSession({
        sessionId: 'adapter-lookup-test',
        adapterSessionId: 'external-abc-123',
        adapterName: 'claude-code',
      });
      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: session.sessionId,
        session,
      });

      const result = await MakaioBus.request(SessionStorageSubjects.getByAdapterSessionId, {
        adapterSessionId: 'external-abc-123',
      });
      expect(result.session).not.toBeNull();
      expect(result.session?.sessionId).toBe('adapter-lookup-test');
      expect(result.session?.adapterSessionId).toBe('external-abc-123');
    });

    it('should return null for non-existent adapter session ID', async () => {
      const result = await MakaioBus.request(SessionStorageSubjects.getByAdapterSessionId, {
        adapterSessionId: 'non-existent-adapter-id',
      });
      expect(result.session).toBeNull();
    });
  });
}
