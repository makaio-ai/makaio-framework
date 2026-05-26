/**
 * PackageManagerService Tests
 *
 * These tests use in-memory stubs to avoid real Yarn or network access.
 * We verify bus handler wiring, local-install routing, and lifecycle behavior.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createBusInstance, createBusContext, type IMakaioBus } from '@makaio/bus-core';
import { PackageSubjects } from '../namespace.js';
import type { PackageInfo, PackageRegistry, PackageInstallResult, PackageUninstallResult } from '../namespace.js';
import {
  PackageManagerService,
  type PackageManagerClient,
  type LocalInstallClient,
} from '../package-manager-service.js';
import type { PackageRegistryClient } from '../registry-client.js';
import type { FrameworkDependencySpec, InstalledExtensionDescriptor } from '../yarn-integration.js';
import type { ExtensionDescriptor } from '@makaio/contracts';

/**
 * Registry stub data.
 */
const mockRegistry: PackageRegistry = {
  $schema: 'makaio/package-registry/v1',
  updatedAt: '2026-01-31T12:00:00Z',
  adapters: [
    {
      name: '@makaio/ai-adapters-claude-code',
      displayName: 'Claude Code',
      description: 'Anthropic Claude via CLI or API',
      icon: 'claude',
      tags: ['official'],
    },
  ],
  extensions: [
    {
      name: '@makaio/extension-github',
      displayName: 'GitHub',
      description: 'PR comments, issues, code review integration',
      icon: 'github',
      tags: ['official', 'integration'],
    },
  ],
};

/**
 * In-memory package manager stub.
 */
class StubPackageManager implements PackageManagerClient {
  public readonly ensuredFrameworkDependencies: FrameworkDependencySpec[] = [];
  public restoreCount = 0;
  private readonly installedDescriptorNames = new Set<string>();

  public constructor(
    private packages: PackageInfo[],
    private readonly latestVersions: Map<string, string>,
    private readonly descriptors: ReadonlyMap<string, ExtensionDescriptor> = new Map(),
  ) {}

  public async initialize(): Promise<void> {}

  public async installPackage(packageName: string): Promise<string> {
    const npmName = parseTestPackageSpec(packageName);
    const version = this.latestVersions.get(npmName) ?? '1.0.0';
    this.packages = [
      ...this.packages.filter((pkg) => pkg.name !== npmName),
      { name: npmName, version, hasDescriptor: this.descriptors.has(npmName) },
    ];
    if (this.descriptors.has(npmName)) {
      this.installedDescriptorNames.add(npmName);
    }
    return version;
  }

  public async uninstallPackage(packageName: string): Promise<void> {
    this.packages = this.packages.filter((pkg) => pkg.name !== packageName);
  }

  public async listPackages(): Promise<PackageInfo[]> {
    return this.packages;
  }

  public async getLatestVersion(packageName: string): Promise<string> {
    return this.latestVersions.get(packageName) ?? '1.0.0';
  }

  public async ensureFrameworkDependency(dependency: FrameworkDependencySpec): Promise<void> {
    this.ensuredFrameworkDependencies.push(dependency);
  }

  public async readInstalledExtensionDescriptor(npmName: string): Promise<ExtensionDescriptor | null> {
    if (!this.installedDescriptorNames.has(npmName)) {
      return null;
    }
    return this.descriptors.get(npmName) ?? null;
  }

  public async listInstalledExtensionDescriptors(): Promise<InstalledExtensionDescriptor[]> {
    return [...this.installedDescriptorNames].map((npmName) => ({
      npmName,
      version: this.latestVersions.get(npmName) ?? '1.0.0',
      descriptor: this.descriptors.get(npmName)!,
    }));
  }

  public async readManifestSnapshot(): Promise<unknown> {
    return {};
  }

  public async writeManifestAndReinstall(_snapshot: unknown): Promise<void> {
    this.restoreCount += 1;
  }

  public async resolvePackageVersion(_packageSpec: string): Promise<string> {
    return '1.0.0';
  }
}

/**
 * Build the minimal embedded descriptor shape needed by dependency resolver tests.
 * @param name - Descriptor name.
 * @param dependencies - Descriptor-declared dependencies.
 * @returns Extension descriptor fixture.
 */
function createDescriptor(name: string, dependencies: ExtensionDescriptor['dependencies'] = []): ExtensionDescriptor {
  return {
    name,
    displayName: name,
    version: '1.0.0',
    makaio: { framework: '^0.1.0' },
    entrypoints: { server: './index.js' },
    dependencies,
  };
}

