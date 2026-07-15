import type { Plugin } from 'rolldown';
import type { UserConfig } from 'tsdown';
import { defineConfig } from 'tsdown';
import { rewriteFrameworkImportSpecifier } from '@makaio/build-tooling/framework-import-map';
import {
  dependencyDiagnosticPolicy,
  MAKAIO_BUNDLE_PATTERN,
  packageManifestSourcePolicy,
} from '@makaio/build-tooling/tsdown-framework-preset';

/**
 * Options for {@link defineAdapterConfig}.
 */
export interface AdapterPresetOptions {
  /**
   * Entry points for the adapter bundle.
   * Defaults to `['./src/index.ts']`.
   */
  readonly entry?: string | string[] | Record<string, string>;
  /**
   * Additional packages or patterns to externalize.
   *
   * Use this for vendor SDK dependencies that should remain external
   * (e.g. `openai`, `/^@anthropic-ai\//`).
   */
  readonly external?: ReadonlyArray<string | RegExp>;
  /**
   * Framework-facade packages that must remain bundled into this adapter's
   * JavaScript output.
   *
   * Their declaration imports are still rewritten to the stable framework
   * subpath by the tsgo post-processing step. Use this only for implementation
   * helpers that are part of the framework type surface but not runtime
   * dependencies of the standalone adapter.
   */
  readonly bundledFrameworkPackages?: ReadonlyArray<string>;
  /**
   * Whether the adapter has CJS dependencies that need `createRequire`.
   * When true, prepends the createRequire banner to the output.
   */
  readonly needsCreateRequire?: boolean;
  /**
   * Additional banner code to prepend to the output.
   */
  readonly banner?: string;
}

const CREATE_REQUIRE_BANNER = "import { createRequire } from 'module'; const require = createRequire(import.meta.url);";

/**
 * Rolldown plugin that externalizes framework-owned packages (rewriting to
 * `@makaio/framework/<subpath>`) and additional vendor dependencies.
 * @param extra - Additional exact matches or regex patterns to externalize.
 * @param bundledFrameworkPackages - Framework packages that must stay in the adapter JavaScript bundle.
 * @returns Rolldown plugin.
 */
export function adapterExternals(
  extra: ReadonlyArray<string | RegExp> = [],
  bundledFrameworkPackages: ReadonlyArray<string> = [],
): Plugin {
  const bundled = new Set(bundledFrameworkPackages);
  return {
    name: 'adapter-externals',
    resolveId(source) {
      const bundledFrameworkPackage = [...bundled].some(
        (packageName) => source === packageName || source.startsWith(`${packageName}/`),
      );
      const rewritten = bundledFrameworkPackage ? undefined : rewriteFrameworkImportSpecifier(source);
      if (rewritten) return { id: rewritten, external: true };

      for (const pattern of extra) {
        if (typeof pattern === 'string') {
          if (source === pattern || source.startsWith(`${pattern}/`)) {
            return { id: source, external: true };
          }
        } else {
          pattern.lastIndex = 0;
          if (pattern.test(source)) return { id: source, external: true };
        }
      }

      return null;
    },
  };
}

/**
 * Base tsdown preset for adapter implementation packages.
 *
 * Externalizes all framework-owned workspace packages (rewriting specifiers to
 * `@makaio/framework/<subpath>`) while bundling remaining `@makaio/*` workspace
 * packages. Declaration emit is handled separately via tsgo (see
 * `@makaio/build-tooling/tsgo-declarations`).
 *
 * Unlike the extension preset, adapter builds:
 * - Target Node.js only (`platform: 'node'`)
 * - Skip minification (adapters are bundled into the host app)
 */
export const adapterPreset = {
  ...packageManifestSourcePolicy,
  format: 'esm',
  platform: 'node',
  dts: false,
  minify: false,
  deps: {
    ...dependencyDiagnosticPolicy,
    alwaysBundle: [MAKAIO_BUNDLE_PATTERN],
  },
  plugins: [adapterExternals()],
} satisfies Partial<UserConfig>;

/**
 * Build a tsdown config for an adapter implementation package.
 * @param options - Adapter build options.
 * @returns Complete tsdown config.
 */
export function defineAdapterConfig(options: AdapterPresetOptions = {}): UserConfig {
  const {
    entry = ['./src/index.ts'],
    external = [],
    bundledFrameworkPackages = [],
    needsCreateRequire = false,
    banner: customBanner,
  } = options;

  const bannerParts: string[] = [];
  if (needsCreateRequire) bannerParts.push(CREATE_REQUIRE_BANNER);
  if (customBanner) bannerParts.push(customBanner);

  return defineConfig({
    ...adapterPreset,
    entry,
    plugins: [adapterExternals(external, bundledFrameworkPackages)],
    ...(bannerParts.length > 0 ? { banner: { js: bannerParts.join('\n') } } : {}),
  });
}
