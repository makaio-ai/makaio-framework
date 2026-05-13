import { describe, expect, it, vi } from 'vitest';
import type { MakaioExtension } from '@makaio/contracts';
import { createExtensionIdentity } from '../extension/extension-identity-builder.js';
import { runExtensionMigrations } from '../extension/extension-migration-runner.js';
import type { ExtensionEntry } from '../extension/types.js';

/**
 * Build the minimum coordinator entry required by the migration runner.
 * @param pkg - Extension manifest to wrap.
 * @returns Extension entry with discovered state.
 */
function makeEntry(pkg: MakaioExtension): ExtensionEntry {
  return {
    pkg,
    identity: createExtensionIdentity(pkg.name),
    state: 'discovered',
    enabled: true,
    warnings: [],
  };
}

describe('runExtensionMigrations', () => {
  it('throws when loadOrder references an entry that is not loaded', async () => {
    await expect(
      runExtensionMigrations({
        loadOrder: ['missing-extension'],
        entries: new Map(),
        runMigrations: vi.fn(async () => {}),
      }),
    ).rejects.toThrow(/loadOrder.*missing from entries/);
  });

  it('rejects relative migration paths that escape storage.packageRoot', async () => {
    const runMigrations = vi.fn(async () => {});
    const pkg: MakaioExtension = {
      name: 'escaping-extension',
      displayName: 'Escaping extension',
      version: '0.1.0',
      storage: {
        migrations: '../shared/drizzle',
        packageRoot: '/workspace/extensions/escaping-extension',
      },
    };

    await expect(
      runExtensionMigrations({
        loadOrder: [pkg.name],
        entries: new Map([[pkg.name, makeEntry(pkg)]]),
        runMigrations,
      }),
    ).rejects.toThrow(/storage\.migrations.*outside storage\.packageRoot/);
    expect(runMigrations).not.toHaveBeenCalled();
  });
});
