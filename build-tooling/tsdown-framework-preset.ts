import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'rolldown';
import type { UserConfig } from 'tsdown';
import {
  rewriteFrameworkImportSpecifier,
  rewriteFrameworkImportsInText,
} from '@makaio/build-tooling/framework-import-map';

/**
 * Rolldown plugin that externalizes all framework-owned workspace packages and
 * rewrites their import specifiers to `@makaio/framework/<subpath>`.
 *
 * This preserves framework singleton instances (e.g. `MakaioBus`) across all
 * subpath entries of the `@makaio/framework` package by ensuring every entry
 * imports from the same module via Node.js self-referencing package imports.
 *
 * The `resolveId` hook handles JS output rewriting. Since rolldown-plugin-dts
 * does not honor `resolveId`, a `writeBundle` hook post-processes `.d.mts`
 * and `.d.ts` declaration files to apply the same rewrites.
 * @returns Rolldown plugin
 */
export function frameworkExternals(): Plugin {
  return {
    name: 'framework-externals',
    resolveId(source) {
      const rewritten = rewriteFrameworkImportSpecifier(source);
      if (!rewritten) return null;
      return { id: rewritten, external: true };
    },
    writeBundle(options) {
      const dir = options.dir;
      if (!dir) return;
      rewriteDtsFiles(dir);
    },
  };
}

/**
 * Walk a directory and rewrite all framework-owned workspace package specifiers
 * to their `@makaio/framework/<subpath>` equivalents in every `.d.mts` and
 * `.d.ts` declaration file found.
 *
 * rolldown-plugin-dts does not invoke `resolveId`, so this post-processor
 * ensures declaration output is consistent with JS output.
 * @param dir - The output directory to scan recursively.
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
 * Regex that matches all `@makaio/*` workspace packages for bundling.
 *
 * Used by both {@link frameworkPreset} and {@link extensionPreset} to inline
 * workspace packages into the output bundle.
 *
 * Framework-owned public packages (e.g. `@makaio/bus-core`) are externalized
 * and rewritten to their stable `@makaio/framework/<subpath>` form by the
 * {@link frameworkExternals} plugin's `resolveId` hook, which runs before the
 * bundler evaluates this pattern. The pattern therefore safely catches all
 * remaining `@makaio/*` packages for bundling.
 */
export const MAKAIO_BUNDLE_PATTERN = /^@makaio\//;
export const VITEST_BUNDLE_PATTERN = /^@vitest(?:$|\/)/;

export type PackageManifestSourcePolicy = Pick<Partial<UserConfig>, 'exports' | 'checks'>;

export type DependencyDiagnosticPolicy = NonNullable<Partial<UserConfig>['deps']>;

export const packageManifestSourcePolicy = {
  exports: false,
  checks: {
    pluginTimings: false,
  },
} satisfies PackageManifestSourcePolicy;

export const dependencyDiagnosticPolicy = {
  onlyBundle: false,
} satisfies DependencyDiagnosticPolicy;

/**
 * Shared tsdown configuration for all `@makaio/framework` subpath packages.
 *
 * - Externalizes all framework-owned workspace packages and rewrites their
 *   specifiers to `@makaio/framework/<subpath>` (preserves singletons)
 * - Inlines remaining `@makaio/*` workspace deps via tsconfig path resolution
 * - Keeps Vitest external so testing helpers do not bundle the test runner
 * - Defines dependency policy through always/never bundle rules rather than
 *   maintaining a brittle per-package transitive allowlist
 * - Leaves package manifests untouched; package.json exports are source-of-truth
 * @remarks
 * bus-core itself does NOT use this preset — it uses `frameworkBusPreset` instead,
 * which inlines all `@makaio/*` deps (bus-core has no singleton dependency on itself).
 */
export const frameworkPreset = {
  ...packageManifestSourcePolicy,
  format: 'esm',
  dts: true,
  minify: true,
  deps: {
    ...dependencyDiagnosticPolicy,
    alwaysBundle: [MAKAIO_BUNDLE_PATTERN],
    neverBundle: ['vitest', VITEST_BUNDLE_PATTERN],
  },
  plugins: [frameworkExternals()],
} satisfies Partial<UserConfig>;

/**
 * Extended tsdown preset for `@makaio/framework` UI packages that use React/JSX.
 *
 * Extends {@link frameworkPreset} by marking React as never-bundled so it is not
 * included in the framework distribution. Consumers are expected to provide their
 * own React installation.
 */
export const frameworkReactPreset = {
  ...frameworkPreset,
  deps: {
    ...frameworkPreset.deps,
    // String matches are exact package names. No ui-* package imports
    // react-dom subpaths (e.g. react-dom/client) — if that changes, switch
    // 'react-dom' to /^react-dom(?:\/.*)?$/.
    neverBundle: [...frameworkPreset.deps.neverBundle, 'react', 'react-dom', 'react/jsx-runtime'],
  },
} satisfies Partial<UserConfig>;

/**
 * tsdown preset for `@makaio/bus-core` itself.
 *
 * Inlines all `@makaio/*` deps (only `@makaio/core`) with no external rewrites,
 * since bus-core IS the singleton root.
 */
export const frameworkBusPreset = {
  ...packageManifestSourcePolicy,
  format: 'esm',
  dts: true,
  minify: true,
  deps: {
    ...dependencyDiagnosticPolicy,
    alwaysBundle: [MAKAIO_BUNDLE_PATTERN],
  },
} satisfies Partial<UserConfig>;
