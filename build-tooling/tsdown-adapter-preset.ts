import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'rolldown';
import type { UserConfig } from 'tsdown';
import { defineConfig } from 'tsdown';
import {
  rewriteFrameworkImportSpecifier,
  rewriteFrameworkImportsInText,
} from '@makaio/build-tooling/framework-import-map';
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
 * Recursively rewrites framework-owned import specifiers in `.d.mts` and `.d.ts`
 * files. Necessary because rolldown-plugin-dts does not honor `resolveId`.
 * @param dir - Output directory to scan.
 */
function rewriteDtsFiles(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      rewriteDtsFiles(fullPath);
    } else if (entry.name.endsWith('.d.mts') || entry.name.endsWith('.d.ts')) {
      const content = readFileSync(fullPath, 'utf8');
      const rewritten = rewriteFrameworkImportsInText(content);
      if (rewritten !== content) {
        writeFileSync(fullPath, rewritten);
      }
    }
  }
}

/**
 * Rolldown plugin that externalizes framework-owned packages (rewriting to
 * `@makaio/framework/<subpath>`) and additional vendor dependencies.
 *
 * Post-processes declaration files to apply the same import rewrites, since
 * rolldown-plugin-dts does not honor `resolveId`.
 * @param extra - Additional exact matches or regex patterns to externalize.
 * @returns Rolldown plugin.
 */
function adapterExternals(extra: ReadonlyArray<string | RegExp> = []): Plugin {
  return {
    name: 'adapter-externals',
    resolveId(source) {
      const rewritten = rewriteFrameworkImportSpecifier(source);
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
    writeBundle(options) {
      const dir = options.dir;
      if (!dir) return;
      rewriteDtsFiles(dir);
    },
  };
}

/**
 * Whether adapter DTS generation is disabled via environment variable.
 * Set `MAKAIO_SKIP_ADAPTER_DTS=true` to skip expensive eager declaration
 * generation in CI environments where only runtime JS validation is needed.
 */
const skipAdapterDts = process.env['MAKAIO_SKIP_ADAPTER_DTS'] === 'true';

/**
 * Base tsdown preset for adapter implementation packages.
 *
 * Externalizes all framework-owned workspace packages (rewriting specifiers to
 * `@makaio/framework/<subpath>`) while bundling remaining `@makaio/*` workspace
 * packages. Generates TypeScript declarations with post-processed import
 * rewrites.
 *
 * Unlike the extension preset, adapter builds:
 * - Target Node.js only (`platform: 'node'`)
 * - Generate declarations from the full adapter tsconfig graph
 * - Skip minification (adapters are bundled into the host app)
 *
 * Declaration generation can be disabled via `MAKAIO_SKIP_ADAPTER_DTS=true`
 * for CI environments that only need runtime JS validation.
 */
export const adapterPreset = {
  ...packageManifestSourcePolicy,
  format: 'esm',
  platform: 'node',
  dts: skipAdapterDts ? false : { eager: true },
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
  const { entry = ['./src/index.ts'], external = [], needsCreateRequire = false, banner: customBanner } = options;

  const bannerParts: string[] = [];
  if (needsCreateRequire) bannerParts.push(CREATE_REQUIRE_BANNER);
  if (customBanner) bannerParts.push(customBanner);

  return defineConfig({
    ...adapterPreset,
    entry,
    plugins: [adapterExternals(external)],
    ...(bannerParts.length > 0 ? { banner: { js: bannerParts.join('\n') } } : {}),
  });
}
