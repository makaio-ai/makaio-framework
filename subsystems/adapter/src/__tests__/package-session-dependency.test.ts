/**
 * Boot-composition tests for the adapter subsystem's session dependency.
 *
 * An adapter that starts an agent reserves provider-session ownership first,
 * and the session package is what registers the authority it reserves from.
 * The declaration is therefore not documentation: it is what keeps a reserving
 * adapter from ever coming up in a host where that authority is missing, and
 * the coordinator is the thing that enforces it.
 */
import { describe, expect, it } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import type { IMakaioBus } from '@makaio/bus-core';
import { dep, type MakaioNodeExtension } from '@makaio/contracts';
import { ExtensionCoordinator } from '@makaio/kernel';
import { SessionToken } from '@makaio/services-core';
import type {
  AdapterFileConfigSet,
  IAdapterConfigRepository,
  ProviderConfigFileSet,
} from '@makaio/services-core/adapter-subsystem';
import type { KernelMakaioExtension } from '@makaio/kernel';
import { ADAPTER_SUBSYSTEM_PACKAGE_NAME } from '@makaio/services-core/adapter-subsystem';
import { createAdapterSubsystemPackage, orderAfterAdapterSubsystem } from '../index.js';
import { createStubCoordinator, TEST_PLATFORM_DEFAULTS } from './test-utils.js';

/** Config repository that holds nothing — the package never reads it here. */
const EMPTY_CONFIG_REPOSITORY: IAdapterConfigRepository = {
  loadAdapterConfigs: async (): Promise<AdapterFileConfigSet> => ({ configs: new Map() }),
  loadProviderConfigs: async (): Promise<ProviderConfigFileSet> => ({ configs: new Map() }),
  writeProviderConfig: async (): Promise<void> => undefined,
  deleteProviderConfig: async (): Promise<boolean> => false,
  writeAdapterFile: async (): Promise<void> => undefined,
  deleteAdapterFile: async (): Promise<boolean> => false,
};

/**
 * Build the adapter subsystem package under test.
 * @returns The package manifest, composed with inert dependencies.
 */
function buildPackage(): MakaioNodeExtension<IMakaioBus> {
  return createAdapterSubsystemPackage({
    configRepository: EMPTY_CONFIG_REPOSITORY,
    coordinator: createStubCoordinator(),
    platformDefaults: TEST_PLATFORM_DEFAULTS,
  });
}

describe('adapter subsystem package — session dependency', () => {
  it('declares the session package as a required dependency', () => {
    expect(buildPackage().dependencies).toContainEqual(dep(SessionToken.name));
  });

  it('does not load when the session package is absent from the load set', () => {
    const coordinator = new ExtensionCoordinator(createBusInstance(), {});

    // The declaration's whole point: a host that forgot the session package
    // does not get an adapter subsystem that quietly starts and then dispatches
    // starts it cannot reserve. The coordinator refuses the load set outright,
    // naming the missing package.
    expect(() => coordinator.load([buildPackage()])).toThrow(SessionToken.name);
  });
});

/** What the ordering cases vary on an otherwise inert manifest. */
interface TestExtensionFields {
  /** Adapter contributions, when the case needs the package to be a contributor. */
  readonly adapters?: NonNullable<KernelMakaioExtension['adapters']>;
  /** Declared dependencies, when the case needs the package placed in the graph. */
  readonly dependencies?: NonNullable<KernelMakaioExtension['dependencies']>;
  /** Service factory, when the case records the start order. */
  readonly create?: NonNullable<KernelMakaioExtension['create']>;
}

/**
 * Build an extension manifest for the ordering cases.
 *
 * Typed rather than cast: this helper is the only place that has to know what a
 * manifest minimally is, so a field renamed on the contract fails here instead
 * of being erased by a double assertion at four call sites. The optional fields
 * carry no `undefined` member, so an absent key is the only way to omit one —
 * which is what the coordinator reads.
 * @param name - Package name.
 * @param fields - Whatever the case varies.
 * @returns The manifest.
 */
function testExtension(name: string, fields: TestExtensionFields = {}): KernelMakaioExtension {
  // `displayName` is required and `version` is a version literal, not a string —
  // the two facts the previous double assertions were hiding.
  const manifest: KernelMakaioExtension = { name, displayName: name, version: '1.0.0' };
  return { ...manifest, ...fields };
}

