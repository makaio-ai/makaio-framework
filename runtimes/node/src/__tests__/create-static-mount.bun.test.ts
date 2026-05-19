/**
 * Integration test for {@link defaultCreateMount}.
 *
 * Exercises the real `@hono/node-server/serve-static` middleware through a live
 * Hono instance to verify that the `rewriteRequestPath` correctly strips the URL
 * prefix before resolving files against `serveRoot`.
 *
 * These tests use real implementations throughout — no mocked modules.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { defaultCreateMount } from '../create-static-mount.js';

// ---------------------------------------------------------------------------
// Fixture paths
// ---------------------------------------------------------------------------

/**
 * Absolute path to the `browser` bundle directory used as `serveRoot`.
 * Contains a single `index.js` file starting with `export default`.
 */
const SERVE_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'browser-ext',
  'bundle',
  'browser',
);

/** URL prefix that mirrors the production convention. */
const URL_PREFIX = '/extensions/browser-ext/browser';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('defaultCreateMount', () => {
  it('serves a static file under the URL prefix', async () => {
    const app = new Hono();
    const mount = defaultCreateMount(SERVE_ROOT, URL_PREFIX);
    mount(app);

    const res = await app.request(`${URL_PREFIX}/index.js`);

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('export default');
  });

  it('returns 404 for non-existent files under the prefix', async () => {
    const app = new Hono();
    const mount = defaultCreateMount(SERVE_ROOT, URL_PREFIX);
    mount(app);

    const res = await app.request(`${URL_PREFIX}/nonexistent.js`);

    expect(res.status).toBe(404);
  });

  it('strips the full prefix so only the file-relative path reaches serveRoot', async () => {
    // The rewriteRequestPath maps:
    //   /extensions/browser-ext/browser/index.js → /index.js
    // Verify this by ensuring the response body matches the exact fixture content.
    const app = new Hono();
    const mount = defaultCreateMount(SERVE_ROOT, URL_PREFIX);
    mount(app);

    const res = await app.request(`${URL_PREFIX}/index.js`);
    expect(res.status).toBe(200);
    const body = await res.text();

    // The fixture exports a default arrow function — exact content assertion.
    expect(body.trim()).toBe(`export default () => ({ pages: [] });`);
  });
});
