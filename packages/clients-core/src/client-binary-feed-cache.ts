/**
 * In-memory cache for the latest-available-version feed per managed client.
 *
 * The cache is hydrated from the `client_binary_state` table on boot and
 * persisted back to storage via the bus on every update. The manager calls
 * {@link ClientBinaryFeedCache.update} after every successful feed refresh.
 * Feed metadata is read by the manager exclusively via
 * {@link ClientBinaryVersionResolver.getLatestVersionMeta}.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import type { LatestVersionSourceStatus } from '@makaio/contracts';
import { ClientBinaryStorageSubjects } from './storage/client-binary-storage-namespace.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Cached feed entry for a single managed client.
 * Internal to {@link ClientBinaryFeedCache} — used by {@link ClientBinaryFeedCache.update}
 * for error-path timestamp preservation.
 */
interface FeedCacheEntry {
  /**
   * Latest version string from the upstream feed, or `null` when the feed
   * has never been checked or the last check returned no version.
   */
  latestAvailableVersion: string | null;
  /**
   * Epoch timestamp in milliseconds when the feed was last checked, or `null`
   * when no check has been performed yet.
   */
  lastCheckedAt: number | null;
  /**
   * Freshness classification of this cache entry.
   *
   * - `'fresh'`  — the version index was fetched within the cache TTL.
   * - `'cached'` — the cached value is stale but still available.
   * - `'error'`  — the last refresh attempt failed; value may be absent.
   */
  sourceStatus: LatestVersionSourceStatus;
}

// ---------------------------------------------------------------------------
// Cache implementation
// ---------------------------------------------------------------------------

/**
 * In-memory cache of latest-available-version metadata per managed client.
 *
 * **Lifecycle:**
 * 1. Call {@link ClientBinaryFeedCache.hydrate} at boot to populate the cache
 *    from persisted state rows.
 * 2. Call {@link ClientBinaryFeedCache.update} after every feed refresh to
 *    update the in-memory entry and persist the new metadata to the database.
 *
 * The cache is write-only from the outside: the manager reads feed metadata
 * exclusively via {@link ClientBinaryVersionResolver.getLatestVersionMeta}.
 * The in-memory `cache` Map is retained internally so that
 * {@link ClientBinaryFeedCache.update} can preserve the last-successful
 * `lastCheckedAt` timestamp on error without an extra storage round-trip.
 */
export class ClientBinaryFeedCache {
  private readonly cache = new Map<string, FeedCacheEntry>();
  private readonly bus: IMakaioBus;

  /**
   * @param bus - Bus instance used to persist feed-cache updates to storage
   */
  public constructor(bus: IMakaioBus) {
    this.bus = bus;
  }

  // -------------------------------------------------------------------------
  // Boot hydration
  // -------------------------------------------------------------------------

  /**
   * Hydrates the in-memory cache from all persisted state rows.
   *
   * Must be called once at boot, before any calls to {@link update}. Rows that
   * have `latestVersionLastCheckedAt` set are
   * classified as `'cached'`; rows without it are classified as `'error'`
   * (the feed has never been successfully checked).
   *
   * Returns the raw state rows so the caller can reuse them (e.g. to seed
   * the version resolver) without a second `loadAllState` bus round-trip.
   * @returns All persisted state rows fetched during hydration
   */
  public async hydrate(): Promise<
    ReadonlyArray<{
      clientId: string;
      latestAvailableVersion: string | null;
      latestVersionLastCheckedAt: number | null;
      latestVersionSourceStatus: LatestVersionSourceStatus;
    }>
  > {
    const { states } = await this.bus.request(ClientBinaryStorageSubjects.loadAllState, {});
    for (const state of states) {
      this.cache.set(state.clientId, {
        latestAvailableVersion: state.latestAvailableVersion,
        lastCheckedAt: state.latestVersionLastCheckedAt,
        sourceStatus: state.latestVersionSourceStatus === 'fresh' ? 'cached' : state.latestVersionSourceStatus,
      });
    }
    return states;
  }

  // -------------------------------------------------------------------------
  // Write
  // -------------------------------------------------------------------------

  /**
   * Persist the feed-cache entry for a client to storage and then update the
   * in-memory cache.
   *
   * Storage is written first so that a bus failure leaves the in-memory cache
   * unchanged, keeping the resolver and storage in sync. The in-memory entry is
   * only updated after the bus request succeeds.
   *
   * Call this after every feed refresh attempt, including failures (using
   * `'error'` as the `sourceStatus`). On error the caller should pass the
   * last-known version from the version resolver — not `null` — so that the
   * cached value remains useful for subsequent list operations.
   * @param clientId - Stable client identifier to update
   * @param latestAvailableVersion - Latest version from the upstream feed,
   *   or the previously cached version when the refresh failed
   * @param sourceStatus - Freshness classification for this update
   */
  public async update(
    clientId: string,
    latestAvailableVersion: string | null,
    sourceStatus: LatestVersionSourceStatus,
  ): Promise<void> {
    const now = Date.now();

    // On error: preserve the last successful check timestamp in-memory so that
    // hydrate() can correctly classify the entry as 'error' (no successful
    // check) rather than 'cached' (a timestamp exists). A new timestamp is only
    // written when the feed refresh actually succeeded.
    //
    // Storage receives `null` on error so the storage handler's null-check
    // logic excludes the timestamp from the conflict-update clause, preserving
    // the last successful value already in the database.
    const isSuccess = sourceStatus !== 'error';
    const lastCheckedAt = isSuccess ? now : (this.cache.get(clientId)?.lastCheckedAt ?? null);

    const entry: FeedCacheEntry = {
      latestAvailableVersion,
      lastCheckedAt,
      sourceStatus,
    };

    await this.bus.request(ClientBinaryStorageSubjects.updateFeedCache, {
      clientId,
      latestAvailableVersion,
      latestVersionLastCheckedAt: isSuccess ? now : null,
      latestVersionSourceStatus: sourceStatus,
      updatedAt: now,
    });

    // Update in-memory cache only after the bus request succeeds so that
    // a persistence failure does not leave the resolver and storage out of sync.
    this.cache.set(clientId, entry);
  }
}
