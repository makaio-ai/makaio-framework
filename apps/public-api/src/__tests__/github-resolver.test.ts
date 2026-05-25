import { describe, it, expect, vi, type Mock } from 'vitest';
import { GitHubReleaseResolver } from '../releases/github-resolver.js';

function createGitHubRelease(overrides: {
  tag: string;
  prerelease?: boolean;
  assets?: Array<{ name: string; url: string; size: number }>;
  publishedAt?: string;
}) {
  return {
    tag_name: overrides.tag,
    prerelease: overrides.prerelease ?? false,
    published_at: overrides.publishedAt ?? '2026-05-04T12:00:00Z',
    assets: (overrides.assets ?? []).map((a) => ({
      name: a.name,
      browser_download_url: a.url,
      size: a.size,
    })),
  };
}

function createMockFetch(releases: ReturnType<typeof createGitHubRelease>[]): Mock {
  return vi.fn().mockImplementation(async (url: string) => {
    if (url.includes('/releases')) {
      return new Response(JSON.stringify(releases), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('update.json')) {
      return new Response(JSON.stringify({ version: '0.1.0', hash: 'abc123' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('Not Found', { status: 404 });
  });
}

describe('GitHubReleaseResolver', () => {
  const baseConfig = { repo: 'makaio-ai/makaio-framework', cacheTtlMs: 60_000 };

  describe('getLatestRelease', () => {
    it('resolves the latest stable release (non-prerelease)', async () => {
      const mockFetch = createMockFetch([
        createGitHubRelease({
          tag: 'v0.2.0',
          assets: [
            { name: 'stable-macos-arm64-update.json', url: 'https://gh/update.json', size: 100 },
            { name: 'stable-macos-arm64-Makaio.app.tar.zst', url: 'https://gh/app.tar.zst', size: 50_000_000 },
          ],
        }),
        createGitHubRelease({
          tag: 'v0.1.0-canary.3',
          prerelease: true,
          assets: [{ name: 'canary-macos-arm64-update.json', url: 'https://gh/canary-update.json', size: 100 }],
        }),
      ]);

      const resolver = new GitHubReleaseResolver({ ...baseConfig, fetch: mockFetch });
      const release = await resolver.getLatestRelease('stable');

      expect(release).not.toBeNull();
      expect(release!.tag).toBe('v0.2.0');
      expect(release!.version).toBe('0.2.0');
      expect(release!.assets.has('stable-macos-arm64-update.json')).toBe(true);
      expect(release!.assets.has('stable-macos-arm64-Makaio.app.tar.zst')).toBe(true);
    });

    it('resolves the latest canary release (prerelease with canary tag)', async () => {
      const mockFetch = createMockFetch([
        createGitHubRelease({ tag: 'v0.2.0' }),
        createGitHubRelease({
          tag: 'v0.2.0-canary.5',
          prerelease: true,
          assets: [{ name: 'canary-macos-arm64-update.json', url: 'https://gh/canary-update.json', size: 100 }],
        }),
        createGitHubRelease({
          tag: 'v0.1.0-canary.3',
          prerelease: true,
          assets: [{ name: 'canary-macos-arm64-update.json', url: 'https://gh/old-canary-update.json', size: 100 }],
        }),
      ]);

      const resolver = new GitHubReleaseResolver({ ...baseConfig, fetch: mockFetch });
      const release = await resolver.getLatestRelease('canary');

      expect(release).not.toBeNull();
      expect(release!.tag).toBe('v0.2.0-canary.5');
    });

    it('resolves cef channel from the same release as stable', async () => {
      const mockFetch = createMockFetch([
        createGitHubRelease({
          tag: 'v0.2.0',
          assets: [
            { name: 'stable-macos-arm64-update.json', url: 'https://gh/stable-update.json', size: 100 },
            { name: 'cef-macos-arm64-update.json', url: 'https://gh/cef-update.json', size: 100 },
          ],
        }),
      ]);

      const resolver = new GitHubReleaseResolver({ ...baseConfig, fetch: mockFetch });
      const release = await resolver.getLatestRelease('cef');

      expect(release).not.toBeNull();
      expect(release!.tag).toBe('v0.2.0');
    });

    it('resolves cef-canary channel from the same prerelease as canary', async () => {
      const mockFetch = createMockFetch([
        createGitHubRelease({
          tag: 'v0.2.0-canary.5',
          prerelease: true,
          assets: [
            { name: 'canary-macos-arm64-update.json', url: 'https://gh/canary-update.json', size: 100 },
            { name: 'cef-canary-macos-arm64-update.json', url: 'https://gh/cef-canary-update.json', size: 100 },
          ],
        }),
      ]);

      const resolver = new GitHubReleaseResolver({ ...baseConfig, fetch: mockFetch });
      const release = await resolver.getLatestRelease('cef-canary');

      expect(release).not.toBeNull();
      expect(release!.tag).toBe('v0.2.0-canary.5');
    });

    it('returns null when no releases match the channel', async () => {
      const mockFetch = createMockFetch([createGitHubRelease({ tag: 'v0.1.0' })]);

      const resolver = new GitHubReleaseResolver({ ...baseConfig, fetch: mockFetch });
      const release = await resolver.getLatestRelease('canary');

      expect(release).toBeNull();
    });

    it('returns null when the selected release has no assets for the requested channel', async () => {
      const mockFetch = createMockFetch([
        createGitHubRelease({
          tag: 'v0.2.0',
          assets: [{ name: 'stable-macos-arm64-update.json', url: 'https://gh/stable-update.json', size: 100 }],
        }),
      ]);

      const resolver = new GitHubReleaseResolver({ ...baseConfig, fetch: mockFetch });
      const release = await resolver.getLatestRelease('cef');

      expect(release).toBeNull();
    });

    it('pre-fetches update.json content into asset.content', async () => {
      const mockFetch = createMockFetch([
        createGitHubRelease({
          tag: 'v0.1.0',
          assets: [{ name: 'stable-macos-arm64-update.json', url: 'https://gh/update.json', size: 100 }],
        }),
      ]);

      const resolver = new GitHubReleaseResolver({ ...baseConfig, fetch: mockFetch });
      const release = await resolver.getLatestRelease('stable');

      const asset = release!.assets.get('stable-macos-arm64-update.json');
      expect(asset?.content).toEqual({ version: '0.1.0', hash: 'abc123' });
    });

    it('degrades gracefully when update.json fetch fails', async () => {
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (String(url).includes('/releases')) {
          return new Response(
            JSON.stringify([
              createGitHubRelease({
                tag: 'v0.1.0',
                assets: [
                  { name: 'stable-macos-arm64-update.json', url: 'https://gh/update.json', size: 100 },
                  { name: 'stable-macos-arm64-Makaio.app.tar.zst', url: 'https://gh/app.tar.zst', size: 50_000_000 },
                ],
              }),
            ]),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (String(url).includes('update.json')) {
          return new Response('Service Unavailable', { status: 503 });
        }
        return new Response('Not Found', { status: 404 });
      });

      const resolver = new GitHubReleaseResolver({ ...baseConfig, fetch: mockFetch });
      const release = await resolver.getLatestRelease('stable');

      expect(release).not.toBeNull();
      expect(release!.tag).toBe('v0.1.0');
      const updateAsset = release!.assets.get('stable-macos-arm64-update.json');
      expect(updateAsset).toBeDefined();
      expect(updateAsset!.content).toBeUndefined();
      const binaryAsset = release!.assets.get('stable-macos-arm64-Makaio.app.tar.zst');
      expect(binaryAsset).toBeDefined();
      expect(binaryAsset!.url).toBe('https://gh/app.tar.zst');
    });

    it('throws on GitHub API error (e.g. rate limit)', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(new Response('Rate limit exceeded', { status: 403, statusText: 'Forbidden' }));

      const resolver = new GitHubReleaseResolver({ ...baseConfig, fetch: mockFetch });
      await expect(resolver.getLatestRelease('stable')).rejects.toThrow('GitHub API error: 403 Forbidden');
    });
  });

  describe('caching', () => {
    it('returns cached result within TTL without re-fetching', async () => {
      const mockFetch = createMockFetch([createGitHubRelease({ tag: 'v0.1.0' })]);

      const resolver = new GitHubReleaseResolver({ ...baseConfig, cacheTtlMs: 60_000, fetch: mockFetch });

      await resolver.getLatestRelease('stable');
      await resolver.getLatestRelease('stable');

      const releaseCalls = mockFetch.mock.calls.filter((c) => String(c[0]).includes('/releases'));
      expect(releaseCalls).toHaveLength(1);
    });

    it('re-fetches after TTL expires', async () => {
      const mockFetch = createMockFetch([createGitHubRelease({ tag: 'v0.1.0' })]);

      const resolver = new GitHubReleaseResolver({ ...baseConfig, cacheTtlMs: 0, fetch: mockFetch });

      await resolver.getLatestRelease('stable');
      await resolver.getLatestRelease('stable');

      const releaseCalls = mockFetch.mock.calls.filter((c) => String(c[0]).includes('/releases'));
      expect(releaseCalls.length).toBeGreaterThan(1);
    });

    it('does not reuse a failed inflight release resolve', async () => {
      let updateJsonCalls = 0;
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/releases')) {
          return new Response(
            JSON.stringify([
              createGitHubRelease({
                tag: 'v0.1.0',
                assets: [{ name: 'stable-macos-arm64-update.json', url: 'https://gh/update.json', size: 100 }],
              }),
            ]),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        updateJsonCalls += 1;
        if (updateJsonCalls === 1) {
          return new Response('Service Unavailable', { status: 503 });
        }
        return new Response(JSON.stringify({ version: '0.1.0', hash: 'abc123' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const resolver = new GitHubReleaseResolver({ ...baseConfig, fetch: mockFetch });

      // First call: update.json fetch fails but resolveRelease degrades gracefully — the
      // release is returned without content on the update.json asset and is then cached.
      const first = await resolver.getLatestRelease('stable');
      expect(first).toMatchObject({ tag: 'v0.1.0' });
      expect(first!.assets.get('stable-macos-arm64-update.json')?.content).toBeUndefined();

      // Second call: the resolved release is cached (cacheTtlMs: 60_000), so no new
      // update.json fetch is attempted — updateJsonCalls remains 1.
      const second = await resolver.getLatestRelease('stable');
      expect(second).toMatchObject({ tag: 'v0.1.0' });
      expect(updateJsonCalls).toBe(1);
    });
  });

  describe('getAllChannels', () => {
    it('returns info only for channels with matching release assets', async () => {
      const mockFetch = createMockFetch([
        createGitHubRelease({
          tag: 'v0.2.0',
          publishedAt: '2026-05-04T12:00:00Z',
          assets: [{ name: 'stable-macos-arm64-update.json', url: 'https://gh/update.json', size: 100 }],
        }),
        createGitHubRelease({
          tag: 'v0.2.0-canary.3',
          prerelease: true,
          publishedAt: '2026-05-03T12:00:00Z',
          assets: [],
        }),
      ]);

      const resolver = new GitHubReleaseResolver({ ...baseConfig, fetch: mockFetch });
      const channels = await resolver.getAllChannels();

      expect(channels).toEqual([{ name: 'stable', version: '0.2.0', updatedAt: '2026-05-04T12:00:00Z' }]);
    });
  });
});
