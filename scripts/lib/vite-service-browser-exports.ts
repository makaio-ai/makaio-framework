/**
 * Vite plugin that enforces browser conditional exports for configured package families.
 *
 * **Problem:** `resolve.tsconfigPaths` can resolve package-family imports via
 * tsconfig `paths` entries that point to `index.ts` (the Node/default entry).
 * This bypasses `package.json` conditional exports, so browser builds pull in
 * server-only code (`child_process`, `fs`, drizzle, etc.).
 *
 * **Solution:** This plugin runs before tsconfig path resolution
 * (`enforce: 'pre'`) and redirects to `index.browser.ts` when one exists
 * alongside the default `index.ts`. Services without a browser entry fall
 * through to normal resolution.
 *
 * This enforces the same boundary as `package.json` `"browser"` conditional
 * exports — the plugin simply makes it work in the presence of tsconfig path
 * mappings.
 * @example
 * ```typescript
 * // vite.config.ts
 * import { serviceBrowserExportsPlugin } from '../../scripts/lib/vite-service-browser-exports.js';
 *
 * export default defineConfig({
 *   extensions: [
 *     serviceBrowserExportsPlugin({
 *       packages: [{ packageName: '@scope/services', sourceRoots: ['/workspace/services/src'] }],
 *     }),
 *     react(),
 *   ],
 *   resolve: { tsconfigPaths: true },
 * });
 * ```
 * @packageDocumentation
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

export interface BrowserExportPackageFamily {
  /** Package-family name to match, for example `@scope/package`. */
  readonly packageName: string;
  /** Source roots that contain one directory per subpath. */
  readonly sourceRoots: readonly string[];
}

export interface ServiceBrowserExportsPluginOptions {
  /**
   * Package families that may contain `index.browser.ts` entries. Host
   * hosts must pass host-owned package names and roots explicitly; the
   * reusable framework plugin never infers host layout from the surrounding
   * repository.
   */
  readonly packages?: readonly BrowserExportPackageFamily[];
}

/**
 * Returns the first path in `candidates` that exists on disk, or `undefined`
 * when none of them do.
 *
 * Use this whenever a feature can live in multiple topology-specific locations
 * (nested source checkout vs standalone) and only the first real file should be used.
 * @param candidates - Absolute paths to probe in priority order
 * @returns First existing path, or `undefined`
 */
export function firstExistingCandidate(candidates: readonly string[]): string | undefined {
  return candidates.find((c) => existsSync(c));
}

/**
 * Create a Vite plugin that redirects configured `<package>/<name>` imports to
 * their browser entry point when one exists.
 * @param options - Browser export package families to enforce.
 * @returns Vite plugin (enforce: 'pre')
 */
export function serviceBrowserExportsPlugin(options: ServiceBrowserExportsPluginOptions = {}): Plugin {
  const packageFamilies = options.packages ?? [];

  return {
    name: 'makaio:service-browser-exports',
    enforce: 'pre',
    resolveId(source) {
      for (const packageFamily of packageFamilies) {
        const prefix = `${packageFamily.packageName}/`;
        if (!source.startsWith(prefix)) {
          continue;
        }

        const subpath = source.slice(prefix.length);
        if (!/^[a-z][\w-]*$/.test(subpath)) {
          continue;
        }

        const browserEntry = firstExistingCandidate(
          packageFamily.sourceRoots.map((s) => resolve(s, subpath, 'index.browser.ts')),
        );
        if (browserEntry) {
          return browserEntry;
        }
      }

      return null;
    },
  };
}
