import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus, NoHandlerError, type IMakaioBus } from '@makaio/bus-core';
import {
  ArtifactSubjects,
  ConfigSchema,
  ConfigSubjects,
  defineArtifactKind,
  defineReaction,
  MessageStorageSubjects,
  SessionSubjects,
  type Config,
} from '@makaio/contracts';
import type { AdapterFile, ProviderConfigFile } from '@makaio/contracts/config';
import { ClientSubjects } from '@makaio/contracts/client';
import type { IConfigStorage } from '@makaio/core';
import type { KernelMakaioExtension, TransportProvider } from '@makaio/kernel';
import { ExtensionSubjects, KernelSubjects } from '@makaio/kernel';
import type { PersistedMachineIdentity } from '@makaio/machine-identity';
import { ConfigProvider } from '@makaio/providers';
import { DispatchingAuth } from '@makaio/bus-transport-websocket';
import {
  AdapterRuntimeSubjects,
  ArtifactLifecycleHookRegistryToken,
  frameworkCorePackages,
  ModelRegistryToken,
  ReactionRegistryToken,
  SessionOrchestratorToken,
} from '@makaio/services-core';
import {
  AdapterSubsystemSubjects,
  type AdapterFileConfigSet,
  type IAdapterConfigRepository,
  type ProviderConfigFileSet,
} from '@makaio/services-core/adapter-subsystem';
import { localAutomationCronSchedulerPackage } from '@makaio/services-core/automation-trigger';
import { AdapterSubsystemToken } from '@makaio/subsystem-adapter';
import { ClientsCoreToken } from '@makaio/subsystem-client';
import { LogImportRegistryToken } from '@makaio/services-log-import';
import { WorkflowEngineToken } from '@makaio/subsystem-workflow-engine';
import { createPackageManagerPackage } from '@makaio/services-package-manager/package';
import { CLIDetectionSubjects } from '@makaio/services-core/cli-detection/namespace';
import { bootMakaioRuntimeCore, createCompositeWorkspaceRootResolver, type MakaioRuntime } from '../boot.js';
import { CLI_DETECTION_PACKAGE_NAME } from '../cli-detection/package.js';
import { ExplicitDescriptorDiscovery, type DiscoveredExtension } from '../extension-discovery.js';
import { RuntimeSubjects } from '../bus/runtime/namespace.js';

const { homedirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>(),
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: homedirMock,
  };
});

const EXPECTED_FRAMEWORK_BOOT_PACKAGE_NAMES = new Set([
  'preferences-storage',
  CLI_DETECTION_PACKAGE_NAME,
  ClientsCoreToken.name,
  createPackageManagerPackage().name,
  AdapterSubsystemToken.name,
  ...frameworkCorePackages.filter(isHeadlessPackage).map((pkg) => pkg.name),
  // Framework-only boot has no host-supplied cron provider, so `makaio.cron`
  // bindings fall back to the framework's local in-process scheduler.
  localAutomationCronSchedulerPackage.name,
  WorkflowEngineToken.name,
  ModelRegistryToken.name,
  LogImportRegistryToken.name,
  ...(process.platform === 'darwin' ? ['platform-macos'] : []),
]);

/**
 * Mirror the headless boot surface used by default in {@link bootMakaioRuntimeCore}.
 * @param pkg - Package descriptor assembled into framework boot.
 * @returns Whether the package is eligible for the default headless surface.
 */
function isHeadlessPackage(pkg: KernelMakaioExtension): boolean {
  return pkg.surface === undefined || pkg.surface === 'any' || pkg.surface === 'headless';
}

class FakeTransportProvider implements TransportProvider {
  public connectedWith: { readonly bus: IMakaioBus; readonly machineId: string } | undefined;
  public disconnectCount = 0;

  public async connect(bus: IMakaioBus, machineId: string): Promise<void> {
    this.connectedWith = { bus, machineId };
  }

  public async disconnect(): Promise<void> {
    this.disconnectCount += 1;
  }
}

describe('createCompositeWorkspaceRootResolver', () => {
  it('prefers a late-bound dynamic root and falls back to the explicit host resolver', async () => {
    const runnerResolver = vi.fn(async (workspaceId: string) =>
      workspaceId === 'runner' ? '/runner/workspace' : undefined,
    );
    const fallbackResolver = vi.fn(async (workspaceId: string) => `/fallback/${workspaceId}`);
    const resolveWorkspaceRoot = createCompositeWorkspaceRootResolver(
      async (workspaceId) => (workspaceId === 'factory' ? '/dynamic/factory' : undefined),
      runnerResolver,
      fallbackResolver,
    );

    await expect(resolveWorkspaceRoot('factory')).resolves.toBe('/dynamic/factory');
    expect(runnerResolver).not.toHaveBeenCalled();
    expect(fallbackResolver).not.toHaveBeenCalled();
    await expect(resolveWorkspaceRoot('runner')).resolves.toBe('/runner/workspace');
    expect(fallbackResolver).not.toHaveBeenCalled();
    await expect(resolveWorkspaceRoot('static')).resolves.toBe('/fallback/static');
  });
});

