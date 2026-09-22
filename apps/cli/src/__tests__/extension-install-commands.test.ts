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
import type { TransitionOutcome } from '@makaio/kernel';
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
  /** Entries returned by the mocked `LocalPathInstaller.list()`; empty by default. */
  localExtensions: [] as Array<{
    readonly name: string;
    readonly version: string;
    readonly sourcePath: string;
    readonly source: 'local';
    readonly serverImportPath?: string;
    readonly critical?: boolean;
  }>,
  resolverFailure: null as Error | null,
  resolverCalls: [] as Array<{ roots: readonly string[]; force?: boolean }>,
  /** Number of times the mocked `PackageManager.listPackages()` was invoked. */
  listPackagesCallCount: 0,
}));

const enablementMockState = vi.hoisted(() => ({
  disabled: new Set<string>(),
  health: null as Record<string, unknown> | null,
  setEnabledResult: { success: true, outcome: 'applied' } as { success: boolean; outcome: TransitionOutcome },
  setEnabledError: null as Error | null,
  /** Number of times the mocked `kernel:extension.setEnabled` RPC was invoked. */
  setEnabledCallCount: 0,
  /** Number of times the mocked `loadExtensionEnablementStore` was invoked. */
  enablementStoreLoadCount: 0,
  /**
   * Result returned by the `kernel:extension.get` RPC. Defaults to no entry.
   * `extensionManaged` defaults to `true` when the entry itself is present —
   * matching every real descriptor-based extension — so only tests covering
   * the framework-package-collision path need to set it explicitly to `false`.
   */
  getResult: null as { extension: { error?: string; critical?: boolean; extensionManaged?: boolean } | null } | null,
  /** Thrown by the mocked `resolveClientAuth` when set, simulating a missing/rejected credential. */
  resolveAuthError: null as Error | null,
  /** Thrown by the mocked `connectBusClient` when set, simulating a connection-establishment failure. */
  connectError: null as Error | null,
  /** Result returned by the `kernel:extension.list` RPC. */
  listExtensions: [] as ReadonlyArray<{
    readonly name: string;
    readonly displayName: string;
    readonly state: string;
    readonly enabled: boolean;
    readonly critical?: boolean;
    readonly persistedEnabled?: boolean;
    readonly extensionManaged?: boolean;
  }>,
  /** Thrown by the mocked `kernel:extension.list` RPC when set. */
  listRequestError: null as Error | null,
  /**
   * Read failure the mocked enablement store reports, simulating a corrupt,
   * oversized, or unreadable `extensions.json`. Defaults to no failure.
   */
  readFailure: null as { readonly reason: string; readonly diagnostic: string } | null,
}));

vi.mock('@makaio/runtime-node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@makaio/runtime-node')>();
  return {
    ...actual,
    readFrameworkVersion: async () => '0.1.0',
    resolveMakaioHome: () => packageManagerMockState.makaioHome,
    loadExtensionEnablementStore: async (_makaioHome: string) => {
      enablementMockState.enablementStoreLoadCount += 1;
      return {
        readFailure: enablementMockState.readFailure ?? undefined,
        loadEnabled: (name: string): boolean | undefined =>
          enablementMockState.disabled.has(name) ? false : undefined,
        persistEnabled: async (name: string, enabled: boolean): Promise<void> => {
          if (enabled) {
            enablementMockState.disabled.delete(name);
          } else {
            enablementMockState.disabled.add(name);
          }
        },
      };
    },
  };
});

vi.mock('../bus-client.js', async (importOriginal) => {
  // Real `isAuthConnectionError` is preserved (not reimplemented here) so
  // list-command tests exercise the same classification the CLI ships with.
  const actual = await importOriginal<typeof import('../bus-client.js')>();
  return {
    ...actual,
    probeHealth: async () => enablementMockState.health,
    resolveClientAuth: (_health: unknown) => {
      if (enablementMockState.resolveAuthError) throw enablementMockState.resolveAuthError;
      return undefined;
    },
    connectBusClient: async () => {
      if (enablementMockState.connectError) throw enablementMockState.connectError;
      return {
        request: async (
          _subject: unknown,
          payload: Record<string, unknown>,
        ): Promise<
          | { success: boolean; outcome: TransitionOutcome }
          | { extension?: { error?: string; critical?: boolean; extensionManaged: boolean } | null }
          | { extensions: typeof enablementMockState.listExtensions }
        > => {
          // `list`'s request payload is `{}`, distinct from `get`'s `{name}`
          // and `setEnabled`'s `{name, enabled}` — checked in that order.
          if ('enabled' in payload) {
            enablementMockState.setEnabledCallCount += 1;
            if (enablementMockState.setEnabledError) throw enablementMockState.setEnabledError;
            // A real coordinator's own `persistEnabled` call is the file's sole
            // writer once a server is reachable (the CLI writes nothing itself
            // in this path — see `applyLiveToggle`). `setEnabled` is
            // persist-only: it writes the requested preference for every
            // outcome except `'rejected'`, which never writes at all (an
            // unknown name or a critical-extension refusal). This mock bypasses
            // the coordinator, so it reproduces that write here, keyed off
            // `outcome`, instead of a separate ad hoc flag that could drift
            // from what `outcome` implies.
            const name = String(payload['name']);
            const requestedEnabled = payload['enabled'] === true;
            if (enablementMockState.setEnabledResult.outcome !== 'rejected') {
              if (requestedEnabled) enablementMockState.disabled.delete(name);
              else enablementMockState.disabled.add(name);
            }
            return enablementMockState.setEnabledResult;
          }
          if ('name' in payload) {
            // extension.get — return getResult or a bare null-extension response.
            // `extensionManaged` defaults to `true` when the entry is present and
            // the test did not specify it — see `getResult`'s own doc.
            if (!enablementMockState.getResult) return { extension: null };
            const { extension } = enablementMockState.getResult;
            return {
              extension: extension && { extensionManaged: true, ...extension },
            };
          }
          // extension.list
          if (enablementMockState.listRequestError) throw enablementMockState.listRequestError;
          return { extensions: enablementMockState.listExtensions };
        },
        disconnect: () => undefined,
      };
    },
  };
});

vi.mock('@makaio/runtime-node/makaio-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@makaio/runtime-node/makaio-config')>();
  return {
    ...actual,
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
      packageManagerMockState.listPackagesCallCount += 1;
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
      return packageManagerMockState.localExtensions;
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
  critical?: boolean,
): ExtensionDescriptor {
  return {
    name,
    displayName: name,
    version,
    makaio: { framework: '>=0.1.0' },
    entrypoints: { server: true },
    ...(dependencies.length > 0 ? { dependencies } : {}),
    ...(critical !== undefined && { critical }),
  };
}

