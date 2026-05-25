import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { createReleaseRoutes } from '../releases/routes.js';
import { GitHubReleaseResolver } from '../releases/github-resolver.js';
import type { Channel, ChannelInfo, IReleaseResolver, ResolvedRelease } from '../releases/types.js';

function createTestResolver(releases: Partial<Record<Channel, ResolvedRelease>>): IReleaseResolver {
  return {
    async getLatestRelease(channel) {
      return releases[channel] ?? null;
    },
    async getAllChannels() {
      const infos: ChannelInfo[] = [];
      for (const [name, release] of Object.entries(releases)) {
        if (release) {
          infos.push({ name: name as Channel, version: release.version, updatedAt: release.publishedAt });
        }
      }
      return infos;
    },
  };
}

function makeRelease(overrides?: Partial<ResolvedRelease>): ResolvedRelease {
  return {
    tag: 'v0.1.0',
    version: '0.1.0',
    publishedAt: '2026-05-04T12:00:00Z',
    assets: new Map([
      [
        'stable-macos-arm64-update.json',
        { url: 'https://github.com/example/update.json', size: 100, content: { version: '0.1.0', hash: 'abc123' } },
      ],
      ['stable-macos-arm64-Makaio.app.tar.zst', { url: 'https://github.com/example/app.tar.zst', size: 50_000_000 }],
    ]),
    ...overrides,
  };
}

describe('release routes', () => {
  let app: Hono;

  beforeEach(() => {
    const resolver = createTestResolver({ stable: makeRelease() });
    app = new Hono();
    app.route('/releases', createReleaseRoutes(resolver));
  });

  describe('GET /releases/:artifact (update.json)', () => {
    it('serves update.json content inline as JSON', async () => {
      const res = await app.request('/releases/stable-macos-arm64-update.json');

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      const body = await res.json();
      expect(body).toEqual({ version: '0.1.0', hash: 'abc123' });
    });

    it('sets Cache-Control header for update.json', async () => {
      const res = await app.request('/releases/stable-macos-arm64-update.json');
      expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    });
  });

  describe('GET /releases/:artifact (binary artifact)', () => {
    it('redirects to GitHub asset URL with 302', async () => {
      const res = await app.request('/releases/stable-macos-arm64-Makaio.app.tar.zst', {
        redirect: 'manual',
      });

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('https://github.com/example/app.tar.zst');
    });
  });

  describe('GET /releases/:artifact (errors)', () => {
    it('returns 404 for unknown channel', async () => {
      const res = await app.request('/releases/nightly-macos-arm64-update.json');
      expect(res.status).toBe(404);
    });

    it('returns 404 for unknown artifact on valid channel', async () => {
      const res = await app.request('/releases/stable-macos-arm64-nonexistent.dmg');
      expect(res.status).toBe(404);
    });

    it('returns 404 for channel with no releases', async () => {
      const emptyApp = new Hono();
      emptyApp.route('/releases', createReleaseRoutes(createTestResolver({})));

      const res = await emptyApp.request('/releases/stable-macos-arm64-update.json');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /releases/:artifact (upstream failure)', () => {
    it('returns 502 when resolver throws', async () => {
      const failingResolver = new GitHubReleaseResolver({
        repo: 'makaio-ai/makaio-framework',
        fetch: vi
          .fn()
          .mockResolvedValue(new Response('Service Unavailable', { status: 503, statusText: 'Service Unavailable' })),
      });
      const failApp = new Hono();
      failApp.route('/releases', createReleaseRoutes(failingResolver));

      const res = await failApp.request('/releases/stable-macos-arm64-update.json');

      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body).toEqual({ error: 'Upstream service error' });
    });
  });

  describe('GET /releases/channels', () => {
    it('returns channel info as JSON', async () => {
      const res = await app.request('/releases/channels');

      expect(res.status).toBe(200);
      const body = (await res.json()) as { channels: ChannelInfo[] };
      expect(body.channels).toBeInstanceOf(Array);
      expect(body.channels[0]).toMatchObject({ name: 'stable', version: '0.1.0' });
    });

    it('sets Cache-Control header', async () => {
      const res = await app.request('/releases/channels');
      expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    });
  });
});