/**
 * Parse the npm package name out of a test package specifier.
 * @param packageSpec - Package specifier passed to the fake Yarn manager.
 * @returns Package name without version/range suffix.
 */
function parseTestPackageSpec(packageSpec: string): string {
  if (packageSpec.startsWith('@')) {
    const slashIndex = packageSpec.indexOf('/');
    if (slashIndex === -1) {
      return packageSpec;
    }
    const rangeMarker = packageSpec.indexOf('@', slashIndex + 1);
    return rangeMarker === -1 ? packageSpec : packageSpec.slice(0, rangeMarker);
  }
  const rangeMarker = packageSpec.indexOf('@');
  return rangeMarker === -1 ? packageSpec : packageSpec.slice(0, rangeMarker);
}

/**
 * In-memory registry stub.
 */
class StubRegistryService implements PackageRegistryClient {
  public async getRegistry(): Promise<PackageRegistry> {
    return mockRegistry;
  }
}

/**
 * In-memory local installer stub.
 */
class StubLocalInstaller implements LocalInstallClient {
  public readonly installed: Array<{ name: string; version: string; sourcePath: string; serverImportPath: string }> =
    [];

  public async install(sourcePath: string): Promise<PackageInstallResult> {
    const name = `local-ext-${this.installed.length}`;
    const version = '0.1.0';
    this.installed.push({ name, version, sourcePath, serverImportPath: `${sourcePath}/src/server.ts` });
    return { success: true, packageName: name, version, restartRequired: true };
  }

  public async uninstall(extensionName: string): Promise<PackageUninstallResult> {
    const idx = this.installed.findIndex((e) => e.name === extensionName);
    if (idx !== -1) {
      this.installed.splice(idx, 1);
      return { success: true, packageName: extensionName, restartRequired: true };
    }
    return {
      success: false,
      packageName: extensionName,
      error: `Extension ${extensionName} not found`,
      restartRequired: false,
    };
  }

  public async list(): Promise<
    Array<{ name: string; version: string; sourcePath: string; source: 'local'; serverImportPath: string }>
  > {
    return this.installed.map((e) => ({ ...e, source: 'local' as const }));
  }
}

/**
 * Stub dependency resolver that records calls and returns trivial results.
 *
 * Each root becomes a single installed entry with version `'1.0.0'` and
 * source `'new'`. No transitive dependencies are produced.
 */
class StubDependencyResolver {
  public readonly calls: Array<{ roots: readonly string[]; force?: boolean }> = [];

  public constructor(private readonly failure: Error | null = null) {}

  public async resolve(roots: readonly string[], options: { force?: boolean } = {}) {
    this.calls.push({ roots, force: options.force });
    if (this.failure) {
      throw this.failure;
    }
    return {
      installed: roots.map((npmName) => ({ npmName, version: '1.0.0', source: 'new' as const })),
      skipped: [] as Array<{ npmName: string; reason: string }>,
      warnings: [] as string[],
    };
  }
}

function expectInvalidMutationResult(
  result: { error?: string; packageName: string; restartRequired: boolean; success: boolean },
  packageName: string,
): void {
  expect(result.success).toBe(false);
  expect(result.packageName).toBe(packageName);
  expect(result.error).toBeTruthy();
  expect(result.restartRequired).toBe(false);
}