/**
 * In-memory config storage for boot seam tests.
 *
 * Stores a single config snapshot and records every `saveConfig` call so tests
 * can assert persistence side-effects.
 */
class MemoryConfigStorage implements IConfigStorage<Config> {
  /** Most recent config passed to {@link saveConfig}. */
  public saved: Config | undefined;

  /**
   * @param current - Initial config snapshot. `null` yields an empty object.
   */
  public constructor(private current: Partial<Config> | null = null) {}

  /** Current parsed config snapshot held by the storage. */
  public get currentConfig(): Config {
    return ConfigSchema.parse(this.current ?? {});
  }

  public async getConfig(): Promise<Config> {
    return this.currentConfig;
  }

  public async saveConfig(config: Config): Promise<void> {
    this.saved = config;
    this.current = config;
  }
}

/**
 * Config provider with a deterministic machine ID and call counters.
 *
 * Extends the real {@link ConfigProvider} so the test exercises the actual merge
 * and validation logic while overriding identity and environment resolution.
 */
class FixedMachineConfigProvider extends ConfigProvider {
  /** Number of times {@link getConfig} has been invoked. */
  public getConfigCalls = 0;
  /** Number of times {@link getMachineId} has been invoked. */
  public getMachineIdCalls = 0;

  /**
   * @param storage - Backing config storage.
   * @param fixedMachineId - Deterministic machine ID returned by {@link getMachineId}.
   */
  public constructor(
    storage: IConfigStorage<Config>,
    private readonly fixedMachineId: string,
  ) {
    super(storage);
  }

  public override async getConfig(overrides?: Partial<Config>): Promise<Config> {
    this.getConfigCalls += 1;
    return super.getConfig(overrides);
  }

  public override async getMachineId(): Promise<string> {
    this.getMachineIdCalls += 1;
    return this.fixedMachineId;
  }

  protected override getEnv(_key: string): string | undefined {
    return undefined;
  }
}

/**
 * Adapter config repository that counts load calls and refuses all writes.
 *
 * Injected via `CoreBootOptions.adapterConfigRepository` to verify the boot
 * layer delegates to the custom repository instead of creating its own.
 */
class CountingAdapterConfigRepository implements IAdapterConfigRepository {
  /** Number of times {@link loadAdapterConfigs} has been invoked. */
  public adapterLoads = 0;
  /** Number of times {@link loadProviderConfigs} has been invoked. */
  public providerLoads = 0;

  /**
   * @param adapterConfigs - Adapter file fixtures keyed by name.
   * @param providerConfigs - Provider config file fixtures keyed by ID.
   */
  public constructor(
    private readonly adapterConfigs: Map<string, AdapterFile>,
    private readonly providerConfigs: Map<string, ProviderConfigFile>,
  ) {}

  public async loadAdapterConfigs(): Promise<AdapterFileConfigSet> {
    this.adapterLoads += 1;
    return {
      configs: new Map([...this.adapterConfigs.entries()].map(([name, config]) => [name, structuredClone(config)])),
    };
  }

  public async loadProviderConfigs(): Promise<ProviderConfigFileSet> {
    this.providerLoads += 1;
    return {
      configs: new Map([...this.providerConfigs.entries()].map(([id, config]) => [id, structuredClone(config)])),
    };
  }

  public async writeProviderConfig(_id: string, _config: ProviderConfigFile): Promise<void> {
    throw new Error('Unexpected provider config write during boot seam test');
  }

  public async deleteProviderConfig(_id: string): Promise<boolean> {
    throw new Error('Unexpected provider config delete during boot seam test');
  }

  public async writeAdapterFile(_name: string, _config: AdapterFile): Promise<void> {
    throw new Error('Unexpected adapter config write during boot seam test');
  }

  public async deleteAdapterFile(_name: string): Promise<boolean> {
    throw new Error('Unexpected adapter config delete during boot seam test');
  }
}

/**
 * Generate a {@link PersistedMachineIdentity} with real Web Crypto key pairs.
 * @param machineId - Deterministic machine ID to embed.
 * @returns Fully-populated persisted machine identity.
 */
