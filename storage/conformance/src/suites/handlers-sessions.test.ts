/**
 * Conformance suite: session and agent storage handler families.
 *
 * Registers the real Drizzle handlers against a live migrated database and
 * exercises the full CRUD surface over the bus. The suite is dialect-agnostic;
 * the same assertions run on both SQLite and Postgres.
 *
 * Key invariants pinned here:
 * - create→get round-trip preserves all supplied fields.
 * - excluded.*-based upsert: the second write with changed fields wins.
 * - set responds success:true — didAffectRows over the upsert result drives
 *   the flag (.returning()-based row reads are pinned by the crud-factory
 *   families in handlers-family-smoke).
 * - delete: removing a session succeeds and a subsequent get returns null.
 * - getChildren: parentSessionId FK links are traversed correctly.
 * - getSessionAncestorChain: recursive CTE returns root→leaf chain.
 * - agent upsert: writing the same agentId twice keeps exactly one row.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import type { IMakaioSession, MakaioSessionAgent } from '@makaio/contracts';
import {
  registerDrizzleSessionStorage,
  registerDrizzleAgentStorage,
  SessionStorageSubjects,
  AgentStorageSubjects,
  getSessionAncestorChain,
} from '@makaio/services-core/session';
import { describeStorageConformance } from '../harness/env.js';
import { useSuiteDatabaseContext } from '../harness/suite-context.js';
import { makeSession } from '../harness/fixture-session.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal agent payload for the set subject.
 * @param overrides - Field overrides.
 * @returns Payload for AgentStorageSubjects.set.
 */
