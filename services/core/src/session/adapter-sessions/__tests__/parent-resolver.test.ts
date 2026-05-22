/**
 * Tests for parent resolver handler.
 *
 * Verifies that when a parent session is linked, child sessions that reference
 * it get their Makaio session's parentSessionId updated.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSessionStorageSubjects } from '../namespace.js';
import { SessionStorageSubjects } from '../../storage/namespace.js';
import { registerParentResolver } from '../parent-resolver.js';
import { useAdapterSessionTestLifecycle } from './shared.js';

/**
 * Creates a minimal Makaio session for testing.
 * @param sessionId - The session ID to create
 */
async function createMakaioSession(sessionId: string): Promise<void> {
  const now = Date.now();
  await MakaioBus.request(SessionStorageSubjects.set, {
    sessionId,
    session: {
      sessionId,
      createdAt: now,
      lastActivityAt: now,
      status: 'active',
      agents: [],
    },
  });
}

describe('registerParentResolver', () => {
  useAdapterSessionTestLifecycle(
    { beforeEach, afterEach },
    { additionalHandlers: (db) => registerParentResolver(MakaioBus, db) },
  );

  it('should update child Makaio session parentSessionId when parent is linked', async () => {
    // Create Makaio sessions for parent and child
    await createMakaioSession('makaio-parent-1');
    await createMakaioSession('makaio-child-1');

    // Create parent adapter session (not yet linked)
    await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
      adapterSessionId: 'adapter-parent-1',
      adapterName: 'claude-code',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
      kind: 'root',
      model: null,
      cwd: null,
    });

    // Create child adapter session referencing the parent
    await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
      adapterSessionId: 'adapter-child-1',
      adapterName: 'claude-code',
      parentAdapterSessionId: 'adapter-parent-1',
      forkPointMessageId: 'msg-fork-1',
      kind: 'fork',
      model: null,
      cwd: null,
    });

    // Link the child adapter session to its Makaio session first (out-of-order import)
    await MakaioBus.request(AdapterSessionStorageSubjects.linkSession, {
      adapterSessionId: 'adapter-child-1',
      sessionId: 'makaio-child-1',
    });

    // Verify child has no parent yet
    const beforeLink = await MakaioBus.request(SessionStorageSubjects.get, {
      sessionId: 'makaio-child-1',
    });
    expect(beforeLink.session?.parentSessionId).toBeUndefined();

    // Link the parent adapter session - this should trigger parent resolver
    await MakaioBus.request(AdapterSessionStorageSubjects.linkSession, {
      adapterSessionId: 'adapter-parent-1',
      sessionId: 'makaio-parent-1',
    });

    // Wait for async handler to complete
    await vi.waitFor(async () => {
      const result = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: 'makaio-child-1',
      });
      expect(result.session?.parentSessionId).toBe('makaio-parent-1');
    });
  });

  it('should update multiple children when parent is linked', async () => {
    // Create Makaio sessions
    await createMakaioSession('makaio-parent-multi');
    await createMakaioSession('makaio-child-a');
    await createMakaioSession('makaio-child-b');
    await createMakaioSession('makaio-child-c');

    // Create parent adapter session
    await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
      adapterSessionId: 'adapter-parent-multi',
      adapterName: 'claude-code',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
      kind: 'root',
      model: null,
      cwd: null,
    });

    // Create multiple child adapter sessions referencing the same parent
    for (const suffix of ['a', 'b', 'c']) {
      await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
        adapterSessionId: `adapter-child-${suffix}`,
        adapterName: 'claude-code',
        parentAdapterSessionId: 'adapter-parent-multi',
        forkPointMessageId: `msg-fork-${suffix}`,
        kind: 'fork',
        model: null,
        cwd: null,
      });

      // Link each child to its Makaio session (before parent is linked)
      await MakaioBus.request(AdapterSessionStorageSubjects.linkSession, {
        adapterSessionId: `adapter-child-${suffix}`,
        sessionId: `makaio-child-${suffix}`,
      });
    }

    // Link the parent - should update all children
    await MakaioBus.request(AdapterSessionStorageSubjects.linkSession, {
      adapterSessionId: 'adapter-parent-multi',
      sessionId: 'makaio-parent-multi',
    });

    // Wait and verify all children have parent set
    await vi.waitFor(async () => {
      for (const suffix of ['a', 'b', 'c']) {
        const result = await MakaioBus.request(SessionStorageSubjects.get, {
          sessionId: `makaio-child-${suffix}`,
        });
        expect(result.session?.parentSessionId).toBe('makaio-parent-multi');
      }
    });
  });

  it('should skip unlinked children without crashing', async () => {
    // Create only the parent Makaio session
    await createMakaioSession('makaio-parent-skip');

    // Create parent adapter session
    await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
      adapterSessionId: 'adapter-parent-skip',
      adapterName: 'claude-code',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
      kind: 'root',
      model: null,
      cwd: null,
    });

    // Create child adapter sessions - some linked, some not
    await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
      adapterSessionId: 'adapter-child-unlinked',
      adapterName: 'claude-code',
      parentAdapterSessionId: 'adapter-parent-skip',
      forkPointMessageId: 'msg-fork-unlinked',
      kind: 'fork',
      model: null,
      cwd: null,
    });
    // NOTE: We don't link adapter-child-unlinked to any Makaio session

    // Create a linked child
    await createMakaioSession('makaio-child-linked');
    await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
      adapterSessionId: 'adapter-child-linked',
      adapterName: 'claude-code',
      parentAdapterSessionId: 'adapter-parent-skip',
      forkPointMessageId: 'msg-fork-linked',
      kind: 'fork',
      model: null,
      cwd: null,
    });
    await MakaioBus.request(AdapterSessionStorageSubjects.linkSession, {
      adapterSessionId: 'adapter-child-linked',
      sessionId: 'makaio-child-linked',
    });

    // Link the parent - should NOT crash on unlinked child
    await MakaioBus.request(AdapterSessionStorageSubjects.linkSession, {
      adapterSessionId: 'adapter-parent-skip',
      sessionId: 'makaio-parent-skip',
    });

    // Verify the linked child got updated
    await vi.waitFor(async () => {
      const result = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: 'makaio-child-linked',
      });
      expect(result.session?.parentSessionId).toBe('makaio-parent-skip');
    });

    // Verify the unlinked adapter session still has no sessionId
    const unlinkedResult = await MakaioBus.request(AdapterSessionStorageSubjects.get, {
      adapterSessionId: 'adapter-child-unlinked',
    });
    expect(unlinkedResult.session?.sessionId).toBeNull();
  });

  it('should still cascade rootSessionId through an unlinked direct child', async () => {
    await createMakaioSession('makaio-root-gap');
    await createMakaioSession('makaio-grandchild-gap');

    await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
      adapterSessionId: 'adapter-root-gap',
      adapterName: 'claude-code',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
      kind: 'root',
      model: null,
      cwd: null,
    });
    await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
      adapterSessionId: 'adapter-child-gap',
      adapterName: 'claude-code',
      parentAdapterSessionId: 'adapter-root-gap',
      forkPointMessageId: 'fork-gap-child',
      kind: 'fork',
      model: null,
      cwd: null,
    });
    await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
      adapterSessionId: 'adapter-grandchild-gap',
      adapterName: 'claude-code',
      parentAdapterSessionId: 'adapter-child-gap',
      forkPointMessageId: 'fork-gap-grandchild',
      kind: 'fork',
      model: null,
      cwd: null,
    });

    await MakaioBus.request(AdapterSessionStorageSubjects.linkSession, {
      adapterSessionId: 'adapter-grandchild-gap',
      sessionId: 'makaio-grandchild-gap',
    });

    await MakaioBus.request(AdapterSessionStorageSubjects.linkSession, {
      adapterSessionId: 'adapter-root-gap',
      sessionId: 'makaio-root-gap',
    });

    await vi.waitFor(async () => {
      const grandchild = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: 'makaio-grandchild-gap',
      });
      expect(grandchild.session?.rootSessionId).toBe('makaio-root-gap');
    });

    const grandchild = await MakaioBus.request(SessionStorageSubjects.get, {
      sessionId: 'makaio-grandchild-gap',
    });
    expect(grandchild.session?.parentSessionId).toBeUndefined();
  });

  it('should cascade rootSessionId to grandchildren with out-of-order import (G → GG → C → R)', async () => {
    // Chain: R → C → G → GG (root → child → grandchild → great-grandchild)
    // Import order: G first, then GG, then C, then R (out-of-order)
    // When R is finally linked, the cascade must reach GG even though
    // sessions.parent_session_id for G and GG is not yet set at that point.

    await createMakaioSession('makaio-root');
    await createMakaioSession('makaio-child');
    await createMakaioSession('makaio-grandchild');
    await createMakaioSession('makaio-great-grandchild');

    // Upsert all adapter sessions with their parent references.
    // parent_adapter_session_id is always set at upsert time.
    await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
      adapterSessionId: 'adapter-root',
      adapterName: 'claude-code',
      kind: 'root',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
      model: null,
      cwd: null,
    });
    await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
      adapterSessionId: 'adapter-child',
      adapterName: 'claude-code',
      kind: 'fork',
      parentAdapterSessionId: 'adapter-root',
      forkPointMessageId: 'fork-child',
      model: null,
      cwd: null,
    });
    await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
      adapterSessionId: 'adapter-grandchild',
      adapterName: 'claude-code',
      kind: 'fork',
      parentAdapterSessionId: 'adapter-child',
      forkPointMessageId: 'fork-grandchild',
      model: null,
      cwd: null,
    });
    await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
      adapterSessionId: 'adapter-great-grandchild',
      adapterName: 'claude-code',
      kind: 'fork',
      parentAdapterSessionId: 'adapter-grandchild',
      forkPointMessageId: 'fork-great-grandchild',
      model: null,
      cwd: null,
    });

    // Import order: G → GG → C → R (grandchild first, root last)
    //
    // This test verifies that cascadeRootSessionId walks adapter_sessions.parent_adapter_session_id
    // (always populated at upsert time) instead of sessions.parent_session_id (only populated after
    // the resolver has already run for each level).
    //
    // Without the fix, when R is linked, the old cascade walked sessions.parent_session_id.
    // Since GG was linked before G's parent C was linked, GG.parent_session_id was never set,
    // so the cascade from R would stop at G and GG would be permanently orphaned from rootSessionId.
    //
    // With the fix, the cascade walks adapter_sessions.parent_adapter_session_id which is always
    // set at upsert time, so GG.rootSessionId is correctly updated to R.

    // Step 1: Link G — its parent C is not linked yet.
    // Resolver fires for G: looks for G's children (GG not linked yet) → skips GG.
    await MakaioBus.request(AdapterSessionStorageSubjects.linkSession, {
      adapterSessionId: 'adapter-grandchild',
      sessionId: 'makaio-grandchild',
    });

    // Step 2: Link GG — resolver fires for GG: looks for GG's children (none) → nothing.
    // GG's parentSessionId is NOT set here — G's linking event already fired before GG was linked.
    await MakaioBus.request(AdapterSessionStorageSubjects.linkSession, {
      adapterSessionId: 'adapter-great-grandchild',
      sessionId: 'makaio-great-grandchild',
    });

    // Step 3: Link C — resolver fires for C: finds G (linked).
    // Sets G.parentSessionId = C, G.rootSessionId = C.
    // Cascades rootSessionId = C down adapter space: adapter-child → adapter-grandchild (G)
    // → adapter-great-grandchild (GG). GG gets rootSessionId = C.
    await MakaioBus.request(AdapterSessionStorageSubjects.linkSession, {
      adapterSessionId: 'adapter-child',
      sessionId: 'makaio-child',
    });

    // Wait for G to get parentSessionId from C (resolver has processed)
    await vi.waitFor(async () => {
      const g = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: 'makaio-grandchild',
      });
      expect(g.session?.parentSessionId).toBe('makaio-child');
    });

    // Step 4 (critical): Link R — resolver fires for R: finds C (linked).
    // Sets C.parentSessionId = R, C.rootSessionId = R.
    // Cascades rootSessionId = R down adapter space:
    //   adapter-root → adapter-child (C) → adapter-grandchild (G) → adapter-great-grandchild (GG)
    //
    // Without the fix (walking sessions.parent_session_id): the cascade finds G by
    // sessions.parent_session_id = makaio-child (G was set in step 3), updates G.rootSessionId = R,
    // then looks for sessions with parent_session_id = makaio-grandchild — but GG never got its
    // parent_session_id set (G was linked before GG), so GG is orphaned.
    //
    // With the fix (walking adapter_sessions.parent_adapter_session_id): the cascade finds G and
    // GG by their adapter parent references, which are always set at upsert time.
    await MakaioBus.request(AdapterSessionStorageSubjects.linkSession, {
      adapterSessionId: 'adapter-root',
      sessionId: 'makaio-root',
    });

    // Wait for C to get parentSessionId = R (signals resolver has completed for R)
    await vi.waitFor(async () => {
      const c = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: 'makaio-child',
      });
      expect(c.session?.parentSessionId).toBe('makaio-root');
    });

    await vi.waitFor(async () => {
      const grandchild = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: 'makaio-grandchild',
      });
      const greatGrandchild = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: 'makaio-great-grandchild',
      });

      // G's rootSessionId is updated to R by the cascade when R is linked
      expect(grandchild.session?.rootSessionId).toBe('makaio-root');
      // GG's rootSessionId must have been propagated via adapter_sessions traversal.
      // Without the fix, this would still be 'makaio-child' (set in step 3) because
      // GG.parent_session_id is null and the old cascade could not reach GG.
      expect(greatGrandchild.session?.rootSessionId).toBe('makaio-root');
    });
  });

  it('should handle parent with no children gracefully', async () => {
    // Create parent with no children
    await createMakaioSession('makaio-parent-alone');

    await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
      adapterSessionId: 'adapter-parent-alone',
      adapterName: 'claude-code',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
      kind: 'root',
      model: null,
      cwd: null,
    });

    // Link parent - should complete without error
    const result = await MakaioBus.request(AdapterSessionStorageSubjects.linkSession, {
      adapterSessionId: 'adapter-parent-alone',
      sessionId: 'makaio-parent-alone',
    });

    expect(result.success).toBe(true);
  });
});
