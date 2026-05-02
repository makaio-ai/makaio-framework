/**
 * Shared test fixtures for host-shared tests.
 */

import { WindowRegistry } from '@makaio/kernel';

/**
 * Build a registry pre-populated with generic test windows for test coverage.
 *
 * Uses framework-neutral window IDs so tests remain independent of any
 * host identity. The registered windows mirror the structural diversity of
 * real package manifests (singletons, non-singletons, varied styles).
 * @returns A WindowRegistry with generic test window registrations.
 */
export function buildTestRegistry(): WindowRegistry {
  const registry = new WindowRegistry();
  registry.register('framework-shell', 'Framework Shell', { id: 'main', style: 'utility', singleton: true });
  registry.register('test-app.dashboard', 'Dashboard', { id: 'main', style: 'utility', singleton: true });
  registry.register('test-app.editor', 'Editor', { id: 'main', style: 'utility' });
  registry.register('test-app.monitor', 'Monitor', { id: 'main', style: 'utility', singleton: true });
  registry.register('test-app.manager', 'Manager', { id: 'main', style: 'utility', singleton: true });
  return registry;
}
