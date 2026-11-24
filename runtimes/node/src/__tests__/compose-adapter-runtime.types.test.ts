import type { IMakaioBus } from '@makaio/bus-core';
import type { IsolatedNodeExtensionContext } from '@makaio/contracts';
import type {
  ContributionProcessor,
  ExtensionCoordinator,
  KernelExtensionContext,
  KernelMakaioExtension,
} from '@makaio/kernel';
import { createAdapterSubsystemContributionProcessor, createAdapterSubsystemPackage } from '@makaio/subsystem-adapter';
import { createToolContributionProcessor } from '@makaio/services-core';
import { expect, expectTypeOf, it } from 'vitest';
import { prepareAdapterRuntime, type PrepareAdapterRuntimeInput } from '../compose-adapter-runtime.js';
import {
  registerExtensionBootContributions,
  selectBootEligibleExtensionPackages,
} from '../boot-extension-selection.js';

type IsolatedContext = IsolatedNodeExtensionContext<IMakaioBus>;

/**
 * Compile-only assertions for full and isolated runtime composition.
 * @param bus - Bus provided to the isolated coordinator.
 * @param full - Coordinator for the default Node context.
 * @param isolated - Coordinator for the isolated Node context.
 * @param repository - Adapter configuration repository.
 */
function assertHostComposition(
  bus: IMakaioBus,
  full: ExtensionCoordinator,
  isolated: ExtensionCoordinator<IsolatedContext>,
  repository: PrepareAdapterRuntimeInput['configRepository'],
): void {
  const options = { configRepository: repository, platformDefaults: {} };
  const fullPackage = createAdapterSubsystemPackage({ ...options, coordinator: full });
  const isolatedPackage = createAdapterSubsystemPackage<IsolatedContext>({ ...options, coordinator: isolated });
  expectTypeOf(fullPackage).toEqualTypeOf<KernelMakaioExtension>();
  expectTypeOf(isolatedPackage).toEqualTypeOf<KernelMakaioExtension<IsolatedContext>>();
  full.load([fullPackage]);
  isolated.load([isolatedPackage]);

  const fullTools = createToolContributionProcessor();
  const isolatedTools = createToolContributionProcessor<IsolatedContext>();
  expectTypeOf(fullTools).toEqualTypeOf<ContributionProcessor>();
  expectTypeOf(isolatedTools).toEqualTypeOf<ContributionProcessor<IsolatedContext>>();
  full.registerContributionProcessor(fullTools);
  isolated.registerContributionProcessor(isolatedTools);
  isolated.registerContributionProcessor(
    createAdapterSubsystemContributionProcessor<IsolatedContext>({ getAdapterSubsystemService: () => undefined }),
  );

  const prepared = prepareAdapterRuntime<IsolatedContext>({ ...options, coordinator: isolated });
  expectTypeOf(prepared.adapterSubsystemPackage).toEqualTypeOf<KernelMakaioExtension<IsolatedContext>>();
  const manifest = { ...prepared.adapterSubsystemPackage, marker: 'isolated' as const };
  const eligible = selectBootEligibleExtensionPackages({
    packages: [manifest],
    surface: 'headless',
    runtimeEnvironment: { hosts: new Set(['node']), capabilities: new Set() },
    configProvider: undefined,
  });
  expectTypeOf(eligible).toEqualTypeOf<readonly (typeof manifest)[]>();
  registerExtensionBootContributions<IsolatedContext>(eligible, bus, isolated);

  const fullHostTools = createToolContributionProcessor<KernelExtensionContext>();
  // @ts-expect-error isolated hosts cannot invoke processors that require full host capabilities
  isolated.registerContributionProcessor(fullHostTools);
}

it('loads the compile-only runtime composition assertions', () => {
  expect(typeof assertHostComposition).toBe('function');
});
