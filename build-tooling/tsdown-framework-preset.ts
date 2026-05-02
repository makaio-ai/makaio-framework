import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'rolldown';
import type { UserConfig } from 'tsdown';

/**
 * Rolldown plugin that externalizes `@makaio/bus-core` and rewrites
 * the import specifier to `@makaio/framework/bus`.
 *
 * This preserves the MakaioBus singleton across all subpath entries
 * of the `@makaio/framework` package by ensuring every entry imports
 * from the same module (via Node.js self-referencing package imports).
 *
 * The `resolveId` hook handles JS output rewriting. Since rolldown-plugin-dts
 * does not honor `resolveId`, a `writeBundle` hook post-processes `.d.mts`
 * files to apply the same rewrite.
 * @returns Rolldown plugin
 */
export function frameworkExternals(): Plugin {
  return {
    name: 'framework-externals',
    resolveId(source) {
      if (source === '@makaio/bus-core') {
        return { id: '@makaio/framework/bus', external: true };
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
 * Walk a directory and rewrite `@makaio/bus-core` → `@makaio/framework/bus`
 * in all `.d.mts` and `.d.ts` declaration files.
 * @param dir - The output directory to scan
 */
function rewriteDtsFiles(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      rewriteDtsFiles(fullPath);
    } else if (entry.name.endsWith('.d.mts') || entry.name.endsWith('.d.ts')) {
      const content = readFileSync(fullPath, 'utf8');
      if (content.includes('@makaio/bus-core')) {
        writeFileSync(fullPath, content.replaceAll('@makaio/bus-core', '@makaio/framework/bus'));
      }
    }
  }
}

/**
 * Regex that matches all `@makaio/*` workspace packages except `@makaio/bus-core`
 * and any `@makaio/bus-core/*` subpath imports.
 *
 * Used by both {@link frameworkPreset} and {@link extensionPreset} to inline
 * workspace packages into the output bundle. `bus-core` is excluded because it
 * owns the `MakaioBus` singleton; duplicating it would create a disconnected bus.
 */
export const MAKAIO_BUNDLE_PATTERN = /^@makaio\/(?!bus-core(?:$|\/))/;
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
 * - Externalizes `@makaio/bus-core` → `@makaio/framework/bus` (singleton)
 * - Inlines all other `@makaio/*` workspace deps via tsconfig path resolution
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
    alwaysBundle: [/^@makaio\//],
  },
} satisfies Partial<UserConfig>;