async function createPersistedMachineIdentity(machineId: string): Promise<PersistedMachineIdentity> {
  const [ecdhKeyPair, signingKeyPair] = await Promise.all([
    crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']),
    crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']),
  ]);

  return {
    machineId,
    ecdhKeyPair,
    signingKeyPair,
    publicKey: await exportPublicKeyBase64Url(ecdhKeyPair.publicKey),
    signingPublicKey: await exportPublicKeyBase64Url(signingKeyPair.publicKey),
  };
}

/**
 * Export a P-256 public key using the same base64url raw-byte shape as machine identity.
 * @param publicKey - Public key to export.
 * @returns Base64url-encoded raw public key bytes.
 */
async function exportPublicKeyBase64Url(publicKey: CryptoKey): Promise<string> {
  const exported = await crypto.subtle.exportKey('raw', publicKey);
  return Buffer.from(exported).toString('base64url');
}

/**
 * Build a descriptor fixture backed by an on-disk server entry module.
 * @param rootDir - Temporary root that owns the extension package directory.
 * @param name - Extension descriptor name.
 * @param displayName - Human-readable extension display name.
 * @param serverModuleSource - ESM source for the descriptor's server entry.
 * @param options - Optional descriptor fields that vary between tests.
 * @returns Filesystem discovered extension fixture.
 */
async function filesystemDescriptorFixture(
  rootDir: string,
  name: string,
  displayName: string,
  serverModuleSource: string,
  options: { readonly surface?: KernelMakaioExtension['surface'] } = {},
): Promise<DiscoveredExtension> {
  const extensionPath = path.join(rootDir, 'extensions', name.replace(/[^a-z0-9._-]/gi, '_'));
  // Convention: true means "use surface name as stem" → dist/server.mjs
  const serverPath = path.join(extensionPath, 'dist', 'server.mjs');
  await fs.mkdir(path.dirname(serverPath), { recursive: true });
  await fs.writeFile(serverPath, serverModuleSource, 'utf-8');

  return {
    descriptor: {
      name,
      displayName,
      version: '1.0.0',
      makaio: { framework: '>=1.0.0' },
      entrypoints: { server: true as const },
      ...(options.surface !== undefined ? { surface: options.surface } : {}),
    },
    extensionPath,
    source: 'local',
  };
}