describe('orderAfterAdapterSubsystem', () => {
  /**
   * The one contribution that makes a package adapter-contributing.
   *
   * A whole definition, not a stub: `contributesToAdapterSubsystem` only reads
   * the array's length, but a contribution that could not actually be processed
   * would make the ordering case assert against a package the subsystem would
   * reject anyway.
   */
  const ADAPTER_CONTRIBUTION: NonNullable<KernelMakaioExtension['adapters']> = [
    {
      manifest: { name: 'x', protocols: [], clients: [] },
      definition: {
        name: 'x',
        providers: [],
        defaultTimeouts: {
          initialization: 1_000,
          acknowledgement: 1_000,
          completion: 1_000,
          toolApproval: 1_000,
          eventWait: 1_000,
        },
        createAdapter: async () => ({}),
      },
    },
  ];

  /** An extension that contributes an adapter and declares nothing else. */
  const adapterContributor = testExtension('contributing-extension', { adapters: ADAPTER_CONTRIBUTION });

  /** An extension that contributes neither adapters nor providers. */
  const plainExtension = testExtension('plain-extension');

  it('stamps contributors and leaves everything else untouched', () => {
    const [stamped, untouched] = orderAfterAdapterSubsystem([adapterContributor, plainExtension]);

    expect(stamped?.dependencies).toEqual([dep(ADAPTER_SUBSYSTEM_PACKAGE_NAME)]);
    // Same object, not a copy: a package the subsystem does not process must be
    // handed to the coordinator exactly as its author wrote it.
    expect(untouched).toBe(plainExtension);
  });

  it('is idempotent and preserves declared dependencies', () => {
    const withOwnDeps = { ...adapterContributor, dependencies: [dep('provider-x', undefined, true)] };
    const once = orderAfterAdapterSubsystem([withOwnDeps]);
    const twice = orderAfterAdapterSubsystem(once);

    expect(once[0]?.dependencies).toEqual([dep('provider-x', undefined, true), dep(ADAPTER_SUBSYSTEM_PACKAGE_NAME)]);
    expect(twice[0]).toBe(once[0]);
  });

  it('makes a contributor start after the subsystem even behind the session chain', async () => {
    const started: string[] = [];
    /**
     * Build a dependency-free stand-in that records when it starts.
     * @param name - Package name.
     * @param dependencies - Names this stand-in waits for.
     * @returns The stand-in manifest.
     */
    const recorder = (name: string, dependencies: readonly string[] = []): KernelMakaioExtension => {
      const create = (): { init: () => void; destroy: () => void } => ({
        init: (): void => {
          started.push(name);
        },
        destroy: (): void => undefined,
      });
      if (dependencies.length === 0) return testExtension(name, { create });
      return testExtension(name, { create, dependencies: dependencies.map((declared) => dep(declared)) });
    };

    const contributor: KernelMakaioExtension = {
      ...recorder('contributing-extension'),
      adapters: ADAPTER_CONTRIBUTION,
    };
    const subsystem: KernelMakaioExtension = {
      ...buildPackage(),
      create: () => ({
        init: (): void => {
          started.push(ADAPTER_SUBSYSTEM_PACKAGE_NAME);
        },
        destroy: (): void => undefined,
      }),
    };

    const coordinator = new ExtensionCoordinator(createBusInstance(), {
      extensionContextBase: {
        platform: process.platform,
        homedir: '/home/test',
        makaioHome: '/home/test/.makaio',
        username: 'test',
        machineId: 'machine-1',
        busUrl: 'ws://127.0.0.1:0/bus',
        tryImport: async () => null,
      },
    });
    coordinator.load([
      recorder('session-bridge'),
      recorder(SessionToken.name, ['session-bridge']),
      subsystem,
      ...orderAfterAdapterSubsystem([contributor]),
    ]);
    await coordinator.startAll();

    // The regression this helper exists for: the subsystem's own session
    // dependency pushes it deep into the graph, and a contributor with no
    // declared dependencies would otherwise start in the first wave — before
    // the service that has to process its contributions exists.
    expect(started.indexOf(ADAPTER_SUBSYSTEM_PACKAGE_NAME)).toBeLessThan(started.indexOf('contributing-extension'));
    await coordinator.shutdown();
  });
});
