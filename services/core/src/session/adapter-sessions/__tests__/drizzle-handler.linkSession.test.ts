import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, type SessionLinked } from '@makaio/contracts';
import { AdapterSessionStorageSubjects } from '../namespace.js';
import { SessionStorageSubjects } from '../../storage/namespace.js';
import { useAdapterSessionTestLifecycle, createTestSession } from './shared.js';

function buildAdapterSessionUpsert(
  overrides: Partial<{
    adapterSessionId: string;
    adapterName: string;
    parentAdapterSessionId: string | null;
    forkPointMessageId: string | null;
    kind: 'root' | 'fork' | 'subagent';
    model: string | null;
    cwd: string | null;
    logFilePath: string | null;
  }> = {},
) {
  const base = {
    adapterSessionId: 'cc-default',
    adapterName: 'claude-code',
    model: null,
    cwd: null,
    logFilePath: null,
  };
  const kind = overrides.kind ?? 'root';

  switch (kind) {
    case 'root':
      return {
        ...base,
        adapterSessionId: overrides.adapterSessionId ?? base.adapterSessionId,
        adapterName: overrides.adapterName ?? base.adapterName,
        model: overrides.model ?? base.model,
        cwd: overrides.cwd ?? base.cwd,
        logFilePath: overrides.logFilePath ?? base.logFilePath,
        kind: 'root' as const,
        parentAdapterSessionId: null,
        forkPointMessageId: null,
      };
    case 'fork':
      return {
        ...base,
        adapterSessionId: overrides.adapterSessionId ?? base.adapterSessionId,
        adapterName: overrides.adapterName ?? base.adapterName,
        model: overrides.model ?? base.model,
        cwd: overrides.cwd ?? base.cwd,
        logFilePath: overrides.logFilePath ?? base.logFilePath,
        kind: 'fork' as const,
        parentAdapterSessionId: overrides.parentAdapterSessionId ?? 'cc-parent-default',
        forkPointMessageId: overrides.forkPointMessageId ?? 'msg-fork-default',
      };
    case 'subagent':
      return {
        ...base,
        adapterSessionId: overrides.adapterSessionId ?? base.adapterSessionId,
        adapterName: overrides.adapterName ?? base.adapterName,
        model: overrides.model ?? base.model,
        cwd: overrides.cwd ?? base.cwd,
        logFilePath: overrides.logFilePath ?? base.logFilePath,
        kind: 'subagent' as const,
        parentAdapterSessionId: overrides.parentAdapterSessionId ?? 'cc-parent-default',
        forkPointMessageId: null,
      };
  }
}

