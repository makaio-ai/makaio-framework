import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedInstallDescriptor } from '@makaio/contracts/client';
import { ClientBinaryVersionResolver, type FeedFetcher } from '../client-binary-version-resolver.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** Minimal manifest-bucket descriptor used across tests. */
const MANIFEST_DESCRIPTOR: ManagedInstallDescriptor = {
  type: 'manifest-bucket',
  config: {
    baseUrl: 'https://example.com/client',
    versionIndex: { latest: 'version/latest' },
    manifestPath: 'manifest.json',
    manifestChecksumField: 'sha256',
    binaryPath: 'bin/claude',
  },
};

const CLIENT_ID = 'claude-code';

/**
 * Build a {@link FeedFetcher} mock whose `fetchLatestVersion` is a Vitest spy.
 * @param resolvedVersion - Version the spy will resolve to
 * @returns Mock fetcher and the underlying spy
 */
function makeMockFetcher(resolvedVersion: string): { fetcher: FeedFetcher; spy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn<() => Promise<string>>().mockResolvedValue(resolvedVersion);
  const fetcher: FeedFetcher = {
    fetchLatestVersion: spy,
  };
  return { fetcher, spy };
}

/**
 * Build a {@link FeedFetcher} mock that always rejects with the given error.
 * @param error - Error to throw on each call
 * @returns Mock fetcher that always fails
 */