// These integration cases perform real identity/config/SQLite initialization
// and runtime shutdown; the unit-test default is not a boot-plus-shutdown SLO.
describe('bootMakaioRuntimeCore with zero discovered extensions', { timeout: 30_000 }, () => {
  let tempHome: string;
  let runtime: MakaioRuntime | undefined;
  let originalSkipExtensions: string | undefined;
  let originalDatabaseUrl: string | undefined;
  let originalDatabasePath: string | undefined;
  let originalMakaioHome: string | undefined;

  beforeEach(async () => {
    originalSkipExtensions = process.env.MAKAIO_SKIP_EXTENSIONS;
    delete process.env.MAKAIO_SKIP_EXTENSIONS;
    // Boot resolves its database target from these env vars; an ambient value
    // on the developer machine must not re-route the suite onto a real server.
    originalDatabaseUrl = process.env.MAKAIO_DATABASE_URL;
    originalDatabasePath = process.env.MAKAIO_DATABASE_PATH;
    delete process.env.MAKAIO_DATABASE_URL;
    delete process.env.MAKAIO_DATABASE_PATH;
    // Without a configProvider override, boot resolves MAKAIO_HOME to locate
    // the real config directory. An ambient value must not leak into tests.
    originalMakaioHome = process.env.MAKAIO_HOME;
    delete process.env.MAKAIO_HOME;
    tempHome = await fs.mkdtemp(path.join(tmpdir(), 'makaio-zero-ext-'));
    homedirMock.mockReturnValue(tempHome);
    MakaioBus.__resetHandlers?.();
  });

  afterEach(async () => {
    await runtime?.shutdown();
    runtime = undefined;
    MakaioBus.__resetHandlers?.();
    homedirMock.mockReset();
    vi.unstubAllGlobals();
    if (originalSkipExtensions === undefined) {
      delete process.env.MAKAIO_SKIP_EXTENSIONS;
    } else {
      process.env.MAKAIO_SKIP_EXTENSIONS = originalSkipExtensions;
    }
    if (originalDatabaseUrl === undefined) {
      delete process.env.MAKAIO_DATABASE_URL;
    } else {
      process.env.MAKAIO_DATABASE_URL = originalDatabaseUrl;
    }
    if (originalDatabasePath === undefined) {
      delete process.env.MAKAIO_DATABASE_PATH;
    } else {
      process.env.MAKAIO_DATABASE_PATH = originalDatabasePath;
    }
    if (originalMakaioHome === undefined) {
      delete process.env.MAKAIO_HOME;
    } else {
      process.env.MAKAIO_HOME = originalMakaioHome;
    }
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it('starts framework bus, storage, and core packages when discovery returns no descriptors', async () => {
    const transport = new FakeTransportProvider();
    const loadedPackageNames: string[] = [];

    runtime = await bootMakaioRuntimeCore(transport, 0, '127.0.0.1', {
      discovery: new ExplicitDescriptorDiscovery([]),
      frameworkVersion: '3.0.0',
      hostCapabilities: ['node'],
      configureCoordinator: ({ coordinator }) => {
        loadedPackageNames.push(...coordinator.list().map((pkg) => pkg.name));
      },
    });
    const { extensions } = await MakaioBus.request(ExtensionSubjects.list, {});
    const { identity } = await MakaioBus.request(RuntimeSubjects.machineIdentity, {});
    const machineIdentity = identity as PersistedMachineIdentity;
    const activePackageNames = extensions.filter((pkg) => pkg.state === 'active').map((pkg) => pkg.name);

    expect(transport.connectedWith?.machineId).toBe(runtime.machineId);
    expect(runtime.bus).toBe(transport.connectedWith?.bus);
    expect(machineIdentity.machineId).toBe(runtime.machineId);
    expect(MakaioBus.getSchema(SessionSubjects.created)).toBeDefined();
    expect(MakaioBus.getSchema(MessageStorageSubjects.get)).toBeDefined();
    expect(MakaioBus.getSchema(RuntimeSubjects.busPort)).toBeDefined();
    expect(MakaioBus.getSchema(AdapterRuntimeSubjects.resolveId)).toBeDefined();
    await expect(MakaioBus.request(AdapterSubsystemSubjects.listAdapterConfigs, {})).resolves.toEqual({
      configs: [],
    });
    await expect(MakaioBus.request(AdapterSubsystemSubjects.listProviderConfigs, {})).resolves.toEqual({
      configs: [],
    });
    expect(new Set(loadedPackageNames)).toStrictEqual(EXPECTED_FRAMEWORK_BOOT_PACKAGE_NAMES);
    expect(new Set(activePackageNames)).toStrictEqual(EXPECTED_FRAMEWORK_BOOT_PACKAGE_NAMES);
    expect(runtime.trayEntries).toEqual([]);

    const missingBinary = `makaio-cli-detection-missing-${crypto.randomUUID()}`;
    await expect(runtime.bus.request(CLIDetectionSubjects.scan, { binaries: [missingBinary] })).resolves.toEqual({
      results: [{ binary: missingBinary, found: false }],
    });
    await expect(
      runtime.bus.request(ClientSubjects.scan, {
        targets: [{ clientId: 'missing-client', binaryName: missingBinary }],
      }),
    ).resolves.toEqual({
      results: [
        {
          clientId: 'missing-client',
          found: false,
        },
      ],
    });

    await runtime.shutdown();
    runtime = undefined;
    expect(transport.disconnectCount).toBe(1);
  });

  it('runs extension-owned boot contributions before extension contributions are processed', async () => {
    const transport = new FakeTransportProvider();
    const events: string[] = [];

    const descriptor = await filesystemDescriptorFixture(
      tempHome,
      'boot-fixture',
      'Boot Fixture',
      `
const bootPackage = {
  name: 'boot-fixture',
  displayName: 'Boot Fixture',
  version: '1.0.0',
  runtimeBoot: {
    configure({ registerContributionProcessor }) {
      globalThis.__makaioBootZeroEvents.push('boot-configured');
      registerContributionProcessor({
        filter: (pkg) => pkg.name === 'boot-fixture.target',
        async processActivated(name) {
          globalThis.__makaioBootZeroEvents.push(\`contribution:\${name}\`);
        },
      });
    },
  },
};
const targetPackage = { name: 'boot-fixture.target', displayName: 'Boot Fixture Target', version: '1.0.0' };
export default [bootPackage, targetPackage];
`,
    );
    vi.stubGlobal('__makaioBootZeroEvents', events);

    runtime = await bootMakaioRuntimeCore(transport, 0, '127.0.0.1', {
      discovery: new ExplicitDescriptorDiscovery([descriptor]),
      frameworkVersion: '3.0.0',
      hostCapabilities: ['node'],
    });

    expect(events).toStrictEqual(['boot-configured', 'contribution:boot-fixture.target']);
  });

  it('registers extension artifactKinds during boot', async () => {
    const transport = new FakeTransportProvider();
    const pkg: KernelMakaioExtension = {
      name: 'artifact-kind-fixture',
      displayName: 'Artifact Kind Fixture',
      version: '1.0.0',
      artifactKinds: {
        kinds: [
          defineArtifactKind({
            kind: 'boot-note',
            description: 'Minimal boot-note fixture for boot-time artifact kind registration test.',
            schemaVersion: 1,
            dataSchema: z.object({ title: z.string() }),
            category: 'record',
            titlePath: 'title',
          }),
        ],
      },
    };
    const descriptor: DiscoveredExtension = {
      descriptor: {
        name: 'artifact-kind-fixture',
        displayName: 'Artifact Kind Fixture',
        version: '1.0.0',
        makaio: { framework: '>=1.0.0' },
        entrypoints: { server: true },
      },
      extensionPath: tempHome,
      source: 'local',
      preloadedModule: { default: pkg },
    };

    runtime = await bootMakaioRuntimeCore(transport, 0, '127.0.0.1', {
      discovery: new ExplicitDescriptorDiscovery([descriptor]),
      frameworkVersion: '3.0.0',
      hostCapabilities: ['node'],
    });

    const listed = await MakaioBus.request(ArtifactSubjects.kind.list, { kind: 'boot-note' });

    expect(listed.kinds.map((kind) => kind.kind)).toEqual(['boot-note']);
  });

  it('registers extension transition rules and actions during boot', async () => {
    const transport = new FakeTransportProvider();
    let transitionActionCount = 0;
    const pkg: KernelMakaioExtension = {
      name: 'transition-fixture',
      displayName: 'Transition Fixture',
      version: '1.0.0',
      transitionRules: {
        rules: [
          {
            id: 'transition-fixture.capture-created',
            on: 'artifact.created',
            action: { type: 'transition-fixture.capture' },
            enabled: true,
          },
        ],
      },
      transitionActions: {
        actions: {
          'transition-fixture.capture': () => ({
            async execute() {
              transitionActionCount += 1;
            },
          }),
        },
      },
    };
    const descriptor: DiscoveredExtension = {
      descriptor: {
        name: 'transition-fixture',
        displayName: 'Transition Fixture',
        version: '1.0.0',
        makaio: { framework: '>=1.0.0' },
        entrypoints: { server: true },
      },
      extensionPath: tempHome,
      source: 'local',
      preloadedModule: { default: pkg },
    };

    runtime = await bootMakaioRuntimeCore(transport, 0, '127.0.0.1', {
      discovery: new ExplicitDescriptorDiscovery([descriptor]),
      frameworkVersion: '3.0.0',
      hostCapabilities: ['node'],
    });

    await MakaioBus.emit(ArtifactSubjects.created, {
      artifact: {
        kind: 'implementation-plan',
        id: 'artifact-1',
        revision: 'rev-1',
        schemaVersion: 1,
        scope: { level: 'global' },
        data: { status: 'draft' },
        relations: [],
        actor: { kind: 'agent', id: 'agent-1' },
        timestamp: 1000,
      },
    });

    expect(transitionActionCount).toBe(1);
  });

  it('registers and invokes reactions contributed by a non-product extension during boot', async () => {
    const transport = new FakeTransportProvider();
    let receivedMessage: string | undefined;
    const pkg: KernelMakaioExtension = {
      name: 'reaction-fixture',
      displayName: 'Reaction Fixture',
      version: '1.0.0',
      reactions: {
        createReactions: () => [
          defineReaction({
            kind: 'reaction-fixture.record-message',
            description: 'Records a message supplied by the reaction invocation test.',
            parameterSchema: z.object({ message: z.string() }),
            handler: async (parameters) => {
              receivedMessage = parameters.message;
            },
          }),
        ],
      },
    };
    const descriptor: DiscoveredExtension = {
      descriptor: {
        name: 'reaction-fixture',
        displayName: 'Reaction Fixture',
        version: '1.0.0',
        makaio: { framework: '>=1.0.0' },
        entrypoints: { server: true },
      },
      extensionPath: tempHome,
      source: 'local',
      preloadedModule: { default: pkg },
    };

    runtime = await bootMakaioRuntimeCore(transport, 0, '127.0.0.1', {
      discovery: new ExplicitDescriptorDiscovery([descriptor]),
      frameworkVersion: '3.0.0',
      hostCapabilities: ['node'],
    });

    const registry = runtime.coordinator.getExtensionService(ReactionRegistryToken);
    expect(registry).toBeDefined();

    await expect(
      registry!.invoke(
        'reaction-fixture.record-message',
        { message: 'reaction invoked' },
        { eventKind: 'test.reaction', eventPayload: {}, hostContext: {} },
      ),
    ).resolves.toEqual({ success: true });
    expect(receivedMessage).toBe('reaction invoked');
  });

  it('ignores persisted-disabled runtime owners before framework package selection and runtime boot', async () => {
    const transport = new FakeTransportProvider();
    const disabledOwnerPackageName = 'disabled-runtime-owner';
    const descriptor = await filesystemDescriptorFixture(
      tempHome,
      disabledOwnerPackageName,
      'Disabled Runtime Owner',
      `
export default {
  name: 'disabled-runtime-owner',
  displayName: 'Disabled Runtime Owner',
  version: '1.0.0',
  tray: { label: 'Disabled Owner', section: 'tools' },
  windows: [{ id: 'settings', style: 'utility' }],
  runtimeOwnership: { sessionOrchestrator: true },
  runtimeBoot: {
    configure() {
      globalThis.__makaioBootZeroRuntimeBootCalls += 1;
    },
  },
};
`,
    );
    vi.stubGlobal('__makaioBootZeroRuntimeBootCalls', 0);

    runtime = await bootMakaioRuntimeCore(transport, 0, '127.0.0.1', {
      discovery: new ExplicitDescriptorDiscovery([descriptor]),
      extensionConfigProvider: {
        loadConfig: () => undefined,
        loadEnabled: (name) => (name === disabledOwnerPackageName ? false : undefined),
      },
      frameworkVersion: '3.0.0',
      hostCapabilities: ['node'],
    });

    const { extensions } = await MakaioBus.request(ExtensionSubjects.list, {});
    const sessionOrchestrator = extensions.find((extension) => extension.name === SessionOrchestratorToken.name);
    const disabledOwner = extensions.find((extension) => extension.name === disabledOwnerPackageName);

    expect(sessionOrchestrator?.state).toBe('active');
    expect(disabledOwner).toBeUndefined();
    expect(runtime.trayEntries).toEqual([]);
    expect(runtime.windowRegistry.get('disabled-runtime-owner:settings')).toBeUndefined();
    expect(globalThis).toHaveProperty('__makaioBootZeroRuntimeBootCalls', 0);
  });

  it('ignores non-bootable runtime owners during framework package selection', async () => {
    const transport = new FakeTransportProvider();
    const descriptor = await filesystemDescriptorFixture(
      tempHome,
      'interactive-runtime-owner',
      'Interactive Runtime Owner',
      `
export default {
  name: 'interactive-runtime-owner',
  displayName: 'Interactive Runtime Owner',
  version: '1.0.0',
  surface: 'interactive',
  runtimeOwnership: { sessionOrchestrator: true },
  runtimeBoot: {
    configure() {
      globalThis.__makaioBootZeroRuntimeBootCalls += 1;
    },
  },
};
`,
      { surface: 'interactive' },
    );
    vi.stubGlobal('__makaioBootZeroRuntimeBootCalls', 0);

    runtime = await bootMakaioRuntimeCore(transport, 0, '127.0.0.1', {
      discovery: new ExplicitDescriptorDiscovery([descriptor]),
      frameworkVersion: '3.0.0',
      hostCapabilities: ['node'],
    });

    const { extensions } = await MakaioBus.request(ExtensionSubjects.list, {});
    const sessionOrchestrator = extensions.find((extension) => extension.name === SessionOrchestratorToken.name);
    const interactiveOwner = extensions.find((extension) => extension.name === 'interactive-runtime-owner');

    expect(sessionOrchestrator?.state).toBe('active');
    expect(interactiveOwner).toBeUndefined();
    expect(globalThis).toHaveProperty('__makaioBootZeroRuntimeBootCalls', 0);
  });

  it('rolls back coordinator handlers when host coordinator setup throws', async () => {
    const transport = new FakeTransportProvider();

    await expect(
      bootMakaioRuntimeCore(transport, 0, '127.0.0.1', {
        discovery: new ExplicitDescriptorDiscovery([]),
        frameworkVersion: '3.0.0',
        hostCapabilities: ['node'],
        configureCoordinator: () => {
          throw new Error('coordinator setup failed');
        },
      }),
    ).rejects.toThrow('coordinator setup failed');

    expect(transport.disconnectCount).toBe(1);
    await expect(MakaioBus.request(ExtensionSubjects.list, {})).rejects.toBeInstanceOf(NoHandlerError);
  });

  it('registers extension artifact lifecycle hooks during boot', async () => {
    const transport = new FakeTransportProvider();
    const hook = vi.fn();
    const pkg: KernelMakaioExtension = {
      name: 'artifact-hook-fixture',
      displayName: 'Artifact Hook Fixture',
      version: '1.0.0',
      artifactLifecycleHooks: {
        createHooks: () => [{ id: 'artifact-hook-fixture.after-create', event: 'afterCreate', handler: hook }],
      },
    };
    const descriptor: DiscoveredExtension = {
      descriptor: {
        name: 'artifact-hook-fixture',
        displayName: 'Artifact Hook Fixture',
        version: '1.0.0',
        makaio: { framework: '>=1.0.0' },
        entrypoints: { server: true },
      },
      extensionPath: tempHome,
      source: 'local',
      preloadedModule: { default: pkg },
    };

    runtime = await bootMakaioRuntimeCore(transport, 0, '127.0.0.1', {
      discovery: new ExplicitDescriptorDiscovery([descriptor]),
      frameworkVersion: '3.0.0',
      hostCapabilities: ['node'],
    });

    const registry = runtime.coordinator.getExtensionService(ArtifactLifecycleHookRegistryToken);
    expect(registry).toBeDefined();

    await registry!.runAfterCreate({
      artifact: {
        kind: 'test',
        id: 'test-1',
        revision: 'rev-1',
        schemaVersion: 1,
        scope: { level: 'project', ids: { projectId: 'p1' } },
        data: {},
        relations: [],
        actor: { kind: 'agent', id: 'a1' },
        timestamp: 1,
      },
      meta: new Map(),
      kindRegistration: undefined,
    });
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('runs host coordinator cleanups before coordinator shutdown during teardown', async () => {
    const transport = new FakeTransportProvider();
    const events: string[] = [];
    const descriptor = await filesystemDescriptorFixture(
      tempHome,
      'service-package',
      'Service Package',
      `
export default {
  name: 'service-package',
  displayName: 'Service Package',
  version: '1.0.0',
  create: () => ({
    destroy: () => {
      globalThis.__makaioBootZeroEvents.push('service-destroyed');
    },
  }),
};
`,
    );
    vi.stubGlobal('__makaioBootZeroEvents', events);

    runtime = await bootMakaioRuntimeCore(transport, 0, '127.0.0.1', {
      discovery: new ExplicitDescriptorDiscovery([descriptor]),
      frameworkVersion: '3.0.0',
      hostCapabilities: ['node'],
      configureCoordinator: () => () => {
        events.push('host-cleanup');
      },
    });

    await runtime.shutdown();
    runtime = undefined;

    expect(events).toStrictEqual(['host-cleanup', 'service-destroyed']);
  });

  it('uses injected config provider and machine identity as one coherent runtime identity', async () => {
    const transport = new FakeTransportProvider();
    const machineIdentity = await createPersistedMachineIdentity('custom-machine-id');
    const storage = new MemoryConfigStorage(null);
    const configProvider = new FixedMachineConfigProvider(storage, machineIdentity.machineId);

    runtime = await bootMakaioRuntimeCore(transport, 0, '127.0.0.1', {
      configProvider,
      machineIdentity,
      discovery: new ExplicitDescriptorDiscovery([]),
      frameworkVersion: '3.0.0',
      hostCapabilities: ['node'],
    });

    const readiness = await MakaioBus.request(KernelSubjects.isReady, {});
    const configResponse = await MakaioBus.request(ConfigSubjects.get, {});
    const identityResponse = await MakaioBus.request(RuntimeSubjects.machineIdentity, {});
    const updateResponse = await MakaioBus.request(ConfigSubjects.update, { config: configResponse.config });

    expect(runtime.machineId).toBe('custom-machine-id');
    expect(transport.connectedWith?.machineId).toBe('custom-machine-id');
    expect(readiness).toEqual({ ready: true, machineId: 'custom-machine-id' });
    expect(configResponse.config.mode).toBe('local');
    expect(identityResponse.identity).toBe(machineIdentity);
    expect(updateResponse).toEqual({ success: true });
    expect(storage.saved).toEqual(configResponse.config);
    expect(storage.currentConfig).toEqual(configResponse.config);
    expect(configProvider.getConfigCalls).toBeGreaterThanOrEqual(1);
    expect(configProvider.getMachineIdCalls).toBe(1);
  });

  it('fails before default identity fallback creates keys when LAN resolver is missing', async () => {
    const dispatchingAuth = new DispatchingAuth({});
    const transport = new FakeTransportProvider() as FakeTransportProvider & {
      dispatchingAuth: DispatchingAuth;
    };
    transport.dispatchingAuth = dispatchingAuth;

    await expect(
      bootMakaioRuntimeCore(transport, 0, '127.0.0.1', {
        makaioHome: tempHome,
        lanBind: true,
        discovery: new ExplicitDescriptorDiscovery([]),
        frameworkVersion: '3.0.0',
        hostCapabilities: ['node'],
      }),
    ).rejects.toThrow('[boot] peerSigningKeyResolver is required when lanBind is enabled');

    expect(transport.connectedWith).toBeUndefined();
    expect(transport.disconnectCount).toBe(0);
    await expect(fs.stat(path.join(tempHome, 'keys'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses injected machine identity as the runtime machineId when config provider is defaulted', async () => {
    const transport = new FakeTransportProvider();
    const machineIdentity = await createPersistedMachineIdentity('provisioned-machine-id');

    runtime = await bootMakaioRuntimeCore(transport, 0, '127.0.0.1', {
      makaioHome: tempHome,
      machineIdentity,
      discovery: new ExplicitDescriptorDiscovery([]),
      frameworkVersion: '3.0.0',
      hostCapabilities: ['node'],
    });

    const readiness = await MakaioBus.request(KernelSubjects.isReady, {});
    const identityResponse = await MakaioBus.request(RuntimeSubjects.machineIdentity, {});

    expect(runtime.machineId).toBe('provisioned-machine-id');
    expect(transport.connectedWith?.machineId).toBe('provisioned-machine-id');
    expect(readiness).toEqual({ ready: true, machineId: 'provisioned-machine-id' });
    expect(identityResponse.identity).toBe(machineIdentity);
    await expect(fs.stat(path.join(tempHome, 'keys'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails fast when injected config provider and machine identity disagree on machineId', async () => {
    const transport = new FakeTransportProvider();
    const machineIdentity = await createPersistedMachineIdentity('identity-machine-id');
    const configProvider = new FixedMachineConfigProvider(new MemoryConfigStorage(null), 'config-machine-id');

    await expect(
      bootMakaioRuntimeCore(transport, 0, '127.0.0.1', {
        configProvider,
        machineIdentity,
        discovery: new ExplicitDescriptorDiscovery([]),
        frameworkVersion: '3.0.0',
        hostCapabilities: ['node'],
      }),
    ).rejects.toThrow(
      "[boot] Config provider machineId 'config-machine-id' does not match " +
        "runtime machine identity 'identity-machine-id'",
    );

    expect(transport.connectedWith).toBeUndefined();
    expect(transport.disconnectCount).toBe(0);
  });

  it('uses an injected adapter config repository during adapter subsystem startup', async () => {
    const transport = new FakeTransportProvider();
    const repository = new CountingAdapterConfigRepository(
      new Map<string, AdapterFile>(),
      new Map<string, ProviderConfigFile>(),
    );

    runtime = await bootMakaioRuntimeCore(transport, 0, '127.0.0.1', {
      adapterConfigRepository: repository,
      discovery: new ExplicitDescriptorDiscovery([]),
      frameworkVersion: '3.0.0',
      hostCapabilities: ['node'],
    });

    await expect(MakaioBus.request(AdapterSubsystemSubjects.ensureReady, {})).resolves.toEqual({
      ready: true,
    });
    await expect(MakaioBus.request(AdapterSubsystemSubjects.listAdapterConfigs, {})).resolves.toEqual({
      configs: [],
    });
    await expect(MakaioBus.request(AdapterSubsystemSubjects.listProviderConfigs, {})).resolves.toEqual({
      configs: [],
    });
    expect(repository.adapterLoads).toBe(1);
    expect(repository.providerLoads).toBe(1);
  });

  it('uses injected machine identity for runtime identity and LAN E2E auth', async () => {
    const machineIdentity = await createPersistedMachineIdentity('lan-machine-id');
    const configProvider = new FixedMachineConfigProvider(new MemoryConfigStorage(null), machineIdentity.machineId);
    const dispatchingAuth = new DispatchingAuth({});
    const setE2EAuthSpy = vi.spyOn(dispatchingAuth, 'setE2EAuth');
    const transport = new FakeTransportProvider() as FakeTransportProvider & {
      dispatchingAuth: DispatchingAuth;
    };
    transport.dispatchingAuth = dispatchingAuth;

    runtime = await bootMakaioRuntimeCore(transport, 0, '127.0.0.1', {
      configProvider,
      machineIdentity,
      lanBind: true,
      peerSigningKeyResolver: async () => null,
      discovery: new ExplicitDescriptorDiscovery([]),
      frameworkVersion: '3.0.0',
      hostCapabilities: ['node'],
    });

    const identityResponse = await MakaioBus.request(RuntimeSubjects.machineIdentity, {});

    expect(identityResponse.identity).toBe(machineIdentity);
    expect(runtime.machineId).toBe('lan-machine-id');
    expect(setE2EAuthSpy).toHaveBeenCalledTimes(1);
  });
});