describe('registerDrizzleAdapterSessionStorage', () => {
  const ctx = useAdapterSessionTestLifecycle({ beforeEach, afterEach });

  describe('getByLogFilePath', () => {
    it('should return the adapter session for a known log file path', async () => {
      await MakaioBus.request(
        AdapterSessionStorageSubjects.upsert,
        buildAdapterSessionUpsert({
          adapterSessionId: 'cc-log-path-1',
          logFilePath: '/tmp/known-session.jsonl',
        }),
      );

      const result = await MakaioBus.request(AdapterSessionStorageSubjects.getByLogFilePath, {
        logFilePath: '/tmp/known-session.jsonl',
      });

      expect(result.session?.adapterSessionId).toBe('cc-log-path-1');
      expect(result.session?.logFilePath).toBe('/tmp/known-session.jsonl');
    });

    it('should return null for an unknown log file path', async () => {
      const result = await MakaioBus.request(AdapterSessionStorageSubjects.getByLogFilePath, {
        logFilePath: '/tmp/missing-session.jsonl',
      });

      expect(result.session).toBeNull();
    });
  });

  describe('linkSession', () => {
    it('should link adapter session to Makaio session', async () => {
      // Create Makaio session for FK
      await createTestSession(ctx.db, 'makaio-link-1');

      await MakaioBus.request(
        AdapterSessionStorageSubjects.upsert,
        buildAdapterSessionUpsert({ adapterSessionId: 'cc-link-1' }),
      );

      const result = await MakaioBus.request(AdapterSessionStorageSubjects.linkSession, {
        adapterSessionId: 'cc-link-1',
        sessionId: 'makaio-link-1',
      });

      expect(result.success).toBe(true);

      const getResult = await MakaioBus.request(AdapterSessionStorageSubjects.get, {
        adapterSessionId: 'cc-link-1',
      });
      expect(getResult.session?.sessionId).toBe('makaio-link-1');
    });

    it('should return false for non-existent adapter session', async () => {
      const result = await MakaioBus.request(AdapterSessionStorageSubjects.linkSession, {
        adapterSessionId: 'non-existent',
        sessionId: 'makaio-1',
      });

      expect(result.success).toBe(false);
    });

    it('should emit adapter.session.linked event on successful link', async () => {
      // Capture emitted events
      const capturedEvents: SessionLinked[] = [];
      const unsubscribe = MakaioBus.on(AdapterSubjects.session.linked, (ctx) => {
        capturedEvents.push(ctx.payload);
      });

      try {
        // Create Makaio session for FK
        await createTestSession(ctx.db, 'makaio-link-event-1');

        await MakaioBus.request(
          AdapterSessionStorageSubjects.upsert,
          buildAdapterSessionUpsert({ adapterSessionId: 'cc-link-event-1' }),
        );

        await MakaioBus.request(AdapterSessionStorageSubjects.linkSession, {
          adapterSessionId: 'cc-link-event-1',
          sessionId: 'makaio-link-event-1',
        });

        // Verify event was emitted with correct payload
        expect(capturedEvents).toHaveLength(1);
        expect(capturedEvents[0]).toEqual({
          adapterName: 'claude-code',
          adapterSessionId: 'cc-link-event-1',
          sessionId: 'makaio-link-event-1',
        });
      } finally {
        unsubscribe();
      }
    });

    it('should not emit event when linkSession fails', async () => {
      // Capture emitted events
      const capturedEvents: SessionLinked[] = [];
      const unsubscribe = MakaioBus.on(AdapterSubjects.session.linked, (ctx) => {
        capturedEvents.push(ctx.payload);
      });

      try {
        // Try to link non-existent adapter session
        await MakaioBus.request(AdapterSessionStorageSubjects.linkSession, {
          adapterSessionId: 'non-existent-for-event',
          sessionId: 'makaio-1',
        });

        // No event should be emitted
        expect(capturedEvents).toHaveLength(0);
      } finally {
        unsubscribe();
      }
    });

    it('should succeed for unknown adapters — adapterId is not resolved', async () => {
      const capturedEvents: SessionLinked[] = [];
      const unsubscribe = MakaioBus.on(AdapterSubjects.session.linked, (ctx) => {
        capturedEvents.push(ctx.payload);
      });
      try {
        await createTestSession(ctx.db, 'makaio-best-effort-link-1');
        await MakaioBus.request(
          AdapterSessionStorageSubjects.upsert,
          buildAdapterSessionUpsert({
            adapterSessionId: 'cc-best-effort-link-1',
            adapterName: 'unknown-adapter',
          }),
        );
        const result = await MakaioBus.request(AdapterSessionStorageSubjects.linkSession, {
          adapterSessionId: 'cc-best-effort-link-1',
          sessionId: 'makaio-best-effort-link-1',
        });
        expect(result.success).toBe(true);
        const { session } = await MakaioBus.request(AdapterSessionStorageSubjects.get, {
          adapterSessionId: 'cc-best-effort-link-1',
        });
        expect(session?.sessionId).toBe('makaio-best-effort-link-1');
        expect(capturedEvents).toHaveLength(1);
        expect(capturedEvents[0].adapterName).toBe('unknown-adapter');
      } finally {
        unsubscribe();
      }
    });

    it('should be idempotent - same sessionId succeeds without event', async () => {
      const capturedEvents: SessionLinked[] = [];
      const unsubscribe = MakaioBus.on(AdapterSubjects.session.linked, (ctx) => {
        capturedEvents.push(ctx.payload);
      });

      try {
        await createTestSession(ctx.db, 'makaio-idempotent-1');
        await MakaioBus.request(
          AdapterSessionStorageSubjects.upsert,
          buildAdapterSessionUpsert({ adapterSessionId: 'cc-idempotent-1' }),
        );

        // First link - should emit
        const result1 = await MakaioBus.request(AdapterSessionStorageSubjects.linkSession, {
          adapterSessionId: 'cc-idempotent-1',
          sessionId: 'makaio-idempotent-1',
        });
        expect(result1.success).toBe(true);
        expect(capturedEvents).toHaveLength(1);

        // Second link with same sessionId - should succeed but NOT emit again
        const result2 = await MakaioBus.request(AdapterSessionStorageSubjects.linkSession, {
          adapterSessionId: 'cc-idempotent-1',
          sessionId: 'makaio-idempotent-1',
        });
        expect(result2.success).toBe(true);
        expect(capturedEvents).toHaveLength(1); // Still 1, not 2
      } finally {
        unsubscribe();
      }
    });

    it('should fail when trying to link to a different sessionId', async () => {
      await createTestSession(ctx.db, 'makaio-first');
      await createTestSession(ctx.db, 'makaio-second');
      await MakaioBus.request(
        AdapterSessionStorageSubjects.upsert,
        buildAdapterSessionUpsert({ adapterSessionId: 'cc-relink-test' }),
      );

      // First link succeeds
      const result1 = await MakaioBus.request(AdapterSessionStorageSubjects.linkSession, {
        adapterSessionId: 'cc-relink-test',
        sessionId: 'makaio-first',
      });
      expect(result1.success).toBe(true);

      // Second link with DIFFERENT sessionId should fail
      const result2 = await MakaioBus.request(AdapterSessionStorageSubjects.linkSession, {
        adapterSessionId: 'cc-relink-test',
        sessionId: 'makaio-second',
      });
      expect(result2.success).toBe(false);

      // Original link should remain unchanged
      const { session } = await MakaioBus.request(AdapterSessionStorageSubjects.get, {
        adapterSessionId: 'cc-relink-test',
      });
      expect(session?.sessionId).toBe('makaio-first');
    });

    it('should propagate forkPointMessageId to main session on link', async () => {
      // Create Makaio session for FK
      await createTestSession(ctx.db, 'makaio-fork-prop-1');

      // Create adapter session with forkPointMessageId
      await MakaioBus.request(
        AdapterSessionStorageSubjects.upsert,
        buildAdapterSessionUpsert({
          adapterSessionId: 'cc-fork-prop-1',
          parentAdapterSessionId: 'cc-parent-1',
          forkPointMessageId: 'msg-fork-point-123',
          kind: 'fork',
        }),
      );

      // Link the adapter session to the Makaio session
      const result = await MakaioBus.request(AdapterSessionStorageSubjects.linkSession, {
        adapterSessionId: 'cc-fork-prop-1',
        sessionId: 'makaio-fork-prop-1',
      });
      expect(result.success).toBe(true);

      // Verify forkPointMessageId was propagated to the main session
      const { session } = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: 'makaio-fork-prop-1',
      });
      expect(session?.forkPointMessageId).toBe('msg-fork-point-123');
    });

    it('should not update forkPointMessageId when adapter session has none', async () => {
      // Create Makaio session for FK
      await createTestSession(ctx.db, 'makaio-no-fork-1');

      // Create adapter session WITHOUT forkPointMessageId (root session)
      await MakaioBus.request(
        AdapterSessionStorageSubjects.upsert,
        buildAdapterSessionUpsert({ adapterSessionId: 'cc-no-fork-1' }),
      );

      // Link the adapter session
      const result = await MakaioBus.request(AdapterSessionStorageSubjects.linkSession, {
        adapterSessionId: 'cc-no-fork-1',
        sessionId: 'makaio-no-fork-1',
      });
      expect(result.success).toBe(true);

      // Verify main session has no forkPointMessageId
      const { session } = await MakaioBus.request(SessionStorageSubjects.get, {
        sessionId: 'makaio-no-fork-1',
      });
      expect(session?.forkPointMessageId).toBeUndefined();
    });
  });
});
