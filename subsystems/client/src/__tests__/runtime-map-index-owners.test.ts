import { beforeEach, describe, expect, it } from 'vitest';
import type { ClientRuntimeRecord } from '../client-runtime-registry-types.js';
import { RuntimeMap } from '../storage/runtime-map.js';

const NOW = 1_700_000_100_000;
const FRESHNESS_WINDOW = 60_000;

/**
 * Construct a runtime record with the minimum evidence needed for index tests.
 * @param overrides - Values that distinguish this runtime generation
 * @returns Runtime record suitable for RuntimeMap mutations
 */
function makeRecord(
  overrides: Partial<ClientRuntimeRecord> & Pick<ClientRuntimeRecord, 'clientRuntimeId' | 'clientId'>,
): ClientRuntimeRecord {
  return {
    status: 'started',
    observedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('RuntimeMap index ownership', () => {
  let map: RuntimeMap;

  beforeEach(() => {
    map = new RuntimeMap();
  });

  it('returns the older owner after a newer shared adapter record rekeys with its prior snapshot', () => {
    const older = makeRecord({
      clientRuntimeId: 'runtime-a',
      clientId: 'codex',
      adapterSessionId: 'shared-adapter',
      createdAt: NOW - 2,
    });
    const newer = makeRecord({
      clientRuntimeId: 'runtime-b',
      clientId: 'codex',
      adapterSessionId: 'shared-adapter',
      createdAt: NOW - 1,
    });
    map.set(older);
    map.set(newer);

    const rekeyed = { ...newer, adapterSessionId: 'replacement-adapter' };
    map.set(rekeyed, newer);

    expect(map.findByEvidence(undefined, undefined, 'shared-adapter', 'codex')?.clientRuntimeId).toBe(
      older.clientRuntimeId,
    );
  });

  it('restores the older owner when the current shared adapter record is deleted', () => {
    const older = makeRecord({
      clientRuntimeId: 'runtime-a',
      clientId: 'codex',
      adapterSessionId: 'shared-adapter',
      createdAt: NOW - 2,
    });
    const newer = makeRecord({
      clientRuntimeId: 'runtime-b',
      clientId: 'codex',
      adapterSessionId: 'shared-adapter',
      createdAt: NOW - 1,
    });
    map.set(older);
    map.set(newer);

    map.delete(newer.clientRuntimeId);

    expect(map.findByEvidence(undefined, undefined, 'shared-adapter', 'codex')?.clientRuntimeId).toBe(
      older.clientRuntimeId,
    );
  });

  it('does not restore a stale hydrated record after a fresh record rekeys or is deleted', () => {
    const stale = makeRecord({
      clientRuntimeId: 'runtime-stale',
      clientId: 'codex',
      adapterSessionId: 'shared-adapter',
      createdAt: NOW - 2,
      updatedAt: NOW - FRESHNESS_WINDOW - 1,
    });
    const fresh = makeRecord({
      clientRuntimeId: 'runtime-fresh',
      clientId: 'codex',
      adapterSessionId: 'shared-adapter',
      createdAt: NOW - 1,
    });
    map.setFromStorage(stale, NOW, FRESHNESS_WINDOW);
    map.set(fresh);

    map.set({ ...fresh, adapterSessionId: 'replacement-adapter' }, fresh);
    expect(map.findByEvidence(undefined, undefined, 'shared-adapter', 'codex')).toBeUndefined();

    map.set(fresh);
    map.delete(fresh.clientRuntimeId);
    expect(map.findByEvidence(undefined, undefined, 'shared-adapter', 'codex')).toBeUndefined();
  });

  it('uses the runtime ID as a deterministic tie-breaker regardless of insertion order', () => {
    const first = makeRecord({
      clientRuntimeId: 'runtime-a',
      clientId: 'codex',
      adapterSessionId: 'shared-adapter',
      createdAt: NOW - 1,
    });
    const second = makeRecord({
      clientRuntimeId: 'runtime-b',
      clientId: 'codex',
      adapterSessionId: 'shared-adapter',
      createdAt: NOW - 1,
    });

    for (const records of [
      [first, second],
      [second, first],
    ]) {
      const hydrated = new RuntimeMap();
      for (const record of records) {
        hydrated.setFromStorage(record, NOW, FRESHNESS_WINDOW);
      }

      expect(hydrated.findByEvidence(undefined, undefined, 'shared-adapter', 'codex')?.clientRuntimeId).toBe(
        second.clientRuntimeId,
      );
    }
  });

  it('removes a prior hydrated record eligibility when the same runtime ID is replaced', () => {
    const initial = makeRecord({
      clientRuntimeId: 'runtime-replaced',
      clientId: 'codex',
      adapterSessionId: 'old-adapter',
    });
    const replacement = { ...initial, adapterSessionId: 'new-adapter' };
    map.setFromStorage(initial, NOW, FRESHNESS_WINDOW);
    map.setFromStorage(replacement, NOW, FRESHNESS_WINDOW);

    expect(map.findByEvidence(undefined, undefined, 'old-adapter', 'codex')).toBeUndefined();
    expect(map.findByEvidence(undefined, undefined, 'new-adapter', 'codex')?.clientRuntimeId).toBe(
      replacement.clientRuntimeId,
    );
  });
});
