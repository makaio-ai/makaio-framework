/**
 * Tests for the parent resolver handler (unified sessions table).
 *
 * Verifies that when `session.import.completed` is emitted for a parent
 * session, child sessions that reference it via `parentExternalSessionId`
 * (but whose `parentSessionId` is not yet set) get their `parentSessionId`
 * and `rootSessionId` updated correctly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { SessionSubjects, type IMakaioSession } from '@makaio/contracts';
import { SessionStorageSubjects } from '../../storage/namespace.js';
import { registerParentResolver } from '../parent-resolver.js';
import { createTempDb, createDbCleanup } from '@makaio/test-utils/drizzle-harness';
import { installSessionStorageTestSchema } from '../../testing/storage-test-schema.js';
import { registerDrizzleSessionStorage } from '../../storage/drizzle-handler.js';

/** Millisecond counter for unique timestamps in each test. */
let _ts = 1;
const ts = (): number => _ts++;

/**
 * Creates a minimal Makaio session in the test database.
 * @param sessionId - Session ID to create
 * @param overrides - Optional field overrides
 */
async function createSession(
  sessionId: string,
  overrides: Partial<{
    adapterSessionId: string;
    parentExternalSessionId: string;
    parentSessionId: string;
    rootSessionId: string;
    branchKind: 'fork' | 'subagent' | 'compress';
    source: string;
  }> = {},
): Promise<void> {
  const now = ts();
  await MakaioBus.request(SessionStorageSubjects.set, {
    sessionId,
    session: {
      sessionId,
      createdAt: now,
      lastActivityAt: now,
      status: 'active',
      agents: [],
      source: 'claude-code',
      ...overrides,
    },
  });
}

/**
 * Wait for a session to satisfy an assertion after the async resolver runs.
 * @param sessionId - Session ID to load
 * @param assertSession - Assertion callback run inside vi.waitFor
 */
async function expectEventuallySession(
  sessionId: string,
  assertSession: (session: IMakaioSession | null) => void,
): Promise<void> {
  await vi.waitFor(async () => {
    const { session } = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
    assertSession(session);
  });
}

/**
 * Emit session.import.completed for a session to trigger the parent resolver.
 * @param sessionId - Makaio session ID
 * @param adapterSessionId - External (adapter) session ID
 */
async function emitImportCompleted(sessionId: string, adapterSessionId: string): Promise<void> {
  await MakaioBus.emit(SessionSubjects.import.completed, {
    sessionId,
    adapterSessionId,
    source: 'claude-code',
  });
}

describe('registerParentResolver', () => {
  let _cleanup: (() => void) | undefined;

  beforeEach(async () => {
    _ts = 1;
    const { db, close, dbPath } = await createTempDb('parent-resolver');

    await installSessionStorageTestSchema(db);

    const sessionCleanup = registerDrizzleSessionStorage(MakaioBus, db);
    const resolverCleanup = registerParentResolver(MakaioBus, db);

    _cleanup = createDbCleanup(
      () => {
        resolverCleanup();
        sessionCleanup();
      },
      close,
      dbPath,
    );
  });

  afterEach(() => {
    _cleanup?.();
    _cleanup = undefined;
  });

  it('updates child parentSessionId when parent import completes', async () => {
    // Create parent session
    await createSession('parent-1', { adapterSessionId: 'ext-parent-1' });

    // Create child session with parentExternalSessionId pointing to parent's ext ID
    // but no parentSessionId yet (out-of-order: child imported before parent)
    await createSession('child-1', {
      adapterSessionId: 'ext-child-1',
      parentExternalSessionId: 'ext-parent-1',
    });

    // Emit import.completed for parent — resolver should link the child
    await emitImportCompleted('parent-1', 'ext-parent-1');

    await expectEventuallySession('child-1', (child) => {
      expect(child?.parentSessionId).toBe('parent-1');
      expect(child?.rootSessionId).toBe('parent-1');
    });
  });

  it('updates multiple children when parent import completes', async () => {
    await createSession('parent-multi', { adapterSessionId: 'ext-parent-multi' });

    for (const suffix of ['a', 'b', 'c']) {
      await createSession(`child-${suffix}`, {
        adapterSessionId: `ext-child-${suffix}`,
        parentExternalSessionId: 'ext-parent-multi',
      });
    }

    await emitImportCompleted('parent-multi', 'ext-parent-multi');

    for (const suffix of ['a', 'b', 'c']) {
      await expectEventuallySession(`child-${suffix}`, (session) => {
        expect(session?.parentSessionId).toBe('parent-multi');
      });
    }
  });

  it('skips children that already have parentSessionId set (already resolved)', async () => {
    await createSession('parent-already', { adapterSessionId: 'ext-parent-already' });

    // Child with parentSessionId already set — resolver should skip it
    await createSession('child-resolved', {
      adapterSessionId: 'ext-child-resolved',
      parentExternalSessionId: 'ext-parent-already',
      parentSessionId: 'some-other-parent',
    });

    await emitImportCompleted('parent-already', 'ext-parent-already');

    await expectEventuallySession('child-resolved', (session) => {
      // Should not have been overwritten
      expect(session?.parentSessionId).toBe('some-other-parent');
    });
  });

  it('handles parent with no children gracefully', async () => {
    await createSession('parent-alone', { adapterSessionId: 'ext-parent-alone' });

    // Should not throw
    await expect(emitImportCompleted('parent-alone', 'ext-parent-alone')).resolves.not.toThrow();
  });

  it('propagates rootSessionId from parent when parent is itself a child', async () => {
    // Root → parent → child (parent already knows its root)
    await createSession('root-session', { adapterSessionId: 'ext-root' });
    await createSession('mid-session', {
      adapterSessionId: 'ext-mid',
      parentExternalSessionId: 'ext-root',
      parentSessionId: 'root-session',
      rootSessionId: 'root-session',
    });
    await createSession('leaf-session', {
      adapterSessionId: 'ext-leaf',
      parentExternalSessionId: 'ext-mid',
    });

    await emitImportCompleted('mid-session', 'ext-mid');

    await expectEventuallySession('leaf-session', (leaf) => {
      expect(leaf?.parentSessionId).toBe('mid-session');
      // rootSessionId from mid-session should propagate
      expect(leaf?.rootSessionId).toBe('root-session');
    });
  });

  it('cascades rootSessionId to grandchildren via parentExternalSessionId traversal', async () => {
    // Root → child → grandchild (grandchild imported before child and root)
    await createSession('root-gc', { adapterSessionId: 'ext-root-gc' });
    await createSession('child-gc', {
      adapterSessionId: 'ext-child-gc',
      parentExternalSessionId: 'ext-root-gc',
    });
    // grandchild: parentSessionId already set (child was resolved), but rootSessionId may be stale
    await createSession('grandchild-gc', {
      adapterSessionId: 'ext-grandchild-gc',
      parentExternalSessionId: 'ext-child-gc',
      parentSessionId: 'child-gc',
      rootSessionId: 'child-gc', // stale — child was root before root was imported
    });

    // Now root import completes — cascade should update rootSessionId all the way to grandchild
    await emitImportCompleted('root-gc', 'ext-root-gc');

    await expectEventuallySession('child-gc', (child) => {
      expect(child?.parentSessionId).toBe('root-gc');
      expect(child?.rootSessionId).toBe('root-gc');
    });

    // Grandchild should have rootSessionId cascaded to root-gc
    await expectEventuallySession('grandchild-gc', (grandchild) => {
      expect(grandchild?.rootSessionId).toBe('root-gc');
    });
  });
});
