/**
 * Shared two-step build pipeline for adapter implementation packages.
 *
 * Step 1: tsdown bundles JS (with `dts: false`).
 * Step 2: tsgo emits per-file declarations and rewrites framework imports.
 * @packageDocumentation
 */

import { build } from 'tsdown';
import { defineAdapterConfig, type AdapterPresetOptions } from '@makaio/build-tooling/tsdown-adapter-preset';
import { emitDeclarations } from '@makaio/build-tooling/tsgo-declarations';

/**
 * Options for {@link buildAdapterPackage}.
 */
export interface BuildAdapterPackageOptions extends AdapterPresetOptions {
  /**
   * Absolute path to the package directory.
   * Required for tsgo declaration emit.
   */
  readonly packageDir: string;
}

/**
 * Build an adapter implementation package.
 *
 * Runs tsdown for JS bundling (with `dts: false`), then emits declarations
 * via tsgo and rewrites framework imports in the output.
 * @param options - Adapter package build options.
 */
export async function buildAdapterPackage(options: BuildAdapterPackageOptions): Promise<void> {
  const { packageDir, ...presetOptions } = options;
  const start = performance.now();

  console.info('[build] Bundling JS via tsdown…');
  await build(defineAdapterConfig(presetOptions));

  emitDeclarations({ packageDir });

  const elapsed = ((performance.now() - start) / 1000).toFixed(1);
  console.info(`[build] Done in ${elapsed}s`);
}

export { defineAdapterConfig, type AdapterPresetOptions };
