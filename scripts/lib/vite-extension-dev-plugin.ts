/**
 * Vite plugin for serving extension browser bundles in dev mode.
 *
 * Intercepts requests to `/extensions/*` paths and serves the source files
 * through Vite's transform pipeline, providing HMR and bare-specifier
 * resolution. In production, these paths are served by Hono sub-apps.
 * @example
 * ```typescript
 * // vite.config.ts
 * import { viteExtensionDevPlugin } from '../../scripts/lib/vite-extension-dev-plugin.js';
 * import { discoverExtensionBrowserDevEntries } from '../../scripts/lib/discover-extension-browser-dev-entries.js';
 *
 * export default defineConfig({
 *   extensions: [react(), viteExtensionDevPlugin({ extensionDevEntries: discoverExtensionBrowserDevEntries() })],
 * });
 * ```
 * @packageDocumentation
 */

import type { Plugin } from 'vite';

/**
 * An extension browser entry for dev-mode serving.
 */
export interface ExtensionDevEntry {
  /** URL path the renderer fetches, e.g. `/extensions/my-ext/browser/index.js`. */
  readonly urlPath: string;
  /** Absolute path to the source file Vite will transform. */
  readonly sourceAbsPath: string;
}

/**
 * Options for {@link viteExtensionDevPlugin}.
 */
export interface ViteExtensionDevPluginOptions {
  /**
   * Extension browser entries to serve alongside first-party entries.
   *
   * Populated via {@link discoverExtensionBrowserDevEntries} at Vite config
   * evaluation time. Omit or pass an empty array to serve first-party only.
   */
  readonly extensionDevEntries?: ReadonlyArray<ExtensionDevEntry>;
  /**
   * Additional extension browser entries to serve, keyed by URL path.
   *
   * Each key is the URL path the renderer requests at runtime (e.g.
   * `/extensions/my-ext/browser/index.js`) and each value is the
   * absolute path to the TypeScript source file Vite will transform.
   *
   * These entries take precedence over extension dev entries on URL collision.
   * The caller is responsible for resolving paths and checking file existence
   * before passing entries here.
   */
  readonly additionalEntries?: Readonly<Record<string, string>>;
}

/**
 * Vite plugin that intercepts `/extensions/*` requests in dev mode and serves
 * the source through Vite's transform pipeline.
 *
 * Uses {@link https://vitejs.dev/guide/api-plugin.html#transformrequest | server.transformRequest()}
 * so that every intercepted file goes through the full Vite pipeline: TypeScript
 * transpilation, JSX transform, bare-specifier resolution, and HMR injection.
 * No import maps are required in dev mode because Vite resolves all specifiers.
 *
 * The `extensionMap` merges entries in priority order: additional entries
 * supplied via `options.additionalEntries` take precedence, followed by
 * extension dev entries supplied via `options.extensionDevEntries`. Extension
 * dev entries are discovered synchronously at Vite config time by
 * {@link discoverExtensionBrowserDevEntries}.
 * @param options - Optional plugin configuration.
 * @returns Vite plugin instance.
 */
export function viteExtensionDevPlugin(options?: ViteExtensionDevPluginOptions): Plugin {
  // Static map of extension URL paths to absolute source file paths.
  // Keys are the URL paths that browser code requests at runtime.
  // Values are the TypeScript source files that Vite will transform.
  const extensionMap: Record<string, string> = {
    ...options?.additionalEntries,
  };

  // Merge extension dev entries, but never overwrite additional entries on URL collision.
  // Additional entries win by convention — callers that need first-party priority
  // supply them via `additionalEntries`.
  for (const entry of options?.extensionDevEntries ?? []) {
    if (!(entry.urlPath in extensionMap)) {
      extensionMap[entry.urlPath] = entry.sourceAbsPath;
    } else {
      console.warn(
        `[vite-extension-dev-plugin] Extension dev entry "${entry.urlPath}" conflicts with existing entry, skipping`,
      );
    }
  }

  return {
    name: 'makaio-extension-dev',

    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        // Strip query string (e.g. `?t=...` appended by Vite HMR cache-busting)
        // before looking up the extension map so HMR re-fetches are served correctly.
        const url = req.url?.split('?')[0];
        if (!url || !extensionMap[url]) return next();

        try {
          const sourcePath = extensionMap[url];
          // Feed Vite the absolute source path directly. In the Electron
          // renderer dev server this avoids a second `/@fs/` resolution pass
          // that can fail even when the underlying source file exists.
          const result = await server.transformRequest(sourcePath);
          if (!result) return next();

          res.setHeader('Content-Type', 'application/javascript');
          res.end(result.code);
        } catch (error) {
          next(error);
        }
      });
    },
  };
}
