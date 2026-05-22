import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus, NoHandlerError, type IMakaioBus } from '@makaio/bus-core';
import { MessageStorageSubjects, SessionSubjects } from '@makaio/contracts';
import type { KernelMakaioExtension, TransportProvider } from '@makaio/kernel';
import { ExtensionSubjects } from '@makaio/kernel';
import {
  AdapterRuntimeSubjects,
  frameworkCorePackages,
  ModelRegistryToken,
  SessionOrchestratorToken,
} from '@makaio/services-core';
import { AdapterSubsystemToken } from '@makaio/subsystem-adapter';
import { ClientsCoreToken } from '@makaio/subsystem-client';
import { LogImportRegistryToken } from '@makaio/services-log-import';
import { createPackageManagerPackage } from '@makaio/services-package-manager/package';
import { bootMakaioRuntimeCore, type MakaioRuntime } from '../boot.js';
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
  ClientsCoreToken.name,
  createPackageManagerPackage().name,
  AdapterSubsystemToken.name,
  ...frameworkCorePackages.filter(isHeadlessPackage).map((pkg) => pkg.name),
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

describe('bootMakaioRuntimeCore with zero discovered extensions', () => {
  let tempHome: string;
  let runtime: MakaioRuntime | undefined;
  let originalSkipExtensions: string | undefined;

  beforeEach(async () => {
    originalSkipExtensions = process.env.MAKAIO_SKIP_EXTENSIONS;
    delete process.env.MAKAIO_SKIP_EXTENSIONS;
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
    const activePackageNames = extensions.filter((pkg) => pkg.state === 'active').map((pkg) => pkg.name);

    expect(transport.connectedWith?.machineId).toBe(runtime.machineId);
    expect(MakaioBus.getSchema(SessionSubjects.created)).toBeDefined();
    expect(MakaioBus.getSchema(MessageStorageSubjects.get)).toBeDefined();
    expect(MakaioBus.getSchema(RuntimeSubjects.busPort)).toBeDefined();
    expect(MakaioBus.getSchema(AdapterRuntimeSubjects.resolveId)).toBeDefined();
    expect(new Set(loadedPackageNames)).toStrictEqual(EXPECTED_FRAMEWORK_BOOT_PACKAGE_NAMES);
    expect(new Set(activePackageNames)).toStrictEqual(EXPECTED_FRAMEWORK_BOOT_PACKAGE_NAMES);
    expect(runtime.trayEntries).toEqual([]);

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
});
