/**
 * Tests for the extension install/uninstall/list/update subcommands.
 *
 * The command registration assertions stay lightweight. Install behavior uses
 * package-manager seams so rollback invariants can be covered without invoking
 * the real filesystem, Yarn Berry, or the user makaio home directory.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { registerExtensionCommands } from '../extension-commands.js';
import type { PackageInfo } from '@makaio/services-package-manager/namespace';

const packageManagerMockState = vi.hoisted(() => ({
  packages: [] as PackageInfo[],
  latestVersions: new Map<string, string>(),
  manifestDependencies: new Set<string>(),
  installedPackages: [] as string[],
  ensuredFrameworkRanges: [] as string[],
  manifestRestores: 0,
  localInstalls: [] as string[],
  localUninstalls: [] as string[],
  localFailures: new Set<string>(),
  localUninstallFailures: new Set<string>(),
  resolverFailure: null as Error | null,
  resolverCalls: [] as Array<{ roots: readonly string[]; force?: boolean }>,
}));

vi.mock('@makaio/runtime-node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@makaio/runtime-node')>();
  return {
    ...actual,
    readFrameworkVersion: async () => '0.1.0',
    resolveMakaioHome: () => '/tmp/makaio-test-home',
  };
});

vi.mock('@makaio/services-package-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@makaio/services-package-manager')>();

  class MockYarnPackageManager {
    public constructor(_makaioHome: string) {}

    public async initialize(): Promise<void> {}

    public async listPackages(): Promise<PackageInfo[]> {
      return packageManagerMockState.packages;
    }

    public async getLatestVersion(packageName: string): Promise<string> {
      return packageManagerMockState.latestVersions.get(packageName) ?? 'unknown';
    }

    public async installPackage(packageName: string): Promise<string> {
      packageManagerMockState.installedPackages.push(packageName);
      return packageManagerMockState.latestVersions.get(packageName) ?? 'unknown';
    }

    public async ensureFrameworkDependency(dependency: { readonly versionRange: string }): Promise<void> {
      packageManagerMockState.ensuredFrameworkRanges.push(dependency.versionRange);
      packageManagerMockState.manifestDependencies.add('@makaio/framework');
    }

    public async readManifestSnapshot(): Promise<unknown> {
      return { dependencies: [...packageManagerMockState.manifestDependencies] };
    }

    public async writeManifestAndReinstall(snapshot: unknown): Promise<void> {
      const dependencies = (snapshot as { dependencies?: unknown }).dependencies;
      packageManagerMockState.manifestDependencies = new Set(
        Array.isArray(dependencies)
          ? dependencies.filter((dependency): dependency is string => typeof dependency === 'string')
          : [],
      );
      packageManagerMockState.manifestRestores += 1;
    }
  }

  class MockDependencyResolver {
    public async resolve(roots: readonly string[], options: { force?: boolean } = {}) {
      packageManagerMockState.resolverCalls.push({ roots, force: options.force });
      if (packageManagerMockState.resolverFailure) {
        throw packageManagerMockState.resolverFailure;
      }
      for (const root of roots) {
        packageManagerMockState.manifestDependencies.add(root);
      }
      return {
        installed: roots.map((npmName) => ({ npmName, version: '1.0.0', source: 'new' as const })),
        skipped: [],
        warnings: [],
      };
    }
  }

  class MockDescriptorNameResolver {
    public async resolveNpmPackageName(descriptorName: string): Promise<string> {
      return descriptorName;
    }
  }

  class MockRegistryService {
    public async getRegistry() {
      return { $schema: 'makaio/package-registry/v1', updatedAt: '', adapters: [], extensions: [] };
    }
  }

  class MockLocalPathInstaller {
    public constructor(_extensionsDir: string) {}

    public async install(sourcePath: string) {
      packageManagerMockState.localInstalls.push(sourcePath);
      if (packageManagerMockState.localFailures.has(sourcePath)) {
        return { success: false as const, packageName: '', error: `failed ${sourcePath}`, restartRequired: false };
      }
      const packageName = `local-${packageManagerMockState.localInstalls.length}`;
      return { success: true as const, packageName, version: '0.1.0', restartRequired: true };
    }

    public async uninstall(extensionName: string) {
      packageManagerMockState.localUninstalls.push(extensionName);
      if (packageManagerMockState.localUninstallFailures.has(extensionName)) {
        return {
          success: false as const,
          packageName: extensionName,
          error: `cleanup failed ${extensionName}`,
          restartRequired: false,
        };
      }
      return { success: true as const, packageName: extensionName, restartRequired: true };
    }

    public async list() {
      return [];
    }
  }

  return {
    ...actual,
    YarnPackageManager: MockYarnPackageManager,
    LocalPathInstaller: MockLocalPathInstaller,
    DependencyResolver: MockDependencyResolver,
    DescriptorNameResolver: MockDescriptorNameResolver,
    RegistryService: MockRegistryService,
  };
});

describe('extension install CLI commands', () => {
  let program: InstanceType<typeof Command>;

  beforeEach(() => {
    packageManagerMockState.packages = [];
    packageManagerMockState.latestVersions.clear();
    packageManagerMockState.manifestDependencies = new Set<string>();
    packageManagerMockState.installedPackages = [];
    packageManagerMockState.ensuredFrameworkRanges = [];
    packageManagerMockState.manifestRestores = 0;
    packageManagerMockState.localInstalls = [];
    packageManagerMockState.localUninstalls = [];
    packageManagerMockState.localFailures = new Set<string>();
    packageManagerMockState.localUninstallFailures = new Set<string>();
    packageManagerMockState.resolverFailure = null;
    packageManagerMockState.resolverCalls = [];
    process.exitCode = undefined;
    program = new Command();
    program.exitOverride();
    registerExtensionCommands(program);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should register extension install subcommand', () => {
    const ext = program.commands.find((c) => c.name() === 'extension');
    const install = ext?.commands.find((c) => c.name() === 'install');
    expect(install).toBeDefined();
    expect(install?.description()).toBe('Install extensions from npm or local paths');
  });

  it('registers install as variadic with force option', () => {
    const ext = program.commands.find((c) => c.name() === 'extension');
    const install = ext?.commands.find((c) => c.name() === 'install');

    expect(install?.registeredArguments[0]?.variadic).toBe(true);
    expect(install?.options.some((option) => option.long === '--force')).toBe(true);
  });

  it('installs multiple npm sources through dependency resolver', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    await program.parseAsync([
      'node',
      'test',
      'extension',
      'install',
      '@makaio/adapter-claude-code-tmux',
      '@makaio/extension-prompt',
      '--force',
    ]);

    expect(packageManagerMockState.resolverCalls).toEqual([
      {
        roots: ['@makaio/adapter-claude-code-tmux', '@makaio/extension-prompt'],
        force: true,
      },
    ]);
    expect(packageManagerMockState.ensuredFrameworkRanges).toEqual(['^0.1.0']);
    expect(infoSpy).toHaveBeenCalledWith('Restart makaio to activate.');
  });

  it('rolls back npm and local installs when a later local install fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    packageManagerMockState.localFailures.add('/tmp/second-local');

    await program.parseAsync([
      'node',
      'test',
      'extension',
      'install',
      '@makaio/extension-prompt',
      '/tmp/first-local',
      '/tmp/second-local',
    ]);

    expect(packageManagerMockState.resolverCalls).toEqual([{ roots: ['@makaio/extension-prompt'], force: undefined }]);
    expect(packageManagerMockState.localInstalls).toEqual(['/tmp/first-local', '/tmp/second-local']);
    expect(packageManagerMockState.localUninstalls).toEqual(['local-1']);
    expect(packageManagerMockState.manifestRestores).toBe(1);
    expect(packageManagerMockState.manifestDependencies.has('@makaio/extension-prompt')).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith('Install failed: failed /tmp/second-local');
  });

  it('rolls back framework peer changes when dependency resolution fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    packageManagerMockState.resolverFailure = new Error('resolver failed');

    await program.parseAsync(['node', 'test', 'extension', 'install', '@makaio/extension-prompt']);

    expect(packageManagerMockState.resolverCalls).toEqual([{ roots: ['@makaio/extension-prompt'], force: undefined }]);
    expect(packageManagerMockState.ensuredFrameworkRanges).toEqual(['^0.1.0']);
    expect(packageManagerMockState.manifestRestores).toBe(1);
    expect(packageManagerMockState.manifestDependencies.has('@makaio/framework')).toBe(false);
    expect(packageManagerMockState.manifestDependencies.has('@makaio/extension-prompt')).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith('Install failed: resolver failed');
  });

  it('surfaces local rollback cleanup failures', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    packageManagerMockState.localFailures.add('/tmp/second-local');
    packageManagerMockState.localUninstallFailures.add('local-1');

    await program.parseAsync([
      'node',
      'test',
      'extension',
      'install',
      '@makaio/extension-prompt',
      '/tmp/first-local',
      '/tmp/second-local',
    ]);

    expect(packageManagerMockState.localUninstalls).toEqual(['local-1']);
    expect(packageManagerMockState.manifestRestores).toBe(1);
    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      'Install failed: Install failed and local rollback failed: failed /tmp/second-local; rollback errors: cleanup failed local-1',
    );
  });

  it('should register extension uninstall subcommand', () => {
    const ext = program.commands.find((c) => c.name() === 'extension');
    const uninstall = ext?.commands.find((c) => c.name() === 'uninstall');
    expect(uninstall).toBeDefined();
    expect(uninstall?.description()).toBe('Uninstall an extension');
  });

  it('should register extension list subcommand', () => {
    const ext = program.commands.find((c) => c.name() === 'extension');
    const list = ext?.commands.find((c) => c.name() === 'list');
    expect(list).toBeDefined();
    expect(list?.description()).toBe('List installed extensions');
  });

  it('should register extension update subcommand', () => {
    const ext = program.commands.find((c) => c.name() === 'extension');
    const update = ext?.commands.find((c) => c.name() === 'update');
    expect(update).toBeDefined();
    expect(update?.description()).toBe('Update one or all installed extensions');
  });

  it('should skip update when latest version cannot be determined', async () => {
    packageManagerMockState.packages = [{ name: '@acme/weather-tools', version: '1.0.0', hasDescriptor: true }];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    await program.parseAsync(['node', 'test', 'extension', 'update']);

    expect(warnSpy).toHaveBeenCalledWith('Could not determine latest version for @acme/weather-tools; skipping.');
    expect(infoSpy).not.toHaveBeenCalledWith('@acme/weather-tools@1.0.0 is up to date.');
    expect(packageManagerMockState.installedPackages).toEqual([]);
  });

  it('should report up to date only when latest version matches installed version', async () => {
    packageManagerMockState.packages = [{ name: '@acme/weather-tools', version: '1.0.0', hasDescriptor: true }];
    packageManagerMockState.latestVersions.set('@acme/weather-tools', '1.0.0');
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    await program.parseAsync(['node', 'test', 'extension', 'update']);

    expect(infoSpy).toHaveBeenCalledWith('@acme/weather-tools@1.0.0 is up to date.');
    expect(packageManagerMockState.installedPackages).toEqual([]);
  });
});
