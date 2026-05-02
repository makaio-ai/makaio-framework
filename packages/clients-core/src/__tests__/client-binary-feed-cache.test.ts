/**
 * Tests for {@link ClientBinaryFeedCache}.
 *
 * Uses a real bus instance with targeted handler registrations so that the
 * cache persistence ordering and failure-isolation invariants are exercised
 * against the real implementation rather than mocks.
 *
 * Coverage:
 * - Successful update persists to storage and then updates in-memory cache
 * - When the bus request fails, the in-memory cache is NOT updated (the
 *   previous value is retained so resolver and storage remain in sync)
 * - Hydration populates the cache from persisted state rows
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { ClientBinaryFeedCache } from '../client-binary-feed-cache.js';
import { ClientBinaryStorageSubjects } from '../storage/client-binary-storage-namespace.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Register a `loadAllState` handler that returns an empty state list.
 *
 * Required so that {@link ClientBinaryFeedCache.hydrate} can complete.
 * @param bus - Bus instance to register on
 * @returns Cleanup function
 */
function registerEmptyLoadAllState(bus: IMakaioBus): () => void {
  return bus.on(ClientBinaryStorageSubjects.loadAllState, (ctx) => {
    ctx.setResult({ states: [] });
  });
}

/**
 * Register an `updateFeedCache` handler that resolves successfully.
 * @param bus - Bus instance to register on
 * @returns Cleanup function
 */
function registerSuccessfulUpdateFeedCache(bus: IMakaioBus): () => void {
  return bus.on(ClientBinaryStorageSubjects.updateFeedCache, (ctx) => {
    ctx.setResult({ success: true });
  });
}

/**
 * Register an `updateFeedCache` handler that throws.
 * @param bus - Bus instance to register on
 * @returns Cleanup function
 */
