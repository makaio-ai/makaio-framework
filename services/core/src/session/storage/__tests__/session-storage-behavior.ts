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
import type { IMakaioSession } from '@makaio/contracts';
import { SessionStorageSubjects } from '../namespace.js';
import { createSession } from './shared.js';

/** The identity triplet as the backfill write carries it. */
interface BackfillIdentity {
  /** Adapter type name of the lead conversation. */
  adapterName: string;
  /** Adapter instance the lead conversation was minted inside. */
  adapterId: string;
  /** Provider session, when the caller knows one. */
  adapterSessionId?: string;
}

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

  describe('adapter-session currency', () => {
    it('defaults to inherited currency and leaves the current ID unset', async () => {
      const session = createSession({ sessionId: 'currency-default', adapterSessionId: 'origin-id' });

      await MakaioBus.request(SessionStorageSubjects.set, { sessionId: session.sessionId, session });

      const stored = await MakaioBus.request(SessionStorageSubjects.get, { sessionId: session.sessionId });
      // Asserted strictly: both backends must materialize the column default
      // rather than leave it absent. A `?? 'inherited'` fallback here would pass
      // for a backend that never wrote the state at all, which is exactly the
      // divergence this shared behavior suite exists to catch.
      expect(stored.session?.currentAdapterSessionIdState).toBe('inherited');
      expect(stored.session?.currentAdapterSessionId).toBeUndefined();
    });

    // Writing the pair is not exercised here, because neither surface this suite
    // covers can write it: `storage:session.update` no longer carries the pair
    // and `storage:session.set` never did. The single writer is the
    // `storage:sessionOwnership` seam, whose own shared suite asserts both the
    // mirror it writes and that a whole-record `set` cannot clobber it.
  });

  describe('status compare-and-swap', () => {
    it('applies an update only while the stored status is one the caller expected', async () => {
      const session = createSession({ sessionId: 'status-cas', status: 'closed' });
      await MakaioBus.request(SessionStorageSubjects.set, { sessionId: session.sessionId, session });

      const applied = await MakaioBus.request(SessionStorageSubjects.update, {
        sessionId: session.sessionId,
        status: 'active',
        expectedStatus: ['closed'],
      });
      expect(applied.success).toBe(true);
      const reopened = await MakaioBus.request(SessionStorageSubjects.get, { sessionId: session.sessionId });
      expect(reopened.session?.status).toBe('active');

      // The same call again: the row moved on, so the write must not land. This
      // is what keeps an observation from undoing a decision that was taken
      // after it read the row.
      const refused = await MakaioBus.request(SessionStorageSubjects.update, {
        sessionId: session.sessionId,
        status: 'closed',
        expectedStatus: ['closed'],
      });
      expect(refused.success).toBe(false);
      const unchanged = await MakaioBus.request(SessionStorageSubjects.get, { sessionId: session.sessionId });
      expect(unchanged.session?.status).toBe('active');
    });

    it('guards every field the update carries, not only the status', async () => {
      const session = createSession({ sessionId: 'status-cas-fields', status: 'archived', title: 'original' });
      await MakaioBus.request(SessionStorageSubjects.set, { sessionId: session.sessionId, session });

      const refused = await MakaioBus.request(SessionStorageSubjects.update, {
        sessionId: session.sessionId,
        status: 'active',
        title: 'renamed',
        expectedStatus: ['closed'],
      });

      expect(refused.success).toBe(false);
      const stored = await MakaioBus.request(SessionStorageSubjects.get, { sessionId: session.sessionId });
      expect(stored.session?.status).toBe('archived');
      expect(stored.session?.title).toBe('original');
    });

    it('leaves an omitted expectation unconditional', async () => {
      const session = createSession({ sessionId: 'status-cas-omitted', status: 'archived' });
      await MakaioBus.request(SessionStorageSubjects.set, { sessionId: session.sessionId, session });

      const applied = await MakaioBus.request(SessionStorageSubjects.update, {
        sessionId: session.sessionId,
        status: 'active',
      });

      expect(applied.success).toBe(true);
      const stored = await MakaioBus.request(SessionStorageSubjects.get, { sessionId: session.sessionId });
      expect(stored.session?.status).toBe('active');
    });
  });

  describe('lead designation', () => {
    it('takes the caller’s designation on insert and the stored one on conflict', async () => {
      const session = createSession({ sessionId: 'lead-designation', leadAgentId: 'agent-inserted' });

      // A fresh row has no designation to lose, so the insert keeps the
      // caller's value — the same split the agent row's origin column makes.
      await MakaioBus.request(SessionStorageSubjects.set, { sessionId: session.sessionId, session });
      const inserted = await MakaioBus.request(SessionStorageSubjects.get, { sessionId: session.sessionId });
      expect(inserted.session?.leadAgentId).toBe('agent-inserted');

      // On conflict it is dropped: `set` carries a caller-held snapshot with no
      // expectation in it, and the designation's single writer — the reserving
      // transaction — writes it under a compare-and-swap.
      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: session.sessionId,
        session: { ...inserted.session!, leadAgentId: 'agent-snapshot', title: 'renamed' },
      });
      const afterConflict = await MakaioBus.request(SessionStorageSubjects.get, { sessionId: session.sessionId });
      expect(afterConflict.session?.title).toBe('renamed');
      expect(afterConflict.session?.leadAgentId).toBe('agent-inserted');

      // Unsetting it is refused for the same reason, so a stale reader cannot
      // leave a session leaderless by accident.
      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: session.sessionId,
        session: { ...inserted.session!, leadAgentId: undefined },
      });
      const afterClear = await MakaioBus.request(SessionStorageSubjects.get, { sessionId: session.sessionId });
      expect(afterClear.session?.leadAgentId).toBe('agent-inserted');
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

  describe('identity backfill (conditional on an open identity and a named lead)', () => {
    /**
     * Seed one row and return the identity write that should land on it.
     * @param overrides - Session fields the case needs to differ.
     * @returns The seeded session ID and a writer for the identity backfill.
     */
    async function seedForBackfill(overrides: Partial<IMakaioSession>): Promise<{
      sessionId: string;
      backfill: (identity: BackfillIdentity, lead: string | null) => Promise<boolean>;
    }> {
      const session = createSession(overrides);
      await MakaioBus.request(SessionStorageSubjects.set, { sessionId: session.sessionId, session });
      return {
        sessionId: session.sessionId,
        backfill: async (identity, lead) =>
          (
            await MakaioBus.request(SessionStorageSubjects.update, {
              sessionId: session.sessionId,
              identity,
              expectIdentityOpenForLead: lead,
              lastActivityAt: Date.now(),
            })
          ).success,
      };
    }

    /**
     * Read the stored identity triplet of a session.
     * @param sessionId - Session to read.
     * @returns The three identity columns as stored.
     */
    async function readIdentity(
      sessionId: string,
    ): Promise<{ adapterName?: string; adapterId?: string; adapterSessionId?: string }> {
      const { session } = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
      return {
        adapterName: session?.adapterName,
        adapterId: session?.adapterId,
        adapterSessionId: session?.adapterSessionId,
      };
    }

    it('writes the triplet while the identity is open and the row names the lead', async () => {
      const { sessionId, backfill } = await seedForBackfill({ leadAgentId: 'lead-1' });

      expect(await backfill({ adapterName: 'lead-adapter', adapterId: 'lead-instance' }, 'lead-1')).toBe(true);

      // The provider session is genuinely absent here — a reserved start withholds
      // it — and its absence must not be written as a value.
      expect(await readIdentity(sessionId)).toEqual({
        adapterName: 'lead-adapter',
        adapterId: 'lead-instance',
        adapterSessionId: undefined,
      });
    });

    it('lets exactly one of two racing writers establish the identity (case 216)', async () => {
      const { sessionId, backfill } = await seedForBackfill({ leadAgentId: 'lead-1' });

      // Both writers name the same lead and both believe the identity is open,
      // which is exactly the state a re-read plus a re-check could not tell apart
      // from the one where a peer had already written. Issued together, so the
      // arbitration is the predicate's and not the test's ordering.
      const [first, second] = await Promise.all([
        backfill({ adapterName: 'winner-adapter', adapterId: 'winner-instance' }, 'lead-1'),
        backfill({ adapterName: 'loser-adapter', adapterId: 'loser-instance' }, 'lead-1'),
      ]);

      expect([first, second].filter(Boolean)).toHaveLength(1);
      const stored = await readIdentity(sessionId);
      const winner = first ? 'winner' : 'loser';
      expect(stored.adapterName).toBe(`${winner}-adapter`);
      expect(stored.adapterId).toBe(`${winner}-instance`);
    });

    it('refuses a row whose identity is already established (case 217)', async () => {
      const { sessionId, backfill } = await seedForBackfill({
        leadAgentId: 'lead-1',
        adapterName: 'established-adapter',
        adapterId: 'established-instance',
      });

      expect(await backfill({ adapterName: 'late-adapter', adapterId: 'late-instance' }, 'lead-1')).toBe(false);
      expect(await readIdentity(sessionId)).toMatchObject({
        adapterName: 'established-adapter',
        adapterId: 'established-instance',
      });
    });

    it('refuses a row holding only an instance, with no name beside it (case 217)', async () => {
      // The arm that fails a predicate testing `adapter_name` alone: a
      // half-populated row would be completed by a second writer, and a completed
      // pair whose halves came from two writers is the state the pair exists to
      // prevent.
      const { sessionId, backfill } = await seedForBackfill({
        leadAgentId: 'lead-1',
        adapterId: 'orphan-instance',
      });

      expect(await backfill({ adapterName: 'late-adapter', adapterId: 'late-instance' }, 'lead-1')).toBe(false);
      expect(await readIdentity(sessionId)).toMatchObject({
        adapterName: undefined,
        adapterId: 'orphan-instance',
      });
    });

    it('refuses a row holding only a name, with no instance beside it (case 217)', async () => {
      const { sessionId, backfill } = await seedForBackfill({
        leadAgentId: 'lead-1',
        adapterName: 'orphan-adapter',
      });

      expect(await backfill({ adapterName: 'late-adapter', adapterId: 'late-instance' }, 'lead-1')).toBe(false);
      expect(await readIdentity(sessionId)).toMatchObject({
        adapterName: 'orphan-adapter',
        adapterId: undefined,
      });
    });

    it('refuses when the row names a different lead (case 217)', async () => {
      const { sessionId, backfill } = await seedForBackfill({ leadAgentId: 'lead-2' });

      // The designation moved — a replacement lead, or a removal followed by
      // another start. The identity a superseded lead assembled describes a
      // conversation the session no longer follows.
      expect(await backfill({ adapterName: 'stale-adapter', adapterId: 'stale-instance' }, 'lead-1')).toBe(false);
      expect(await readIdentity(sessionId)).toMatchObject({ adapterName: undefined, adapterId: undefined });
    });

    it('refuses a designation expectation against a row that carries none (case 217)', async () => {
      const { sessionId, backfill } = await seedForBackfill({});

      expect(await backfill({ adapterName: 'stale-adapter', adapterId: 'stale-instance' }, 'lead-1')).toBe(false);
      expect(await readIdentity(sessionId)).toMatchObject({ adapterName: undefined, adapterId: undefined });
    });

    it('accepts an explicit no-designation expectation, and only while none is stored', async () => {
      // The composition a host without a designation authority produces: the
      // column stays unset and the first agent observed establishes the identity.
      const undesignated = await seedForBackfill({});
      expect(await undesignated.backfill({ adapterName: 'only-adapter', adapterId: 'only-instance' }, null)).toBe(true);
      expect(await readIdentity(undesignated.sessionId)).toMatchObject({ adapterName: 'only-adapter' });

      // And where a designation does exist, the same expectation is a false
      // statement about the row rather than a wildcard.
      const designated = await seedForBackfill({ leadAgentId: 'lead-1' });
      expect(await designated.backfill({ adapterName: 'no-adapter', adapterId: 'no-instance' }, null)).toBe(false);
      expect(await readIdentity(designated.sessionId)).toMatchObject({ adapterName: undefined });
    });

    it('withholds every field a refused identity write carried', async () => {
      const session = createSession({
        sessionId: 'identity-refusal-withholds',
        leadAgentId: 'lead-2',
        title: 'original',
      });
      await MakaioBus.request(SessionStorageSubjects.set, { sessionId: session.sessionId, session });

      const refused = await MakaioBus.request(SessionStorageSubjects.update, {
        sessionId: session.sessionId,
        identity: { adapterName: 'stale-adapter', adapterId: 'stale-instance' },
        expectIdentityOpenForLead: 'lead-1',
        title: 'renamed',
      });

      // One statement, one outcome: a caller that wants its unconditional fields
      // written anyway issues them separately, which is what the announcement
      // handler does on the refusal path.
      expect(refused.success).toBe(false);
      const { session: stored } = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: session.sessionId,
      });
      expect(stored?.title).toBe('original');
    });

    it('rejects an identity write that carries no expectation, and the reverse', async () => {
      await expect(
        MakaioBus.request(SessionStorageSubjects.update, {
          sessionId: 'never-reached',
          identity: { adapterName: 'unguarded-adapter', adapterId: 'unguarded-instance' },
        }),
      ).rejects.toThrow(/expectIdentityOpenForLead is required/i);

      await expect(
        MakaioBus.request(SessionStorageSubjects.update, {
          sessionId: 'never-reached',
          expectIdentityOpenForLead: 'lead-1',
          title: 'guarded by a condition about columns it never writes',
        }),
      ).rejects.toThrow(/identity is required/i);
    });
  });
}
