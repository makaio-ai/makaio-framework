import type { IMakaioBus } from '@makaio/bus-core';
import type { IsolatedNodeExtensionContext } from '@makaio/contracts/extension';
import { expect, expectTypeOf, it } from 'vitest';
import {
  ExtensionCoordinator,
  type ContributionProcessor,
  type KernelExtensionContext,
  type KernelMakaioExtension,
} from '../index.js';
import type { ExtensionEntry } from '../extension/types.js';

type SpecialHostContext = KernelExtensionContext & { readonly hostLabel: string };
type IsolatedContext = IsolatedNodeExtensionContext<IMakaioBus>;

/** Compile-only assertions for the default host and a host with a required capability.
 * @param bus - Host bus type used to construct the coordinator.
 * @param specialManifest - Extension requiring the test host capability.
 * @param specialProcessor - Processor requiring the test host capability.
 * @param fullManifest - Manifest that uses the full Node host.
 * @param fullContext - A full context to check each required capability independently.
 */
function hostContextAssertions(
  bus: IMakaioBus,
  specialManifest: KernelMakaioExtension<SpecialHostContext>,
  specialProcessor: ContributionProcessor<SpecialHostContext>,
  fullManifest: KernelMakaioExtension,
  fullContext: KernelExtensionContext,
): void {
  const coordinator = new ExtensionCoordinator(bus);
  const entries = coordinator.load([
    {
      name: 'type-reader',
      displayName: 'Type reader',
      version: '1.0.0',
      create: (context) => {
        expectTypeOf(context).toEqualTypeOf<KernelExtensionContext>();
        return { init: async () => {}, destroy: async () => {} };
      },
    },
  ]);
  expectTypeOf(entries).toEqualTypeOf<readonly ExtensionEntry['pkg'][]>();
  expectTypeOf(coordinator.getExtension('type-reader')).toEqualTypeOf<ExtensionEntry['pkg'] | undefined>();
  coordinator.registerContributionProcessor({
    processActivated: async (_name, manifest, context) => {
      expectTypeOf(manifest).toEqualTypeOf<ExtensionEntry['pkg']>();
      expectTypeOf(context).toEqualTypeOf<KernelExtensionContext>();
    },
  });

  const { journal, database, ...shared } = fullContext;
  expectTypeOf<Extract<'database' | 'journal', keyof IsolatedContext>>().toBeNever();
  const isolated = new ExtensionCoordinator<IsolatedContext>(bus, {
    extensionContextBase: { ...shared, constructContext: (context) => context },
  });
  // @ts-expect-error a supplied context base must provide a factory even on an isolated host
  void new ExtensionCoordinator<IsolatedContext>(bus, { extensionContextBase: shared });
  // @ts-expect-error an isolated coordinator cannot load a manifest requiring the full context
  isolated.load([fullManifest]);
  // @ts-expect-error a full context requires its journal
  const withoutJournal: KernelExtensionContext = { ...shared, database };
  // @ts-expect-error a full context requires its database facade
  const withoutDatabase: KernelExtensionContext = { ...shared, journal };
  void [withoutJournal, withoutDatabase];

  // @ts-expect-error a default host cannot load a manifest requiring the special host
  coordinator.load([specialManifest]);
  // @ts-expect-error a default host cannot call processors requiring the special host
  coordinator.registerContributionProcessor(specialProcessor);
  // @ts-expect-error a special host must supply its context factory
  void new ExtensionCoordinator<SpecialHostContext>(bus);
}

it('loads the compile-only host context assertions', () => {
  expect(typeof hostContextAssertions).toBe('function');
});
