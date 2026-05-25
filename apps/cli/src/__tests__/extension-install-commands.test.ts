/**
 * Tests for the extension install/uninstall/list/update subcommands.
 *
 * The command registration assertions stay lightweight. Install behavior uses
 * package-manager seams backed by temporary package files so rollback and
 * manifest-sync invariants can be covered without invoking Yarn Berry or the
 * user makaio home directory.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from 'commander';
import { registerExtensionCommands } from '../extension-commands.js';
import type { ExtensionDescriptor } from '@makaio/contracts';
import type { PackageInfo } from '@makaio/services-package-manager/namespace';
import { makeTestRepo, writeTestManifest } from './manifest-test-helpers.js';

const packageManagerMockState = vi.hoisted(() => ({
  makaioHome: '',
  fakeRegistryRoot: '',
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
    resolveMakaioHome: () => packageManagerMockState.makaioHome,
  };
});

vi.mock('@makaio/services-package-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@makaio/services-package-manager')>();
  const fs = await import('node:fs/promises');
  const nodePath = await import('node:path');
  const { safeParseExtensionDescriptor } = await import('@makaio/contracts');

  type PackageJson = {
    readonly name?: string;
    readonly version?: string;
    readonly dependencies?: Record<string, string>;
  };

  const emptyManifest: PackageJson = {
    name: 'makaio-test-packages',
    version: '1.0.0',
    dependencies: {},
  };

  function packagePath(root: string, npmName: string): string {
    return nodePath.join(root, ...npmName.split('/'));
  }

  function extractNpmName(packageSpec: string): string {
    if (packageSpec.startsWith('@')) {
      const slashIndex = packageSpec.indexOf('/');
      if (slashIndex === -1) return packageSpec;
      const rangeMarker = packageSpec.indexOf('@', slashIndex + 1);
      return rangeMarker === -1 ? packageSpec : packageSpec.slice(0, rangeMarker);
    }

    const rangeMarker = packageSpec.indexOf('@');
    return rangeMarker === -1 ? packageSpec : packageSpec.slice(0, rangeMarker);
  }

  async function readJsonFile<T>(filePath: string): Promise<T | null> {
    try {
      return JSON.parse(await fs.readFile(filePath, 'utf-8')) as T;
    } catch (error) {
      if (
        error instanceof SyntaxError ||
        (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
      ) {
        return null;
      }
      throw error;
    }
  }

  async function readHomeManifest(makaioHome: string): Promise<PackageJson> {
    return (await readJsonFile<PackageJson>(nodePath.join(makaioHome, 'package.json'))) ?? emptyManifest;
  }

  async function writeHomeManifest(makaioHome: string, manifest: PackageJson): Promise<void> {
    await fs.mkdir(makaioHome, { recursive: true });
    await fs.writeFile(nodePath.join(makaioHome, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
    packageManagerMockState.manifestDependencies = new Set(Object.keys(manifest.dependencies ?? {}));
  }

  async function updateHomeDependency(makaioHome: string, npmName: string, versionRange: string): Promise<void> {
    const manifest = await readHomeManifest(makaioHome);
    await writeHomeManifest(makaioHome, {
      ...manifest,
      dependencies: { ...(manifest.dependencies ?? {}), [npmName]: versionRange },
    });
  }

  class MockYarnPackageManager {
    public constructor(private readonly makaioHome: string) {}

    public async initialize(): Promise<void> {
      await fs.mkdir(nodePath.join(this.makaioHome, 'node_modules'), { recursive: true });
      if ((await readJsonFile<PackageJson>(nodePath.join(this.makaioHome, 'package.json'))) === null) {
        await writeHomeManifest(this.makaioHome, emptyManifest);
      }
    }

    public async listPackages(): Promise<PackageInfo[]> {
      return packageManagerMockState.packages;
    }

    public async getLatestVersion(packageName: string): Promise<string> {
      return packageManagerMockState.latestVersions.get(packageName) ?? 'unknown';
    }

    public async installPackage(packageName: string): Promise<string> {
      if (packageManagerMockState.resolverFailure) {
        throw packageManagerMockState.resolverFailure;
      }

      const npmName = extractNpmName(packageName);
      packageManagerMockState.installedPackages.push(packageName);
      const registryPackagePath = packagePath(packageManagerMockState.fakeRegistryRoot, npmName);
      const installedPackagePath = packagePath(nodePath.join(this.makaioHome, 'node_modules'), npmName);
      const registryPackageJson = await readJsonFile<PackageJson>(nodePath.join(registryPackagePath, 'package.json'));
      const version = packageManagerMockState.latestVersions.get(npmName) ?? registryPackageJson?.version ?? 'unknown';

      await updateHomeDependency(this.makaioHome, npmName, version);
      await fs.mkdir(installedPackagePath, { recursive: true });
      await fs.writeFile(
        nodePath.join(installedPackagePath, 'package.json'),
        `${JSON.stringify({ name: npmName, version }, null, 2)}\n`,
        'utf-8',
      );

      const descriptor = await readJsonFile<unknown>(nodePath.join(registryPackagePath, 'descriptor.json'));
      if (descriptor !== null) {
        await fs.writeFile(
          nodePath.join(installedPackagePath, 'descriptor.json'),
          `${JSON.stringify(descriptor, null, 2)}\n`,
          'utf-8',
        );
      }

      return version;
    }

    public async ensureFrameworkDependency(dependency: { readonly versionRange: string }): Promise<void> {
      packageManagerMockState.ensuredFrameworkRanges.push(dependency.versionRange);
      await updateHomeDependency(this.makaioHome, '@makaio/framework', dependency.versionRange);
    }

    public async readManifestSnapshot(): Promise<unknown> {
      return readHomeManifest(this.makaioHome);
    }

    public async writeManifestAndReinstall(snapshot: unknown): Promise<void> {
      await writeHomeManifest(this.makaioHome, snapshot as PackageJson);
      packageManagerMockState.manifestRestores += 1;
    }

    public async readInstalledExtensionDescriptor(npmName: string) {
      const descriptor = await readJsonFile<unknown>(
        nodePath.join(this.makaioHome, 'node_modules', ...npmName.split('/'), 'descriptor.json'),
      );
      if (descriptor === null) {
        return null;
      }
      const result = safeParseExtensionDescriptor(descriptor);
      return result.success ? result.data : null;
    }

    public async listInstalledExtensionDescriptors() {
      const manifest = await readHomeManifest(this.makaioHome);
      const entries = await Promise.all(
        Object.keys(manifest.dependencies ?? {}).map(async (npmName) => {
          const descriptor = await this.readInstalledExtensionDescriptor(npmName);
          if (descriptor === null) return null;

          const packageJson = await readJsonFile<PackageJson>(
            nodePath.join(this.makaioHome, 'node_modules', ...npmName.split('/'), 'package.json'),
          );
          return { npmName, version: packageJson?.version ?? 'unknown', descriptor };
        }),
      );
      return entries.filter((entry): entry is NonNullable<(typeof entries)[number]> => entry !== null);
    }
  }

  class RecordingDependencyResolver extends actual.DependencyResolver {
    public override async resolve(
      roots: readonly string[],
      options: Parameters<InstanceType<typeof actual.DependencyResolver>['resolve']>[1] = {},
    ) {
      packageManagerMockState.resolverCalls.push({ roots, force: options.force });
      return super.resolve(roots, options);
    }
  }

  class MockDescriptorNameResolver extends actual.DescriptorNameResolver {
    public override async resolveNpmPackageName(descriptorName: string): Promise<string> {
      if (descriptorName.startsWith('@')) {
        return descriptorName;
      }
      return super.resolveNpmPackageName(descriptorName);
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
    DependencyResolver: RecordingDependencyResolver,
    DescriptorNameResolver: MockDescriptorNameResolver,
    RegistryService: MockRegistryService,
  };
});

function descriptor(
  name: string,
  version: string,
  dependencies: ExtensionDescriptor['dependencies'] = [],
): ExtensionDescriptor {
  return {
    name,
    displayName: name,
    version,
    makaio: { framework: '>=0.1.0' },
    entrypoints: { server: true },
    ...(dependencies.length > 0 ? { dependencies } : {}),
  };
}

async function writePublishedPackage(packageName: string, packageDescriptor: ExtensionDescriptor): Promise<void> {
  const packageRoot = path.join(packageManagerMockState.fakeRegistryRoot, ...packageName.split('/'));
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    path.join(packageRoot, 'package.json'),
    `${JSON.stringify({ name: packageName, version: packageDescriptor.version }, null, 2)}\n`,
    'utf-8',
  );
  await writeFile(
    path.join(packageRoot, 'descriptor.json'),
    `${JSON.stringify(packageDescriptor, null, 2)}\n`,
    'utf-8',
  );
}

describe('extension install CLI commands', () => {
  let program: InstanceType<typeof Command>;

  beforeEach(async () => {
    packageManagerMockState.makaioHome = mkdtempSync(path.join(tmpdir(), 'makaio-cli-home-'));
    packageManagerMockState.fakeRegistryRoot = mkdtempSync(path.join(tmpdir(), 'makaio-cli-registry-'));
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
    await writePublishedPackage(
      '@makaio/adapter-claude-code-tmux',
      descriptor('@makaio/adapter-claude-code-tmux', '1.0.0'),
    );
    await writePublishedPackage('@makaio/extension-prompt', descriptor('@makaio/extension-prompt', '1.0.0'));
    await writePublishedPackage(
      '@makaio/extension-parent',
      descriptor('@makaio/extension-parent', '1.0.0', [
        { type: 'extension', name: '@makaio/extension-child', version: '>=2.0.0' },
      ]),
    );
    await writePublishedPackage('@makaio/extension-child', descriptor('@makaio/extension-child', '2.0.0'));
    process.exitCode = undefined;
    program = new Command();
    program.exitOverride();
    registerExtensionCommands(program);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all([
      rm(packageManagerMockState.makaioHome, { recursive: true, force: true }),
      rm(packageManagerMockState.fakeRegistryRoot, { recursive: true, force: true }),
    ]);
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

  it('prints direct root installs without writing transitive dependencies to the manifest sync result', async () => {
    const repo = await makeTestRepo('makaio-extension-parent-sync-');
    const manifestPath = await writeTestManifest(repo, { extensions: [] });
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(repo);
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    await program.parseAsync(['node', 'test', 'extension', 'install', '@makaio/extension-parent']);

    expect(packageManagerMockState.resolverCalls).toEqual([{ roots: ['@makaio/extension-parent'], force: undefined }]);
    expect(infoSpy).toHaveBeenCalledWith('Installed @makaio/extension-parent@1.0.0');
    expect(infoSpy).toHaveBeenCalledWith('Installed @makaio/extension-child@2.0.0');
    expect(infoSpy).toHaveBeenCalledWith('Restart makaio to activate.');
    expect(JSON.parse(await readFile(manifestPath, 'utf-8')).extensions).toEqual(['@makaio/extension-parent@1.0.0']);
    cwdSpy.mockRestore();
  });

  it('returns only direct root specs in directNpm, excluding transitive dependencies', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});

    const { installExtensionSources } = await import('../extension-install-transaction.js');
    const result = await installExtensionSources(['@makaio/extension-parent']);

    expect(result.directNpm).toEqual([
      { packageName: '@makaio/extension-parent', version: '1.0.0', spec: '@makaio/extension-parent@1.0.0' },
    ]);
    expect(result.directNpm.map((r) => r.packageName)).not.toContain('@makaio/extension-child');
    expect(result.changed).toBe(true);
  });

  it('syncs bare npm installs into the project manifest as resolved exact pins', async () => {
    const repo = await makeTestRepo('makaio-extension-install-sync-');
    const manifestPath = await writeTestManifest(repo, { extensions: [] });
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(repo);
    vi.spyOn(console, 'info').mockImplementation(() => {});

    await program.parseAsync(['node', 'test', 'extension', 'install', '@makaio/extension-prompt']);

    expect(JSON.parse(await readFile(manifestPath, 'utf-8')).extensions).toEqual(['@makaio/extension-prompt@1.0.0']);
    cwdSpy.mockRestore();
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

  it('syncs existing project manifest pins after extension update', async () => {
    const repo = await makeTestRepo('makaio-extension-update-sync-');
    const manifestPath = await writeTestManifest(repo, {
      extensions: ['@acme/weather-tools@1.0.0'],
    });
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(repo);
    packageManagerMockState.packages = [
      { name: '@acme/weather-tools', version: '1.0.0', hasDescriptor: true },
      { name: '@acme/local-only', version: '1.0.0', hasDescriptor: true },
    ];
    packageManagerMockState.latestVersions.set('@acme/weather-tools', '1.1.0');
    packageManagerMockState.latestVersions.set('@acme/local-only', '2.0.0');
    vi.spyOn(console, 'info').mockImplementation(() => {});

    await program.parseAsync(['node', 'test', 'extension', 'update']);

    expect(JSON.parse(await readFile(manifestPath, 'utf-8')).extensions).toEqual(['@acme/weather-tools@1.1.0']);
    expect(packageManagerMockState.installedPackages).toEqual(['@acme/weather-tools', '@acme/local-only']);
    cwdSpy.mockRestore();
  });
});
