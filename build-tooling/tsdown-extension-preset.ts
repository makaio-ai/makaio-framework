import type { Plugin } from 'rolldown';
import type { UserConfig } from 'tsdown';
import { defineConfig } from 'tsdown';
import { SHARED_BROWSER_EXTERNALS } from '@makaio/build-tooling/browser-shared-externals';
import { rewriteFrameworkImportSpecifier } from '@makaio/build-tooling/framework-import-map';
import {
  dependencyDiagnosticPolicy,
  MAKAIO_BUNDLE_PATTERN,
  packageManifestSourcePolicy,
} from '@makaio/build-tooling/tsdown-framework-preset';

/**
 * Options for {@link defineExtensionConfig}.
 */
export interface ExtensionPresetOptions {
  /**
   * Entry points for the extension bundle.
   * Passed directly to tsdown `entry`.
   * Defaults to `['./src/index.ts']`.
   */
  readonly entry?: string | string[] | Record<string, string>;
  /**
   * Native Node addons to externalize rather than bundle.
   *
   * These packages ship precompiled `.node` binaries and must stay external.
   */
  readonly nativeModules?: string[];
  /**
   * Additional packages or patterns to externalize.
   *
   * Use this for heavy optional runtime dependencies that should remain host
   * resolved instead of being inlined into the extension bundle.
   */
  readonly external?: ReadonlyArray<string | RegExp>;
}

/**
 * Rolldown plugin that externalizes host-owned extension dependencies.
 *
 * Extensions must share the host's browser/runtime singletons, so this plugin
 * externalizes all framework-owned workspace packages (rewriting their
 * specifiers to `@makaio/framework/<subpath>`), the canonical shared browser
 * dependency contract, native modules, and any additional caller-supplied
 * patterns.
 * @param nativeModules - Exact native addon packages to externalize.
 * @param extra - Additional exact matches or regex patterns to externalize.
 * @returns Rolldown plugin.
 */
function extensionExternals(
  nativeModules: ReadonlyArray<string> = [],
  extra: ReadonlyArray<string | RegExp> = [],
): Plugin {
  const exactExternals = new Set<string>([...SHARED_BROWSER_EXTERNALS, ...nativeModules]);

  return {
    name: 'extension-externals',
    resolveId(source) {
      // Shared browser externals and native modules keep their original
      // specifier — the browser host resolves them by that name. Check
      // these before framework import rewriting so @makaio/ui-* packages
      // are not accidentally rewritten to @makaio/framework/ui-*.
      if (exactExternals.has(source)) return { id: source, external: true };
      const rewritten = rewriteFrameworkImportSpecifier(source);
      if (rewritten) return { id: rewritten, external: true };

      for (const pattern of extra) {
        if (typeof pattern === 'string') {
          if (source === pattern) return { id: source, external: true };
        } else {
          // Reset lastIndex before each test so callers who accidentally
          // pass a /g or /y regex do not get alternating true/false results
          // across successive resolveId calls during the same build.
          pattern.lastIndex = 0;
          if (pattern.test(source)) return { id: source, external: true };
        }
      }

      return null;
    },
  };
}

/**
 * Base tsdown preset for standalone extension bundles.
 *
 * Externalizes all framework-owned workspace packages (rewriting specifiers to
 * `@makaio/framework/<subpath>`) and the shared browser dependency contract,
 * while bundling all remaining `@makaio/*` workspace packages.
 * Dependency policy is owned by explicit always/external rules rather than a
 * brittle transitive allowlist for every extension build.
 * Package manifests remain authored metadata; builds must not rewrite them.
 */
export const extensionPreset = {
  ...packageManifestSourcePolicy,
  format: 'esm',
  dts: false,
  minify: true,
  deps: {
    ...dependencyDiagnosticPolicy,
    alwaysBundle: [MAKAIO_BUNDLE_PATTERN],
  },
  plugins: [extensionExternals()],
} satisfies Partial<UserConfig>;

/**
 * Build a tsdown config for a standalone extension.
 * @param options - Extension build options.
 * @returns Complete tsdown config.
 */
export function defineExtensionConfig(options: ExtensionPresetOptions = {}): UserConfig {
  const { entry = ['./src/index.ts'], nativeModules = [], external = [] } = options;

  // extensions is intentionally overridden rather than merged — the preset's
  // zero-arg default plugin has no native modules or extras, so callers who
  // need those must replace the entire plugin array. This mirrors how
  // frameworkPreset + frameworkExternals work in the same file.
  return defineConfig({
    ...extensionPreset,
    entry,
    plugins: [extensionExternals(nativeModules, external)],
  });
}
