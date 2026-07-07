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

  describe('metadata', () => {
    it('should persist session metadata through set, get, and list', async () => {
      const metadata = {
        downstream: {
          workflowId: 'workflow-1',
          attempt: 1,
          tags: ['branch', 'correlation'],
        },
      };
      const session = {
        ...createSession({ sessionId: 'metadata-roundtrip' }),
        metadata,
      };

      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: session.sessionId,
        session,
      });

      const getResult = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: session.sessionId,
      });
      const listResult = await MakaioBus.request(SessionStorageSubjects.list, {
        status: 'all',
      });

      expect(getResult.session).toMatchObject({ metadata });
      expect(listResult.sessions.find((item) => item.sessionId === session.sessionId)).toMatchObject({ metadata });
    });

    it('should replace and clear metadata through partial update', async () => {
      const session = {
        ...createSession({ sessionId: 'metadata-update' }),
        metadata: { initial: 'value' },
      };
      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: session.sessionId,
        session,
      });

      const replacement = { downstream: { workflowId: 'workflow-2' } };
      const replaceResult = await MakaioBus.request(SessionStorageSubjects.update, {
        sessionId: session.sessionId,
        metadata: replacement,
      });
      const afterReplace = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: session.sessionId,
      });

      const clearResult = await MakaioBus.request(SessionStorageSubjects.update, {
        sessionId: session.sessionId,
        metadata: null,
      });
      const afterClear = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: session.sessionId,
      });

      expect(replaceResult.success).toBe(true);
      expect(afterReplace.session).toMatchObject({ metadata: replacement });
      expect(clearResult.success).toBe(true);
      expect(afterClear.session).not.toBeNull();
      expect(afterClear.session?.metadata).toBeUndefined();
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

    it('should return null for source-less ambiguous adapter session ID lookups', async () => {
      const claudeSession = createSession({
        sessionId: 'adapter-lookup-claude',
        adapterSessionId: 'external-shared-123',
        adapterName: 'claude-code',
        source: 'claude-code',
      });
      const codexSession = createSession({
        sessionId: 'adapter-lookup-codex',
        adapterSessionId: 'external-shared-123',
        adapterName: 'codex',
        source: 'codex',
      });

      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: claudeSession.sessionId,
        session: claudeSession,
      });
      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: codexSession.sessionId,
        session: codexSession,
      });

      const ambiguousResult = await MakaioBus.request(SessionStorageSubjects.getByAdapterSessionId, {
        adapterSessionId: 'external-shared-123',
      });
      const claudeResult = await MakaioBus.request(SessionStorageSubjects.getByAdapterSessionId, {
        adapterSessionId: 'external-shared-123',
        source: 'claude-code',
      });
      const codexResult = await MakaioBus.request(SessionStorageSubjects.getByAdapterSessionId, {
        adapterSessionId: 'external-shared-123',
        source: 'codex',
      });
      const claudeAdapterResult = await MakaioBus.request(SessionStorageSubjects.getByAdapterSessionId, {
        adapterSessionId: 'external-shared-123',
        adapterName: 'claude-code',
      });

      expect(ambiguousResult.session).toBeNull();
      expect(claudeResult.session?.sessionId).toBe('adapter-lookup-claude');
      expect(codexResult.session?.sessionId).toBe('adapter-lookup-codex');
      expect(claudeAdapterResult.session?.sessionId).toBe('adapter-lookup-claude');
    });
  });

  describe('machineId', () => {
    it('persists caller-supplied machineId on session set and update', async () => {
      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: 'session-machine',
        session: createSession({
          sessionId: 'session-machine',
          createdAt: 1,
          lastActivityAt: 1,
          agents: [],
          status: 'active',
          machineId: 'machine-a',
        }),
      });

      expect(
        (await MakaioBus.request(SessionStorageSubjects.get, { sessionId: 'session-machine' })).session?.machineId,
      ).toBe('machine-a');

      await MakaioBus.request(SessionStorageSubjects.update, { sessionId: 'session-machine', machineId: 'machine-b' });
      expect(
        (await MakaioBus.request(SessionStorageSubjects.get, { sessionId: 'session-machine' })).session?.machineId,
      ).toBe('machine-b');
    });

    it('persists importUpsert machineId exactly as supplied by the caller', async () => {
      const { sessionId } = await MakaioBus.request(SessionStorageSubjects.importUpsert, {
        kind: 'root',
        externalSessionId: 'external-machine',
        source: 'claude-code',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
        cwd: '/repo',
        machineId: 'owner-machine',
      });

      expect((await MakaioBus.request(SessionStorageSubjects.get, { sessionId })).session?.machineId).toBe(
        'owner-machine',
      );
    });

    it('fills missing importUpsert machineId from a later caller-supplied owner', async () => {
      const { sessionId } = await MakaioBus.request(SessionStorageSubjects.importUpsert, {
        kind: 'root',
        externalSessionId: 'external-machine-fill',
        source: 'claude-code',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
        cwd: '/repo',
      });

      await MakaioBus.request(SessionStorageSubjects.importUpsert, {
        kind: 'root',
        externalSessionId: 'external-machine-fill',
        source: 'claude-code',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
        cwd: '/repo',
        machineId: 'owner-machine-filled',
      });

      expect((await MakaioBus.request(SessionStorageSubjects.get, { sessionId })).session?.machineId).toBe(
        'owner-machine-filled',
      );
    });

    it('does not overwrite an existing importUpsert machineId', async () => {
      const { sessionId } = await MakaioBus.request(SessionStorageSubjects.importUpsert, {
        kind: 'root',
        externalSessionId: 'external-machine-preserve',
        source: 'claude-code',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
        cwd: '/repo',
        machineId: 'owner-machine-original',
      });

      await MakaioBus.request(SessionStorageSubjects.importUpsert, {
        kind: 'root',
        externalSessionId: 'external-machine-preserve',
        source: 'claude-code',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
        cwd: '/repo',
        machineId: 'owner-machine-new',
      });

      expect((await MakaioBus.request(SessionStorageSubjects.get, { sessionId })).session?.machineId).toBe(
        'owner-machine-original',
      );
    });

    it('clears machineId when re-upsert supplies explicit null', async () => {
      const { sessionId } = await MakaioBus.request(SessionStorageSubjects.importUpsert, {
        kind: 'root',
        externalSessionId: 'external-machine-null-clear',
        source: 'claude-code',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
        cwd: '/repo',
        machineId: 'owner-machine-to-clear',
      });

      expect((await MakaioBus.request(SessionStorageSubjects.get, { sessionId })).session?.machineId).toBe(
        'owner-machine-to-clear',
      );

      await MakaioBus.request(SessionStorageSubjects.importUpsert, {
        kind: 'root',
        externalSessionId: 'external-machine-null-clear',
        source: 'claude-code',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
        cwd: '/repo',
        machineId: null,
      });

      expect((await MakaioBus.request(SessionStorageSubjects.get, { sessionId })).session?.machineId).toBeUndefined();
    });

    it('preserves machineId when re-upsert omits the field (undefined)', async () => {
      const { sessionId } = await MakaioBus.request(SessionStorageSubjects.importUpsert, {
        kind: 'root',
        externalSessionId: 'external-machine-undef-keep',
        source: 'claude-code',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
        cwd: '/repo',
        machineId: 'owner-machine-kept',
      });

      await MakaioBus.request(SessionStorageSubjects.importUpsert, {
        kind: 'root',
        externalSessionId: 'external-machine-undef-keep',
        source: 'claude-code',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
        cwd: '/repo',
        // machineId intentionally omitted (undefined)
      });

      expect((await MakaioBus.request(SessionStorageSubjects.get, { sessionId })).session?.machineId).toBe(
        'owner-machine-kept',
      );
    });

    it('overwrites machineId with a new string when re-upserting a session without one', async () => {
      const { sessionId } = await MakaioBus.request(SessionStorageSubjects.importUpsert, {
        kind: 'root',
        externalSessionId: 'external-machine-string-fill',
        source: 'claude-code',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
        cwd: '/repo',
        // No machineId on first insert
      });

      expect((await MakaioBus.request(SessionStorageSubjects.get, { sessionId })).session?.machineId).toBeUndefined();

      await MakaioBus.request(SessionStorageSubjects.importUpsert, {
        kind: 'root',
        externalSessionId: 'external-machine-string-fill',
        source: 'claude-code',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
        cwd: '/repo',
        machineId: 'late-owner',
      });

      expect((await MakaioBus.request(SessionStorageSubjects.get, { sessionId })).session?.machineId).toBe(
        'late-owner',
      );
    });
  });

  describe('spawningToolCallId updates', () => {
    it('should fill missing spawn provenance without overwriting existing provenance', async () => {
      const session = createSession({
        sessionId: 'spawn-provenance-write-once',
        branchKind: 'subagent',
      });
      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: session.sessionId,
        session,
      });

      const firstUpdate = await MakaioBus.request(SessionStorageSubjects.update, {
        sessionId: session.sessionId,
        spawningToolCallId: 'tool-call-first',
      });
      const secondUpdate = await MakaioBus.request(SessionStorageSubjects.update, {
        sessionId: session.sessionId,
        spawningToolCallId: 'tool-call-second',
        title: 'renamed while preserving provenance',
      });

      const result = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: session.sessionId,
      });

      expect(firstUpdate.success).toBe(true);
      expect(secondUpdate.success).toBe(true);
      expect(result.session?.spawningToolCallId).toBe('tool-call-first');
      expect(result.session?.title).toBe('renamed while preserving provenance');
    });
  });
}
