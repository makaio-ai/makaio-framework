import { createBusInstance } from '@makaio/bus-core';
import { describe, expect, it } from 'vitest';
import { ExtensionCoordinator } from '../extension/extension-coordinator.js';
import { ExtensionStorageCapabilityError } from '../extension/extension-selection.js';
import { StorageDatabaseInvariantError } from '../extension/extension-start-runner.js';

describe('storage eligibility', () => {
  it('rejects missing storage capability and names required dependents', async () => {
    const coordinator = new ExtensionCoordinator(createBusInstance(), {
      runtimeEnvironment: { hosts: new Set(), capabilities: new Set() },
    });
    try {
      expect(() =>
        coordinator.load([
          { name: 'implicit-storage', displayName: 'Implicit Storage', version: '1.0.0', storage: {} },
          {
            name: 'explicit-storage',
            displayName: 'Explicit Storage',
            version: '1.0.0',
            requires: [{ type: 'capability', id: 'storage.drizzle' }],
          },
          {
            name: 'dependent',
            displayName: 'Dependent',
            version: '1.0.0',
            dependencies: [{ type: 'extension', name: 'implicit-storage', version: '*' }],
          },
          {
            name: 'transitive',
            displayName: 'Transitive',
            version: '1.0.0',
            dependencies: [{ type: 'extension', name: 'dependent', version: '*' }],
          },
          {
            name: 'optional',
            displayName: 'Optional',
            version: '1.0.0',
            dependencies: [{ type: 'extension', name: 'implicit-storage', version: '*', optional: true }],
          },
        ]),
      ).toThrow(
        expect.objectContaining({
          constructor: ExtensionStorageCapabilityError,
          capability: 'storage.drizzle',
          extensions: ['implicit-storage', 'explicit-storage'],
          dependents: ['dependent', 'transitive'],
        }),
      );
    } finally {
      await coordinator.shutdown();
    }
  });

  it('rejects a storage declaration that requires an unadvertised capability version', async () => {
    const coordinator = new ExtensionCoordinator(createBusInstance(), {
      runtimeEnvironment: { hosts: new Set(), capabilities: new Set(['storage.drizzle']) },
    });
    try {
      expect(() =>
        coordinator.load([
          {
            name: 'versioned-storage',
            displayName: 'Versioned Storage',
            version: '1.0.0',
            storage: {},
            requires: [{ type: 'capability', id: 'storage.drizzle', version: '^1.0.0' }],
          },
        ]),
      ).toThrow(ExtensionStorageCapabilityError);
    } finally {
      await coordinator.shutdown();
    }
  });

  it('raises a typed invariant error when an admitted storage extension has no database', async () => {
    const coordinator = new ExtensionCoordinator(createBusInstance(), {
      runtimeEnvironment: { hosts: new Set(), capabilities: new Set(['storage.drizzle']) },
    });
    try {
      coordinator.load([
        {
          name: 'required-storage',
          displayName: 'Required Storage',
          version: '1.0.0',
          critical: true,
          storage: { registerHandlers: () => undefined },
        },
      ]);
      await expect(coordinator.startAll()).rejects.toBeInstanceOf(StorageDatabaseInvariantError);
      expect(coordinator.getInfo('required-storage')).toMatchObject({ state: 'failed' });
    } finally {
      await coordinator.shutdown();
    }
  });

  it('reports a database mismatch when retrying a storage extension that failed to start', async () => {
    const coordinator = new ExtensionCoordinator(createBusInstance(), {
      runtimeEnvironment: { hosts: new Set(), capabilities: new Set(['storage.drizzle']) },
      persistEnabled: async () => undefined,
    });
    try {
      coordinator.load([
        {
          name: 'retry-storage',
          displayName: 'Retry Storage',
          version: '1.0.0',
          storage: { registerHandlers: () => undefined },
        },
      ]);
      await coordinator.startAll();
      expect(coordinator.getInfo('retry-storage')).toMatchObject({ state: 'failed' });
      await coordinator.applyExtensionTransition('retry-storage', true);
      expect(coordinator.getInfo('retry-storage')).toMatchObject({
        state: 'failed',
        error: expect.stringContaining('the host supplied no database'),
      });
    } finally {
      await coordinator.shutdown();
    }
  });
});
