import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import { RuntimeRegistry } from '../runtime-registry.js';
import { registerDrizzleSupervisorRuntimeStorage } from '../storage/drizzle-handler.js';
import { SupervisorRuntimeStorageSubjects } from '../storage/namespace.js';
import type { SupervisorRuntimeInit } from '../types.js';
import { createTestDb } from './helpers/create-test-db.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const BASE_INIT: SupervisorRuntimeInit = {
  supervisorSessionId: 'sup_001',
  clientId: 'claude-code',
  pid: 12345,
  cwd: '/home/user/project',
  command: 'claude',
  args: [],
  startedAt: 1_700_000_000_000,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RuntimeRegistry', () => {
  let db: MakaioDatabase;
  let close: () => void;
  let storageCleanup: (() => void) | undefined;
  let registry: RuntimeRegistry;

  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    storageCleanup = registerDrizzleSupervisorRuntimeStorage(MakaioBus, db);
    registry = new RuntimeRegistry(MakaioBus);
  });

  afterEach(() => {
    storageCleanup?.();
    close?.();
  });

  describe('register', () => {
    it('creates a new runtime with status = running', async () => {
      await registry.register(BASE_INIT);

      const runtime = registry.getBySupervisorId(BASE_INIT.supervisorSessionId);
      expect(runtime).toBeDefined();
      expect(runtime?.status).toBe('running');
      expect(runtime?.supervisorSessionId).toBe(BASE_INIT.supervisorSessionId);
      expect(runtime?.clientId).toBe(BASE_INIT.clientId);
      expect(runtime?.pid).toBe(12345);
      expect(runtime?.command).toBe('claude');
    });

    it('persists the runtime to storage', async () => {
      await registry.register(BASE_INIT);

      // Verify storage via a fresh registry (cold load)
      const freshRegistry = new RuntimeRegistry(MakaioBus);
      await freshRegistry.loadFromStorage();

      const runtime = freshRegistry.getBySupervisorId(BASE_INIT.supervisorSessionId);
      expect(runtime).toBeDefined();
      expect(runtime?.status).toBe('running');
    });

    it('indexes sessionId and adapterSessionId when provided', async () => {
      await registry.register({
        ...BASE_INIT,
        sessionId: 'sess_001',
        adapterSessionId: 'adp_001',
      });

      expect(registry.getBySessionId('sess_001')?.supervisorSessionId).toBe(BASE_INIT.supervisorSessionId);
      expect(registry.getByAdapterSessionId('adp_001')?.supervisorSessionId).toBe(BASE_INIT.supervisorSessionId);
    });
  });

  describe('lookup by correlation field', () => {
    beforeEach(async () => {
      await registry.register({
        ...BASE_INIT,
        sessionId: 'sess_abc',
        adapterSessionId: 'adp_xyz',
      });
    });

    it('looks up by supervisorSessionId', () => {
      const runtime = registry.getBySupervisorId(BASE_INIT.supervisorSessionId);
      expect(runtime?.supervisorSessionId).toBe(BASE_INIT.supervisorSessionId);
    });

    it('returns undefined for unknown supervisorSessionId', () => {
      expect(registry.getBySupervisorId('nonexistent')).toBeUndefined();
    });

    it('looks up by sessionId', () => {
      const runtime = registry.getBySessionId('sess_abc');
      expect(runtime?.supervisorSessionId).toBe(BASE_INIT.supervisorSessionId);
    });

    it('returns undefined for unknown sessionId', () => {
      expect(registry.getBySessionId('unknown_sess')).toBeUndefined();
    });

    it('looks up by adapterSessionId', () => {
      const runtime = registry.getByAdapterSessionId('adp_xyz');
      expect(runtime?.supervisorSessionId).toBe(BASE_INIT.supervisorSessionId);
    });

    it('returns undefined for unknown adapterSessionId', () => {
      expect(registry.getByAdapterSessionId('unknown_adp')).toBeUndefined();
    });
  });

  describe('update', () => {
    beforeEach(async () => {
      await registry.register({
        ...BASE_INIT,
        sessionId: 'sess_old',
      });
    });

    it('applies status and stoppedAt update', async () => {
      const ok = await registry.update({
        supervisorSessionId: BASE_INIT.supervisorSessionId,
        status: 'stopped',
        stoppedAt: 1_700_000_005_000,
        pid: null,
      });

      expect(ok).toBe(true);

      const runtime = registry.getBySupervisorId(BASE_INIT.supervisorSessionId);
      expect(runtime?.status).toBe('stopped');
      expect(runtime?.stoppedAt).toBe(1_700_000_005_000);
      expect(runtime?.pid).toBeNull();
    });

    it('persists status update to storage', async () => {
      await registry.update({
        supervisorSessionId: BASE_INIT.supervisorSessionId,
        status: 'exited',
        pid: null,
      });

      const freshRegistry = new RuntimeRegistry(MakaioBus);
      await freshRegistry.loadFromStorage();

      const runtime = freshRegistry.getBySupervisorId(BASE_INIT.supervisorSessionId);
      expect(runtime?.status).toBe('exited');
    });

    it('updates secondary indices when sessionId changes', async () => {
      await registry.update({
        supervisorSessionId: BASE_INIT.supervisorSessionId,
        sessionId: 'sess_new',
      });

      // Old sessionId should no longer resolve
      expect(registry.getBySessionId('sess_old')).toBeUndefined();
      // New sessionId should resolve correctly
      expect(registry.getBySessionId('sess_new')?.supervisorSessionId).toBe(BASE_INIT.supervisorSessionId);
    });

    it('updates secondary indices when adapterSessionId changes', async () => {
      // Register with an initial adapterSessionId
      await registry.register({
        ...BASE_INIT,
        supervisorSessionId: 'sup_adp_reindex',
        adapterSessionId: 'adp_old',
      });

      await registry.update({
        supervisorSessionId: 'sup_adp_reindex',
        adapterSessionId: 'adp_new',
      });

      // Old adapterSessionId should no longer resolve
      expect(registry.getByAdapterSessionId('adp_old')).toBeUndefined();
      // New adapterSessionId should resolve correctly
      expect(registry.getByAdapterSessionId('adp_new')?.supervisorSessionId).toBe('sup_adp_reindex');
    });

    it('returns false for unknown supervisorSessionId', async () => {
      const ok = await registry.update({
        supervisorSessionId: 'nonexistent',
        status: 'stopped',
      });
      expect(ok).toBe(false);
    });

    it('setting sessionId to undefined in update() is a no-op — the index entry is preserved', async () => {
      // The JSDoc on update() explicitly documents that sessionId: undefined
      // is indistinguishable from omitting the field (Partial<Pick<...>> semantics)
      // and is therefore treated as a no-op. Clearing a correlation field is not
      // supported. This test asserts the negative: the existing index must remain
      // intact after an update that includes sessionId: undefined.
      const ok = await registry.update({
        supervisorSessionId: BASE_INIT.supervisorSessionId,
        sessionId: undefined,
        status: 'stopped',
      });

      expect(ok).toBe(true);

      // The sessionId index entry must still resolve — undefined was a no-op.
      const bySession = registry.getBySessionId('sess_old');
      expect(bySession?.supervisorSessionId).toBe(BASE_INIT.supervisorSessionId);

      // Only the status field (which was explicitly provided) must have changed.
      const runtime = registry.getBySupervisorId(BASE_INIT.supervisorSessionId);
      expect(runtime?.status).toBe('stopped');
    });

    it('setting adapterSessionId to undefined in update() is a no-op — the index entry is preserved', async () => {
      // Symmetrical to the sessionId case: adapterSessionId: undefined must not
      // clear the secondary index entry set at registration time.
      await registry.register({
        ...BASE_INIT,
        supervisorSessionId: 'sup_adp_noop',
        adapterSessionId: 'adp_noop_value',
      });

      const ok = await registry.update({
        supervisorSessionId: 'sup_adp_noop',
        adapterSessionId: undefined,
        status: 'stopped',
      });

      expect(ok).toBe(true);

      const byAdp = registry.getByAdapterSessionId('adp_noop_value');
      expect(byAdp?.supervisorSessionId).toBe('sup_adp_noop');
    });

    it('returns false and leaves in-memory state untouched when storage returns success: false', async () => {
      // Register a high-priority override that forces the storage update to fail.
      const unsubOverride = MakaioBus.on(
        SupervisorRuntimeStorageSubjects.update,
        (ctx) => ctx.setResult({ success: false }),
        { priority: 999 },
      );

      try {
        const ok = await registry.update({
          supervisorSessionId: BASE_INIT.supervisorSessionId,
          status: 'stopped',
        });

        expect(ok).toBe(false);
        // In-memory state must be unchanged — storage failure must not mutate indices.
        const runtime = registry.getBySupervisorId(BASE_INIT.supervisorSessionId);
        expect(runtime?.status).toBe('running');
      } finally {
        unsubOverride();
      }
    });
  });

  describe('remove', () => {
    beforeEach(async () => {
      await registry.register({
        ...BASE_INIT,
        sessionId: 'sess_rm',
        adapterSessionId: 'adp_rm',
      });
    });

    it('removes from primary and secondary indices', async () => {
      await registry.remove(BASE_INIT.supervisorSessionId);

      expect(registry.getBySupervisorId(BASE_INIT.supervisorSessionId)).toBeUndefined();
      expect(registry.getBySessionId('sess_rm')).toBeUndefined();
      expect(registry.getByAdapterSessionId('adp_rm')).toBeUndefined();
    });

    it('persists deletion to storage', async () => {
      await registry.remove(BASE_INIT.supervisorSessionId);

      const freshRegistry = new RuntimeRegistry(MakaioBus);
      await freshRegistry.loadFromStorage();

      expect(freshRegistry.getBySupervisorId(BASE_INIT.supervisorSessionId)).toBeUndefined();
    });

    it('returns false for unknown supervisorSessionId', async () => {
      const ok = await registry.remove('nonexistent');
      expect(ok).toBe(false);
    });

    it('returns false and leaves in-memory state untouched when storage returns success: false', async () => {
      // Register a high-priority override that forces the storage delete to fail.
      const unsubOverride = MakaioBus.on(
        SupervisorRuntimeStorageSubjects.delete,
        (ctx) => ctx.setResult({ success: false }),
        { priority: 999 },
      );

      try {
        const ok = await registry.remove(BASE_INIT.supervisorSessionId);

        expect(ok).toBe(false);
        // In-memory indices must be unchanged — storage failure must not mutate them.
        expect(registry.getBySupervisorId(BASE_INIT.supervisorSessionId)).toBeDefined();
        expect(registry.getBySessionId('sess_rm')).toBeDefined();
        expect(registry.getByAdapterSessionId('adp_rm')).toBeDefined();
      } finally {
        unsubOverride();
      }
    });
  });

  describe('getAll and getByStatus', () => {
    beforeEach(async () => {
      await registry.register({ ...BASE_INIT, supervisorSessionId: 'sup_a' });
      await registry.register({ ...BASE_INIT, supervisorSessionId: 'sup_b' });
      await registry.update({ supervisorSessionId: 'sup_b', status: 'stopped' });
    });

    it('getAll returns all registered runtimes', () => {
      expect(registry.getAll()).toHaveLength(2);
    });

    it('getByStatus filters correctly', () => {
      const running = registry.getByStatus('running');
      expect(running).toHaveLength(1);
      expect(running[0]?.supervisorSessionId).toBe('sup_a');

      const stopped = registry.getByStatus('stopped');
      expect(stopped).toHaveLength(1);
      expect(stopped[0]?.supervisorSessionId).toBe('sup_b');
    });
  });

  describe('loadFromStorage', () => {
    it('hydrates the in-memory cache from persisted records', async () => {
      // Populate via original registry
      await registry.register({
        ...BASE_INIT,
        sessionId: 'sess_persist',
        adapterSessionId: 'adp_persist',
      });

      // Create a fresh registry pointing at the same storage
      const fresh = new RuntimeRegistry(MakaioBus);
      await fresh.loadFromStorage();

      // All three lookup keys should work
      expect(fresh.getBySupervisorId(BASE_INIT.supervisorSessionId)?.clientId).toBe('claude-code');
      expect(fresh.getBySessionId('sess_persist')?.supervisorSessionId).toBe(BASE_INIT.supervisorSessionId);
      expect(fresh.getByAdapterSessionId('adp_persist')?.supervisorSessionId).toBe(BASE_INIT.supervisorSessionId);
    });

    it('is a no-op when storage is empty', async () => {
      await registry.loadFromStorage();
      expect(registry.getAll()).toHaveLength(0);
    });
  });
});
