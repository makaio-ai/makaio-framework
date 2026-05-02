/**
 * Bun build plugin that stubs out non-JavaScript assets in the main process bundle.
 *
 * The Electrobun main process bundle is Bun/Node.js code — it never executes
 * style sheets, WebAssembly binary assets, or other browser-only assets. Plugin
 * and adapter packages import UI components via lazy `() => import(...)`, and
 * Bun follows those dynamic imports during bundling. Those UI components may
 * import `.scss`, `.wasm`, or other non-JS files that Bun cannot process without
 * a loader.
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
 * await Bun.build({
 *   extensions: [stubAssetsPlugin()],
 *   // ...
 * });
 * ```
 * @packageDocumentation
 */

import type { BunPlugin } from 'bun';

/**
 * Create a Bun build plugin that replaces browser-only asset imports with empty
 * module stubs in the main process bundle.
 *
 * This is safe because the main process never renders UI or executes WASM
 * binaries — these assets are unused transitive dependencies of plugin and
 * adapter packages reachable from the main-process bundle.
 * @returns Bun {@link BunPlugin}.
 */
export function stubAssetsPlugin(): BunPlugin {
  return {
    name: 'stub-assets',
    setup(build) {
      // CSS Modules and plain stylesheets — return empty CSS modules object.
      build.onLoad({ filter: /\.(css|scss)$/ }, () => ({
        contents: 'export default {};',
        loader: 'js',
      }));

      // WebAssembly binaries — resolve uninstalled WASM specifiers (e.g.
      // `web-tree-sitter/tree-sitter.wasm?binary` from transitive deps)
      // to a virtual namespace so the onLoad handler below can stub them.
      build.onResolve({ filter: /\.wasm(\?.*)?$/ }, (args) => ({
        path: args.path,
        namespace: 'stub-wasm',
      }));

      build.onLoad({ filter: /\.wasm(\?.*)?$/, namespace: 'stub-wasm' }, () => ({
        contents: 'export default null;',
        loader: 'js',
      }));
    },
  };
}
