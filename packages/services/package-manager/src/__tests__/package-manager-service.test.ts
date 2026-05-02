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
  type PackageRegistryClient,
  type LocalInstallClient,
} from '../package-manager-service.js';

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
  public readonly ensuredFrameworkRanges: string[] = [];

  public constructor(
    private packages: PackageInfo[],
    private readonly latestVersions: Map<string, string>,
  ) {}

  public async initialize(): Promise<void> {}

  public async installPackage(packageName: string): Promise<string> {
    const version = this.latestVersions.get(packageName) ?? '1.0.0';
    this.packages = [
      ...this.packages.filter((pkg) => pkg.name !== packageName),
      { name: packageName, version, hasDescriptor: false },
    ];
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

  public async ensureFrameworkDependency(versionRange: string): Promise<void> {
    this.ensuredFrameworkRanges.push(versionRange);
  }
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
  public readonly installed: Array<{ name: string; version: string; sourcePath: string }> = [];

  public async install(sourcePath: string): Promise<PackageInstallResult> {
    const name = `local-ext-${this.installed.length}`;
    const version = '0.1.0';
    this.installed.push({ name, version, sourcePath });
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

  public async list(): Promise<Array<{ name: string; version: string; sourcePath: string; source: 'local' }>> {
    return this.installed.map((e) => ({ ...e, source: 'local' as const }));
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

      expect(result.packages).toEqual([{ name: 'local-ext-0', version: '0.1.0', hasDescriptor: true }]);

      await localService.destroy();
    });

    it('should install via npm by default (no source field)', async () => {
      const installedEvents: Array<{ packageName: string; version: string }> = [];
      const cleanup = bus.on(PackageSubjects.installed, (ctx) => {
        installedEvents.push(ctx.payload);
      });

      const result = await bus.request(PackageSubjects.install, {
        packageName: '@makaio/extension-github',
      });

      expect(result.success).toBe(true);
      expect(result.packageName).toBe('@makaio/extension-github');
      expect(result.version).toBe('1.0.0');
      expect(result.restartRequired).toBe(true);
      expect(packageManager.ensuredFrameworkRanges).toEqual(['^0.1.0']);
      expect(installedEvents).toEqual([{ packageName: '@makaio/extension-github', version: '1.0.0' }]);

      cleanup();
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
        packageName: '/tmp/my-local-ext',
        source: 'local',
      });

      expect(result.success).toBe(true);
      expect(result.packageName).toBe('local-ext-0');
      expect(result.restartRequired).toBe(true);
      expect(localInstaller.installed).toHaveLength(1);
      expect(localInstaller.installed[0]?.sourcePath).toBe('/tmp/my-local-ext');
      expect(localYarnManager.ensuredFrameworkRanges).toEqual([]);
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
        packageName: './my-local-ext',
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

      await bus.request(PackageSubjects.install, { packageName: '@makaio/extension-github' });

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
        packageName: '',
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

    it('should leave packages.getRegistry unhandled when no registryService is provided', async () => {
      const emptyBus = createBusInstance({ context: createBusContext() });
      const emptyService = new PackageManagerService(emptyBus, '/tmp/.makaio', {
        yarnManager: new StubPackageManager([], new Map()),
        localInstaller: new StubLocalInstaller(),
      });
      await emptyService.init();

      await expect(async () => {
        await emptyBus.request(PackageSubjects.getRegistry, {});
      }).rejects.toThrow();

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
});