function makeFailingFetcher(error: Error): FeedFetcher {
  return {
    fetchLatestVersion: vi.fn<() => Promise<string>>().mockRejectedValue(error),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClientBinaryVersionResolver', () => {
  let resolver: ClientBinaryVersionResolver;

  beforeEach(() => {
    resolver = new ClientBinaryVersionResolver(makeMockFetcher('1.0.0').fetcher);
  });

  // -------------------------------------------------------------------------
  // resolveInstallVersion — explicit version
  // -------------------------------------------------------------------------

  describe('resolveInstallVersion with explicit version', () => {
    it('returns the caller-supplied version without contacting the feed', async () => {
      const { fetcher, spy } = makeMockFetcher('99.0.0');
      resolver = new ClientBinaryVersionResolver(fetcher);

      const result = await resolver.resolveInstallVersion(CLIENT_ID, MANIFEST_DESCRIPTOR, '2.3.4');

      expect(result.version).toBe('2.3.4');
      expect(result.explicit).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // resolveInstallVersion — explicit invalid version
  // -------------------------------------------------------------------------

  describe('resolveInstallVersion with explicit invalid version', () => {
    it('throws when the explicit version is an empty string', async () => {
      await expect(resolver.resolveInstallVersion(CLIENT_ID, MANIFEST_DESCRIPTOR, '')).rejects.toThrow(
        'Explicit version returned an empty version string',
      );
    });

    it('throws when the explicit version is a whitespace-only string', async () => {
      await expect(resolver.resolveInstallVersion(CLIENT_ID, MANIFEST_DESCRIPTOR, '   ')).rejects.toThrow(
        'Explicit version returned an empty version string',
      );
    });
  });

  // -------------------------------------------------------------------------
  // resolveInstallVersion — no version, cache hit
  // -------------------------------------------------------------------------

  describe('resolveInstallVersion without version — cache hit', () => {
    it('returns the cached latest version without a live fetch', async () => {
      const { fetcher, spy } = makeMockFetcher('2.0.0');
      resolver = new ClientBinaryVersionResolver(fetcher);
      resolver.seedFromStorage(CLIENT_ID, '1.9.0', Date.now());

      const result = await resolver.resolveInstallVersion(CLIENT_ID, MANIFEST_DESCRIPTOR, undefined);

      expect(result.version).toBe('1.9.0');
      expect(result.explicit).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    });

    it('respects the seeded version even when the fetcher would return a different one', async () => {
      const { fetcher } = makeMockFetcher('3.0.0');
      resolver = new ClientBinaryVersionResolver(fetcher);
      resolver.seedFromStorage(CLIENT_ID, '2.5.0', Date.now());

      const result = await resolver.resolveInstallVersion(CLIENT_ID, MANIFEST_DESCRIPTOR, undefined);

      expect(result.version).toBe('2.5.0');
    });
  });

  // -------------------------------------------------------------------------
  // resolveInstallVersion — no version, cache miss
  // -------------------------------------------------------------------------

  describe('resolveInstallVersion without version — cache miss', () => {
    it('performs a live fetch and caches the result when no cache entry exists', async () => {
      const { fetcher, spy } = makeMockFetcher('1.5.0');
      resolver = new ClientBinaryVersionResolver(fetcher);

      const result = await resolver.resolveInstallVersion(CLIENT_ID, MANIFEST_DESCRIPTOR, undefined);

      expect(result.version).toBe('1.5.0');
      expect(result.explicit).toBe(false);
      expect(spy).toHaveBeenCalledOnce();
      expect(spy).toHaveBeenCalledWith(MANIFEST_DESCRIPTOR);
    });

    it('marks the cache entry as fresh after a successful live fetch', async () => {
      const { fetcher } = makeMockFetcher('1.5.0');
      resolver = new ClientBinaryVersionResolver(fetcher);
      await resolver.resolveInstallVersion(CLIENT_ID, MANIFEST_DESCRIPTOR, undefined);

      const meta = resolver.getLatestVersionMeta(CLIENT_ID);

      expect(meta.latestVersionSourceStatus).toBe('fresh');
    });

    it('throws when the live fetch fails and there is no cache entry', async () => {
      resolver = new ClientBinaryVersionResolver(makeFailingFetcher(new Error('network down')));

      await expect(resolver.resolveInstallVersion(CLIENT_ID, MANIFEST_DESCRIPTOR, undefined)).rejects.toThrow(
        'network down',
      );
    });
  });

  // -------------------------------------------------------------------------
  // FeedFetcher contract enforcement — empty version guard
  // -------------------------------------------------------------------------

  describe('FeedFetcher empty-version guard', () => {
    it('throws when resolveInstallVersion receives an empty string from the fetcher', async () => {
      const { fetcher } = makeMockFetcher('');
      resolver = new ClientBinaryVersionResolver(fetcher);

      await expect(resolver.resolveInstallVersion(CLIENT_ID, MANIFEST_DESCRIPTOR, undefined)).rejects.toThrow(
        'FeedFetcher returned an empty version string',
      );
    });

    it('throws when resolveInstallVersion receives a whitespace-only string from the fetcher', async () => {
      const { fetcher } = makeMockFetcher('   ');
      resolver = new ClientBinaryVersionResolver(fetcher);

      await expect(resolver.resolveInstallVersion(CLIENT_ID, MANIFEST_DESCRIPTOR, undefined)).rejects.toThrow(
        'FeedFetcher returned an empty version string',
      );
    });

    it('throws when refresh receives an empty string from the fetcher', async () => {
      const { fetcher } = makeMockFetcher('');
      resolver = new ClientBinaryVersionResolver(fetcher);

      // refresh() catches errors internally — the empty-version guard must
      // re-throw before the cache is written, so the cache should remain empty.
      const ok = await resolver.refresh(CLIENT_ID, MANIFEST_DESCRIPTOR);

      expect(ok).toBe(false);
      expect(resolver.getLatestVersionMeta(CLIENT_ID).latestAvailableVersion).toBeNull();
    });

    it('does not corrupt the cache when refresh receives an empty string', async () => {
      const { fetcher } = makeMockFetcher('');
      resolver = new ClientBinaryVersionResolver(fetcher);
      resolver.seedFromStorage(CLIENT_ID, '1.0.0', 1_000);

      await resolver.refresh(CLIENT_ID, MANIFEST_DESCRIPTOR);

      // The pre-seeded version must be preserved; an empty fetch must not overwrite it.
      const meta = resolver.getLatestVersionMeta(CLIENT_ID);
      expect(meta.latestAvailableVersion).toBe('1.0.0');
      expect(meta.latestVersionSourceStatus).toBe('error');
    });

    it('trims leading/trailing whitespace from a valid version returned by the fetcher', async () => {
      const { fetcher } = makeMockFetcher('  1.5.0  ');
      resolver = new ClientBinaryVersionResolver(fetcher);

      const result = await resolver.resolveInstallVersion(CLIENT_ID, MANIFEST_DESCRIPTOR, undefined);

      expect(result.version).toBe('1.5.0');
    });
  });

  // -------------------------------------------------------------------------
  // refresh — successful refresh
  // -------------------------------------------------------------------------

  describe('refresh — success', () => {
    it('returns true and updates the cache to fresh on success', async () => {
      const { fetcher } = makeMockFetcher('2.1.0');
      resolver = new ClientBinaryVersionResolver(fetcher);

      const ok = await resolver.refresh(CLIENT_ID, MANIFEST_DESCRIPTOR);

      expect(ok).toBe(true);
      const meta = resolver.getLatestVersionMeta(CLIENT_ID);
      expect(meta.latestAvailableVersion).toBe('2.1.0');
      expect(meta.latestVersionSourceStatus).toBe('fresh');
      expect(meta.latestVersionLastCheckedAt).toBeTypeOf('number');
    });

    it('overwrites an existing cache entry with the newly fetched version', async () => {
      const { fetcher } = makeMockFetcher('2.2.0');
      resolver = new ClientBinaryVersionResolver(fetcher);
      resolver.seedFromStorage(CLIENT_ID, '1.0.0', 1_000);

      await resolver.refresh(CLIENT_ID, MANIFEST_DESCRIPTOR);

      const meta = resolver.getLatestVersionMeta(CLIENT_ID);
      expect(meta.latestAvailableVersion).toBe('2.2.0');
      expect(meta.latestVersionSourceStatus).toBe('fresh');
    });

    it('updates latestVersionLastCheckedAt to a recent timestamp', async () => {
      const before = Date.now();
      const { fetcher } = makeMockFetcher('1.0.0');
      resolver = new ClientBinaryVersionResolver(fetcher);

      await resolver.refresh(CLIENT_ID, MANIFEST_DESCRIPTOR);

      const after = Date.now();
      const meta = resolver.getLatestVersionMeta(CLIENT_ID);
      expect(meta.latestVersionLastCheckedAt).toBeGreaterThanOrEqual(before);
      expect(meta.latestVersionLastCheckedAt).toBeLessThanOrEqual(after);
    });
  });

  // -------------------------------------------------------------------------
  // refresh — failed refresh
  // -------------------------------------------------------------------------

  describe('refresh — failure', () => {
    it('returns false when the feed fetch fails', async () => {
      resolver = new ClientBinaryVersionResolver(makeFailingFetcher(new Error('timeout')));

      const ok = await resolver.refresh(CLIENT_ID, MANIFEST_DESCRIPTOR);

      expect(ok).toBe(false);
    });

    it('retains the cached version but sets status to error on failure', async () => {
      // Seed a prior known-good version.
      const { fetcher: goodFetcher } = makeMockFetcher('1.8.0');
      resolver = new ClientBinaryVersionResolver(goodFetcher);
      await resolver.refresh(CLIENT_ID, MANIFEST_DESCRIPTOR);

      // Now simulate a failed refresh with a new resolver instance that has
      // the old entry pre-seeded.
      const failingResolver = new ClientBinaryVersionResolver(makeFailingFetcher(new Error('upstream error')));
      failingResolver.seedFromStorage(CLIENT_ID, '1.8.0', Date.now());

      const ok = await failingResolver.refresh(CLIENT_ID, MANIFEST_DESCRIPTOR);

      expect(ok).toBe(false);
      const meta = failingResolver.getLatestVersionMeta(CLIENT_ID);
      expect(meta.latestAvailableVersion).toBe('1.8.0');
      expect(meta.latestVersionSourceStatus).toBe('error');
      expect(meta.latestVersionLastCheckedAt).not.toBeNull();
    });

    it('leaves the cache empty when there was no prior entry and the fetch fails', async () => {
      resolver = new ClientBinaryVersionResolver(makeFailingFetcher(new Error('down')));

      await resolver.refresh(CLIENT_ID, MANIFEST_DESCRIPTOR);

      const meta = resolver.getLatestVersionMeta(CLIENT_ID);
      expect(meta.latestAvailableVersion).toBeNull();
      expect(meta.latestVersionLastCheckedAt).toBeNull();
      expect(meta.latestVersionSourceStatus).toBe('error');
    });
  });

  // -------------------------------------------------------------------------
  // getLatestVersionMeta — no entry
  // -------------------------------------------------------------------------

  describe('getLatestVersionMeta — no cache entry', () => {
    it('returns null fields and error status when the client has never been fetched', () => {
      const meta = resolver.getLatestVersionMeta('unknown-client');

      expect(meta.latestAvailableVersion).toBeNull();
      expect(meta.latestVersionLastCheckedAt).toBeNull();
      expect(meta.latestVersionSourceStatus).toBe('error');
    });
  });

  // -------------------------------------------------------------------------
  // seedFromStorage
  // -------------------------------------------------------------------------

  describe('seedFromStorage', () => {
    it('marks seeded entries as cached, not fresh', () => {
      resolver.seedFromStorage(CLIENT_ID, '1.0.0', 1_000_000);

      const meta = resolver.getLatestVersionMeta(CLIENT_ID);
      expect(meta.latestVersionSourceStatus).toBe('cached');
    });

    it('preserves the stored checkedAt timestamp', () => {
      const storedAt = 1_700_000_000_000;
      resolver.seedFromStorage(CLIENT_ID, '1.0.0', storedAt);

      const meta = resolver.getLatestVersionMeta(CLIENT_ID);
      expect(meta.latestVersionLastCheckedAt).toBe(storedAt);
    });

    it('throws when the persisted version is an empty string', () => {
      expect(() => resolver.seedFromStorage(CLIENT_ID, '', 1_000_000)).toThrow(
        'Storage version returned an empty version string',
      );
    });

    it('throws when the persisted version is a whitespace-only string', () => {
      expect(() => resolver.seedFromStorage(CLIENT_ID, '   ', 1_000_000)).toThrow(
        'Storage version returned an empty version string',
      );
    });

    it('does not write to the cache when the persisted version is invalid', () => {
      expect(() => resolver.seedFromStorage(CLIENT_ID, '', 1_000_000)).toThrow();

      expect(resolver.getLatestVersionMeta(CLIENT_ID).latestAvailableVersion).toBeNull();
    });

    // -----------------------------------------------------------------------
    // RT-9: explicit status parameter
    // -----------------------------------------------------------------------

    it("seedFromStorage with status 'error' preserves 'error' in the cache", () => {
      resolver.seedFromStorage(CLIENT_ID, '1.0.0', 1_000_000, 'error');

      const meta = resolver.getLatestVersionMeta(CLIENT_ID);
      expect(meta.latestVersionSourceStatus).toBe('error');
    });

    it("seedFromStorage with status 'fresh' downgrades to 'cached'", () => {
      // 'fresh' is a live-fetch classification and must not be persisted across
      // restarts — the resolver normalises it to 'cached' on seed.
      resolver.seedFromStorage(CLIENT_ID, '1.0.0', 1_000_000, 'fresh');

      const meta = resolver.getLatestVersionMeta(CLIENT_ID);
      expect(meta.latestVersionSourceStatus).toBe('cached');
    });
  });

  // -------------------------------------------------------------------------
  // clear
  // -------------------------------------------------------------------------

  describe('clear', () => {
    it('removes all cache entries', async () => {
      const { fetcher } = makeMockFetcher('1.0.0');
      resolver = new ClientBinaryVersionResolver(fetcher);
      await resolver.refresh(CLIENT_ID, MANIFEST_DESCRIPTOR);
      await resolver.refresh('other-client', MANIFEST_DESCRIPTOR);

      resolver.clear();

      expect(resolver.getLatestVersionMeta(CLIENT_ID).latestAvailableVersion).toBeNull();
      expect(resolver.getLatestVersionMeta('other-client').latestAvailableVersion).toBeNull();
    });
  });
});
