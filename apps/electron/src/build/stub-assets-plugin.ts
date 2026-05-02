/**
 * esbuild plugin that stubs out non-JavaScript assets in the main process bundle.
 *
 * The Electron main process bundle is Node.js code — it never executes style
 * sheets, WebAssembly binary assets, or other browser-only assets. Plugin and
 * adapter packages import UI components via lazy `() => import(...)`, and
 * esbuild follows those dynamic imports during bundling. Those UI components
 * may import `.scss`, `.wasm`, or other non-JS files that esbuild cannot
 * process without a loader.
 *
 * This plugin intercepts the following asset types and returns an empty module
 * stub, which is safe because the main process never uses these assets:
 *
 * - `.css`, `.scss` — CSS Modules (`styles.foo` → `undefined`, harmless)
 * - `.wasm`, `.wasm?binary` — WebAssembly binaries (e.g. tree-sitter from
 *   `@google/gemini-cli-core`) that are only loaded in the renderer or CLI
 *
 * @example
 * ```ts
 * await build({
 *   extensions: [stubAssetsPlugin()],
 *   // ...
 * });
 * ```
 * @packageDocumentation
 */

import type { Plugin } from 'esbuild';

/**
 * Create an esbuild plugin that replaces browser-only asset imports with empty
 * module stubs in the main process bundle.
 *
 * This is safe because the main process never renders UI or executes WASM
 * binaries — these assets are unused transitive dependencies of plugin and
 * adapter packages reachable from the main-process bundle.
 * @returns esbuild {@link Plugin}.
 */
export function stubAssetsPlugin(): Plugin {
  return {
    name: 'stub-assets',
    setup(build) {
      // CSS Modules and plain stylesheets — return empty CSS modules object.
      build.onLoad({ filter: /\.(css|scss)$/ }, () => ({
        contents: 'export default {};',
        loader: 'js',
      }));

      // WebAssembly binaries (including Vite-style ?binary query params).
      // The `filter` matches the path component; `?binary` suffix appears
      // as part of the resolved path esbuild passes to onLoad.
      build.onLoad({ filter: /\.wasm(\?.*)?$/ }, () => ({
        contents: 'export default null;',
        loader: 'js',
      }));
    },
  };
}