/**
 * Write a real `descriptor.json` into a project's own `node_modules`, so
 * {@link FilesystemDescriptorDiscovery} — the runtime's actual discovery
 * class, unmocked here — can scan it exactly as it would at boot.
 * @param projectRoot - Absolute project root (the directory the CLI is
 *   invoked from; tests point `process.cwd()` at this).
 * @param packageDescriptor - Descriptor to write for the project-local package.
 */
async function writeProjectLocalDescriptor(projectRoot: string, packageDescriptor: ExtensionDescriptor): Promise<void> {
  const packageRoot = path.join(projectRoot, 'node_modules', ...packageDescriptor.name.split('/'));
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    path.join(packageRoot, 'descriptor.json'),
    `${JSON.stringify(packageDescriptor, null, 2)}\n`,
    'utf-8',
  );
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
    packageManagerMockState.listPackagesCallCount = 0;
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
    expect(list?.description()).toBe('List installed extensions with runtime state when a server is reachable');
  });

  it('should register extension enable subcommand', () => {
    const ext = program.commands.find((c) => c.name() === 'extension');
    const enable = ext?.commands.find((c) => c.name() === 'enable');
    expect(enable).toBeDefined();
    expect(enable?.description()).toBe(
      'Enable an extension (persists the preference; takes effect on the next server start)',
    );
  });

  it('should register extension disable subcommand', () => {
    const ext = program.commands.find((c) => c.name() === 'extension');
    const disable = ext?.commands.find((c) => c.name() === 'disable');
    expect(disable).toBeDefined();
    expect(disable?.description()).toBe(
      'Disable an extension (persists the preference; takes effect on the next server start)',
    );
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

describe('extension enable/disable commands', () => {
  let program: InstanceType<typeof Command>;

  beforeEach(() => {
    enablementMockState.disabled.clear();
    enablementMockState.health = null;
    enablementMockState.setEnabledResult = { success: true, outcome: 'applied' };
    enablementMockState.setEnabledError = null;
    enablementMockState.setEnabledCallCount = 0;
    enablementMockState.enablementStoreLoadCount = 0;
    enablementMockState.getResult = null;
    enablementMockState.resolveAuthError = null;
    enablementMockState.connectError = null;
    enablementMockState.listExtensions = [];
    enablementMockState.listRequestError = null;
    enablementMockState.readFailure = null;
    packageManagerMockState.packages = [];
    packageManagerMockState.localExtensions = [];
    packageManagerMockState.listPackagesCallCount = 0;
    packageManagerMockState.makaioHome = mkdtempSync(path.join(tmpdir(), 'makaio-cli-enable-'));
    delete process.env.MAKAIO_BUS_URL;
    process.exitCode = undefined;
    vi.restoreAllMocks();
    // The offline listing's project-local discovery tier scans
    // `{cwd}/node_modules` for real (unmocked — see `FilesystemDescriptorDiscovery`),
    // so without this the test runner's own checkout — which has real
    // extension descriptors under its workspace `node_modules` — would leak
    // into every offline listing assertion below. `makaioHome` is a fresh,
    // empty directory per test, so its `node_modules` (created empty by the
    // mocked `YarnPackageManager.initialize()`) is a safe stand-in; tests that
    // exercise the project-local tier itself override this explicitly.
    vi.spyOn(process, 'cwd').mockReturnValue(packageManagerMockState.makaioHome);
    program = new Command();
    registerExtensionCommands(program);
  });

  afterEach(() => {
    process.exitCode = undefined;
    delete process.env.MAKAIO_BUS_URL;
  });

  it('writes the enablement file and reports offline when no server is running', async () => {
    packageManagerMockState.packages = [{ name: 'my-ext', version: '1.0.0', hasDescriptor: true }];
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await program.parseAsync(['extension', 'enable', 'my-ext'], { from: 'user' });
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Persisted; no running server'));
    expect(enablementMockState.disabled.has('my-ext')).toBe(false);
  });

  it('writes the disabled entry and reports offline when no server is running', async () => {
    packageManagerMockState.packages = [{ name: 'my-ext', version: '1.0.0', hasDescriptor: true }];
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await program.parseAsync(['extension', 'disable', 'my-ext'], { from: 'user' });
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Persisted; no running server'));
    expect(enablementMockState.disabled.has('my-ext')).toBe(true);
  });

  it('refuses to persist offline for an unknown name, leaving the enablement file untouched', async () => {
    // No packages installed at all — 'my-ext' is a pure typo from the CLI's
    // perspective, exactly the case the offline path must not silently accept.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await program.parseAsync(['extension', 'disable', 'my-ext'], { from: 'user' });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('no installed extension with this name'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('makaio extension list'));
    expect(enablementMockState.disabled.has('my-ext')).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it('refuses to persist offline when the configured bus is remote and unreachable, writing nothing locally', async () => {
    process.env.MAKAIO_BUS_URL = 'ws://build-server.internal:6252/bus';
    packageManagerMockState.packages = [{ name: 'remote-ext', version: '1.0.0', hasDescriptor: true }];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'disable', 'remote-ext'], { from: 'user' });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('the configured server at ws://build-server.internal:6252/bus is unreachable'),
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('run this command on that host'));
    // The offline write path is only correct for a local bus — an
    // unreachable remote server's enablement file is not this machine's.
    expect(enablementMockState.disabled.has('remote-ext')).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it('still writes offline when the configured bus URL is explicitly local and unreachable', async () => {
    process.env.MAKAIO_BUS_URL = 'ws://127.0.0.1:6252/bus';
    packageManagerMockState.packages = [{ name: 'my-ext', version: '1.0.0', hasDescriptor: true }];
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'enable', 'my-ext'], { from: 'user' });

    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Persisted; no running server'));
    expect(enablementMockState.disabled.has('my-ext')).toBe(false);
    expect(process.exitCode).toBeUndefined();
  });

  it('refuses to fall back to the offline listing when the configured bus is remote and unreachable', async () => {
    process.env.MAKAIO_BUS_URL = 'ws://build-server.internal:6252/bus';
    // Installed locally, so a wrongly-taken offline fallback would list it —
    // this name must never appear in the output.
    packageManagerMockState.packages = [{ name: 'local-only-ext', version: '1.0.0', hasDescriptor: true }];
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'list'], { from: 'user' });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('the configured server at ws://build-server.internal:6252/bus is unreachable'),
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('run this command on that host'));
    expect(infoSpy).not.toHaveBeenCalledWith(expect.stringContaining('local-only-ext'));
    expect(process.exitCode).toBe(1);
  });

  it('still falls back to the offline listing when the configured bus URL is explicitly local and unreachable', async () => {
    process.env.MAKAIO_BUS_URL = 'ws://127.0.0.1:6252/bus';
    packageManagerMockState.packages = [{ name: 'my-ext', version: '1.0.0', hasDescriptor: true }];
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'list'], { from: 'user' });

    expect(infoSpy).toHaveBeenCalledWith('my-ext (1.0.0, npm) [enabled]');
    expect(process.exitCode).toBeUndefined();
  });

  it('reports live-applied when server is reachable and RPC succeeds', async () => {
    enablementMockState.health = { url: 'ws://localhost:1234' };
    // A non-null `extension` is what makes the server "manage" this name —
    // `kernel:extension.get` reporting an entry — so the request reaches
    // `setEnabled` instead of the unmanaged-name fallback.
    enablementMockState.getResult = { extension: {} };
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await program.parseAsync(['extension', 'enable', 'my-ext'], { from: 'user' });
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('already matches this state'));
  });

  it('writes nothing locally when the server throws applying the request outright', async () => {
    enablementMockState.health = { url: 'ws://localhost:1234' };
    enablementMockState.getResult = { extension: {} };
    enablementMockState.setEnabledError = new Error('transition failed');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await program.parseAsync(['extension', 'disable', 'my-ext'], { from: 'user' });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'request failed: transition failed. Nothing was written locally; the reachable server owns this preference.',
      ),
    );
    // The CLI never wrote a value of its own in the live path, so there is
    // nothing local to revert either.
    expect(enablementMockState.disabled.has('my-ext')).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it('leaves the recorded preference alone, not the inverse request, when the server throws applying it', async () => {
    // Re-disabling an already-disabled extension is a no-op write. A thrown
    // request must leave it disabled instead of flipping it on — the CLI
    // does not write anything of its own to flip in the live path.
    enablementMockState.disabled.add('my-ext');
    enablementMockState.health = { url: 'ws://localhost:1234' };
    enablementMockState.getResult = { extension: {} };
    enablementMockState.setEnabledError = new Error('transition failed');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'disable', 'my-ext'], { from: 'user' });

    expect(enablementMockState.disabled.has('my-ext')).toBe(true);
  });

  it('refuses to disable a critical extension reported by the running server', async () => {
    enablementMockState.health = { url: 'ws://localhost:1234' };
    enablementMockState.getResult = { extension: { critical: true } };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await program.parseAsync(['extension', 'disable', 'core-ext'], { from: 'user' });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('it is a critical extension'));
    expect(enablementMockState.disabled.has('core-ext')).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it('refuses to disable a critical extension offline, reading the flag from the installed descriptor', async () => {
    packageManagerMockState.packages = [{ name: 'core-ext', version: '1.0.0', hasDescriptor: true, critical: true }];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await program.parseAsync(['extension', 'disable', 'core-ext'], { from: 'user' });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('it is a critical extension'));
    expect(enablementMockState.disabled.has('core-ext')).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it('refuses to disable a critical extension installed from a local path, reading the flag exactly as it would for an npm install', async () => {
    // `LocalPathInstaller.list()` already carries the descriptor's `critical`
    // flag through `InstalledExtensionEntry` — the offline critical check
    // must see it identically regardless of whether the extension came from
    // npm or a local symlink.
    packageManagerMockState.localExtensions = [
      { name: 'core-local-ext', version: '1.0.0', sourcePath: '/tmp/core-local-ext', source: 'local', critical: true },
    ];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await program.parseAsync(['extension', 'disable', 'core-local-ext'], { from: 'user' });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('it is a critical extension'));
    expect(enablementMockState.disabled.has('core-local-ext')).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it('enabling a critical extension is never refused', async () => {
    packageManagerMockState.packages = [{ name: 'core-ext', version: '1.0.0', hasDescriptor: true, critical: true }];
    enablementMockState.disabled.add('core-ext');
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await program.parseAsync(['extension', 'enable', 'core-ext'], { from: 'user' });
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Persisted; no running server'));
    expect(enablementMockState.disabled.has('core-ext')).toBe(false);
  });

  it('reports a rejected request as unwritten when the server refuses it outright', async () => {
    enablementMockState.health = { url: 'ws://localhost:1234' };
    enablementMockState.setEnabledResult = { success: false, outcome: 'rejected' };
    enablementMockState.getResult = { extension: { error: 'active dependents remain: child' } };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await program.parseAsync(['extension', 'disable', 'dep-ext'], { from: 'user' });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('the request was rejected. Nothing was written.'));
    expect(enablementMockState.disabled.has('dep-ext')).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it('reports "not installed" when extension.get returns no entry and the name is not installed', async () => {
    enablementMockState.health = { url: 'ws://localhost:1234' };
    // getResult stays null → extension.get returns { extension: null }, and
    // packageManagerMockState.packages stays empty from beforeEach, so the
    // name is not installed either — the unmanaged-name fallback must not
    // silently persist a preference for a name nothing will ever read.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await program.parseAsync(['extension', 'enable', 'my-ext'], { from: 'user' });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('no installed extension with this name'));
    expect(enablementMockState.disabled.has('my-ext')).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it('persists directly and reports restart-required for an installed name absent from the coordinator', async () => {
    // The server is reachable and knows the extension is installed (surfaced
    // through the package manager), but never loaded it into its coordinator
    // — interactive-only on a headless server, unmet `requires`, or
    // `MAKAIO_SKIP_EXTENSIONS`. `kernel:extension.get` reports `null` for it,
    // so the CLI must write the preference itself instead of forwarding to
    // `setEnabled`, which has nothing to compare against for this name.
    enablementMockState.health = { url: 'ws://localhost:1234' };
    packageManagerMockState.packages = [{ name: 'my-ext', version: '1.0.0', hasDescriptor: true }];
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await program.parseAsync(['extension', 'enable', 'my-ext'], { from: 'user' });
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('not loaded in the running server'));
    expect(enablementMockState.disabled.has('my-ext')).toBe(false);
    expect(process.exitCode).toBeUndefined();
  });

  it('refuses to disable a critical extension absent from the coordinator, reading the flag from the installed descriptor', async () => {
    enablementMockState.health = { url: 'ws://localhost:1234' };
    packageManagerMockState.packages = [{ name: 'core-ext', version: '1.0.0', hasDescriptor: true, critical: true }];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await program.parseAsync(['extension', 'disable', 'core-ext'], { from: 'user' });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('it is a critical extension'));
    expect(enablementMockState.disabled.has('core-ext')).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it('lists a hand-disabled critical extension as enabled, matching what boot does with it', async () => {
    packageManagerMockState.packages = [
      { name: 'core-ext', version: '1.0.0', hasDescriptor: true, critical: true },
      { name: 'plain-ext', version: '2.0.0', hasDescriptor: true },
    ];
    enablementMockState.disabled.add('core-ext');
    enablementMockState.disabled.add('plain-ext');
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'list'], { from: 'user' });

    expect(infoSpy).toHaveBeenCalledWith('core-ext (1.0.0, npm) [enabled]');
    expect(infoSpy).toHaveBeenCalledWith('plain-ext (2.0.0, npm) [disabled]');
  });

  it("surfaces a live-disabled extension's still-enabled durable preference in the live listing", async () => {
    // `setEnabled` is persist-only, so a live disable of an active extension
    // leaves `enabled: true` until the next restart while `persistedEnabled`
    // already reads `false` live from the coordinator's `loadEnabled`
    // callback — the label must show both, not just the stale runtime state.
    enablementMockState.health = { url: 'ws://localhost:1234' };
    enablementMockState.listExtensions = [
      {
        name: 'restart-pending-ext',
        displayName: 'Restart Pending',
        state: 'active',
        enabled: true,
        persistedEnabled: false,
      },
    ];
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'list'], { from: 'user' });

    expect(infoSpy).toHaveBeenCalledWith('Restart Pending (restart-pending-ext) [active, disabled after restart]');
  });

  it("surfaces a boot-disabled extension's now-enabled durable preference in the live listing", async () => {
    // The inverse divergence: the runtime still reports the entry as
    // disabled (no restart has applied the new preference yet), but the
    // durable preference already reads enabled.
    enablementMockState.health = { url: 'ws://localhost:1234' };
    enablementMockState.listExtensions = [
      {
        name: 'restart-pending-ext',
        displayName: 'Restart Pending',
        state: 'skipped',
        enabled: false,
        persistedEnabled: true,
      },
    ];
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'list'], { from: 'user' });

    expect(infoSpy).toHaveBeenCalledWith('Restart Pending (restart-pending-ext) [disabled, enabled after restart]');
  });

  it("surfaces a hand-disabled critical extension's permanently-ignored durable disable, instead of falsely promising it takes effect after restart", async () => {
    // The coordinator force-starts a critical extension on every boot
    // regardless of the enablement file, so `enabled: true` alongside
    // `persistedEnabled: false` for a critical entry never transitions to
    // disabled on the next restart — the "disabled after restart" label
    // would be a false promise here.
    enablementMockState.health = { url: 'ws://localhost:1234' };
    enablementMockState.listExtensions = [
      {
        name: 'critical-ext',
        displayName: 'Critical Ext',
        state: 'active',
        enabled: true,
        persistedEnabled: false,
        critical: true,
      },
    ];
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'list'], { from: 'user' });

    expect(infoSpy).toHaveBeenCalledWith('Critical Ext (critical-ext) [active, durable disable ignored (critical)]');
    expect(infoSpy).not.toHaveBeenCalledWith(expect.stringContaining('disabled after restart'));
  });

  it('keeps the restart-pending label for a non-critical divergence, unaffected by the critical-specific label', async () => {
    // Control case for the previous test: the same enabled/persistedEnabled
    // divergence, but non-critical, must keep the existing restart-pending
    // label rather than the critical-specific override.
    enablementMockState.health = { url: 'ws://localhost:1234' };
    enablementMockState.listExtensions = [
      {
        name: 'non-critical-ext',
        displayName: 'Non-Critical Ext',
        state: 'active',
        enabled: true,
        persistedEnabled: false,
        critical: false,
      },
    ];
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'list'], { from: 'user' });

    expect(infoSpy).toHaveBeenCalledWith('Non-Critical Ext (non-critical-ext) [active, disabled after restart]');
  });

  it('keeps the compact live label when the runtime state and durable preference agree', async () => {
    enablementMockState.health = { url: 'ws://localhost:1234' };
    enablementMockState.listExtensions = [
      { name: 'steady-ext', displayName: 'Steady', state: 'active', enabled: true, persistedEnabled: true },
    ];
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'list'], { from: 'user' });

    expect(infoSpy).toHaveBeenCalledWith('Steady (steady-ext) [active]');
  });

  it('keeps the compact live label when the coordinator has no durable-preference reader', async () => {
    // `persistedEnabled` is omitted entirely (not `false`) when the
    // coordinator was built without a `loadEnabled` reader — there is no
    // durable preference to compare against, so the label must not claim a
    // divergence that cannot be known.
    enablementMockState.health = { url: 'ws://localhost:1234' };
    enablementMockState.listExtensions = [
      { name: 'no-reader-ext', displayName: 'No Reader', state: 'active', enabled: true },
    ];
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'list'], { from: 'user' });

    expect(infoSpy).toHaveBeenCalledWith('No Reader (no-reader-ext) [active]');
  });

  /**
   * Write a real, dynamically-importable server entrypoint module exporting a
   * descriptor's own package alongside one dot-prefixed child package, so the
   * offline listing's `import()` of `serverImportPath` (unmocked — this is the
   * real production code path) resolves it exactly as the runtime would.
   * @param descriptorName - Parent descriptor package name.
   * @param childName - Dot-prefixed child package name.
   * @param childCritical - Critical flag the child package declares on itself.
   * @returns Absolute path to the written `.mjs` module.
   */
  async function writeMultiPackageServerEntry(
    descriptorName: string,
    childName: string,
    childCritical = false,
  ): Promise<string> {
    const moduleDir = path.join(packageManagerMockState.makaioHome, 'fixture-packages', descriptorName);
    await mkdir(moduleDir, { recursive: true });
    const modulePath = path.join(moduleDir, 'server.mjs');
    await writeFile(
      modulePath,
      `export default [\n` +
        `  { name: ${JSON.stringify(descriptorName)}, displayName: 'Parent', version: '0.1.0' },\n` +
        `  { name: ${JSON.stringify(childName)}, displayName: 'Child', version: '0.1.0', critical: ${childCritical} },\n` +
        `];\n`,
      'utf-8',
    );
    return modulePath;
  }

  it('lists every executable child package a descriptor exports, each with its own persisted preference', async () => {
    const serverImportPath = await writeMultiPackageServerEntry('makaio-dev', 'makaio-dev.relay-connection');
    packageManagerMockState.packages = [
      { name: 'makaio-dev', version: '0.1.0', hasDescriptor: true, serverImportPath },
    ];
    enablementMockState.disabled.add('makaio-dev.relay-connection');
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'list'], { from: 'user' });

    expect(infoSpy).toHaveBeenCalledWith('makaio-dev (0.1.0, npm) [enabled]');
    expect(infoSpy).toHaveBeenCalledWith('makaio-dev.relay-connection (0.1.0, npm) [disabled]');
  });

  it("keeps a child package's persisted disabled preference visible in the offline listing after the server stops", async () => {
    const serverImportPath = await writeMultiPackageServerEntry('makaio-dev', 'makaio-dev.relay-connection');
    packageManagerMockState.packages = [
      { name: 'makaio-dev', version: '0.1.0', hasDescriptor: true, serverImportPath },
    ];

    // Server is running and does not manage this child (coordinator returns
    // no entry for it), so the live toggle path writes the enablement file
    // itself — see `applyUnmanagedNameToggle`.
    enablementMockState.health = { url: 'ws://localhost:1234' };
    enablementMockState.getResult = { extension: null };
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await program.parseAsync(['extension', 'disable', 'makaio-dev.relay-connection'], { from: 'user' });
    expect(enablementMockState.disabled.has('makaio-dev.relay-connection')).toBe(true);

    // Server stops.
    enablementMockState.health = null;
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await program.parseAsync(['extension', 'list'], { from: 'user' });

    expect(infoSpy).toHaveBeenCalledWith('makaio-dev.relay-connection (0.1.0, npm) [disabled]');
  });

  it('disables a child package name entirely offline', async () => {
    const serverImportPath = await writeMultiPackageServerEntry('makaio-dev', 'makaio-dev.relay-connection');
    packageManagerMockState.packages = [
      { name: 'makaio-dev', version: '0.1.0', hasDescriptor: true, serverImportPath },
    ];
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'disable', 'makaio-dev.relay-connection'], { from: 'user' });

    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('Extension "makaio-dev.relay-connection" disabled. Persisted; no running server'),
    );
    expect(enablementMockState.disabled.has('makaio-dev.relay-connection')).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it('reports the auth failure instead of silently falling back to the offline listing', async () => {
    // Health probe succeeded (the server IS running), but this client cannot
    // authenticate to it — MAKAIO_BUS_SECRET is absent, mirroring
    // resolveClientAuth's real throw.
    enablementMockState.health = { url: 'ws://localhost:1234', auth: true };
    enablementMockState.resolveAuthError = new Error(
      'Server requires authentication. Set MAKAIO_BUS_SECRET to connect.',
    );
    packageManagerMockState.packages = [{ name: 'plain-ext', version: '2.0.0', hasDescriptor: true }];
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'list'], { from: 'user' });

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('MAKAIO_BUS_SECRET'));
    // The offline listing must not print as if no server were running.
    expect(infoSpy).not.toHaveBeenCalledWith(expect.stringContaining('plain-ext'));
    expect(process.exitCode).toBe(1);
  });

  it('reports a live RPC failure instead of falling back to the offline listing', async () => {
    // Connection succeeds — the server is unambiguously reachable — but the
    // `kernel:extension.list` request itself fails.
    enablementMockState.health = { url: 'ws://localhost:1234' };
    enablementMockState.listRequestError = new Error('internal kernel error');
    packageManagerMockState.packages = [{ name: 'plain-ext', version: '2.0.0', hasDescriptor: true }];
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'list'], { from: 'user' });

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('internal kernel error'));
    expect(infoSpy).not.toHaveBeenCalledWith(expect.stringContaining('plain-ext'));
    expect(process.exitCode).toBe(1);
  });

  it('falls back to the offline listing when the server becomes unreachable after a successful health probe', async () => {
    // A non-auth transport failure while connecting — the health probe raced
    // with the server going down — is the one case that still falls through.
    enablementMockState.health = { url: 'ws://localhost:1234' };
    enablementMockState.connectError = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    packageManagerMockState.packages = [{ name: 'plain-ext', version: '2.0.0', hasDescriptor: true }];
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'list'], { from: 'user' });

    expect(infoSpy).toHaveBeenCalledWith('plain-ext (2.0.0, npm) [enabled]');
    expect(process.exitCode).toBeUndefined();
  });

  it('refuses to fall back to the offline listing when a remote health probe succeeds but the connection then fails for a non-auth reason', async () => {
    // The same probe/connect race as the loopback case above, but against a
    // remote `MAKAIO_BUS_URL` — a remote target must refuse identically to
    // an outright-failed health probe rather than silently reporting this
    // machine's own installs as the configured server's state.
    process.env.MAKAIO_BUS_URL = 'ws://build-server.internal:6252/bus';
    enablementMockState.health = { url: 'ws://build-server.internal:6252/bus' };
    enablementMockState.connectError = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    packageManagerMockState.packages = [{ name: 'local-only-ext', version: '1.0.0', hasDescriptor: true }];
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'list'], { from: 'user' });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('the configured server at ws://build-server.internal:6252/bus is unreachable'),
    );
    expect(infoSpy).not.toHaveBeenCalledWith(expect.stringContaining('local-only-ext'));
    expect(process.exitCode).toBe(1);
  });

  it('surfaces extension entry error and defers to next boot when the outcome is restart-required', async () => {
    enablementMockState.health = { url: 'ws://localhost:1234' };
    enablementMockState.setEnabledResult = { success: false, outcome: 'restart-required' };
    enablementMockState.getResult = {
      extension: { error: 'restart required: runtimeOwnership extension was never started this boot' },
    };
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await program.parseAsync(['extension', 'enable', 'my-ext'], { from: 'user' });
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('restart required: runtimeOwnership extension was never started this boot'),
    );
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('The preference will take effect on next boot.'));
  });

  it('warns and exits non-zero when the enablement file could not be read, but still lists installed extensions', async () => {
    enablementMockState.readFailure = {
      reason: 'not-json',
      diagnostic:
        'Enablement file at "/fake/config/extensions.json" contains invalid JSON; treating all extensions as enabled.',
    };
    packageManagerMockState.packages = [{ name: 'plain-ext', version: '2.0.0', hasDescriptor: true }];
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'list'], { from: 'user' });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('extension enablement preferences could not be read'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('contains invalid JSON'));
    // The listing still runs — it reports what is installed even though the
    // preferences behind it could not be trusted.
    expect(infoSpy).toHaveBeenCalledWith('plain-ext (2.0.0, npm) [enabled]');
    expect(process.exitCode).toBe(1);
  });

  it('warns and exits non-zero when the enablement file could not be read for a local live listing', async () => {
    // The local-live branch (a reachable server on the loopback bus) must
    // still surface a broken enablement file — only the remote-live branch
    // below is exempt, since it never reads this machine's file at all.
    enablementMockState.health = { url: 'ws://localhost:1234' };
    enablementMockState.listExtensions = [
      { name: 'loaded-ext', displayName: 'Loaded Ext', state: 'active', enabled: true },
    ];
    enablementMockState.readFailure = {
      reason: 'not-json',
      diagnostic:
        'Enablement file at "/fake/config/extensions.json" contains invalid JSON; treating all extensions as enabled.',
    };
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'list'], { from: 'user' });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('extension enablement preferences could not be read'));
    expect(infoSpy).toHaveBeenCalledWith('Loaded Ext (loaded-ext) [active]');
    expect(process.exitCode).toBe(1);
  });

  it('never loads or warns about a broken local enablement file when a remote server answers the live listing', async () => {
    // `printRemoteLiveListing` never uses local enablement preferences, so
    // the local file's read failure must never even be attempted for a
    // remote target — no warning, no exit-1 side effect, and the remote
    // snapshot is shown normally.
    process.env.MAKAIO_BUS_URL = 'ws://build-server.internal:6252/bus';
    enablementMockState.health = { url: 'ws://build-server.internal:6252/bus' };
    enablementMockState.listExtensions = [
      { name: 'remote-ext', displayName: 'Remote Ext', state: 'active', enabled: true },
    ];
    enablementMockState.readFailure = {
      reason: 'not-json',
      diagnostic: 'Enablement file at "/fake/config/extensions.json" contains invalid JSON.',
    };
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'list'], { from: 'user' });

    expect(warnSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith('Remote Ext (remote-ext) [active]');
    expect(process.exitCode).toBeUndefined();
    // The local enablement file is never even opened for a remote target.
    expect(enablementMockState.enablementStoreLoadCount).toBe(0);
  });

  it('merges an installed-but-not-loaded name into the live listing with its persisted preference', async () => {
    enablementMockState.health = { url: 'ws://localhost:1234' };
    enablementMockState.listExtensions = [
      { name: 'loaded-ext', displayName: 'Loaded Ext', state: 'active', enabled: true },
    ];
    // `never-loaded` is installed but absent from the coordinator's live
    // snapshot (interactive-only, unmet requires, or MAKAIO_SKIP_EXTENSIONS)
    // yet has a persisted disable — exactly the case the unmanaged-name
    // toggle fallback addresses, so the live listing must surface it too.
    packageManagerMockState.packages = [{ name: 'never-loaded', version: '1.0.0', hasDescriptor: true }];
    enablementMockState.disabled.add('never-loaded');
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'list'], { from: 'user' });

    expect(infoSpy).toHaveBeenCalledWith('Loaded Ext (loaded-ext) [active]');
    expect(infoSpy).toHaveBeenCalledWith('never-loaded (1.0.0, npm) [not loaded, disabled]');
  });

  it("surfaces an installed override's presence on a same-named framework package's row instead of silently hiding it", async () => {
    // The coordinator's live snapshot already contains an entry named
    // `collided-ext` (the framework package), so the not-loaded merge's
    // `liveNames` dedup would otherwise make the installed override
    // completely invisible — neither listed as its own row (the coordinator
    // never created one for it) nor merged as not-loaded (the name looks
    // "seen"). The framework package's own row must carry a note instead.
    enablementMockState.health = { url: 'ws://localhost:1234' };
    enablementMockState.listExtensions = [
      {
        name: 'collided-ext',
        displayName: 'Collided (framework)',
        state: 'active',
        enabled: true,
        extensionManaged: false,
      },
    ];
    packageManagerMockState.packages = [{ name: 'collided-ext', version: '1.0.0', hasDescriptor: true }];
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'list'], { from: 'user' });

    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Collided (framework) (collided-ext) [active]'));
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('installed override present'));
    // No separate "not loaded" row for the same name — the note lives on the
    // framework package's own row instead of a second listing entry.
    expect(infoSpy).not.toHaveBeenCalledWith(expect.stringContaining('not loaded'));
  });

  it('still merges installed-but-not-loaded names when MAKAIO_BUS_URL is explicitly local', async () => {
    process.env.MAKAIO_BUS_URL = 'ws://127.0.0.1:6252/bus';
    enablementMockState.health = { url: 'ws://127.0.0.1:6252/bus' };
    enablementMockState.listExtensions = [
      { name: 'loaded-ext', displayName: 'Loaded Ext', state: 'active', enabled: true },
    ];
    packageManagerMockState.packages = [{ name: 'never-loaded', version: '1.0.0', hasDescriptor: true }];
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'list'], { from: 'user' });

    expect(infoSpy).toHaveBeenCalledWith('never-loaded (1.0.0, npm) [not loaded, enabled]');
  });

  it("does not merge this machine's installed-but-not-loaded names into a remote server's live listing", async () => {
    process.env.MAKAIO_BUS_URL = 'ws://build-server.internal:6252/bus';
    enablementMockState.health = { url: 'ws://build-server.internal:6252/bus' };
    enablementMockState.listExtensions = [
      { name: 'loaded-ext', displayName: 'Loaded Ext', state: 'active', enabled: true },
    ];
    // Installed on *this* machine only — must never be reported as if it
    // belonged to the remote host's coordinator.
    packageManagerMockState.packages = [{ name: 'local-only-ext', version: '1.0.0', hasDescriptor: true }];
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'list'], { from: 'user' });

    expect(infoSpy).toHaveBeenCalledWith('Loaded Ext (loaded-ext) [active]');
    expect(infoSpy).not.toHaveBeenCalledWith(expect.stringContaining('local-only-ext'));
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('this is a remote server (MAKAIO_BUS_URL) — extensions installed but not loaded'),
    );
  });

  it('reports the empty-list note for a remote server with nothing registered, without checking local installs', async () => {
    process.env.MAKAIO_BUS_URL = 'ws://build-server.internal:6252/bus';
    enablementMockState.health = { url: 'ws://build-server.internal:6252/bus' };
    enablementMockState.listExtensions = [];
    // A local-only install must never surface even the "not loaded" merge
    // that the empty-list short-circuit exists to preserve for a local bus.
    packageManagerMockState.packages = [{ name: 'local-only-ext', version: '1.0.0', hasDescriptor: true }];
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'list'], { from: 'user' });

    expect(infoSpy).toHaveBeenCalledWith('No extensions registered in the running server.');
    expect(infoSpy).not.toHaveBeenCalledWith(expect.stringContaining('local-only-ext'));
  });

  it('reports the remote-bus refusal and writes nothing when the unmanaged fallback would target a different machine', async () => {
    process.env.MAKAIO_BUS_URL = 'ws://build-server.internal:6252/bus';
    enablementMockState.health = { url: 'ws://build-server.internal:6252/bus' };
    // `kernel:extension.get` reports no entry, so the CLI would otherwise
    // fall back to writing the enablement file directly for this name.
    enablementMockState.getResult = { extension: null };
    packageManagerMockState.packages = [{ name: 'remote-ext', version: '1.0.0', hasDescriptor: true }];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'disable', 'remote-ext'], { from: 'user' });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("run this command on the server's host to persist the preference"),
    );
    // Nothing was written locally — the fallback refused before touching the file.
    expect(enablementMockState.disabled.has('remote-ext')).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it('still writes the enablement file for the unmanaged-name fallback when the bus is local', async () => {
    process.env.MAKAIO_BUS_URL = 'ws://127.0.0.1:6252/bus';
    enablementMockState.health = { url: 'ws://127.0.0.1:6252/bus' };
    enablementMockState.getResult = { extension: null };
    packageManagerMockState.packages = [{ name: 'local-ext', version: '1.0.0', hasDescriptor: true }];
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'disable', 'local-ext'], { from: 'user' });

    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('not loaded in the running server'));
    expect(enablementMockState.disabled.has('local-ext')).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it('routes a name retained by a same-named framework package to the unmanaged-name fallback instead of setEnabled', async () => {
    // `kernel:extension.get` reports an entry for this name, but
    // `extensionManaged: false` means the coordinator loaded a framework
    // package under it, not the disabled operator-managed override being
    // enabled here — forwarding to `setEnabled` would have the server throw
    // ("framework packages are not toggleable"). The CLI must persist the
    // preference itself instead, exactly like the `extension: null` case.
    enablementMockState.health = { url: 'ws://localhost:1234' };
    enablementMockState.getResult = { extension: { extensionManaged: false } };
    packageManagerMockState.packages = [{ name: 'collided-ext', version: '1.0.0', hasDescriptor: true }];
    // Pre-disabled, so the persisted write this test verifies actually
    // flips the recorded preference rather than trivially matching an
    // already-absent entry.
    enablementMockState.disabled.add('collided-ext');
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'enable', 'collided-ext'], { from: 'user' });

    expect(enablementMockState.setEnabledCallCount).toBe(0);
    expect(enablementMockState.disabled.has('collided-ext')).toBe(false);
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('a framework package currently holds this name'));
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('restart'));
    expect(process.exitCode).toBeUndefined();
  });

  it('refuses the framework-package-collision fallback for a remote server, writing nothing locally', async () => {
    process.env.MAKAIO_BUS_URL = 'ws://build-server.internal:6252/bus';
    enablementMockState.health = { url: 'ws://build-server.internal:6252/bus' };
    enablementMockState.getResult = { extension: { extensionManaged: false } };
    packageManagerMockState.packages = [{ name: 'collided-ext', version: '1.0.0', hasDescriptor: true }];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'enable', 'collided-ext'], { from: 'user' });

    expect(enablementMockState.setEnabledCallCount).toBe(0);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("run this command on the server's host to persist the preference"),
    );
    expect(enablementMockState.disabled.has('collided-ext')).toBe(false);
    expect(process.exitCode).toBe(1);
    // The remote guard sits ahead of the installed-package listing fetch —
    // a remote target must never scan this machine's local packages just to
    // reach a refusal it was always going to report.
    expect(packageManagerMockState.listPackagesCallCount).toBe(0);
  });

  it('refuses the never-loaded unmanaged-name fallback for a remote server without scanning local packages', async () => {
    // Same guard as the framework-package-collision case above, but for the
    // other `managedEntry === null` reason: the coordinator never loaded any
    // entry for this name at all (`kernel:extension.get` returns `null`).
    process.env.MAKAIO_BUS_URL = 'ws://build-server.internal:6252/bus';
    enablementMockState.health = { url: 'ws://build-server.internal:6252/bus' };
    enablementMockState.getResult = { extension: null };
    packageManagerMockState.packages = [{ name: 'never-loaded-ext', version: '1.0.0', hasDescriptor: true }];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'enable', 'never-loaded-ext'], { from: 'user' });

    expect(enablementMockState.setEnabledCallCount).toBe(0);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("run this command on the server's host to persist the preference"),
    );
    expect(enablementMockState.disabled.has('never-loaded-ext')).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(packageManagerMockState.listPackagesCallCount).toBe(0);
  });

  it('keys the offline listing and unmanaged toggle by the descriptor name, not the npm dependency identifier', async () => {
    // `@makaio/extension-opencode` installs a descriptor named `opencode` —
    // the enablement file, the runtime loader, and this listing must all key
    // on `opencode`, never on the npm package name it shipped under.
    packageManagerMockState.packages = [
      { name: '@makaio/extension-opencode', descriptorName: 'opencode', version: '1.0.0', hasDescriptor: true },
    ];
    enablementMockState.disabled.add('opencode');
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'list'], { from: 'user' });

    // Keyed by the descriptor identity, with the differing npm dependency
    // identifier retained only as a display extra.
    expect(infoSpy).toHaveBeenCalledWith('opencode (1.0.0, npm, npm package: @makaio/extension-opencode) [disabled]');
  });

  it('enables an npm-installed extension by its descriptor name even though the npm dependency identifier differs', async () => {
    packageManagerMockState.packages = [
      { name: '@makaio/extension-opencode', descriptorName: 'opencode', version: '1.0.0', hasDescriptor: true },
    ];
    enablementMockState.disabled.add('opencode');
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'enable', 'opencode'], { from: 'user' });

    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Persisted; no running server'));
    expect(enablementMockState.disabled.has('opencode')).toBe(false);
    expect(process.exitCode).toBeUndefined();
  });

  describe('project-local discovery precedence (offline)', () => {
    let projectRoot: string;
    let cwdSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
      projectRoot = await makeTestRepo('makaio-cli-project-local-');
      cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectRoot);
    });

    afterEach(async () => {
      cwdSpy.mockRestore();
      await rm(projectRoot, { recursive: true, force: true });
    });

    it('refuses to disable a critical extension found only in the project-local node_modules tier', async () => {
      // `$MAKAIO_HOME` knows nothing about this name — it is a dependency of
      // the project the CLI is invoked from, discoverable only through the
      // runtime's highest-priority `{cwd}/node_modules` tier.
      await writeProjectLocalDescriptor(projectRoot, descriptor('project-critical-ext', '1.0.0', [], true));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await program.parseAsync(['extension', 'disable', 'project-critical-ext'], { from: 'user' });

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('it is a critical extension'));
      expect(enablementMockState.disabled.has('project-critical-ext')).toBe(false);
      expect(process.exitCode).toBe(1);
    });

    it("lets a project-local override's critical flag win over the $MAKAIO_HOME-installed version of the same name", async () => {
      // `$MAKAIO_HOME/node_modules` reports this name as ordinary, but the
      // project-local tier the runtime prioritizes above it overrides the
      // same name as critical — the higher-priority tier must decide.
      packageManagerMockState.packages = [{ name: 'shared-ext', version: '1.0.0', hasDescriptor: true }];
      await writeProjectLocalDescriptor(projectRoot, descriptor('shared-ext', '2.0.0', [], true));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await program.parseAsync(['extension', 'disable', 'shared-ext'], { from: 'user' });

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('it is a critical extension'));
      expect(enablementMockState.disabled.has('shared-ext')).toBe(false);
      expect(process.exitCode).toBe(1);
    });

    it('lists a project-local extension offline even though it is absent from every $MAKAIO_HOME tier', async () => {
      await writeProjectLocalDescriptor(projectRoot, descriptor('project-only-ext', '1.0.0'));
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

      await program.parseAsync(['extension', 'list'], { from: 'user' });

      expect(infoSpy).toHaveBeenCalledWith('project-only-ext (1.0.0, project-local) [enabled]');
    });

    /**
     * Write a real, dynamically-importable `dist/server.mjs` for a
     * project-local package at the runtime's own convention path (see
     * `resolveConventionEntrypoint` in `load-extensions.ts`), exporting the
     * descriptor's own package alongside one dot-prefixed child package —
     * the project-local counterpart of `writeMultiPackageServerEntry` above,
     * which instead points a mocked npm listing's `serverImportPath` at an
     * arbitrary fixture location.
     * @param root - Project root the project-local `node_modules` tier is scanned from.
     * @param descriptorName - Parent descriptor package name.
     * @param childName - Dot-prefixed child package name.
     * @param childCritical - Critical flag the child package declares on itself.
     */
    async function writeProjectLocalMultiPackageServerEntry(
      root: string,
      descriptorName: string,
      childName: string,
      childCritical = false,
    ): Promise<void> {
      const distDir = path.join(root, 'node_modules', ...descriptorName.split('/'), 'dist');
      await mkdir(distDir, { recursive: true });
      await writeFile(
        path.join(distDir, 'server.mjs'),
        `export default [\n` +
          `  { name: ${JSON.stringify(descriptorName)}, displayName: 'Parent', version: '0.1.0' },\n` +
          `  { name: ${JSON.stringify(childName)}, displayName: 'Child', version: '0.1.0', critical: ${childCritical} },\n` +
          `];\n`,
        'utf-8',
      );
    }

    it("resolves a higher-priority tier's child package name against a lower-priority tier's own descriptor of the same name to a single entry, keeping the higher-priority tier's precedence", async () => {
      // The project-local tier (highest priority) exports child package
      // `parent-ext.child` from descriptor `parent-ext`, non-critical. A
      // lower-priority $MAKAIO_HOME npm install happens to have its own,
      // unrelated descriptor literally named `parent-ext.child`, critical.
      // Tracking collisions only by `group[0].name` (the descriptor) would
      // let both entries survive the merge — the runtime's own
      // `mergePackagesByDescriptorSourcePriority` never would, since it
      // tracks every emitted package name, not just descriptor names.
      await writeProjectLocalDescriptor(projectRoot, descriptor('parent-ext', '1.0.0'));
      await writeProjectLocalMultiPackageServerEntry(projectRoot, 'parent-ext', 'parent-ext.child', false);
      packageManagerMockState.packages = [
        { name: 'parent-ext.child', version: '9.0.0', hasDescriptor: true, critical: true },
      ];
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

      await program.parseAsync(['extension', 'list'], { from: 'user' });

      const childListings = infoSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.startsWith('parent-ext.child '));
      // Exactly one row for the colliding name, from the higher-priority
      // (project-local) tier — not the lower-priority npm descriptor.
      expect(childListings).toEqual(['parent-ext.child (0.1.0, project-local) [enabled]']);

      // The offline disable-validation path scans this same list for the
      // first matching row; it must see the winning (non-critical) entry,
      // not the shadowed npm descriptor's `critical: true`.
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await program.parseAsync(['extension', 'disable', 'parent-ext.child'], { from: 'user' });
      expect(errorSpy).not.toHaveBeenCalled();
      expect(enablementMockState.disabled.has('parent-ext.child')).toBe(true);
    });
  });

  describe('project-local discovery precedence (live)', () => {
    let projectRoot: string;
    let cwdSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
      projectRoot = await makeTestRepo('makaio-cli-project-local-live-');
      cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectRoot);
    });

    afterEach(async () => {
      cwdSpy.mockRestore();
      await rm(projectRoot, { recursive: true, force: true });
    });

    it("does not surface a project-local-only extension as installed-but-not-loaded in the live listing, because a reachable server may not share this CLI invocation's cwd", async () => {
      await writeProjectLocalDescriptor(projectRoot, descriptor('project-only-live-ext', '1.0.0'));
      enablementMockState.health = { url: 'ws://localhost:1234' };
      // At least one live entry so the listing does not take the early
      // empty-list return, which would print before reaching the not-loaded
      // merge and its note.
      enablementMockState.listExtensions = [
        { name: 'loaded-ext', displayName: 'Loaded Ext', state: 'active', enabled: true },
      ];
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

      await program.parseAsync(['extension', 'list'], { from: 'user' });

      expect(infoSpy).toHaveBeenCalledWith('Loaded Ext (loaded-ext) [active]');
      // The `'all'`-tier offline listing would have reported this name as
      // `[not loaded, enabled]` (see the offline describe block above); the
      // live listing must not, since it only trusts the $MAKAIO_HOME-shared
      // tiers for a reachable server.
      expect(infoSpy).not.toHaveBeenCalledWith(expect.stringContaining('project-only-live-ext'));
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('this listing only covers extensions shared through $MAKAIO_HOME'),
      );
    });

    it('reports an empty live listing without merging a project-local-only install, and without the shared-home note', async () => {
      await writeProjectLocalDescriptor(projectRoot, descriptor('project-only-live-ext', '1.0.0'));
      enablementMockState.health = { url: 'ws://localhost:1234' };
      enablementMockState.listExtensions = [];
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

      await program.parseAsync(['extension', 'list'], { from: 'user' });

      // With no live entries and nothing in the $MAKAIO_HOME-shared tiers,
      // `hasNotLoaded` is `false` and the command takes the empty-list
      // short-circuit — it must not report the project-local install as
      // installed-but-not-loaded to get there.
      expect(infoSpy).toHaveBeenCalledWith('No extensions registered in the running server.');
      expect(infoSpy).not.toHaveBeenCalledWith(expect.stringContaining('project-only-live-ext'));
    });

    it('rejects the unmanaged-toggle fallback for a project-local-only name as unknown, because the reachable server may not share this cwd', async () => {
      await writeProjectLocalDescriptor(projectRoot, descriptor('project-only-live-ext', '1.0.0'));
      enablementMockState.health = { url: 'ws://localhost:1234' };
      // `kernel:extension.get` reports no entry, so the CLI falls back to the
      // unmanaged-name toggle path, which must validate against the
      // `'shared-home'` listing rather than this process's own project-local
      // tier.
      enablementMockState.getResult = { extension: null };
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await program.parseAsync(['extension', 'disable', 'project-only-live-ext'], { from: 'user' });

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('no installed extension with this name'));
      expect(enablementMockState.disabled.has('project-only-live-ext')).toBe(false);
      expect(process.exitCode).toBe(1);
    });

    it('still resolves a $MAKAIO_HOME-installed (non-project-local) unmanaged name live, unaffected by the shared-home restriction', async () => {
      // Control case for the previous test: the same live, unmanaged-name
      // fallback must keep succeeding for a name discoverable through the
      // tiers that remain in scope (`$MAKAIO_HOME/node_modules`), confirming
      // the restriction is specific to the project-local tier.
      packageManagerMockState.packages = [{ name: 'home-installed-ext', version: '1.0.0', hasDescriptor: true }];
      enablementMockState.health = { url: 'ws://localhost:1234' };
      enablementMockState.getResult = { extension: null };
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

      await program.parseAsync(['extension', 'disable', 'home-installed-ext'], { from: 'user' });

      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('not loaded in the running server'));
      expect(enablementMockState.disabled.has('home-installed-ext')).toBe(true);
      expect(process.exitCode).toBeUndefined();
    });
  });
});
