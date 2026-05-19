import { describe, it, expect, beforeEach, afterEach, jest, mock } from 'bun:test';
import { ClientRuntimeRegistry } from '../client-runtime-registry.js';
import { RuntimeMap } from '../storage/runtime-map.js';
import type { ClientRuntimeObserveRequest } from '@makaio/contracts/client';
import type { ClientRuntimeRecord } from '../client-runtime-registry-types.js';
import type { IMakaioBus } from '@makaio/bus-core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_OBSERVED_AT = 1_700_000_000_000;

/**
 * Build a minimal observe request.
 * @param overrides - Fields to override the defaults
 * @returns Observation request
 */
function makeObservation(
  overrides: Partial<ClientRuntimeObserveRequest> & Pick<ClientRuntimeObserveRequest, 'clientId'>,
): ClientRuntimeObserveRequest {
  return {
    source: { layer: 'supervisor', producer: 'test' },
    observedAt: BASE_OBSERVED_AT,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClientRuntimeRegistry', () => {
  let registry: ClientRuntimeRegistry;

  beforeEach(() => {
    // No bus — pure in-memory operation for all registry tests
    registry = new ClientRuntimeRegistry();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // create new runtime from pid
  // -------------------------------------------------------------------------

  describe('create new runtime from pid', () => {
    it('creates a new runtime record with observed status when only pid is present', async () => {
      const result = await registry.upsertRuntime(
        makeObservation({
          clientId: 'claude-code',
          pid: 12345,
        }),
      );

      expect(result.created).toBe(true);
      expect(result.promoted).toBe(false);
      expect(typeof result.clientRuntimeId).toBe('string');
      expect(result.clientRuntimeId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

      const record = registry.getRuntime(result.clientRuntimeId);
      expect(record).toBeDefined();
      expect(record?.clientId).toBe('claude-code');
      expect(record?.pid).toBe(12345);
      expect(record?.status).toBe('observed');
    });

    it('assigns a stable UUID on creation', async () => {
      const first = await registry.upsertRuntime(makeObservation({ clientId: 'codex', pid: 1 }));
      const second = await registry.upsertRuntime(makeObservation({ clientId: 'codex', pid: 2 }));

      expect(first.clientRuntimeId).not.toBe(second.clientRuntimeId);
    });

    it('returns created=true and promoted=false for a new pid-based runtime', async () => {
      const result = await registry.upsertRuntime(makeObservation({ clientId: 'claude-code', pid: 9999 }));

      expect(result.created).toBe(true);
      expect(result.promoted).toBe(false);
    });

    it('stores pid and parentPid on the new record', async () => {
      const result = await registry.upsertRuntime(makeObservation({ clientId: 'claude-code', pid: 100, parentPid: 1 }));

      const record = registry.getRuntime(result.clientRuntimeId);
      expect(record?.pid).toBe(100);
      expect(record?.parentPid).toBe(1);
    });

    it('stores detached argv and metadata snapshots on create', async () => {
      const argv = ['claude', '--resume'];
      const nested = { label: 'initial' };
      const metadata: Record<string, unknown> = { nested };

      const result = await registry.upsertRuntime(
        makeObservation({ clientId: 'claude-code', pid: 321, argv, metadata }),
      );

      argv[1] = '--mutated';
      nested.label = 'mutated';

      const record = registry.getRuntime(result.clientRuntimeId);
      expect(record?.argv).toEqual(['claude', '--resume']);
      expect(record?.metadata).toEqual({ nested: { label: 'initial' } });
    });
  });

  // -------------------------------------------------------------------------
  // create new runtime from adapterSessionId
  // -------------------------------------------------------------------------

  describe('create new runtime from adapterSessionId', () => {
    it('creates a new runtime with started status when adapterSessionId is present', async () => {
      const result = await registry.upsertRuntime(
        makeObservation({
          clientId: 'claude-code',
          adapterSessionId: 'adapter-sess-abc',
        }),
      );

      expect(result.created).toBe(true);
      expect(result.promoted).toBe(false);

      const record = registry.getRuntime(result.clientRuntimeId);
      expect(record?.status).toBe('started');
      expect(record?.adapterSessionId).toBe('adapter-sess-abc');
    });

    it('different adapterSessionIds for the same clientId create separate records', async () => {
      const first = await registry.upsertRuntime(
        makeObservation({ clientId: 'claude-code', adapterSessionId: 'sess-1' }),
      );
      const second = await registry.upsertRuntime(
        makeObservation({ clientId: 'claude-code', adapterSessionId: 'sess-2' }),
      );

      expect(first.clientRuntimeId).not.toBe(second.clientRuntimeId);
      expect(first.created).toBe(true);
      expect(second.created).toBe(true);
    });

    it('same adapterSessionId + same clientId matches the existing record', async () => {
      const first = await registry.upsertRuntime(
        makeObservation({ clientId: 'claude-code', adapterSessionId: 'sess-shared' }),
      );
      const second = await registry.upsertRuntime(
        makeObservation({ clientId: 'claude-code', adapterSessionId: 'sess-shared' }),
      );

      expect(second.clientRuntimeId).toBe(first.clientRuntimeId);
      expect(second.created).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // match existing runtime by supervisorSessionId
  // -------------------------------------------------------------------------

  describe('match existing runtime by supervisorSessionId', () => {
    it('returns the same clientRuntimeId for a repeated supervisorSessionId', async () => {
      const first = await registry.upsertRuntime(
        makeObservation({ clientId: 'claude-code', supervisorSessionId: 'sup-sess-1' }),
      );
      const second = await registry.upsertRuntime(
        makeObservation({ clientId: 'claude-code', supervisorSessionId: 'sup-sess-1' }),
      );

      expect(second.clientRuntimeId).toBe(first.clientRuntimeId);
      expect(second.created).toBe(false);
      expect(second.promoted).toBe(false);
    });

    it('creates a new record with started status for a supervisorSessionId', async () => {
      const result = await registry.upsertRuntime(
        makeObservation({ clientId: 'claude-code', supervisorSessionId: 'sup-sess-new' }),
      );

      expect(result.created).toBe(true);
      const record = registry.getRuntime(result.clientRuntimeId);
      expect(record?.status).toBe('started');
      expect(record?.supervisorSessionId).toBe('sup-sess-new');
    });

    it('supervisorSessionId takes matching priority over pid when both are present', async () => {
      // Create via pid first
      const pidResult = await registry.upsertRuntime(makeObservation({ clientId: 'claude-code', pid: 5555 }));

      // Now observe with supervisorSessionId only (no pid) — creates a separate record
      const supResult = await registry.upsertRuntime(
        makeObservation({ clientId: 'claude-code', supervisorSessionId: 'sup-unique' }),
      );

      expect(supResult.clientRuntimeId).not.toBe(pidResult.clientRuntimeId);
      expect(supResult.created).toBe(true);

      // Now send supervisorSessionId again — should match the sup record, not the pid record
      const rematch = await registry.upsertRuntime(
        makeObservation({ clientId: 'claude-code', supervisorSessionId: 'sup-unique', pid: 5555 }),
      );

      expect(rematch.clientRuntimeId).toBe(supResult.clientRuntimeId);
      expect(rematch.created).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // enrich existing runtime with stronger evidence
  // -------------------------------------------------------------------------

  describe('enrich existing runtime with stronger evidence', () => {
    it('enriches a pid-based record with a supervisorSessionId and promotes it', async () => {
      const initial = await registry.upsertRuntime(makeObservation({ clientId: 'claude-code', pid: 7777 }));

      const enriched = await registry.upsertRuntime(
        makeObservation({
          clientId: 'claude-code',
          pid: 7777,
          supervisorSessionId: 'sup-promotes',
        }),
      );

      expect(enriched.clientRuntimeId).toBe(initial.clientRuntimeId);
      expect(enriched.created).toBe(false);
      expect(enriched.promoted).toBe(true);

      const record = registry.getRuntime(initial.clientRuntimeId);
      expect(record?.status).toBe('started');
      expect(record?.supervisorSessionId).toBe('sup-promotes');
      expect(record?.pid).toBe(7777);
    });

    it('does not promote a record that is already started', async () => {
      const initial = await registry.upsertRuntime(
        makeObservation({ clientId: 'claude-code', supervisorSessionId: 'sup-already-started' }),
      );

      expect(initial.created).toBe(true);

      const second = await registry.upsertRuntime(
        makeObservation({
          clientId: 'claude-code',
          supervisorSessionId: 'sup-already-started',
          adapterSessionId: 'adapter-extra',
        }),
      );

      expect(second.promoted).toBe(false);
      expect(second.created).toBe(false);

      const record = registry.getRuntime(initial.clientRuntimeId);
      expect(record?.status).toBe('started');
      expect(record?.adapterSessionId).toBe('adapter-extra');
    });

    it('enriches metadata without clearing previously set evidence fields', async () => {
      const initial = await registry.upsertRuntime(
        makeObservation({
          clientId: 'claude-code',
          pid: 8888,
          cwd: '/home/user/project',
          argv: ['claude', '--resume'],
        }),
      );

      await registry.upsertRuntime(
        makeObservation({
          clientId: 'claude-code',
          pid: 8888,
          metadata: { key: 'value' },
        }),
      );

      const record = registry.getRuntime(initial.clientRuntimeId);
      expect(record?.cwd).toBe('/home/user/project');
      expect(record?.argv).toEqual(['claude', '--resume']);
      expect(record?.metadata).toEqual({ key: 'value' });
    });

    it('stores detached metadata snapshots on enrichment', async () => {
      const initial = await registry.upsertRuntime(makeObservation({ clientId: 'claude-code', pid: 8181 }));
      const nested = { label: 'initial' };
      const metadata: Record<string, unknown> = { nested };

      await registry.upsertRuntime(makeObservation({ clientId: 'claude-code', pid: 8181, metadata }));

      nested.label = 'mutated';

      const record = registry.getRuntime(initial.clientRuntimeId);
      expect(record?.metadata).toEqual({ nested: { label: 'initial' } });
    });

    it('enriches an adapterSessionId-based record with a pid and keeps started status', async () => {
      const initial = await registry.upsertRuntime(
        makeObservation({ clientId: 'codex', adapterSessionId: 'adapter-codex-1' }),
      );

      const enriched = await registry.upsertRuntime(
        makeObservation({ clientId: 'codex', adapterSessionId: 'adapter-codex-1', pid: 4242 }),
      );

      expect(enriched.clientRuntimeId).toBe(initial.clientRuntimeId);
      expect(enriched.promoted).toBe(false); // already 'started', so no promotion
      const record = registry.getRuntime(initial.clientRuntimeId);
      expect(record?.pid).toBe(4242);
      expect(record?.status).toBe('started');
    });

    it('refreshes observedAt from the latest captured observation when an observed runtime is re-encountered', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(BASE_OBSERVED_AT + 1_000);

      const initial = await registry.upsertRuntime(makeObservation({ clientId: 'claude-code', pid: 9191 }));

      jest.setSystemTime(BASE_OBSERVED_AT + 5_000);
      await registry.upsertRuntime(
        makeObservation({
          clientId: 'claude-code',
          pid: 9191,
          observedAt: BASE_OBSERVED_AT + 4_000,
        }),
      );

      const record = registry.getRuntime(initial.clientRuntimeId);
      expect(record?.status).toBe('observed');
      expect(record?.observedAt).toBe(BASE_OBSERVED_AT + 4_000);
      expect(record?.updatedAt).toBe(BASE_OBSERVED_AT + 5_000);
    });

    it('does not regress observedAt when an older captured observation arrives later', async () => {
      const initial = await registry.upsertRuntime(
        makeObservation({ clientId: 'claude-code', pid: 9192, observedAt: BASE_OBSERVED_AT + 4_000 }),
      );
      const initialUpdatedAt = initial.record.updatedAt;

      await registry.upsertRuntime(
        makeObservation({ clientId: 'claude-code', pid: 9192, observedAt: BASE_OBSERVED_AT + 1_000 }),
      );

      const record = registry.getRuntime(initial.clientRuntimeId);
      expect(record?.observedAt).toBe(BASE_OBSERVED_AT + 4_000);
      expect(record?.updatedAt).toBe(initialUpdatedAt);
    });

    it('refreshes observedAt when an observed runtime is promoted', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(BASE_OBSERVED_AT + 1_000);

      const initial = await registry.upsertRuntime(makeObservation({ clientId: 'claude-code', pid: 9292 }));

      jest.setSystemTime(BASE_OBSERVED_AT + 6_000);
      await registry.upsertRuntime(
        makeObservation({
          clientId: 'claude-code',
          pid: 9292,
          supervisorSessionId: 'sup-promote-observed-at',
          observedAt: BASE_OBSERVED_AT + 5_000,
        }),
      );

      const record = registry.getRuntime(initial.clientRuntimeId);
      expect(record?.status).toBe('started');
      expect(record?.observedAt).toBe(BASE_OBSERVED_AT + 5_000);
      expect(record?.updatedAt).toBe(BASE_OBSERVED_AT + 6_000);
    });

    it('assigns strictly monotonic updatedAt values for same-millisecond mutations', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(BASE_OBSERVED_AT + 1_000);

      const initial = await registry.upsertRuntime(makeObservation({ clientId: 'claude-code', pid: 9393 }));
      const enriched = await registry.upsertRuntime(
        makeObservation({ clientId: 'claude-code', pid: 9393, cwd: '/workspace' }),
      );
      const promoted = await registry.upsertRuntime(
        makeObservation({ clientId: 'claude-code', pid: 9393, supervisorSessionId: 'sup-same-ms' }),
      );

      expect(enriched.record.updatedAt).toBeGreaterThan(initial.record.updatedAt);
      expect(promoted.record.updatedAt).toBeGreaterThan(enriched.record.updatedAt);
    });
  });

  // -------------------------------------------------------------------------
  // snapshot isolation
  // -------------------------------------------------------------------------

  describe('snapshot isolation', () => {
    it('returns detached record snapshots from creation results and getRuntime', async () => {
      const result = await registry.upsertRuntime(
        makeObservation({
          clientId: 'claude-code',
          pid: 1234,
          argv: ['claude', '--resume'],
          metadata: { nested: { label: 'initial' } },
        }),
      );

      result.record.argv?.push('--mutated');
      const resultNested = result.record.metadata?.nested;
      if (typeof resultNested === 'object' && resultNested !== null && 'label' in resultNested) {
        resultNested.label = 'mutated';
      }

      const firstSnapshot = registry.getRuntime(result.clientRuntimeId);
      firstSnapshot?.argv?.push('--get-mutated');
      const firstNested = firstSnapshot?.metadata?.nested;
      if (typeof firstNested === 'object' && firstNested !== null && 'label' in firstNested) {
        firstNested.label = 'get-mutated';
      }

      const secondSnapshot = registry.getRuntime(result.clientRuntimeId);
      expect(secondSnapshot?.argv).toEqual(['claude', '--resume']);
      expect(secondSnapshot?.metadata).toEqual({ nested: { label: 'initial' } });
    });

    it('returns detached record snapshots from existing-record results', async () => {
      const initial = await registry.upsertRuntime(
        makeObservation({
          clientId: 'claude-code',
          pid: 4321,
          metadata: { nested: { label: 'initial' } },
        }),
      );
      const existing = await registry.upsertRuntime(makeObservation({ clientId: 'claude-code', pid: 4321 }));

      const existingNested = existing.record.metadata?.nested;
      if (typeof existingNested === 'object' && existingNested !== null && 'label' in existingNested) {
        existingNested.label = 'mutated';
      }

      expect(registry.getRuntime(initial.clientRuntimeId)?.metadata).toEqual({ nested: { label: 'initial' } });
    });
  });

  // -------------------------------------------------------------------------
  // clear and size
  // -------------------------------------------------------------------------

  describe('clear and size', () => {
    it('starts with size 0', () => {
      expect(registry.size).toBe(0);
    });

    it('reflects the correct size after upserts', async () => {
      await registry.upsertRuntime(makeObservation({ clientId: 'claude-code', pid: 1 }));
      await registry.upsertRuntime(makeObservation({ clientId: 'claude-code', pid: 2 }));

      expect(registry.size).toBe(2);
    });

    it('clears all records', async () => {
      await registry.upsertRuntime(makeObservation({ clientId: 'claude-code', pid: 1 }));
      registry.clear();

      expect(registry.size).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // RO-4: loadFromStorage + stale-PID threshold
  // -------------------------------------------------------------------------

  describe('loadFromStorage — stale-PID threshold (RO-4)', () => {
    /**
     * Build a minimal {@link ClientRuntimeRecord} suitable for mock storage.
     * @param overrides - Fields to apply over sensible defaults
     * @returns Minimal storage record
     */
    function makeStorageRecord(
      overrides: Partial<ClientRuntimeRecord> & Pick<ClientRuntimeRecord, 'clientRuntimeId' | 'clientId'>,
    ): ClientRuntimeRecord {
      return {
        status: 'started',
        observedAt: BASE_OBSERVED_AT,
        createdAt: BASE_OBSERVED_AT,
        updatedAt: BASE_OBSERVED_AT,
        ...overrides,
      };
    }

    /**
     * Build a minimal mock bus whose `requestOptional` returns a fixed loadAll response.
     * @param records - Records to return from the storage loadAll response
     * @returns Mock bus implementing only the `requestOptional` method
     */
    function makeMockBus(records: ClientRuntimeRecord[]): IMakaioBus {
      return {
        requestOptional: mock().mockResolvedValue({
          handled: true,
          data: { records },
        }),
      } as unknown as IMakaioBus;
    }

    it('skips pid index for records whose updatedAt exceeds the 24-hour threshold', async () => {
      const staleUpdatedAt = Date.now() - 25 * 60 * 60 * 1_000; // 25 hours ago
      const staleRecord = makeStorageRecord({
        clientRuntimeId: 'stale-runtime-1',
        clientId: 'claude-code',
        pid: 9001,
        updatedAt: staleUpdatedAt,
        createdAt: staleUpdatedAt,
        observedAt: staleUpdatedAt,
      });

      const busRegistry = new ClientRuntimeRegistry(makeMockBus([staleRecord]));
      await busRegistry.loadFromStorage();

      // Primary record should be present
      expect(busRegistry.getRuntime('stale-runtime-1')).toBeDefined();

      // pid-based upsert must create a NEW record (not match the stale one)
      const result = await busRegistry.upsertRuntime(makeObservation({ clientId: 'claude-code', pid: 9001 }));

      expect(result.created).toBe(true);
      expect(result.clientRuntimeId).not.toBe('stale-runtime-1');
    });

    it('skips adapterSessionId index for records whose updatedAt exceeds the 24-hour threshold', async () => {
      const staleUpdatedAt = Date.now() - 25 * 60 * 60 * 1_000;
      const staleRecord = makeStorageRecord({
        clientRuntimeId: 'stale-runtime-2',
        clientId: 'claude-code',
        adapterSessionId: 'adapter-stale-sess',
        updatedAt: staleUpdatedAt,
        createdAt: staleUpdatedAt,
        observedAt: staleUpdatedAt,
      });

      const busRegistry = new ClientRuntimeRegistry(makeMockBus([staleRecord]));
      await busRegistry.loadFromStorage();

      // adapterSessionId-based upsert must create a NEW record
      const result = await busRegistry.upsertRuntime(
        makeObservation({ clientId: 'claude-code', adapterSessionId: 'adapter-stale-sess' }),
      );

      expect(result.created).toBe(true);
      expect(result.clientRuntimeId).not.toBe('stale-runtime-2');
    });

    it('always hydrates supervisorSessionId index regardless of age', async () => {
      const staleUpdatedAt = Date.now() - 25 * 60 * 60 * 1_000;
      const staleRecord = makeStorageRecord({
        clientRuntimeId: 'stale-runtime-sup',
        clientId: 'claude-code',
        supervisorSessionId: 'sup-old-but-uuid',
        pid: 9002,
        updatedAt: staleUpdatedAt,
        createdAt: staleUpdatedAt,
        observedAt: staleUpdatedAt,
      });

      const busRegistry = new ClientRuntimeRegistry(makeMockBus([staleRecord]));
      await busRegistry.loadFromStorage();

      // supervisorSessionId must still match even for stale records
      const result = await busRegistry.upsertRuntime(
        makeObservation({ clientId: 'claude-code', supervisorSessionId: 'sup-old-but-uuid' }),
      );

      expect(result.created).toBe(false);
      expect(result.clientRuntimeId).toBe('stale-runtime-sup');
    });

    it('populates pid and adapterSessionId indexes for fresh records', async () => {
      const freshUpdatedAt = Date.now() - 60 * 60 * 1_000; // 1 hour ago — within threshold
      const freshRecord = makeStorageRecord({
        clientRuntimeId: 'fresh-runtime-1',
        clientId: 'claude-code',
        pid: 8001,
        adapterSessionId: 'adapter-fresh-sess',
        updatedAt: freshUpdatedAt,
        createdAt: freshUpdatedAt,
        observedAt: freshUpdatedAt,
      });

      const busRegistry = new ClientRuntimeRegistry(makeMockBus([freshRecord]));
      await busRegistry.loadFromStorage();

      const pidResult = await busRegistry.upsertRuntime(makeObservation({ clientId: 'claude-code', pid: 8001 }));
      expect(pidResult.created).toBe(false);
      expect(pidResult.clientRuntimeId).toBe('fresh-runtime-1');

      const adapterResult = await busRegistry.upsertRuntime(
        makeObservation({ clientId: 'claude-code', adapterSessionId: 'adapter-fresh-sess' }),
      );
      expect(adapterResult.created).toBe(false);
      expect(adapterResult.clientRuntimeId).toBe('fresh-runtime-1');
    });
  });

  // -------------------------------------------------------------------------
  // RO-7: Enrichment that changes pid index
  // -------------------------------------------------------------------------

  describe('enrichment — pid index after adapterSessionId-based creation (RO-7)', () => {
    it('resolves the correct record when pid is added via enrichment', async () => {
      // Create a runtime record using adapterSessionId only
      const initial = await registry.upsertRuntime(
        makeObservation({ clientId: 'claude-code', adapterSessionId: 'adapter-enrich-ro7' }),
      );
      expect(initial.created).toBe(true);

      // Enrich the same record with a pid
      await registry.upsertRuntime(
        makeObservation({
          clientId: 'claude-code',
          adapterSessionId: 'adapter-enrich-ro7',
          pid: 7070,
        }),
      );

      const record = registry.getRuntime(initial.clientRuntimeId);
      expect(record?.pid).toBe(7070);

      // Subsequent upsert by pid alone must resolve back to the original record
      const pidLookup = await registry.upsertRuntime(makeObservation({ clientId: 'claude-code', pid: 7070 }));

      expect(pidLookup.created).toBe(false);
      expect(pidLookup.clientRuntimeId).toBe(initial.clientRuntimeId);
    });

    it('does not leak a stale pid index entry when pid changes on an existing record', async () => {
      // Create a runtime record with an initial pid
      const initial = await registry.upsertRuntime(makeObservation({ clientId: 'claude-code', pid: 8080 }));
      expect(initial.created).toBe(true);

      // A new observation arrives with a different pid for the same supervisorSessionId
      // (tests that the secondary index for the old pid is removed on re-set)
      await registry.upsertRuntime(
        makeObservation({
          clientId: 'claude-code',
          pid: 8080,
          supervisorSessionId: 'sup-pid-change',
        }),
      );
      // Now enrich with a new pid value (simulating pid recycling or correction)
      await registry.upsertRuntime(
        makeObservation({
          clientId: 'claude-code',
          supervisorSessionId: 'sup-pid-change',
          pid: 8081,
        }),
      );

      // Old pid must not resolve the record any more (index was stale)
      // — supervisorSessionId wins in this case, so the second upsert will match
      // via supervisorSessionId and update the pid. A fresh pid-only lookup
      // should resolve to the new value.
      const newPidResult = await registry.upsertRuntime(makeObservation({ clientId: 'claude-code', pid: 8081 }));

      expect(newPidResult.created).toBe(false);
      expect(newPidResult.clientRuntimeId).toBe(initial.clientRuntimeId);
    });
  });
});

// ---------------------------------------------------------------------------
// RO-5: RuntimeMap.delete — secondary index cleanup
// ---------------------------------------------------------------------------

describe('RuntimeMap.delete — secondary index cleanup (RO-5)', () => {
  /**
   * Build a minimal {@link ClientRuntimeRecord} for use in RuntimeMap tests.
   * @param overrides - Fields to override sensible defaults
   * @returns Minimal runtime record
   */
  function makeRecord(
    overrides: Partial<ClientRuntimeRecord> & Pick<ClientRuntimeRecord, 'clientRuntimeId' | 'clientId'>,
  ): ClientRuntimeRecord {
    return {
      status: 'started',
      observedAt: BASE_OBSERVED_AT,
      createdAt: BASE_OBSERVED_AT,
      updatedAt: BASE_OBSERVED_AT,
      ...overrides,
    };
  }

  let map: RuntimeMap;

  beforeEach(() => {
    map = new RuntimeMap();
  });

  it('removes the record from the primary store after delete', () => {
    const record = makeRecord({ clientRuntimeId: 'rt-del-1', clientId: 'claude-code', pid: 1001 });
    map.set(record);

    map.delete('rt-del-1');

    expect(map.get('rt-del-1')).toBeUndefined();
    expect(map.size).toBe(0);
  });

  it('clears the pid secondary index after deleting the record', () => {
    const record = makeRecord({ clientRuntimeId: 'rt-del-2', clientId: 'claude-code', pid: 2002 });
    map.set(record);

    map.delete('rt-del-2');

    // After deletion, a fresh record set with the same pid must be treated as new
    const fresh = makeRecord({ clientRuntimeId: 'rt-fresh', clientId: 'claude-code', pid: 2002 });
    map.set(fresh);

    // findByEvidence must return the new record, not the deleted one
    const found = map.findByEvidence(undefined, 2002, undefined, 'claude-code');
    expect(found?.clientRuntimeId).toBe('rt-fresh');
  });

  it('clears the adapterSessionId secondary index after deleting the record', () => {
    const record = makeRecord({
      clientRuntimeId: 'rt-del-3',
      clientId: 'claude-code',
      adapterSessionId: 'adapter-del-sess',
    });
    map.set(record);

    map.delete('rt-del-3');

    const found = map.findByEvidence(undefined, undefined, 'adapter-del-sess', 'claude-code');
    expect(found).toBeUndefined();
  });

  it('clears the supervisorSessionId secondary index after deleting the record', () => {
    const record = makeRecord({
      clientRuntimeId: 'rt-del-4',
      clientId: 'claude-code',
      supervisorSessionId: 'sup-del-session',
    });
    map.set(record);

    map.delete('rt-del-4');

    const found = map.findByEvidence('sup-del-session', undefined, undefined, 'claude-code');
    expect(found).toBeUndefined();
  });

  it('is a no-op when the clientRuntimeId is not in the map', () => {
    expect(() => map.delete('nonexistent-id')).not.toThrow();
    expect(map.size).toBe(0);
  });

  it('does not affect unrelated records when one is deleted', () => {
    const first = makeRecord({ clientRuntimeId: 'rt-del-5a', clientId: 'claude-code', pid: 5001 });
    const second = makeRecord({ clientRuntimeId: 'rt-del-5b', clientId: 'claude-code', pid: 5002 });
    map.set(first);
    map.set(second);

    map.delete('rt-del-5a');

    expect(map.get('rt-del-5b')).toBeDefined();
    expect(map.size).toBe(1);
    const found = map.findByEvidence(undefined, 5002, undefined, 'claude-code');
    expect(found?.clientRuntimeId).toBe('rt-del-5b');
  });
});