describe('PackageManagerService', () => {
  let bus: IMakaioBus;
  let service: PackageManagerService;
  let packageManager: StubPackageManager;

  beforeEach(async () => {
    bus = createBusInstance({ context: createBusContext() });
    packageManager = new StubPackageManager(
      [{ name: '@makaio/ai-adapters-claude-code', version: '1.0.0', hasDescriptor: false }],
      new Map([['@makaio/ai-adapters-claude-code', '2.0.0']]),
    );

    service = new PackageManagerService(bus, '/tmp/.makaio', {
      yarnManager: packageManager,
      registryService: new StubRegistryService(),
      localInstaller: new StubLocalInstaller(),
      dependencyResolver: new StubDependencyResolver(),
      frameworkPeerRange: '^0.1.0',
    });
    await service.init();
  });

  afterEach(async () => {
    await service.destroy();
  });

  describe('bus handler registration', () => {
    it('should list packages from npm (via StubPackageManager)', async () => {
      const result = await bus.request(PackageSubjects.list, {});
      expect(result.packages).toHaveLength(1);
      expect(result.packages[0]?.name).toBe('@makaio/ai-adapters-claude-code');
    });

    it('should include local extensions in packages.list', async () => {
      const localInstaller = new StubLocalInstaller();
      await localInstaller.install('/tmp/my-local-ext');
      const localBus = createBusInstance({ context: createBusContext() });
      const localService = new PackageManagerService(localBus, '/tmp/.makaio', {
        yarnManager: new StubPackageManager([], new Map()),
        localInstaller,
      });
      await localService.init();

      const result = await localBus.request(PackageSubjects.list, {});

      expect(result.packages).toEqual([
        {
          name: 'local-ext-0',
          version: '0.1.0',
          hasDescriptor: true,
          serverImportPath: '/tmp/my-local-ext/src/server.ts',
        },
      ]);

      await localService.destroy();
    });

    it('should install via npm by default (no source field)', async () => {
      const installedEvents: Array<{ packageName: string; version: string }> = [];
      const cleanup = bus.on(PackageSubjects.installed, (ctx) => {
        installedEvents.push(ctx.payload);
      });

      const result = await bus.request(PackageSubjects.install, {
        packageNames: ['@makaio/extension-github'],
      });

      expect(result.success).toBe(true);
      expect(result.packageName).toBe('@makaio/extension-github');
      expect(result.version).toBe('1.0.0');
      expect(result.restartRequired).toBe(true);
      expect(packageManager.ensuredFrameworkDependencies).toEqual([{ versionRange: '^0.1.0' }]);
      expect(installedEvents).toEqual([{ packageName: '@makaio/extension-github', version: '1.0.0' }]);

      cleanup();
    });

    it('accepts backward-compatible single packageName install payloads', async () => {
      const result = await bus.request(PackageSubjects.install, {
        packageName: '@makaio/extension-github',
      });

      expect(result.success).toBe(true);
      expect(result.packageName).toBe('@makaio/extension-github');
      expect(packageManager.ensuredFrameworkDependencies).toEqual([{ versionRange: '^0.1.0' }]);
    });

    it('uses a host-provided framework package path for npm installs when available', async () => {
      const localBus = createBusInstance({ context: createBusContext() });
      const localYarnManager = new StubPackageManager([], new Map());
      const localService = new PackageManagerService(localBus, '/tmp/.makaio', {
        yarnManager: localYarnManager,
        localInstaller: new StubLocalInstaller(),
        dependencyResolver: new StubDependencyResolver(),
        frameworkPeerRange: '^0.1.0',
        frameworkPackagePath: '/app/node_modules/@makaio/framework',
      });
      await localService.init();

      const result = await localBus.request(PackageSubjects.install, {
        packageNames: ['@makaio/extension-github'],
      });

      expect(result.success).toBe(true);
      expect(localYarnManager.ensuredFrameworkDependencies).toEqual([
        { versionRange: '^0.1.0', localPackagePath: '/app/node_modules/@makaio/framework' },
      ]);

      await localService.destroy();
    });

    it('should route source: local to LocalInstallClient', async () => {
      const localInstaller = new StubLocalInstaller();
      const localYarnManager = new StubPackageManager([], new Map());
      const localBus = createBusInstance({ context: createBusContext() });
      const localService = new PackageManagerService(localBus, '/tmp/.makaio', {
        yarnManager: localYarnManager,
        localInstaller,
      });
      await localService.init();

      const installedEvents: Array<{ packageName: string; version: string }> = [];
      const cleanup = localBus.on(PackageSubjects.installed, (ctx) => {
        installedEvents.push(ctx.payload);
      });

      const result = await localBus.request(PackageSubjects.install, {
        packageNames: ['/tmp/my-local-ext'],
        source: 'local',
      });

      expect(result.success).toBe(true);
      expect(result.packageName).toBe('local-ext-0');
      expect(result.restartRequired).toBe(true);
      expect(localInstaller.installed).toHaveLength(1);
      expect(localInstaller.installed[0]?.sourcePath).toBe('/tmp/my-local-ext');
      expect(localYarnManager.ensuredFrameworkDependencies).toEqual([]);
      expect(installedEvents).toHaveLength(1);
      expect(installedEvents[0]?.packageName).toBe('local-ext-0');

      cleanup();
      await localService.destroy();
    });

    it('should detect local path installs when source is omitted', async () => {
      const localInstaller = new StubLocalInstaller();
      const localBus = createBusInstance({ context: createBusContext() });
      const localService = new PackageManagerService(localBus, '/tmp/.makaio', {
        yarnManager: new StubPackageManager([], new Map()),
        localInstaller,
      });
      await localService.init();

      const result = await localBus.request(PackageSubjects.install, {
        packageNames: ['./my-local-ext'],
      });

      expect(result.success).toBe(true);
      expect(localInstaller.installed[0]?.sourcePath).toBe('./my-local-ext');

      await localService.destroy();
    });

    it('should emit packages.installed event on npm install', async () => {
      const installedEvents: Array<{ packageName: string; version: string }> = [];
      const cleanup = bus.on(PackageSubjects.installed, (ctx) => {
        installedEvents.push(ctx.payload);
      });

      await bus.request(PackageSubjects.install, { packageNames: ['@makaio/extension-github'] });

      expect(installedEvents).toHaveLength(1);
      expect(installedEvents[0]?.packageName).toBe('@makaio/extension-github');

      cleanup();
    });

    it('should emit packages.uninstalled event on uninstall', async () => {
      const uninstalledEvents: Array<{ packageName: string }> = [];
      const cleanup = bus.on(PackageSubjects.uninstalled, (ctx) => {
        uninstalledEvents.push(ctx.payload);
      });

      const result = await bus.request(PackageSubjects.uninstall, {
        packageName: '@makaio/ai-adapters-claude-code',
      });

      expect(result.success).toBe(true);
      expect(result.packageName).toBe('@makaio/ai-adapters-claude-code');
      expect(result.restartRequired).toBe(true);
      expect(uninstalledEvents).toEqual([{ packageName: '@makaio/ai-adapters-claude-code' }]);

      cleanup();
    });

    it('should uninstall local extensions before npm packages', async () => {
      const localInstaller = new StubLocalInstaller();
      await localInstaller.install('/tmp/my-local-ext');
      const localBus = createBusInstance({ context: createBusContext() });
      const localService = new PackageManagerService(localBus, '/tmp/.makaio', {
        yarnManager: new StubPackageManager([{ name: 'other-ext', version: '1.0.0', hasDescriptor: true }], new Map()),
        localInstaller,
      });
      await localService.init();

      const result = await localBus.request(PackageSubjects.uninstall, {
        packageName: 'local-ext-0',
      });

      expect(result.success).toBe(true);
      expect(localInstaller.installed).toHaveLength(0);

      await localService.destroy();
    });

    it('should return restartRequired: false for invalid install packageName', async () => {
      const result = await bus.request(PackageSubjects.install, {
        packageNames: [''],
      });

      expectInvalidMutationResult(result, '');
    });

    it('should return restartRequired: false for invalid uninstall packageName', async () => {
      const result = await bus.request(PackageSubjects.uninstall, {
        packageName: '',
      });

      expectInvalidMutationResult(result, '');
    });

    it('should register packages.getLatestVersion handler', async () => {
      const result = await bus.request(PackageSubjects.getLatestVersion, {
        packageName: '@makaio/ai-adapters-claude-code',
      });

      expect(result.success).toBe(true);
      expect(result.packageName).toBe('@makaio/ai-adapters-claude-code');
      expect(result.latestVersion).toBe('2.0.0');
    });

    it('should register packages.getRegistry handler and return registry data', async () => {
      const result = await bus.request(PackageSubjects.getRegistry, {});

      expect(result.adapters).toHaveLength(1);
      expect(result.extensions).toHaveLength(1);
    });

    it('should use the injected package registry service when provided', async () => {
      const emptyBus = createBusInstance({ context: createBusContext() });
      const registry: PackageRegistry = {
        $schema: 'makaio/package-registry/v1',
        updatedAt: '2026-05-17T00:00:00Z',
        adapters: [],
        extensions: [],
      };
      const emptyService = new PackageManagerService(emptyBus, '/tmp/.makaio', {
        yarnManager: new StubPackageManager([], new Map()),
        localInstaller: new StubLocalInstaller(),
        registryService: { getRegistry: async () => registry },
      });
      await emptyService.init();

      await expect(emptyBus.request(PackageSubjects.getRegistry, {})).resolves.toEqual(registry);

      await emptyService.destroy();
    });

    it('should check for updates using semver comparison', async () => {
      const result = await bus.request(PackageSubjects.checkUpdates, {});

      expect(result.updates).toHaveLength(1);
      expect(result.updates[0]?.name).toBe('@makaio/ai-adapters-claude-code');
      expect(result.updates[0]?.currentVersion).toBe('1.0.0');
      expect(result.updates[0]?.latestVersion).toBe('2.0.0');
    });
  });

  describe('lifecycle', () => {
    it('should be idempotent for init', async () => {
      await service.init();
      await service.init(); // Should not throw
    });

    it('should be idempotent for destroy', async () => {
      await service.destroy();
      await service.destroy(); // Should not throw
    });

    it('should unregister handlers on destroy', async () => {
      await service.destroy();

      await expect(async () => {
        await bus.request(PackageSubjects.list, {});
      }).rejects.toThrow();
    });
  });

  describe('dependency resolver injection', () => {
    it('uses the default dependency resolver with injected yarn manager and registry service', async () => {
      const registry: PackageRegistry = {
        $schema: 'makaio/package-registry/v1',
        updatedAt: '2026-05-17T00:00:00Z',
        adapters: [],
        extensions: [
          {
            name: '@acme/prompt-tools',
            descriptorName: 'prompt-tools',
            displayName: 'Prompt Tools',
            description: 'Prompt helper extension',
            tags: ['test'],
          },
        ],
      };
      const descriptors = new Map<string, ExtensionDescriptor>([
        ['@acme/root', createDescriptor('root', [{ type: 'extension', name: 'prompt-tools', version: '^1.0.0' }])],
        ['@acme/prompt-tools', createDescriptor('prompt-tools')],
      ]);
      const localYarnManager = new StubPackageManager([], new Map(), descriptors);
      const localBus = createBusInstance({ context: createBusContext() });
      const localService = new PackageManagerService(localBus, '/tmp/.makaio', {
        yarnManager: localYarnManager,
        localInstaller: new StubLocalInstaller(),
        registryService: { getRegistry: async () => registry },
        frameworkPeerRange: '^0.1.0',
      });
      await localService.init();

      const result = await localBus.request(PackageSubjects.install, {
        packageNames: ['@acme/root'],
      });

      expect(result.success).toBe(true);
      expect(result.installed).toEqual([
        { npmName: '@acme/root', version: '1.0.0', source: 'new' },
        { npmName: '@acme/prompt-tools', version: '1.0.0', source: 'new' },
      ]);
      expect(localYarnManager.ensuredFrameworkDependencies).toEqual([{ versionRange: '^0.1.0' }]);

      await localService.destroy();
    });

    it('delegates npm installs to dependency resolver when configured', async () => {
      const resolver = new StubDependencyResolver();
      const localBus = createBusInstance({ context: createBusContext() });
      const localService = new PackageManagerService(localBus, '/tmp/.makaio', {
        yarnManager: new StubPackageManager([], new Map()),
        localInstaller: new StubLocalInstaller(),
        dependencyResolver: resolver,
      });
      await localService.init();

      const result = await localBus.request(PackageSubjects.install, {
        packageNames: ['@makaio/adapter-claude-code-tmux', '@makaio/extension-prompt'],
        force: true,
      });

      expect(result.success).toBe(true);
      expect(result.installed).toHaveLength(2);
      expect(resolver.calls).toEqual([
        { roots: ['@makaio/adapter-claude-code-tmux', '@makaio/extension-prompt'], force: true },
      ]);

      await localService.destroy();
    });

    it('restores the full npm manifest snapshot when dependency resolution fails after framework peer setup', async () => {
      const resolver = new StubDependencyResolver(new Error('resolver failed'));
      const localYarnManager = new StubPackageManager([], new Map());
      const localBus = createBusInstance({ context: createBusContext() });
      const localService = new PackageManagerService(localBus, '/tmp/.makaio', {
        yarnManager: localYarnManager,
        localInstaller: new StubLocalInstaller(),
        dependencyResolver: resolver,
        frameworkPeerRange: '^0.1.0',
      });
      await localService.init();

      const result = await localBus.request(PackageSubjects.install, {
        packageNames: ['@makaio/adapter-claude-code-tmux'],
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('resolver failed');
      expect(localYarnManager.ensuredFrameworkDependencies).toEqual([{ versionRange: '^0.1.0' }]);
      expect(localYarnManager.restoreCount).toBe(1);

      await localService.destroy();
    });
  });
});
