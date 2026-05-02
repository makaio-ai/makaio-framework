/**
 * Public API for the binary install strategy subsystem.
 *
 * Exports:
 * - Shared types ({@link InstallStrategy}, {@link InstallArtifact},
 *   {@link StrategyDependencies}, {@link StrategyProgressCallback}).
 * - Concrete strategy classes for direct use or testing.
 * - {@link createStrategy} factory to instantiate the correct strategy from a
 *   {@link ManagedInstallDescriptor} without exhaustive type-narrowing at the
 *   call site.
 * @packageDocumentation
 */

export { assertJsonObject, makeDownloadProgressAdapter } from './types.js';
export type { InstallArtifact, InstallStrategy, StrategyDependencies, StrategyProgressCallback } from './types.js';

export { GithubReleaseStrategy } from './github-release-strategy.js';
export { ManifestBucketStrategy } from './manifest-bucket-strategy.js';
export { NpmStrategy } from './npm-strategy.js';

import { ManagedInstallDescriptorSchema, type ManagedInstallDescriptor } from '@makaio/contracts/client';
import { GithubReleaseStrategy } from './github-release-strategy.js';
import { ManifestBucketStrategy } from './manifest-bucket-strategy.js';
import { NpmStrategy } from './npm-strategy.js';
import type { InstallStrategy, StrategyDependencies } from './types.js';

/**
 * Instantiate the appropriate {@link InstallStrategy} for the given descriptor.
 *
 * The factory validates the descriptor and then performs exhaustive narrowing
 * over the `type` discriminant so callers do not need to repeat the switch
 * logic.
 * @param descriptor - The managed install descriptor from a
 *   {@link ClientDefinition}, or an unvalidated runtime value with a `type`
 *   field.
 * @param deps - Injected I/O dependencies forwarded to the chosen strategy.
 * @returns A ready-to-use {@link InstallStrategy} instance, or `undefined`
 *   when an unvalidated runtime descriptor is not supported.
 */
export function createStrategy(
  descriptor: ManagedInstallDescriptor,
  deps: StrategyDependencies,
): InstallStrategy | undefined;
export function createStrategy(
  descriptor: { readonly type: string },
  deps: StrategyDependencies,
): InstallStrategy | undefined;
export function createStrategy(
  descriptor: ManagedInstallDescriptor | { readonly type: string },
  deps: StrategyDependencies,
): InstallStrategy | undefined {
  const parsed = ManagedInstallDescriptorSchema.safeParse(descriptor);
  if (!parsed.success) {
    return undefined;
  }

  switch (parsed.data.type) {
    case 'manifest-bucket':
      return new ManifestBucketStrategy(parsed.data, deps);
    case 'npm':
      return new NpmStrategy(parsed.data, deps);
    case 'github-release':
      return new GithubReleaseStrategy(parsed.data, deps);
  }
}
