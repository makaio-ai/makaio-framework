/**
 * End-to-end round-trip integration tests for the client runtime registry +
 * persistence + hydration lifecycle.
 *
 * These tests exercise the full path:
 *   observe → persist to Drizzle → destroy service → recreate service →
 *   loadFromStorage() → re-observe → verify match or non-match
 *
 * Both the service and the storage handler are wired onto the same isolated
 * bus instance so persistence flows through to the real SQLite database on
 * every upsert, and hydration reads back from the same DB on `init()`.
 *
 * The `createPluginTestDb` utility is used for DB lifecycle (schema creation,
 * data clearing, file cleanup) only. Storage handlers are registered manually
 * via `registerDrizzleRuntimeStorage(bus, db, ctx)` so the bus reference is the
 * same isolated instance that the service uses — not the global `MakaioBus`
 * singleton.
 * @packageDocumentation
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { ClientSubjects } from '@makaio/contracts/client';
import { createPluginTestDb, type PluginTestDbContext } from '@makaio/test-utils/drizzle-harness';
import { makeStubExtensionContext } from '@makaio/test-utils';
import { ClientRuntimeRegistry } from '../client-runtime-registry.js';
import { ClientRuntimeService } from '../client-runtime-service.js';
import { registerDrizzleRuntimeStorage, selectRuntimeById } from '../storage/runtime-drizzle-handler.js';
import { clientRuntimes } from '../storage/runtime-schema.js';
import { CLIENT_RUNTIME_DDL } from './test-ddl.js';

// ---------------------------------------------------------------------------
// Suite-level DB lifecycle
// ---------------------------------------------------------------------------

let dbCtx: PluginTestDbContext;

beforeAll(async () => {
  dbCtx = await createPluginTestDb({
    name: 'client-runtime-roundtrip',
    schemas: CLIENT_RUNTIME_DDL,
    tables: ['client_runtimes'],
    // Handler registration is managed per-test (see beforeEach) so that the
    // same isolated bus instance is used for both service and storage.
    registerHandlers: () => () => {},
  });
});

afterAll(async () => {
  await dbCtx.close();
});

// ---------------------------------------------------------------------------
// Per-test lifecycle helpers
// ---------------------------------------------------------------------------

let bus: IMakaioBus;
let service: ClientRuntimeService;
let storageCleanup: () => void;

/**
 * Spin up a fresh service and wire storage handlers onto a given bus instance.
 *
 * Registers `registerDrizzleRuntimeStorage` on `localBus` so that every upsert
 * made by the registry flows through to the Drizzle SQLite database. Calls
 * `service.init()` which triggers `loadFromStorage()` before accepting
 * observations.
 * @param localBus - Isolated bus instance to wire service and storage onto
 * @returns Initialized service instance (also assigned to the outer `service` variable)
 */
async function bootService(localBus: IMakaioBus): Promise<ClientRuntimeService> {
  storageCleanup?.();
  storageCleanup = registerDrizzleRuntimeStorage(localBus, dbCtx.db, makeStubExtensionContext(localBus));
  service = new ClientRuntimeService(localBus);
  await service.init();
  return service;
}

beforeEach(async () => {
  await dbCtx.clearData();
  bus = createBusInstance();
  await bootService(bus);
});

afterEach(async () => {
  await service?.destroy();
  storageCleanup?.();
});

// ---------------------------------------------------------------------------
// Test case 1: Basic round-trip
// ---------------------------------------------------------------------------

describe('basic round-trip: observe → persist → restart → re-observe matches', () => {
  it('returns created=false and the same clientRuntimeId after a service restart', async () => {
    // Phase 1: observe a new runtime — this persists the record to Drizzle.
    const firstResult = await bus.request(ClientSubjects.runtime.observe, {
      clientId: 'claude-code',
      source: { layer: 'supervisor', producer: 'test-supervisor' },
      observedAt: 1_700_000_000_000,
      supervisorSessionId: 'sup-roundtrip-1',
      pid: 42001,
    });

    expect(firstResult.created).toBe(true);
    const { clientRuntimeId } = firstResult;

    // Verify the record landed in the database.
    const dbRecord = await selectRuntimeById(dbCtx.db, clientRuntimeId);
    expect(dbRecord).toBeDefined();
    expect(dbRecord?.supervisorSessionId).toBe('sup-roundtrip-1');

    // Phase 2: tear down the service — clears in-memory state.
    await service.destroy();

    // Phase 3: create a fresh bus and service, wired to the same DB.
    // init() calls loadFromStorage() which hydrates the in-memory map from DB.
    const freshBus = createBusInstance();
    await bootService(freshBus);

    // Phase 4: re-observe with the same supervisorSessionId — must match the
    // hydrated record, not create a new one.
    const secondResult = await freshBus.request(ClientSubjects.runtime.observe, {
      clientId: 'claude-code',
      source: { layer: 'supervisor', producer: 'test-supervisor' },
      observedAt: 1_700_000_001_000,
      supervisorSessionId: 'sup-roundtrip-1',
      pid: 42001,
    });

    expect(secondResult.created).toBe(false);
    expect(secondResult.clientRuntimeId).toBe(clientRuntimeId);
  });
});

