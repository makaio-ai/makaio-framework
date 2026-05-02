import { serveStatic } from 'hono/bun';

/**
 * Default static-serving mount factory for Bun.
 *
 * Registers a wildcard route under `urlPrefix` that serves files from
 * `serveRoot` (an absolute path) using Hono's Bun-native `serveStatic`
 * middleware. The `rewriteRequestPath` option strips the URL prefix before
 * the middleware resolves it against `root`, so a request for
 * `/extensions/my-ext/browser/index.js` resolves to `<serveRoot>/index.js`.
 * @param serveRoot - Absolute path to the directory containing the browser bundle.
 * @param urlPrefix - URL prefix to mount the static handler under.
 * @returns A mount callback that synchronously registers the static route on the Hono app.
 */
export function defaultCreateMount(serveRoot: string, urlPrefix: string): (app: unknown) => void {
  // Normalize once so route registration and request rewriting stay aligned.
  const normalizedPrefix = urlPrefix.endsWith('/') ? urlPrefix.slice(0, -1) : urlPrefix;
  const prefixWithSlash = `${normalizedPrefix}/`;
  const handler = serveStatic({
    root: serveRoot,
    rewriteRequestPath: (requestPath) => requestPath.slice(prefixWithSlash.length - 1),
  });
  return (app) => {
    // `app` is typed as `unknown` in MakaioPackage.http.mount.
    // The composition root always passes a Hono instance here.
    (app as { use: (path: string, handler: unknown) => void }).use(`${normalizedPrefix}/*`, handler);
  };
}
