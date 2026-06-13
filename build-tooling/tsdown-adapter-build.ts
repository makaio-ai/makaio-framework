/**
 * Shared tsdown build pipeline for adapter implementation packages.
 * @packageDocumentation
 */

import { build } from 'tsdown';
import { defineAdapterConfig, type AdapterPresetOptions } from '@makaio/build-tooling/tsdown-adapter-preset';

/**
 * Options for {@link buildAdapterPackage}.
 */
export type BuildAdapterPackageOptions = AdapterPresetOptions;

/**
 * Build an adapter implementation package.
 *
 * Adapter implementation packages use the adapter preset's bundled
 * declarations so their published `.d.mts` files do not expose workspace-only
 * helper packages to consumers.
 * @param options - Adapter package build options.
 */
export async function buildAdapterPackage(options: BuildAdapterPackageOptions = {}): Promise<void> {
  await build(defineAdapterConfig(options));
}
