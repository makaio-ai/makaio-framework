import type { MakaioNodeExtension } from '@makaio/contracts/extension';
import type { Hono } from 'hono';
import { createApiApp, type ApiConfig } from './app.js';
import type { IMakaioBus } from '@makaio/bus-core';

const DEFAULT_GITHUB_REPO = 'makaio-ai/makaio-framework';
const DEFAULT_CACHE_TTL_MS = 60_000;

/**
 * Read API configuration from environment variables.
 *
 * | Variable | Default | Description |
 * |----------|---------|-------------|
 * | `GITHUB_REPO` | `makaio-ai/makaio-framework` | GitHub repo for releases |
 * | `GITHUB_TOKEN` | — | Optional GitHub API token for higher rate limits |
 * | `CACHE_TTL_MS` | `60000` | Release cache TTL in milliseconds |
 * @param env - Environment map to read. Defaults to `process.env`.
 * @returns API configuration for `createApiApp`.
 */
export function readApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const githubRepo = env['GITHUB_REPO']?.trim();
  return {
    github: {
      repo: githubRepo ? githubRepo : DEFAULT_GITHUB_REPO,
      githubToken: env['GITHUB_TOKEN'],
      cacheTtlMs: readCacheTtlMs(env['CACHE_TTL_MS']),
    },
  };
}

/**
 * API extension.
 *
 * Mounts the release API under `/api`. The server host remains a
 * generic composition root; release behavior is selected by including this
 * descriptor-backed package in the bundled extension list.
 */
export const apiExtension: MakaioNodeExtension<IMakaioBus> = {
  name: 'public-api',
  displayName: 'Makaio API',
  version: '0.1.0',

  http: {
    prefix: '/api',

    /**
     * Mount the Makaio API Hono sub-app.
     * @param app - Host-owned Hono app instance (typed as `unknown` by contracts).
     */
    mount(app: unknown): void {
      if (!isHonoRouteTarget(app)) {
        throw new TypeError('apiExtension requires a Hono-compatible host app');
      }
      app.route('/api', createApiApp(readApiConfig()));
    },
  },
};

/**
 * Check whether a host app exposes the Hono route API needed by this extension.
 * @param app - Host-owned app value.
 * @returns Whether the value supports `route(prefix, app)`.
 */
function isHonoRouteTarget(app: unknown): app is Pick<Hono, 'route'> {
  return typeof app === 'object' && app !== null && typeof (app as { readonly route?: unknown }).route === 'function';
}

/**
 * Parse the release cache TTL environment value.
 * @param rawCacheTtlMs - Raw `CACHE_TTL_MS` value.
 * @returns Valid cache TTL in milliseconds.
 */
function readCacheTtlMs(rawCacheTtlMs: string | undefined): number {
  if (rawCacheTtlMs === undefined) {
    return DEFAULT_CACHE_TTL_MS;
  }
  if (rawCacheTtlMs.trim() === '') {
    throw new Error('Invalid CACHE_TTL_MS: (empty)');
  }

  const cacheTtlMs = Number(rawCacheTtlMs);
  if (!Number.isFinite(cacheTtlMs) || cacheTtlMs < 0) {
    throw new Error(`Invalid CACHE_TTL_MS: ${rawCacheTtlMs}`);
  }
  return cacheTtlMs;
}