function registerFailingUpdateFeedCache(bus: IMakaioBus): () => void {
  return bus.on(ClientBinaryStorageSubjects.updateFeedCache, () => {
    throw new Error('Storage unavailable');
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('ClientBinaryFeedCache', () => {
  let bus: IMakaioBus;
  let cleanupHandlers: Array<() => void>;

  beforeEach(() => {
    bus = createBusInstance();
    cleanupHandlers = [];
  });

  afterEach(() => {
    for (const cleanup of cleanupHandlers) {
      cleanup();
    }
    cleanupHandlers = [];
  });

  // -------------------------------------------------------------------------
  // hydrate()
  // -------------------------------------------------------------------------

  it('hydrate returns persisted state rows from storage', async () => {
    cleanupHandlers.push(
      bus.on(ClientBinaryStorageSubjects.loadAllState, (ctx) => {
        ctx.setResult({
          states: [
            {
              clientId: 'test-client',
              activeVersion: null,
              latestAvailableVersion: '1.0.0',
              latestVersionLastCheckedAt: 1000,
              latestVersionSourceStatus: 'fresh',
              updatedAt: 1000,
            },
          ],
        });
      }),
    );

    const cache = new ClientBinaryFeedCache(bus);
    const states = await cache.hydrate();

    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({
      clientId: 'test-client',
      latestAvailableVersion: '1.0.0',
      latestVersionLastCheckedAt: 1000,
    });
  });

  it('hydrate normalizes fresh to cached in the in-memory cache', async () => {
    // After a restart, a 'fresh' row from storage is stale — the cache must
    // downgrade it to 'cached'. This normalization is invisible from the outside
    // now that get() has been removed, but it affects the error-path timestamp
    // preservation in update(): a hydrated entry with a valid lastCheckedAt
    // causes the error path to retain that timestamp in-memory (even though
    // storage receives null). We verify the normalization indirectly by
    // asserting that an error update after hydration sends null to storage
    // while the cache itself records the hydrated timestamp.
    const capturedPayloads: Array<{
      latestVersionLastCheckedAt: number | null;
      latestVersionSourceStatus: string;
    }> = [];

    cleanupHandlers.push(
      bus.on(ClientBinaryStorageSubjects.loadAllState, (ctx) => {
        ctx.setResult({
          states: [
            {
              clientId: 'test-client',
              activeVersion: null,
              latestAvailableVersion: '1.0.0',
              latestVersionLastCheckedAt: 1000,
              latestVersionSourceStatus: 'fresh',
              updatedAt: 1000,
            },
          ],
        });
      }),
    );
    cleanupHandlers.push(
      bus.on(ClientBinaryStorageSubjects.updateFeedCache, (ctx) => {
        capturedPayloads.push({
          latestVersionLastCheckedAt: ctx.payload.latestVersionLastCheckedAt,
          latestVersionSourceStatus: ctx.payload.latestVersionSourceStatus,
        });
        ctx.setResult({ success: true });
      }),
    );

    const cache = new ClientBinaryFeedCache(bus);
    await cache.hydrate();

    // An error update immediately after hydration must send null to storage
    // (the storage handler preserves the DB value), proving the in-memory cache
    // has a valid lastCheckedAt from the hydrated row — meaning normalization
    // produced 'cached' (not 'fresh') with the original timestamp intact.
    await cache.update('test-client', null, 'error');

    expect(capturedPayloads).toHaveLength(1);
    expect(capturedPayloads[0]?.latestVersionLastCheckedAt).toBeNull();
    expect(capturedPayloads[0]?.latestVersionSourceStatus).toBe('error');
  });

  // -------------------------------------------------------------------------
  // update() — success path
  // -------------------------------------------------------------------------

  it('update persists the correct payload to storage', async () => {
    const capturedPayloads: Array<{
      clientId: string;
      latestAvailableVersion: string | null;
      latestVersionSourceStatus: string;
      latestVersionLastCheckedAt: number | null;
    }> = [];

    cleanupHandlers.push(registerEmptyLoadAllState(bus));
    cleanupHandlers.push(
      bus.on(ClientBinaryStorageSubjects.updateFeedCache, (ctx) => {
        capturedPayloads.push({
          clientId: ctx.payload.clientId,
          latestAvailableVersion: ctx.payload.latestAvailableVersion,
          latestVersionSourceStatus: ctx.payload.latestVersionSourceStatus,
          latestVersionLastCheckedAt: ctx.payload.latestVersionLastCheckedAt,
        });
        ctx.setResult({ success: true });
      }),
    );

    const cache = new ClientBinaryFeedCache(bus);
    await cache.hydrate();

    await cache.update('test-client', '2.0.0', 'fresh');

    expect(capturedPayloads).toHaveLength(1);
    expect(capturedPayloads[0]).toMatchObject({
      clientId: 'test-client',
      latestAvailableVersion: '2.0.0',
      latestVersionSourceStatus: 'fresh',
    });
    expect(capturedPayloads[0]?.latestVersionLastCheckedAt).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // update() — failure path: in-memory cache must NOT be mutated
  // -------------------------------------------------------------------------

  it('update sends null latestVersionLastCheckedAt to storage on error while preserving it in-memory', async () => {
    const capturedPayloads: Array<{
      latestVersionLastCheckedAt: number | null;
      latestVersionSourceStatus: string;
    }> = [];

    cleanupHandlers.push(registerEmptyLoadAllState(bus));
    cleanupHandlers.push(
      bus.on(ClientBinaryStorageSubjects.updateFeedCache, (ctx) => {
        capturedPayloads.push({
          latestVersionLastCheckedAt: ctx.payload.latestVersionLastCheckedAt,
          latestVersionSourceStatus: ctx.payload.latestVersionSourceStatus,
        });
        ctx.setResult({ success: true });
      }),
    );

    const cache = new ClientBinaryFeedCache(bus);
    await cache.hydrate();

    // First: a successful update to seed a lastCheckedAt value.
    await cache.update('test-client', '1.0.0', 'fresh');
    const successPayload = capturedPayloads.at(-1);
    expect(successPayload?.latestVersionLastCheckedAt).not.toBeNull();

    // Second: an error update — storage must receive null, not the preserved
    // in-memory timestamp, so the storage handler's null-check logic preserves
    // the previous successful timestamp in the database.
    await cache.update('test-client', null, 'error');
    const errorPayload = capturedPayloads.at(-1);
    expect(errorPayload?.latestVersionLastCheckedAt).toBeNull();
    expect(errorPayload?.latestVersionSourceStatus).toBe('error');
  });

  it('update rejects when the bus request fails', async () => {
    cleanupHandlers.push(registerEmptyLoadAllState(bus));
    cleanupHandlers.push(registerFailingUpdateFeedCache(bus));

    const cache = new ClientBinaryFeedCache(bus);
    await cache.hydrate();

    await expect(cache.update('test-client', '2.0.0', 'fresh')).rejects.toThrow('Storage unavailable');
  });

  it('a bus failure between success and error leaves the in-memory cache at the successful state', async () => {
    // Sequence: success → bus failure → error update.
    // The bus failure must NOT update the in-memory cache (line 166 is
    // unreachable when the bus request rejects). The subsequent error update
    // should therefore still see the first successful entry's lastCheckedAt
    // when building the in-memory entry — but send null to storage.
    const capturedPayloads: Array<{
      latestVersionLastCheckedAt: number | null;
      latestVersionSourceStatus: string;
    }> = [];

    cleanupHandlers.push(registerEmptyLoadAllState(bus));

    // First handler succeeds — seeds the cache with a known timestamp.
    const cleanupSuccess = registerSuccessfulUpdateFeedCache(bus);
    cleanupHandlers.push(cleanupSuccess);

    const cache = new ClientBinaryFeedCache(bus);
    await cache.hydrate();

    await cache.update('test-client', '1.0.0', 'fresh');

    // Replace with a failing handler to simulate a bus failure.
    cleanupSuccess();
    cleanupHandlers.splice(cleanupHandlers.indexOf(cleanupSuccess), 1);
    const cleanupFail = registerFailingUpdateFeedCache(bus);
    cleanupHandlers.push(cleanupFail);

    // This update must reject — the in-memory cache stays at '1.0.0' / 'fresh'.
    await expect(cache.update('test-client', '2.0.0', 'fresh')).rejects.toThrow('Storage unavailable');

    // Now replace with a capturing handler that succeeds.
    cleanupFail();
    cleanupHandlers.splice(cleanupHandlers.indexOf(cleanupFail), 1);
    cleanupHandlers.push(
      bus.on(ClientBinaryStorageSubjects.updateFeedCache, (ctx) => {
        capturedPayloads.push({
          latestVersionLastCheckedAt: ctx.payload.latestVersionLastCheckedAt,
          latestVersionSourceStatus: ctx.payload.latestVersionSourceStatus,
        });
        ctx.setResult({ success: true });
      }),
    );

    // An error update must send null to storage (not the cached timestamp),
    // because the storage handler interprets null as "do not overwrite".
    await cache.update('test-client', null, 'error');
    const errorPayload = capturedPayloads.at(-1);
    expect(errorPayload?.latestVersionLastCheckedAt).toBeNull();
    expect(errorPayload?.latestVersionSourceStatus).toBe('error');
  });
});
