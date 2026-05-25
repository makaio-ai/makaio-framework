import { Hono } from 'hono';
import { GitHubReleaseResolver, type GitHubResolverConfig } from './releases/github-resolver.js';
import { createReleaseRoutes } from './releases/routes.js';

/** Configuration for the API app. */
export interface ApiConfig {
  /** GitHub release resolver configuration. */
  readonly github: GitHubResolverConfig;
}

/**
 * Create the Makaio API as a composable Hono sub-app.
 *
 * Each domain is mounted at its own path prefix. The server composition root
 * mounts this app at `/api`, so release routes become `/api/releases/...`.
 * @param config - API configuration.
 * @returns Configured Hono app with all API domains.
 */
export function createApiApp(config: ApiConfig): Hono {
  const app = new Hono();

  const resolver = new GitHubReleaseResolver(config.github);
  app.route('/releases', createReleaseRoutes(resolver));

  return app;
}

export type { GitHubResolverConfig } from './releases/github-resolver.js';
export type { IReleaseResolver, Channel, ResolvedRelease, ChannelInfo } from './releases/types.js';
