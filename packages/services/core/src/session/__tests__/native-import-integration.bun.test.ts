/**
 * Integration test for native session import schema.
 *
 * Verifies the complete flow for git-like fork chains with delta storage:
 * - Session origin tracking (adapterName, adapterSessionId)
 * - Fork chain via parentSessionId/rootSessionId
 * - Ancestor chain query (recursive CTE)
 * - isOrchestrated flag for native resume eligibility
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createTestDb, createSession } from '../storage/__tests__/shared.js';
import { MakaioBus } from '@makaio/bus-core';
import { SessionStorageSubjects } from '../storage/namespace.js';
import { getSessionAncestorChain } from '../storage/ancestor-query.js';
import type { MakaioDatabase } from '@makaio/storage-drizzle';

describe('Native Session Import Integration', () => {
  let cleanup: () => void;
  let db: MakaioDatabase;

  beforeEach(async () => {
    const ctx = await createTestDb();
    db = ctx.db;
    cleanup = ctx.cleanup;
  });

  afterEach(() => cleanup());

  it('should support git-like fork chain with delta messages', async () => {
    // Simulate importing CC sessions
    const root = createSession({
      sessionId: 'makaio-1',
      adapterName: 'claude-code',
      adapterSessionId: 'cc-root',
      isOrchestrated: false,
    });

    const fork = createSession({
      sessionId: 'makaio-2',
      parentSessionId: 'makaio-1',
      rootSessionId: 'makaio-1',
      adapterName: 'claude-code',
      adapterSessionId: 'cc-fork',
      isOrchestrated: false,
    });

    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: root.sessionId,
      session: root,
    });
    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: fork.sessionId,
      session: fork,
    });

    // Verify chain
    const chain = await getSessionAncestorChain(db, 'makaio-2');
    expect(chain).toEqual(['makaio-2', 'makaio-1']);

    // Verify root lookup
    const retrieved = await MakaioBus.request(SessionStorageSubjects.get, {
      sessionId: 'makaio-2',
    });
    expect(retrieved.session?.rootSessionId).toBe('makaio-1');
    expect(retrieved.session?.isOrchestrated).toBe(false);
  });

  it('should preserve adapter origin for native resume eligibility', async () => {
    const session = createSession({
      sessionId: 'native-session',
      adapterName: 'claude-code',
      adapterSessionId: 'cc-session-abc',
      adapterId: 'adapter-instance-123',
      isOrchestrated: false,
    });

    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: session.sessionId,
      session,
    });

    const retrieved = await MakaioBus.request(SessionStorageSubjects.get, {
      sessionId: 'native-session',
    });

    expect(retrieved.session).not.toBeNull();
    expect(retrieved.session?.adapterName).toBe('claude-code');
    expect(retrieved.session?.adapterSessionId).toBe('cc-session-abc');
    expect(retrieved.session?.adapterId).toBe('adapter-instance-123');
    expect(retrieved.session?.isOrchestrated).toBe(false);
  });

  it('should mark session as orchestrated when Makaio modifies history', async () => {
    // Start with a native session
    const session = createSession({
      sessionId: 'will-be-orchestrated',
      adapterName: 'claude-code',
      adapterSessionId: 'cc-session-xyz',
      isOrchestrated: false,
    });

    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: session.sessionId,
      session,
    });

    // Simulate Makaio orchestration modifying the session
    const orchestratedSession = {
      ...session,
      isOrchestrated: true,
      lastActivityAt: Date.now(),
    };

    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: orchestratedSession.sessionId,
      session: orchestratedSession,
    });

    const retrieved = await MakaioBus.request(SessionStorageSubjects.get, {
      sessionId: 'will-be-orchestrated',
    });

    // Once orchestrated, native resume is no longer available
    expect(retrieved.session?.isOrchestrated).toBe(true);
  });

  it('should support deep fork chains (3+ levels)', async () => {
    // Create a deep chain: root -> level1 -> level2 -> level3
    const root = createSession({
      sessionId: 'deep-root',
      isOrchestrated: false,
    });
    const level1 = createSession({
      sessionId: 'deep-level1',
      parentSessionId: 'deep-root',
      rootSessionId: 'deep-root',
      isOrchestrated: false,
    });
    const level2 = createSession({
      sessionId: 'deep-level2',
      parentSessionId: 'deep-level1',
      rootSessionId: 'deep-root',
      isOrchestrated: false,
    });
    const level3 = createSession({
      sessionId: 'deep-level3',
      parentSessionId: 'deep-level2',
      rootSessionId: 'deep-root',
      isOrchestrated: false,
    });

    // Store all sessions
    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: root.sessionId,
      session: root,
    });
    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: level1.sessionId,
      session: level1,
    });
    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: level2.sessionId,
      session: level2,
    });
    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: level3.sessionId,
      session: level3,
    });

    // Verify full ancestor chain from deepest level
    const chain = await getSessionAncestorChain(db, 'deep-level3');
    expect(chain).toEqual(['deep-level3', 'deep-level2', 'deep-level1', 'deep-root']);

    // Verify rootSessionId is preserved through chain
    const retrieved = await MakaioBus.request(SessionStorageSubjects.get, {
      sessionId: 'deep-level3',
    });
    expect(retrieved.session?.rootSessionId).toBe('deep-root');
  });
});
