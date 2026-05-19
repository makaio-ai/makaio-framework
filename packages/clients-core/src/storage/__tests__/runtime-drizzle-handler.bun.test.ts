import { describe, it, expect } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import {
  createPluginTestDb,
  usePluginStorageTestLifecycle,
  type PluginTestDbContext,
} from '@makaio/test-utils/drizzle-harness';
import { makeStubExtensionContext } from '@makaio/test-utils';
import {
  registerDrizzleRuntimeStorage,
  ClientRuntimeStorageSubjects,
  selectRuntimeById,
  selectRuntimeBySupervisorSessionId,
  selectRuntimeByPidAndClientId,
} from '../runtime-drizzle-handler.js';
import { clientRuntimes } from '../runtime-schema.js';
import { CLIENT_RUNTIME_DDL } from '../../__tests__/test-ddl.js';

// ---------------------------------------------------------------------------
// Test database factory
// ---------------------------------------------------------------------------

async function createTestDb(): Promise<PluginTestDbContext> {
  return createPluginTestDb({
    name: 'client-runtimes',
    schemas: CLIENT_RUNTIME_DDL,
    tables: ['client_runtimes'],
    registerHandlers: (db) => registerDrizzleRuntimeStorage(MakaioBus, db, makeStubExtensionContext(MakaioBus)),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runtime Drizzle handler', () => {
  const ctx = usePluginStorageTestLifecycle(createTestDb);

  // -------------------------------------------------------------------------
  // upsert — insert
  // -------------------------------------------------------------------------

  describe('upsert (insert)', () => {
    it('inserts a minimal runtime record by id', async () => {
      const now = Date.now();
      const id = 'aaaaaaaa-0000-4000-8000-000000000001';

      const { success } = await MakaioBus.request(ClientRuntimeStorageSubjects.upsert, {
        clientRuntimeId: id,
        clientId: 'claude-code',
        status: 'observed',
        observedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      expect(success).toBe(true);

      const record = await selectRuntimeById(ctx.dbContext.db, id);
      expect(record).toBeDefined();
      expect(record?.clientRuntimeId).toBe(id);
      expect(record?.clientId).toBe('claude-code');
      expect(record?.status).toBe('observed');
      expect(record?.supervisorSessionId).toBeUndefined();
      expect(record?.pid).toBeUndefined();
      expect(record?.adapterSessionId).toBeUndefined();
    });

    it('inserts a fully-populated runtime record', async () => {
      const now = Date.now();
      const id = 'aaaaaaaa-0000-4000-8000-000000000002';

      await MakaioBus.request(ClientRuntimeStorageSubjects.upsert, {
        clientRuntimeId: id,
        clientId: 'codex',
        status: 'started',
        supervisorSessionId: 'sup-sess-001',
        pid: 9999,
        parentPid: 1,
        adapterSessionId: 'adapter-sess-001',
        sessionId: 'framework-sess-001',
        cwd: '/workspace',
        argv: ['codex', '--resume'],
        metadata: { origin: 'test' },
        observedAt: now - 1000,
        createdAt: now - 1000,
        updatedAt: now,
      });

      const record = await selectRuntimeById(ctx.dbContext.db, id);
      expect(record?.status).toBe('started');
      expect(record?.supervisorSessionId).toBe('sup-sess-001');
      expect(record?.pid).toBe(9999);
      expect(record?.parentPid).toBe(1);
      expect(record?.adapterSessionId).toBe('adapter-sess-001');
      expect(record?.sessionId).toBe('framework-sess-001');
      expect(record?.cwd).toBe('/workspace');
      expect(record?.argv).toEqual(['codex', '--resume']);
      expect(record?.metadata).toEqual({ origin: 'test' });
    });
  });

  // -------------------------------------------------------------------------
  // upsert — update
  // -------------------------------------------------------------------------

  describe('upsert (update)', () => {
    it('updates an existing record when the same id is upserted again', async () => {
      const now = Date.now();
      const id = 'aaaaaaaa-0000-4000-8000-000000000003';

      await MakaioBus.request(ClientRuntimeStorageSubjects.upsert, {
        clientRuntimeId: id,
        clientId: 'claude-code',
        status: 'observed',
        pid: 1111,
        observedAt: now - 5000,
        createdAt: now - 5000,
        updatedAt: now - 5000,
      });

      const updatedAt = now;
      const observedAt = now - 100;
      await MakaioBus.request(ClientRuntimeStorageSubjects.upsert, {
        clientRuntimeId: id,
        clientId: 'claude-code',
        status: 'started',
        pid: 1111,
        supervisorSessionId: 'sup-added-later',
        observedAt,
        createdAt: now - 5000,
        updatedAt,
      });

      const record = await selectRuntimeById(ctx.dbContext.db, id);
      expect(record?.status).toBe('started');
      expect(record?.supervisorSessionId).toBe('sup-added-later');
      expect(record?.observedAt).toBe(observedAt);
      expect(record?.updatedAt).toBe(updatedAt);
      // createdAt must not change on update
      expect(record?.createdAt).toBe(now - 5000);
    });

    it('ignores stale updates so older writes cannot regress mutable fields', async () => {
      const now = Date.now();
      const id = 'aaaaaaaa-0000-4000-8000-000000000004';

      await MakaioBus.request(ClientRuntimeStorageSubjects.upsert, {
        clientRuntimeId: id,
        clientId: 'claude-code',
        status: 'started',
        pid: 1111,
        supervisorSessionId: 'sup-current',
        observedAt: now - 1000,
        createdAt: now - 1000,
        updatedAt: now,
      });

      await MakaioBus.request(ClientRuntimeStorageSubjects.upsert, {
        clientRuntimeId: id,
        clientId: 'claude-code',
        status: 'observed',
        pid: 2222,
        observedAt: now - 5000,
        createdAt: now - 5000,
        updatedAt: now - 5000,
      });

      const record = await selectRuntimeById(ctx.dbContext.db, id);
      expect(record?.status).toBe('started');
      expect(record?.pid).toBe(1111);
      expect(record?.supervisorSessionId).toBe('sup-current');
      expect(record?.observedAt).toBe(now - 1000);
      expect(record?.createdAt).toBe(now - 1000);
      expect(record?.updatedAt).toBe(now);
    });
  });

  // -------------------------------------------------------------------------
  // loadAll
  // -------------------------------------------------------------------------

  describe('loadAll', () => {
    it('returns an empty array when no records exist', async () => {
      const { records } = await MakaioBus.request(ClientRuntimeStorageSubjects.loadAll, {});
      expect(records).toEqual([]);
    });

    it('returns all persisted records', async () => {
      const now = Date.now();
      const id1 = 'aaaaaaaa-0000-4000-8000-000000000005';
      const id2 = 'aaaaaaaa-0000-4000-8000-000000000006';

      await MakaioBus.request(ClientRuntimeStorageSubjects.upsert, {
        clientRuntimeId: id1,
        clientId: 'claude-code',
        status: 'observed',
        pid: 2001,
        observedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      await MakaioBus.request(ClientRuntimeStorageSubjects.upsert, {
        clientRuntimeId: id2,
        clientId: 'codex',
        status: 'started',
        supervisorSessionId: 'sup-load-all',
        observedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      const { records } = await MakaioBus.request(ClientRuntimeStorageSubjects.loadAll, {});
      expect(records).toHaveLength(2);

      const ids = records.map((r) => r.clientRuntimeId).sort();
      expect(ids).toEqual([id1, id2].sort());
    });
  });

  // -------------------------------------------------------------------------
  // index-based lookup helpers (test utility, validates index correctness)
  // -------------------------------------------------------------------------

  describe('lookup helpers', () => {
    it('finds a record by supervisorSessionId', async () => {
      const now = Date.now();
      const id = 'aaaaaaaa-0000-4000-8000-000000000007';

      await MakaioBus.request(ClientRuntimeStorageSubjects.upsert, {
        clientRuntimeId: id,
        clientId: 'claude-code',
        status: 'started',
        supervisorSessionId: 'sup-lookup-test',
        observedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      const results = await selectRuntimeBySupervisorSessionId(ctx.dbContext.db, 'sup-lookup-test');
      expect(results).toHaveLength(1);
      expect(results[0].clientRuntimeId).toBe(id);
    });

    it('finds a record by pid and clientId', async () => {
      const now = Date.now();
      const id = 'aaaaaaaa-0000-4000-8000-000000000008';

      await MakaioBus.request(ClientRuntimeStorageSubjects.upsert, {
        clientRuntimeId: id,
        clientId: 'codex',
        status: 'observed',
        pid: 5050,
        observedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      const result = await selectRuntimeByPidAndClientId(ctx.dbContext.db, 5050, 'codex');
      expect(result).toBeDefined();
      expect(result?.clientRuntimeId).toBe(id);
    });

    it('returns undefined when pid+clientId combination does not match', async () => {
      const result = await selectRuntimeByPidAndClientId(ctx.dbContext.db, 99999, 'nonexistent-client');
      expect(result).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // mapRow — unknown status error path (RO-8)
  // -------------------------------------------------------------------------

  describe('mapRow: unknown status in DB', () => {
    it('throws with a descriptive message when loadAll encounters an unrecognised status', async () => {
      const now = Date.now();
      const id = 'aaaaaaaa-0000-4000-8000-000000000099';

      // Bypass the bus upsert handler (which enforces the status enum via Zod)
      // and insert a row with an unknown status value directly via Drizzle so
      // the mapRow guard is exercised.
      await ctx.dbContext.db.insert(clientRuntimes).values({
        id,
        clientId: 'claude-code',
        status: 'bogus',
        observedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      await expect(MakaioBus.request(ClientRuntimeStorageSubjects.loadAll, {})).rejects.toThrow(
        "Unknown ClientRuntimeStatus in DB: 'bogus'",
      );
    });
  });
});
