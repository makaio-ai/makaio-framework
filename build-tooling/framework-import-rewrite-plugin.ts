/**
 * Vite build plugin that externalizes all framework-owned workspace packages
 * and rewrites their import specifiers to the stable `@makaio/framework/<subpath>`
 * form.
 *
 * Delegates to {@link rewriteFrameworkImportSpecifier} from the shared map,
 * ensuring a single source of truth for all rewrite rules.
 * @packageDocumentation
 */

import type { Plugin as VitePlugin } from 'vite';
import { rewriteFrameworkImportSpecifier } from '@makaio/build-tooling/framework-import-map';

/**
 * Vite plugin that externalizes every framework-owned workspace package and
 * rewrites its import specifier to `@makaio/framework/<subpath>`.
 *
 * Runs at `enforce: 'pre'` so it intercepts specifiers before Vite's own
 * resolver sees them, preventing accidental bundling of public framework
 * packages in adapter builds.
 * @returns Vite plugin instance.
 */
export function frameworkImportRewritePlugin(): VitePlugin {
  return {
    name: 'makaio-framework-import-rewrite',
    enforce: 'pre',
    resolveId(source) {
      const rewritten = rewriteFrameworkImportSpecifier(source);
      if (!rewritten) return null;
      return { id: rewritten, external: true };
    },
  };
}
