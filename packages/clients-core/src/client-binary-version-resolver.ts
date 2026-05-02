/**
 * Version resolution and feed-refresh logic for managed client binaries.
 *
 * The {@link ClientBinaryVersionResolver} is a pure, testable utility with no
 * bus coupling of its own. It is consumed by the `ClientBinaryManager` (Task 5)
 * which owns bus registration and persistence.
 * @packageDocumentation
 */

import type { LatestVersionSourceStatus, ManagedInstallDescriptor } from '@makaio/contracts/client';

// ---------------------------------------------------------------------------
// Public contracts
// ---------------------------------------------------------------------------

/**
 * Upstream feed fetcher abstraction.
 *
 * Implementors are responsible for the strategy-specific network calls needed
 * to discover the latest published version of a managed client binary. The
 * resolver treats this as a pure dependency so callers can substitute a mock
 * in tests.
 */
export interface FeedFetcher {
  /**
   * Fetch the latest available version string for the given install descriptor.
   *
   * The returned string must be a non-empty version identifier (semver or
   * opaque tag). The implementor should throw on any network or parse error so
   * the resolver can apply its fallback logic.
   * @param descriptor - Managed install descriptor for the client
   * @returns Resolved latest version string
   */
  fetchLatestVersion(descriptor: ManagedInstallDescriptor): Promise<string>;
}

/**
 * Cached entry for the latest-available version of a single client.
 */
interface VersionCacheEntry {
  /** Latest version string as fetched from the upstream source. */
  version: string;
  /** Epoch timestamp in milliseconds when the entry was last populated. */
  checkedAt: number;
  /**
   * Freshness classification at the time this entry was last written.
   *
   * - `'fresh'`  — a live fetch succeeded within the last request.
   * - `'cached'` — the entry was seeded from persisted storage and has not been
   *                refreshed in the current session.
   * - `'error'`  — the last refresh attempt failed; the version reflects the
   *                previous successful fetch.
   */
  status: LatestVersionSourceStatus;
}

/**
 * Resolution result returned by {@link ClientBinaryVersionResolver.resolveInstallVersion}.
 */
export interface ResolvedInstallVersion {
  /** Concrete version string to install. */
  version: string;
  /**
   * `true` when the version was supplied explicitly by the caller;
   * `false` when the resolver fell back to the cached latest.
   */
  explicit: boolean;
}

/**
 * Latest-version metadata for a single client, suitable for inclusion in a
 * `client.list` response.
 */
export interface LatestVersionMeta {
  /** Latest version string known to the resolver, or `null` when unknown. */
  latestAvailableVersion: string | null;
  /** Epoch timestamp when the latest-version index was last checked, or `null`. */
  latestVersionLastCheckedAt: number | null;
  /** Freshness classification of the cache entry. */
  latestVersionSourceStatus: LatestVersionSourceStatus;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * In-memory version resolver for managed client binaries.
 *
 * Responsibilities:
 * - Resolving a concrete version for `client.install` requests, falling back
 *   to the last known latest when no explicit version is given.
 * - Refreshing the latest-version cache on demand (for `client.list` with
 *   `forceRefresh: true`), with a graceful fallback to the cached value on
 *   network failure.
 * - Exposing the cache state for `client.list` response assembly.
 *
 * This class is intentionally bus-free. The `ClientBinaryManager` owns bus
 * registration and calls into this resolver.
 */
export class ClientBinaryVersionResolver {
  private readonly cache = new Map<string, VersionCacheEntry>();

  /**
   * Creates a new resolver instance.
   * @param feedFetcher - Strategy-agnostic upstream feed fetcher
   */
  public constructor(private readonly feedFetcher: FeedFetcher) {}