// ---------------------------------------------------------------------------
// Test case 2: Stale-pid hydration suppression
// ---------------------------------------------------------------------------

describe('stale-pid hydration suppression: outdated records do not index pid', () => {
  it('creates a NEW record when pid matches a stale record whose supervisorSessionId differs', async () => {
    const staleUpdatedAt = Date.now() - 25 * 60 * 60 * 1_000; // 25 hours ago
    const staleId = 'bbbbbbbb-0000-4000-8000-000000000001';
    const stalePid = 55001;

    // Insert a stale record directly into the DB (bypassing the bus so we can
    // set an arbitrarily old updatedAt that the registry would not allow via
    // normal observe flow). The `id` field here is the Drizzle schema column
    // name (text('id').primaryKey()); the handler layer maps it to/from
    // `clientRuntimeId` at the API boundary.
    await dbCtx.db.insert(clientRuntimes).values({
      id: staleId,
      clientId: 'claude-code',
      status: 'started',
      supervisorSessionId: 'sup-stale-old',
      pid: stalePid,
      observedAt: staleUpdatedAt,
      createdAt: staleUpdatedAt,
      updatedAt: staleUpdatedAt,
    });

    // Tear down the current service and restart with the stale record present.
    await service.destroy();

    // loadFromStorage() runs here — stale record must NOT populate the pid index.
    const freshBus = createBusInstance();
    await bootService(freshBus);

    // Observe with the same pid but a completely different supervisorSessionId.
    // Because the record is stale (>24 h), its pid index was skipped during
    // hydration. The new supervisorSessionId does not match either. So a NEW
    // record must be created.
    const result = await freshBus.request(ClientSubjects.runtime.observe, {
      clientId: 'claude-code',
      source: { layer: 'supervisor', producer: 'test-supervisor' },
      observedAt: Date.now(),
      supervisorSessionId: 'sup-stale-new-session',
      pid: stalePid,
    });

    expect(result.created).toBe(true);
    expect(result.clientRuntimeId).not.toBe(staleId);
  });
});

// ---------------------------------------------------------------------------
// Test case 3: Fresh-record hydration
// ---------------------------------------------------------------------------

describe('fresh-record hydration: recent records do index pid', () => {
  it('returns created=false and the same clientRuntimeId for a pid matching a fresh hydrated record', async () => {
    const freshUpdatedAt = Date.now() - 60 * 60 * 1_000; // 1 hour ago — within 24h threshold
    const freshId = 'cccccccc-0000-4000-8000-000000000001';
    const freshPid = 66001;

    // Insert a fresh record directly into the DB.
    await dbCtx.db.insert(clientRuntimes).values({
      id: freshId,
      clientId: 'claude-code',
      status: 'started',
      supervisorSessionId: 'sup-fresh-session',
      pid: freshPid,
      observedAt: freshUpdatedAt,
      createdAt: freshUpdatedAt,
      updatedAt: freshUpdatedAt,
    });

    // Tear down the current service and restart.
    await service.destroy();

    // loadFromStorage() — fresh record MUST populate the pid index.
    const freshBus = createBusInstance();
    await bootService(freshBus);

    // Observe with the same pid — must hit the hydrated record.
    const result = await freshBus.request(ClientSubjects.runtime.observe, {
      clientId: 'claude-code',
      source: { layer: 'statusline', producer: 'test-statusline' },
      observedAt: Date.now(),
      pid: freshPid,
    });

    expect(result.created).toBe(false);
    expect(result.clientRuntimeId).toBe(freshId);
  });
});

// ---------------------------------------------------------------------------
// RO-6: ClientRuntimeRegistry direct persistence + loadFromStorage hydration
// ---------------------------------------------------------------------------

