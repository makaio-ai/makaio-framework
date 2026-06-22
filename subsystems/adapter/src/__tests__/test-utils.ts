import type { ExtensionCoordinator } from '@makaio/kernel';
import type { PlatformDefaults } from '../adapter-runtime-lifecycle.js';

/**
 * Options for the minimal stub coordinator.
 */
export interface StubCoordinatorOptions {
  /**
   * Provider definition IDs the stub reports as loaded.
   *
   * When omitted, defaults to an empty set — effectively treating all
   * provider IDs as uninstalled. Tests exercising deferred initialization
   * must supply the provider IDs that should appear "loaded but not yet
   * active" so the deferred init path waits for them.
   */
  readonly loadedProviderDefinitionIds?: ReadonlySet<string>;
}

/**
 * Create a minimal stub coordinator for unit tests.
 *
 * Only implements the methods required by `AdapterSubsystemService`:
 * - `registerContributionProcessor` — returns a no-op unregister function
 * - `getLoadedProviderDefinitionIds` — returns the supplied set (or empty)
 *
 * Tests that need full coordinator behavior should use an integration test
 * harness instead.
 * @param options - Optional configuration for the stub.
 * @returns Minimal coordinator stub satisfying the service contract.
 */
export function createStubCoordinator(options?: StubCoordinatorOptions): ExtensionCoordinator {
  const loadedProviderIds = options?.loadedProviderDefinitionIds ?? new Set<string>();
  return {
    registerContributionProcessor: () => () => undefined,
    getLoadedProviderDefinitionIds: () => loadedProviderIds,
  } as unknown as ExtensionCoordinator;
}

/**
 * Minimal platform defaults for unit tests.
 *
 * Provides empty env and no cwd so adapter factory calls can be tested
 * without a real platform context.
 */
export const TEST_PLATFORM_DEFAULTS: PlatformDefaults = {};

/**
 * Test machine identifier used for deterministic adapter ID derivation.
 */
export const TEST_MACHINE_ID = 'test-machine-id';