function makeAgent(overrides: Partial<MakaioSessionAgent> = {}): MakaioSessionAgent {
  const now = Date.now();
  return {
    agentId: `agent-${crypto.randomUUID()}`,
    adapterId: `adapter-${crypto.randomUUID()}`,
    adapterName: 'test-adapter',
    sessionId: `session-${crypto.randomUUID()}`,
    role: 'lead',
    status: 'idle',
    createdAt: now,
    lastActivityAt: now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeStorageConformance('handlers-sessions', (config) => {
  const getCtx = useSuiteDatabaseContext(config);
  const cleanups: Array<() => void> = [];

  beforeAll(() => {
    cleanups.push(registerDrizzleSessionStorage(MakaioBus, getCtx().db));
    cleanups.push(registerDrizzleAgentStorage(MakaioBus, getCtx().db));
  });

  afterAll(() => {
    // Handlers unregister first; the context helper's afterAll (registered
    // earlier, therefore run later) releases the database afterwards.
    for (const fn of cleanups.reverse()) {
      fn();
    }
  });

  // ─── 1. create→get round-trip ───────────────────────────────────────────

  describe('session create→get round-trip', () => {
    it('persists all supplied fields and retrieves an identical record', async () => {
      const session = makeSession({ title: 'conformance test', adapterName: 'claude-code' });
      const sessionId = session.sessionId;

      const setResult = await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId,
        session,
      });
      expect(setResult.success).toBe(true);

      const getResult = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
      expect(getResult.session).not.toBeNull();
      expect(getResult.session?.sessionId).toBe(sessionId);
      expect(getResult.session?.title).toBe('conformance test');
      expect(getResult.session?.adapterName).toBe('claude-code');
      expect(getResult.session?.isOrchestrated).toBe(false);
    });
  });

  // ─── 2. upsert: second write wins ───────────────────────────────────────

  describe('session upsert — excluded.* conflict target', () => {
    it('overwrites mutable fields on conflict (second write wins)', async () => {
      const session = makeSession({ status: 'active', lastActivityAt: 1000 });
      const sessionId = session.sessionId;

      await MakaioBus.request(SessionStorageSubjects.set, { sessionId, session });

      const updated: IMakaioSession = { ...session, status: 'closed', lastActivityAt: 2000 };
      const upsertResult = await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId,
        session: updated,
      });
      expect(upsertResult.success).toBe(true);

      const getResult = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
      expect(getResult.session?.status).toBe('closed');
      expect(getResult.session?.lastActivityAt).toBe(2000);
    });
  });

  // ─── 3. set reports success on insert ───────────────────────────────────

  describe('set reports success — didAffectRows drives the response flag', () => {
    it('set response includes success:true after insert', async () => {
      const session = makeSession();
      const sessionId = session.sessionId;

      const result = await MakaioBus.request(SessionStorageSubjects.set, { sessionId, session });
      // The session set handler reports success via didAffectRows over its
      // onConflictDoUpdate upsert — it never calls .returning(). The factory
      // .returning() path (response carries the persisted row) is exercised
      // by the crud-factory families in handlers-family-smoke.
      expect(result.success).toBe(true);
    });
  });

  // ─── 4. delete ────────────────────────────────────────────────────────────

  describe('delete', () => {
    it('deleting an existing session responds success:true', async () => {
      const session = makeSession();
      const sessionId = session.sessionId;
      await MakaioBus.request(SessionStorageSubjects.set, { sessionId, session });

      const delResult = await MakaioBus.request(SessionStorageSubjects.delete, { sessionId });
      expect(delResult.success).toBe(true);
    });

    it('get returns null after deletion', async () => {
      const session = makeSession();
      const sessionId = session.sessionId;
      await MakaioBus.request(SessionStorageSubjects.set, { sessionId, session });
      await MakaioBus.request(SessionStorageSubjects.delete, { sessionId });

      const getResult = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
      expect(getResult.session).toBeNull();
    });
  });

  // ─── 5. list/getChildren ────────────────────────────────────────────────

  describe('getChildren', () => {
    it('returns both child sessions given a parent', async () => {
      const parentId = `parent-${crypto.randomUUID()}`;
      const parent = makeSession({ sessionId: parentId });
      const child1 = makeSession({ parentSessionId: parentId });
      const child2 = makeSession({ parentSessionId: parentId });

      await MakaioBus.request(SessionStorageSubjects.set, { sessionId: parentId, session: parent });
      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: child1.sessionId,
        session: child1,
      });
      await MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: child2.sessionId,
        session: child2,
      });

      const result = await MakaioBus.request(SessionStorageSubjects.getChildren, { sessionId: parentId });
      expect(result.children).toHaveLength(2);
      const childIds = result.children.map((s) => s.sessionId);
      expect(childIds).toContain(child1.sessionId);
      expect(childIds).toContain(child2.sessionId);
    });
  });

  // ─── 6. ancestors recursive CTE ─────────────────────────────────────────

  describe('getSessionAncestorChain — recursive CTE', () => {
    it('returns ordered ancestor chain from leaf to root', async () => {
      const rootId = `root-${crypto.randomUUID()}`;
      const c1Id = `c1-${crypto.randomUUID()}`;
      const c2Id = `c2-${crypto.randomUUID()}`;
      const c3Id = `c3-${crypto.randomUUID()}`;

      const root = makeSession({ sessionId: rootId });
      const c1 = makeSession({ sessionId: c1Id, parentSessionId: rootId, rootSessionId: rootId });
      const c2 = makeSession({ sessionId: c2Id, parentSessionId: c1Id, rootSessionId: rootId });
      const c3 = makeSession({ sessionId: c3Id, parentSessionId: c2Id, rootSessionId: rootId });

      for (const s of [root, c1, c2, c3]) {
        await MakaioBus.request(SessionStorageSubjects.set, { sessionId: s.sessionId, session: s });
      }

      const chain = await getSessionAncestorChain(getCtx().db, c3Id);
      expect(chain).toEqual([c3Id, c2Id, c1Id, rootId]);
    });

    it('returns a single-element array for a root session', async () => {
      const rootId = `lone-root-${crypto.randomUUID()}`;
      const root = makeSession({ sessionId: rootId });
      await MakaioBus.request(SessionStorageSubjects.set, { sessionId: rootId, session: root });

      const chain = await getSessionAncestorChain(getCtx().db, rootId);
      expect(chain).toEqual([rootId]);
    });
  });

  // ─── 7. agent upsert ────────────────────────────────────────────────────

  describe('agent upsert — single row after two writes', () => {
    it('second write with changed payload overwrites the first, leaving exactly one row', async () => {
      const sessionId = `sess-agent-${crypto.randomUUID()}`;
      const session = makeSession({ sessionId });
      await MakaioBus.request(SessionStorageSubjects.set, { sessionId, session });

      const agentId = `agent-${crypto.randomUUID()}`;
      const agent = makeAgent({ agentId, sessionId, status: 'idle', allowedDirectories: ['/workspace'] });

      await MakaioBus.request(AgentStorageSubjects.set, { agentId, agent });
      const updated: MakaioSessionAgent = {
        ...agent,
        status: 'active',
        allowedDirectories: ['/workspace', '/tmp'],
        lastActivityAt: Date.now() + 100,
      };
      const result = await MakaioBus.request(AgentStorageSubjects.set, { agentId, agent: updated });
      expect(result.success).toBe(true);

      const listResult = await MakaioBus.request(AgentStorageSubjects.listBySession, { sessionId });
      expect(listResult.agents).toHaveLength(1);
      expect(listResult.agents[0].agentId).toBe(agentId);
      expect(listResult.agents[0].status).toBe('active');
      expect(listResult.agents[0].allowedDirectories).toEqual(['/workspace', '/tmp']);
    });

    it('keeps a stored disposed status while still applying the rest of the write', async () => {
      // The upsert's conflict clause merges `status` in SQL rather than taking
      // the caller's value outright, so the rule has to hold on every dialect,
      // not only on the one the shared backend suite runs against.
      const sessionId = `sess-agent-${crypto.randomUUID()}`;
      await MakaioBus.request(SessionStorageSubjects.set, { sessionId, session: makeSession({ sessionId }) });

      const agentId = `agent-${crypto.randomUUID()}`;
      const agent = makeAgent({ agentId, sessionId, status: 'idle' });
      await MakaioBus.request(AgentStorageSubjects.set, { agentId, agent });
      await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId, status: 'disposed' });

      const revival = await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId, status: 'idle' });
      expect(revival).toEqual({ success: true, transitioned: false });

      await MakaioBus.request(AgentStorageSubjects.set, {
        agentId,
        agent: { ...agent, status: 'idle', allowedDirectories: ['/tmp'] },
      });

      const { agent: stored } = await MakaioBus.request(AgentStorageSubjects.get, { agentId });
      expect(stored?.status).toBe('disposed');
      expect(stored?.allowedDirectories).toEqual(['/tmp']);
    });
  });
});