describe('RO-6: ClientRuntimeRegistry — Drizzle persistence + loadFromStorage hydration', () => {
  let ro6Bus: IMakaioBus;
  let ro6StorageCleanup: () => void;

  beforeEach(async () => {
    await dbCtx.clearData();
    ro6Bus = createBusInstance();
    ro6StorageCleanup = registerDrizzleRuntimeStorage(ro6Bus, dbCtx.db, makeStubExtensionContext(ro6Bus));
  });

  afterEach(() => {
    ro6StorageCleanup();
  });

  it('upsertRuntime persists the record to Drizzle with correct fields', async () => {
    const registry = new ClientRuntimeRegistry(ro6Bus);
    const observedAt = Date.now();

    const result = await registry.upsertRuntime({
      clientId: 'claude-code',
      source: { layer: 'supervisor', producer: 'ro6-test' },
      observedAt,
      supervisorSessionId: 'sup-ro6-persist',
      pid: 77001,
      cwd: '/home/user/project',
      argv: ['claude', '--resume'],
    });

    expect(result.created).toBe(true);

    const row = await selectRuntimeById(dbCtx.db, result.clientRuntimeId);

    expect(row).toBeDefined();
    expect(row?.clientRuntimeId).toBe(result.clientRuntimeId);
    expect(row?.clientId).toBe('claude-code');
    expect(row?.status).toBe('started'); // supervisorSessionId warrants 'started'
    expect(row?.supervisorSessionId).toBe('sup-ro6-persist');
    expect(row?.pid).toBe(77001);
    expect(row?.cwd).toBe('/home/user/project');
    expect(row?.argv).toEqual(['claude', '--resume']);
    expect(row?.observedAt).toBe(observedAt);
  });

  it('loadFromStorage hydrates the registry so getRuntime returns the persisted record', async () => {
    // Phase 1: persist a record using the first registry instance.
    const firstRegistry = new ClientRuntimeRegistry(ro6Bus);
    const observedAt = Date.now();

    const { clientRuntimeId } = await firstRegistry.upsertRuntime({
      clientId: 'claude-code',
      source: { layer: 'supervisor', producer: 'ro6-test' },
      observedAt,
      supervisorSessionId: 'sup-ro6-hydrate',
      pid: 77002,
    });

    // Phase 2: create a second registry wired to the same DB bus and hydrate it.
    const secondRegistry = new ClientRuntimeRegistry(ro6Bus);
    await secondRegistry.loadFromStorage();

    const hydrated = secondRegistry.getRuntime(clientRuntimeId);

    expect(hydrated).toBeDefined();
    expect(hydrated?.clientRuntimeId).toBe(clientRuntimeId);
    expect(hydrated?.clientId).toBe('claude-code');
    expect(hydrated?.supervisorSessionId).toBe('sup-ro6-hydrate');
    expect(hydrated?.pid).toBe(77002);
    expect(hydrated?.status).toBe('started');
  });

  it('update round-trip: second upsert updates DB row and hydration picks up the updated value', async () => {
    // Phase 1: create an observed record (pid only, no supervisor → 'observed').
    const registry = new ClientRuntimeRegistry(ro6Bus);
    const observedAt = Date.now();

    const { clientRuntimeId } = await registry.upsertRuntime({
      clientId: 'claude-code',
      source: { layer: 'statusline', producer: 'ro6-test' },
      observedAt,
      pid: 77003,
    });

    // Verify initial DB state.
    const initialRow = await selectRuntimeById(dbCtx.db, clientRuntimeId);
    expect(initialRow?.status).toBe('observed');

    // Phase 2: enrich with supervisorSessionId — promotes 'observed' → 'started'.
    await registry.upsertRuntime({
      clientId: 'claude-code',
      source: { layer: 'supervisor', producer: 'ro6-test' },
      observedAt: observedAt + 1_000,
      pid: 77003,
      supervisorSessionId: 'sup-ro6-update',
    });

    // DB row must reflect the promoted status and new evidence.
    const updatedRow = await selectRuntimeById(dbCtx.db, clientRuntimeId);
    expect(updatedRow?.status).toBe('started');
    expect(updatedRow?.supervisorSessionId).toBe('sup-ro6-update');
    expect(updatedRow?.updatedAt).toBeGreaterThan(initialRow!.updatedAt);

    // Phase 3: hydrate a fresh registry and verify it sees the promoted record.
    const freshRegistry = new ClientRuntimeRegistry(ro6Bus);
    await freshRegistry.loadFromStorage();

    const hydrated = freshRegistry.getRuntime(clientRuntimeId);
    expect(hydrated?.status).toBe('started');
    expect(hydrated?.supervisorSessionId).toBe('sup-ro6-update');
  });
});
