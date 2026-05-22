import type { ExtensionCoordinator } from '@makaio/kernel';
import type { PlatformDefaults } from '../adapter-runtime-lifecycle.js';

/**
 * Create a minimal stub coordinator for unit tests.
 *
 * Only implements the methods required by `AdapterSubsystemService`:
 * - `registerContributionProcessor` — returns a no-op unregister function
 *
 * Tests that need full coordinator behavior should use an integration test
 * harness instead.
 * @returns Minimal coordinator stub satisfying the service contract.
 */
export function createStubCoordinator(): ExtensionCoordinator {
  return {
    registerContributionProcessor: () => () => undefined,
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
