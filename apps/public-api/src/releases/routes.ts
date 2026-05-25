import { Hono } from 'hono';
import type { IReleaseResolver } from './types.js';
import { parseChannel, isUpdateJson } from './channels.js';

const CACHE_HEADERS = { 'Cache-Control': 'public, max-age=60' } as const;

/**
 * Create Hono routes for release artifact serving.
 *
 * Mount at a path prefix via `app.route('/releases', createReleaseRoutes(resolver))`.
 * @param resolver - Release resolver instance.
 * @returns Hono app with release routes.
 */
export function createReleaseRoutes(resolver: IReleaseResolver): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    console.error('[releases]', err.message);
    return c.json({ error: 'Upstream service error' }, 502);
  });

  app.get('/channels', async (c) => {
    const channels = await resolver.getAllChannels();
    return c.json({ channels }, 200, CACHE_HEADERS);
  });

  app.get('/:artifact', async (c) => {
    const artifact = c.req.param('artifact');
    const channel = parseChannel(artifact);
    if (!channel) {
      return c.json({ error: 'Unknown channel' }, 404);
    }

    const release = await resolver.getLatestRelease(channel);
    if (!release) {
      return c.json({ error: 'No release found for channel' }, 404);
    }

    const asset = release.assets.get(artifact);
    if (!asset) {
      return c.json({ error: 'Artifact not found' }, 404);
    }

    if (isUpdateJson(artifact) && asset.content !== undefined) {
      return c.json(asset.content, 200, CACHE_HEADERS);
    }

    return c.redirect(asset.url, 302);
  });

  return app;
}
