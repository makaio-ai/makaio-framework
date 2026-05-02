import { serveStatic } from '@hono/node-server/serve-static';

/**
 * Options shared by {@link bridgeExtensionBrowserEntries} and
 * {@link synthesizeBrowserOnlyPackages} for controlling static-file serving.
 */
export interface BridgeBrowserOptions {
  /**
   * Factory for creating the static-serving mount callback.
   *
   * Injected for testability — production default uses `@hono/node-server/serve-static`
   * synchronously and mounts the directory under `urlPrefix`.
   * @param serveRoot - Absolute path to the directory containing the browser bundle.
   * @param urlPrefix - URL prefix for the route (e.g., `/extensions/my-ext/browser`).
   * @returns A mount callback compatible with {@link MakaioExtension.http.mount}.
   */
  readonly createMount?: (serveRoot: string, urlPrefix: string) => (app: unknown) => void;
}

/**
 * Default static-serving mount factory.
 *
 * Registers a wildcard route under `urlPrefix` that serves files from
 * `serveRoot` (an absolute path). The `rewriteRequestPath` option strips the
 * URL prefix before the middleware joins it with `serveRoot`, so that a request
 * for `/extensions/my-ext/browser/index.js` resolves to
 * `<serveRoot>/index.js` rather than `<serveRoot>/extensions/my-ext/browser/index.js`.
 * @param serveRoot - Absolute path to the directory containing the browser bundle.
 * @param urlPrefix - URL prefix to mount the static handler under.
 * @returns A mount callback that synchronously registers the static route on the Hono app.
 */
// urlPrefix is always constructed as `/extensions/<name>/browser` (no trailing
// slash) by all callers. The trailing-slash normalization in prefixWithSlash
// is defensive but never triggers in practice.
export function defaultCreateMount(serveRoot: string, urlPrefix: string): (app: unknown) => void {
  const prefixWithSlash = urlPrefix.endsWith('/') ? urlPrefix : `${urlPrefix}/`;
  const handler = serveStatic({
    root: serveRoot,
    rewriteRequestPath: (requestPath) => requestPath.slice(prefixWithSlash.length - 1),
  });
  return (app) => {
    // `app` is typed as `unknown` in MakaioExtension.http.mount.
    // The composition root always passes a Hono instance here.
    (app as { use: (path: string, handler: unknown) => void }).use(`${urlPrefix}/*`, handler);
  };
}
