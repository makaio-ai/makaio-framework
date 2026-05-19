import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { makeStubExtensionContext } from '@makaio/test-utils';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import { registerDrizzleSupervisorRuntimeStorage } from '../drizzle-handler.js';
import { SupervisorRuntimeStorageNamespace, SupervisorRuntimeStorageSubjects } from '../namespace.js';
import { createTestDb } from '../../__tests__/helpers/create-test-db.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const BASE_RUNTIME: {
  supervisorSessionId: string;
  clientId: string;
  pid: number | null;
  status: 'running';
  cwd: string;
  command: string;
  args: string[];
  startedAt: number;
} = {
  supervisorSessionId: 'sup_001',
  clientId: 'claude-code',
  pid: 12345,
  status: 'running',
  cwd: '/home/user/project',
  command: 'claude',
  args: ['--no-color'],
  startedAt: 1_700_000_000_000,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerDrizzleSupervisorRuntimeStorage', () => {
  let db: MakaioDatabase;
  let close: () => void;
  let cleanup: (() => void) | undefined;

  beforeEach(async () => {
    MakaioBus.__resetHandlers?.();
    MakaioBus.registerNamespace(SupervisorRuntimeStorageNamespace);
    ({ db, close } = await createTestDb());
    cleanup = registerDrizzleSupervisorRuntimeStorage(MakaioBus, db, makeStubExtensionContext(MakaioBus));
  });

  afterEach(() => {
    cleanup?.();
    close?.();
  });

  describe('registration', () => {
    it('returns a cleanup function that unregisters all handlers', async () => {
      expect(typeof cleanup).toBe('function');

      // Verify handler is active before cleanup
      await MakaioBus.request(SupervisorRuntimeStorageSubjects.set, BASE_RUNTIME);

      cleanup?.();
      cleanup = undefined;

      // After cleanup, subject should have no handler
      await expect(
        MakaioBus.request(SupervisorRuntimeStorageSubjects.get, {
          supervisorSessionId: BASE_RUNTIME.supervisorSessionId,
        }),
      ).rejects.toThrow();
    });
  });

  describe('set handler', () => {
    it('inserts a new runtime record', async () => {
      const result = await MakaioBus.request(SupervisorRuntimeStorageSubjects.set, BASE_RUNTIME);
      expect(result.success).toBe(true);

      const { runtime } = await MakaioBus.request(SupervisorRuntimeStorageSubjects.get, {
        supervisorSessionId: BASE_RUNTIME.supervisorSessionId,
      });
      expect(runtime).not.toBeNull();
      expect(runtime?.supervisorSessionId).toBe(BASE_RUNTIME.supervisorSessionId);
      expect(runtime?.clientId).toBe(BASE_RUNTIME.clientId);
      expect(runtime?.status).toBe('running');
      expect(runtime?.args).toEqual(['--no-color']);
    });

    it('replaces an existing record on conflict', async () => {
      await MakaioBus.request(SupervisorRuntimeStorageSubjects.set, BASE_RUNTIME);
      await MakaioBus.request(SupervisorRuntimeStorageSubjects.set, {
        ...BASE_RUNTIME,
        status: 'stopped' as const,
        stoppedAt: 1_700_000_001_000,
      });

      const { runtime } = await MakaioBus.request(SupervisorRuntimeStorageSubjects.get, {
        supervisorSessionId: BASE_RUNTIME.supervisorSessionId,
      });
      expect(runtime?.status).toBe('stopped');
      expect(runtime?.stoppedAt).toBe(1_700_000_001_000);
    });

    it('persists optional fields: env, sessionId, adapterSessionId, metadata', async () => {
      const withOptionals = {
        ...BASE_RUNTIME,
        env: { MY_VAR: 'value' },
        sessionId: 'sess_abc',
        adapterSessionId: 'adp_xyz',
        metadata: { source: 'test' },
      };

      await MakaioBus.request(SupervisorRuntimeStorageSubjects.set, withOptionals);

      const { runtime } = await MakaioBus.request(SupervisorRuntimeStorageSubjects.get, {
        supervisorSessionId: BASE_RUNTIME.supervisorSessionId,
      });

      expect(runtime?.env).toEqual({ MY_VAR: 'value' });
      expect(runtime?.sessionId).toBe('sess_abc');
      expect(runtime?.adapterSessionId).toBe('adp_xyz');
      expect(runtime?.metadata).toEqual({ source: 'test' });
    });
  });

  describe('get handler', () => {
    beforeEach(async () => {
      await MakaioBus.request(SupervisorRuntimeStorageSubjects.set, {
        ...BASE_RUNTIME,
        sessionId: 'sess_001',
        adapterSessionId: 'adp_001',
      });
    });

    it('returns null when no locator matches', async () => {
      const { runtime } = await MakaioBus.request(SupervisorRuntimeStorageSubjects.get, {
        supervisorSessionId: 'nonexistent',
      });
      expect(runtime).toBeNull();
    });

    it('rejects when no locator field is provided', async () => {
      await expect(MakaioBus.request(SupervisorRuntimeStorageSubjects.get, {} as never)).rejects.toThrow();
    });

    it('looks up by supervisorSessionId', async () => {
      const { runtime } = await MakaioBus.request(SupervisorRuntimeStorageSubjects.get, {
        supervisorSessionId: BASE_RUNTIME.supervisorSessionId,
      });
      expect(runtime?.supervisorSessionId).toBe(BASE_RUNTIME.supervisorSessionId);
    });

    it('looks up by sessionId', async () => {
      const { runtime } = await MakaioBus.request(SupervisorRuntimeStorageSubjects.get, {
        sessionId: 'sess_001',
      });
      expect(runtime?.supervisorSessionId).toBe(BASE_RUNTIME.supervisorSessionId);
    });

    it('looks up by adapterSessionId', async () => {
      const { runtime } = await MakaioBus.request(SupervisorRuntimeStorageSubjects.get, {
        adapterSessionId: 'adp_001',
      });
      expect(runtime?.supervisorSessionId).toBe(BASE_RUNTIME.supervisorSessionId);
    });
  });

  describe('update handler', () => {
    beforeEach(async () => {
      await MakaioBus.request(SupervisorRuntimeStorageSubjects.set, BASE_RUNTIME);
    });

    it('applies partial status update', async () => {
      const result = await MakaioBus.request(SupervisorRuntimeStorageSubjects.update, {
        supervisorSessionId: BASE_RUNTIME.supervisorSessionId,
        status: 'stopped' as const,
        stoppedAt: 1_700_000_005_000,
      });
      expect(result.success).toBe(true);

      const { runtime } = await MakaioBus.request(SupervisorRuntimeStorageSubjects.get, {
        supervisorSessionId: BASE_RUNTIME.supervisorSessionId,
      });
      expect(runtime?.status).toBe('stopped');
      expect(runtime?.stoppedAt).toBe(1_700_000_005_000);
      // Unchanged fields preserved
      expect(runtime?.clientId).toBe(BASE_RUNTIME.clientId);
      expect(runtime?.cwd).toBe(BASE_RUNTIME.cwd);
    });

    it('sets sessionId on partial update', async () => {
      await MakaioBus.request(SupervisorRuntimeStorageSubjects.update, {
        supervisorSessionId: BASE_RUNTIME.supervisorSessionId,
        sessionId: 'sess_late',
      });

      const { runtime } = await MakaioBus.request(SupervisorRuntimeStorageSubjects.get, {
        supervisorSessionId: BASE_RUNTIME.supervisorSessionId,
      });
      expect(runtime?.sessionId).toBe('sess_late');
    });

    it('no-ops when update payload has no mutable fields', async () => {
      const result = await MakaioBus.request(SupervisorRuntimeStorageSubjects.update, {
        supervisorSessionId: BASE_RUNTIME.supervisorSessionId,
      });
      expect(result.success).toBe(true);
    });

    it('returns false when no matching row exists', async () => {
      const result = await MakaioBus.request(SupervisorRuntimeStorageSubjects.update, {
        supervisorSessionId: 'nonexistent',
        status: 'stopped' as const,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('delete handler', () => {
    beforeEach(async () => {
      await MakaioBus.request(SupervisorRuntimeStorageSubjects.set, BASE_RUNTIME);
    });

    it('removes the record', async () => {
      await MakaioBus.request(SupervisorRuntimeStorageSubjects.delete, {
        supervisorSessionId: BASE_RUNTIME.supervisorSessionId,
      });

      const { runtime } = await MakaioBus.request(SupervisorRuntimeStorageSubjects.get, {
        supervisorSessionId: BASE_RUNTIME.supervisorSessionId,
      });
      expect(runtime).toBeNull();
    });

    it('returns false when no matching row exists', async () => {
      const result = await MakaioBus.request(SupervisorRuntimeStorageSubjects.delete, {
        supervisorSessionId: 'nonexistent',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('list handler', () => {
    beforeEach(async () => {
      await MakaioBus.request(SupervisorRuntimeStorageSubjects.set, {
        ...BASE_RUNTIME,
        supervisorSessionId: 'sup_001',
        status: 'running' as const,
      });
      await MakaioBus.request(SupervisorRuntimeStorageSubjects.set, {
        ...BASE_RUNTIME,
        supervisorSessionId: 'sup_002',
        status: 'stopped' as const,
        stoppedAt: 1_700_000_002_000,
      });
      await MakaioBus.request(SupervisorRuntimeStorageSubjects.set, {
        ...BASE_RUNTIME,
        supervisorSessionId: 'sup_003',
        status: 'exited' as const,
        stoppedAt: 1_700_000_003_000,
      });
    });

    it('returns all runtimes without filter', async () => {
      const { runtimes } = await MakaioBus.request(SupervisorRuntimeStorageSubjects.list, {});
      expect(runtimes).toHaveLength(3);
    });

    it('filters by status', async () => {
      const { runtimes } = await MakaioBus.request(SupervisorRuntimeStorageSubjects.list, {
        status: 'running',
      });
      expect(runtimes).toHaveLength(1);
      expect(runtimes[0]?.supervisorSessionId).toBe('sup_001');
    });

    it('respects limit', async () => {
      const { runtimes } = await MakaioBus.request(SupervisorRuntimeStorageSubjects.list, {
        limit: 2,
      });
      expect(runtimes).toHaveLength(2);
    });

    it('returns full records (not just snapshots)', async () => {
      const { runtimes } = await MakaioBus.request(SupervisorRuntimeStorageSubjects.list, {
        status: 'running',
      });
      const r = runtimes[0];
      expect(r).toBeDefined();
      expect(r?.command).toBe('claude');
      expect(r?.args).toEqual(['--no-color']);
    });
  });

  describe('persistence round-trip', () => {
    it('survives a full write-read-update-read cycle', async () => {
      // Write
      await MakaioBus.request(SupervisorRuntimeStorageSubjects.set, {
        ...BASE_RUNTIME,
        env: { PATH: '/usr/bin' },
        sessionId: 'sess_rt',
        adapterSessionId: 'adp_rt',
        metadata: { origin: 'round-trip-test' },
      });

      // Read back
      const { runtime: after_set } = await MakaioBus.request(SupervisorRuntimeStorageSubjects.get, {
        supervisorSessionId: BASE_RUNTIME.supervisorSessionId,
      });
      expect(after_set?.env).toEqual({ PATH: '/usr/bin' });
      expect(after_set?.metadata).toEqual({ origin: 'round-trip-test' });

      // Update status
      await MakaioBus.request(SupervisorRuntimeStorageSubjects.update, {
        supervisorSessionId: BASE_RUNTIME.supervisorSessionId,
        status: 'exited',
        pid: null,
        stoppedAt: 1_700_000_999_000,
      });

      // Read back again
      const { runtime: after_update } = await MakaioBus.request(SupervisorRuntimeStorageSubjects.get, {
        supervisorSessionId: BASE_RUNTIME.supervisorSessionId,
      });
      expect(after_update?.status).toBe('exited');
      expect(after_update?.pid).toBeNull();
      expect(after_update?.stoppedAt).toBe(1_700_000_999_000);
      // Original fields untouched
      expect(after_update?.env).toEqual({ PATH: '/usr/bin' });
      expect(after_update?.metadata).toEqual({ origin: 'round-trip-test' });
    });
  });
});
