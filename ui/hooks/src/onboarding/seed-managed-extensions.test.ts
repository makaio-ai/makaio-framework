import { describe, expect, it } from 'vitest';
import type { ExtensionInfo } from '@makaio/kernel';
import { seedManagedExtensions } from './seed-managed-extensions.js';

/**
 * Build a minimal extension record for `seedManagedExtensions` fixtures.
 * @param overrides - Partial extension fields for the fixture.
 * @returns Extension info fixture.
 */
function makeExtensionInfo(overrides: Partial<ExtensionInfo> = {}): ExtensionInfo {
  return {
    critical: false,
    displayName: 'Example Extension',
    enabled: true,
    extensionManaged: true,
    name: 'example-extension',
    state: 'active',
    ...overrides,
  };
}

describe('seedManagedExtensions', () => {
  it('excludes a non-extension-managed entry from the managed list and its seed', () => {
    const managedEntry = makeExtensionInfo({ name: 'routine' });
    const frameworkEntry = makeExtensionInfo({
      name: 'canonical-model',
      extensionManaged: false,
      persistedEnabled: undefined,
    });

    const { managed, initialDisables } = seedManagedExtensions([managedEntry, frameworkEntry]);

    expect(managed).toEqual([managedEntry]);
    expect(initialDisables.has('canonical-model')).toBe(false);
  });

  it('seeds a durable disable for a managed, non-critical extension', () => {
    const entry = makeExtensionInfo({ name: 'github', enabled: true, persistedEnabled: false });

    const { managed, initialDisables } = seedManagedExtensions([entry]);

    expect(managed).toEqual([entry]);
    expect(initialDisables.get('github')).toBe(false);
  });

  it('does not seed a durable disable for a critical extension, even when persistedEnabled is false', () => {
    // Boot already overrides a hand-edited disable back to enabled for a
    // critical extension — seeding it here would show a locked-off toggle
    // that contradicts the running system.
    const entry = makeExtensionInfo({
      name: 'typeview',
      critical: true,
      enabled: true,
      persistedEnabled: false,
    });

    const { managed, initialDisables } = seedManagedExtensions([entry]);

    expect(managed).toEqual([entry]);
    expect(initialDisables.has('typeview')).toBe(false);
  });

  it('does not seed an extension with no durable disable on record', () => {
    const entry = makeExtensionInfo({ name: 'artifacts', persistedEnabled: undefined });

    const { initialDisables } = seedManagedExtensions([entry]);

    expect(initialDisables.has('artifacts')).toBe(false);
  });
});