  /**
   * Resolve the version to install for a `client.install` request.
   *
   * When `explicitVersion` is supplied it is returned unchanged. When it is
   * absent the resolver returns the last cached latest version. If no cache
   * entry exists for the client, the resolver attempts a live feed refresh; if
   * that also fails, an error is thrown so the caller can reject the request
   * with a clear message rather than installing a phantom version.
   * @param clientId - Stable client identifier (e.g. `'claude-code'`)
   * @param descriptor - Managed install descriptor for the client
   * @param explicitVersion - Version string supplied by the caller, or `undefined`
   * @returns Resolved version and whether it was explicitly requested
   */
  public async resolveInstallVersion(
    clientId: string,
    descriptor: ManagedInstallDescriptor,
    explicitVersion: string | undefined,
  ): Promise<ResolvedInstallVersion> {
    if (explicitVersion !== undefined) {
      return { version: this.#assertValidVersion(explicitVersion, 'Explicit version'), explicit: true };
    }

    const cached = this.cache.get(clientId);
    if (cached !== undefined) {
      return { version: cached.version, explicit: false };
    }

    // No cache entry — attempt a live fetch as a last resort.
    const fetched = this.#assertValidVersion(await this.feedFetcher.fetchLatestVersion(descriptor), 'FeedFetcher');
    this.cache.set(clientId, {
      version: fetched,
      checkedAt: Date.now(),
      status: 'fresh',
    });
    return { version: fetched, explicit: false };
  }

  /**
   * Attempt a live feed refresh and update the in-memory cache.
   *
   * On success the cache entry is updated to `'fresh'`. On failure the
   * existing entry (if any) is retained but its status is set to `'error'` so
   * that callers can surface degraded-mode metadata without losing the last
   * known version.
   * @param clientId - Stable client identifier (e.g. `'claude-code'`)
   * @param descriptor - Managed install descriptor for the client
   * @returns `true` when the refresh succeeded, `false` when it failed
   */
  public async refresh(clientId: string, descriptor: ManagedInstallDescriptor): Promise<boolean> {
    try {
      const version = this.#assertValidVersion(await this.feedFetcher.fetchLatestVersion(descriptor), 'FeedFetcher');
      this.cache.set(clientId, {
        version,
        checkedAt: Date.now(),
        status: 'fresh',
      });
      return true;
    } catch {
      const existing = this.cache.get(clientId);
      if (existing !== undefined) {
        this.cache.set(clientId, { ...existing, status: 'error' });
      }
      return false;
    }
  }

  /**
   * Return the current latest-version metadata for a client, suitable for
   * embedding in a `client.list` response.
   *
   * When no cache entry exists, the returned object has `null` fields and
   * status `'error'` — the absence of a cached value is itself an error state
   * from the perspective of the list consumer.
   * @param clientId - Stable client identifier (e.g. `'claude-code'`)
   * @returns Latest-version metadata object
   */
  public getLatestVersionMeta(clientId: string): LatestVersionMeta {
    const entry = this.cache.get(clientId);
    if (entry === undefined) {
      return {
        latestAvailableVersion: null,
        latestVersionLastCheckedAt: null,
        latestVersionSourceStatus: 'error',
      };
    }

    return {
      latestAvailableVersion: entry.version,
      latestVersionLastCheckedAt: entry.checkedAt,
      latestVersionSourceStatus: entry.status,
    };
  }

  /**
   * Seed the cache with a previously persisted latest-version entry.
   *
   * This is called by the `ClientBinaryManager` at startup to restore the
   * feed-cache state from durable storage so that `resolveInstallVersion` does
   * not need a live fetch on the first call after a restart.
   *
   * The seeded entry defaults to `'cached'` because it survived a process
   * restart and has not been confirmed live in this session. Callers may pass
   * `'error'` when the persisted row records a failed refresh attempt that
   * should remain visible after hydration.
   * @param clientId - Stable client identifier (e.g. `'claude-code'`)
   * @param version - Version string from storage
   * @param checkedAt - Epoch timestamp when the version was last fetched
   * @param status - Persisted source status to seed
   */
  public seedFromStorage(
    clientId: string,
    version: string,
    checkedAt: number,
    status: LatestVersionSourceStatus = 'cached',
  ): void {
    this.cache.set(clientId, {
      version: this.#assertValidVersion(version, 'Storage version'),
      checkedAt,
      status: status === 'fresh' ? 'cached' : status,
    });
  }

  /**
   * Clear all in-memory cache entries.
   *
   * Intended for use in tests and on service destroy.
   */
  public clear(): void {
    this.cache.clear();
  }

  /**
   * Assert that a version string is non-empty after trimming. Throws when the
   * contract is violated so that corrupted state can never be written to the
   * cache.
   * @param version - Raw version string to validate
   * @param source - Human-readable label identifying the caller (used in the
   *   error message to aid debugging)
   * @returns The trimmed version string
   */
  #assertValidVersion(version: string, source: string): string {
    const trimmed = version.trim();
    if (!trimmed) {
      throw new Error(`${source} returned an empty version string`);
    }
    return trimmed;
  }
}
