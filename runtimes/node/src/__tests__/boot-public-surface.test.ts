import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ExtensionOperatorConfigSource } from '@makaio/contracts';
import type { PersistedMachineIdentity } from '@makaio/machine-identity';
import type { ConfigProvider } from '@makaio/providers';
import type { IAdapterConfigRepository } from '@makaio/services-core/adapter-subsystem';
import {
  createExtensionOperatorConfigSnapshot,
  type CoreBootOptions,
  type ExtensionOperatorConfigSnapshot,
} from '@makaio/runtime-node';

/** Root-entrypoint imports load the whole composition root, which is not instant. */
const ROOT_EXPORT_TIMEOUT_MS = 20_000;

describe('runtime-node boot public surface', () => {
  it('exposes host-provided boot infrastructure seams', () => {
    expectTypeOf<CoreBootOptions>().toHaveProperty('configProvider').toEqualTypeOf<ConfigProvider | undefined>();
    expectTypeOf<CoreBootOptions>()
      .toHaveProperty('adapterConfigRepository')
      .toEqualTypeOf<IAdapterConfigRepository | undefined>();
    expectTypeOf<CoreBootOptions>()
      .toHaveProperty('machineIdentity')
      .toEqualTypeOf<PersistedMachineIdentity | undefined>();
  });

  it('exposes the operator config layer as an optional boot seam', () => {
    expectTypeOf<CoreBootOptions>()
      .toHaveProperty('operatorConfig')
      .toEqualTypeOf<ExtensionOperatorConfigSnapshot | undefined>();
  });

  it('exposes a snapshot that satisfies the kernel-facing operator config contract', () => {
    const snapshot = createExtensionOperatorConfigSnapshot(new Map());
    // Assignability is the contract: the coordinator accepts the bare source,
    // while boot needs the enumerable snapshot to diagnose unread entries.
    const source: ExtensionOperatorConfigSource = snapshot;

    expect(source.get('gateway')).toBeUndefined();
  });

  it(
    'exposes the operator config loader from the root entrypoint',
    async () => {
      const rootModule = await import('../index.js');
      const implementation = await import('../extension-operator-config.js');

      expect(rootModule.MAX_OPERATOR_CONFIG_BYTES).toBe(implementation.MAX_OPERATOR_CONFIG_BYTES);
      expect(rootModule.loadExtensionOperatorConfig).toBe(implementation.loadExtensionOperatorConfig);
      expect(rootModule.createExtensionOperatorConfigSnapshot).toBe(
        implementation.createExtensionOperatorConfigSnapshot,
      );
      expect(rootModule.resolveExtensionOperatorConfigDir).toBe(implementation.resolveExtensionOperatorConfigDir);
      expect(rootModule.warnOnUnappliedExtensionOperatorConfig).toBe(
        implementation.warnOnUnappliedExtensionOperatorConfig,
      );
      expect(rootModule.warnOnUnaddressableExtensionOperatorConfigNames).toBe(
        implementation.warnOnUnaddressableExtensionOperatorConfigNames,
      );
    },
    ROOT_EXPORT_TIMEOUT_MS,
  );

  it(
    'exposes the single package-config-defaults merge rule from the root and subpath entrypoints',
    async () => {
      const rootModule = await import('../index.js');
      // The subpath exists so a consumer that needs only these pure helpers can
      // have them without loading the composition root the barrel pulls in.
      const subpathModule = await import('@makaio/runtime-node/boot-config');
      const implementation = await import('../boot-config.js');

      expect(rootModule.mergePackageConfigDefaults).toBe(implementation.mergePackageConfigDefaults);
      expect(subpathModule.mergePackageConfigDefaults).toBe(implementation.mergePackageConfigDefaults);
      expect(rootModule.filterConfigDefaultsForLoadedPackages).toBe(
        implementation.filterConfigDefaultsForLoadedPackages,
      );
      expect(subpathModule.filterConfigDefaultsForLoadedPackages).toBe(
        implementation.filterConfigDefaultsForLoadedPackages,
      );
    },
    ROOT_EXPORT_TIMEOUT_MS,
  );
});
