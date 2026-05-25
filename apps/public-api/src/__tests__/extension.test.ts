import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { apiExtension, readApiConfig } from '../extension.js';

describe('api extension', () => {
  it('reads release API config from environment', () => {
    const config = readApiConfig({
      GITHUB_REPO: 'makaio-ai/makaio',
      GITHUB_TOKEN: 'gh-token',
      CACHE_TTL_MS: '120000',
    });

    expect(config.github).toEqual({
      repo: 'makaio-ai/makaio',
      githubToken: 'gh-token',
      cacheTtlMs: 120_000,
    });
  });

  it('uses release API defaults when environment is unset', () => {
    const config = readApiConfig({});

    expect(config.github).toEqual({
      repo: 'makaio-ai/makaio-framework',
      githubToken: undefined,
      cacheTtlMs: 60_000,
    });
  });

  it('uses the default release repo when GITHUB_REPO is blank', () => {
    const config = readApiConfig({ GITHUB_REPO: '   ' });

    expect(config.github.repo).toBe('makaio-ai/makaio-framework');
  });

  it('rejects invalid cache TTL values', () => {
    expect(() => readApiConfig({ CACHE_TTL_MS: '' })).toThrow('Invalid CACHE_TTL_MS: (empty)');
    expect(() => readApiConfig({ CACHE_TTL_MS: '-1' })).toThrow('Invalid CACHE_TTL_MS: -1');
  });

  it('mounts release routes under /api', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify([]), { status: 200 })));
    try {
      const app = new Hono();
      apiExtension.http?.mount(app);

      const res = await app.request('/api/releases/channels');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ channels: [] });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fails clearly when mounted on a non-Hono host app', () => {
    expect(() => apiExtension.http?.mount({})).toThrow('apiExtension requires a Hono-compatible host app');
  });
});
