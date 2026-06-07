/**
 * Vite plugin that injects an ES import map into the shell HTML at build time.
 *
 * Extension browser bundles contain bare specifiers (`react`,
 * `@makaio/ui-kernel`) that the browser cannot resolve from a dynamic
 * `import()` without an import map. This plugin generates the map from the
 * shell's Rollup bundle and injects it as a `<script type="importmap">` tag
 * into the shell HTML.
 *
 * No-op in dev mode - Vite resolves bare specifiers natively via its own
 * transform pipeline.
 * @packageDocumentation
 */

import type { Plugin } from 'vite';
import {
  SHARED_BROWSER_EXTERNALS,
  toSharedBrowserExternalEntryName,
} from '../../build-tooling/browser-shared-externals.js';
import { generateImportMapFromBundle } from './generate-import-map.js';

type RollupInput = string | readonly string[] | Record<string, string>;

const VIRTUAL_FACADE_PREFIX = '\0makaio-shared-facade:';

/**
 * CJS shared externals that need a virtual ESM facade so that Rolldown
 * emits named exports instead of a default-only CJS wrapper.
 *
 * Each entry maps a bare specifier to the named exports that extension
 * browser bundles expect to import by name.
 */
const CJS_SHARED_FACADES: ReadonlyMap<string, readonly string[]> = new Map([
  [
    'react',
    [
      'createElement',
      'createContext',
      'createRef',
      'Component',
      'useCallback',
      'useContext',
      'useDebugValue',
      'useEffect',
      'useId',
      'useLayoutEffect',
      'useMemo',
      'useReducer',
      'useRef',
      'useState',
      'useSyncExternalStore',
      'useTransition',
      'forwardRef',
      'memo',
      'lazy',
      'StrictMode',
      'Suspense',
      'Fragment',
      'Children',
      'cloneElement',
      'isValidElement',
      'startTransition',
    ],
  ],
  ['react-dom', ['createPortal', 'flushSync']],
  ['react/jsx-runtime', ['jsx', 'jsxs', 'Fragment']],
]);

const SHARED_BROWSER_INPUTS: Record<string, string> = Object.fromEntries(
  SHARED_BROWSER_EXTERNALS.map((specifier) => {
    const entryName = toSharedBrowserExternalEntryName(specifier);
    return [entryName, CJS_SHARED_FACADES.has(specifier) ? `${VIRTUAL_FACADE_PREFIX}${specifier}` : specifier];
  }),
);

/**
 * Merge host application inputs with shared browser facade entries.
 *
 * The import map must point to modules that actually export the shared
 * specifiers. Relying on opportunistic vendor chunks is not enough because
 * those chunks can have no facade module or implementation-shaped exports.
 * @param input - Existing Rollup input config from the host app.
 * @returns Rollup input config including shared browser facade entries.
 */
function mergeSharedBrowserInputs(input: RollupInput | undefined): Record<string, string> {
  if (input === undefined) return { ...SHARED_BROWSER_INPUTS };
  if (typeof input === 'string') return { main: input, ...SHARED_BROWSER_INPUTS };
  if (Array.isArray(input)) {
    const entries = Object.fromEntries(input.map((entry, index) => [`entry${index}`, entry]));
    return { ...entries, ...SHARED_BROWSER_INPUTS };
  }
  const namedInputs = input as Record<string, string>;
  return { ...namedInputs, ...SHARED_BROWSER_INPUTS };
}

/**
 * Vite plugin that injects an ES import map into the shell HTML at build time.
 *
 * Required for extension browser bundles that contain bare specifiers
 * (`react`, `@makaio/ui-kernel`) which the browser cannot resolve from a
 * dynamic `import()`. The import map maps these to the shell's bundled chunks.
 *
 * No-op in dev mode - Vite resolves bare specifiers natively.
 * @returns Vite plugin instance.
 */
export function viteImportMapPlugin(): Plugin {
  let importMapJson: string | undefined;
  let basePath = '/';

  return {
    name: 'makaio:import-map',
    apply: 'build',

    config(config) {
      const input = config.build?.rollupOptions?.input as RollupInput | undefined;
      return {
        build: {
          rollupOptions: {
            input: mergeSharedBrowserInputs(input),
            preserveEntrySignatures: 'exports-only',
          },
        },
      };
    },

    resolveId(source) {
      if (source.startsWith(VIRTUAL_FACADE_PREFIX)) return source;
      return undefined;
    },

    load(id) {
      if (!id.startsWith(VIRTUAL_FACADE_PREFIX)) return undefined;
      const specifier = id.slice(VIRTUAL_FACADE_PREFIX.length);
      const exports = CJS_SHARED_FACADES.get(specifier);
      if (!exports) return undefined;
      return `import _cjs_default from ${JSON.stringify(specifier)};\nexport const { ${exports.join(', ')} } = _cjs_default;\nexport default _cjs_default;\n`;
    },

    configResolved(config) {
      basePath = config.base ?? '/';
    },

    generateBundle(_options, bundle) {
      const importMap = generateImportMapFromBundle(bundle, basePath);
      importMapJson = JSON.stringify(importMap);
    },

    transformIndexHtml: {
      order: 'post',
      handler(html) {
        if (!importMapJson) return html;
        return {
          html,
          tags: [
            {
              tag: 'script',
              attrs: { type: 'importmap' },
              children: importMapJson,
              injectTo: 'head-prepend' as const,
            },
          ],
        };
      },
    },
  };
}
