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
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from 'commander';
import { registerExtensionCommands } from '../extension-commands.js';
import {
  buildConfiguredRuntimeOptions,
  FilesystemDescriptorDiscovery,
  type FrameworkModuleResolver,
} from '@makaio/runtime-node';
import type { ExtensionDescriptor } from '@makaio/contracts';
import {
  ExtensionSubjects,
  type InstalledExtensionCatalogEntry,
  type SetEnabledReason,
  type TransitionOutcome,
} from '@makaio/kernel';
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
  setEnabledResult: { success: true, outcome: 'applied' } as {
    success: boolean;
    outcome: TransitionOutcome;
    reason?: SetEnabledReason;
  },
  setEnabledError: null as Error | null,
  /** Number of times the mocked `kernel:extension.setEnabled` RPC was invoked. */
  setEnabledCallCount: 0,
  /** Number of times the mocked `loadExtensionEnablementStore` was invoked. */
  enablementStoreLoadCount: 0,
  /**
   * Entries returned by the `kernel:extension.catalog` RPC — the server's own
   * installed-package view. `null` models a runtime that exposes no catalog at
   * all, which is a different answer from an empty one.
   */
  catalogEntries: [] as InstalledExtensionCatalogEntry[] | null,
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
        // Dispatches on the subject, not the payload shape: `list` and
        // `catalog` are both `{}` requests, and only the subject tells the two
        // apart — the same way the bus itself routes them.
        request: async (
          subject: unknown,
          payload: Record<string, unknown>,
        ): Promise<
          | { success: boolean; outcome: TransitionOutcome; reason?: SetEnabledReason }
          | { entries: InstalledExtensionCatalogEntry[] | null }
          | { extensions: typeof enablementMockState.listExtensions }
        > => {
          if (subject === ExtensionSubjects.setEnabled) {
            enablementMockState.setEnabledCallCount += 1;
            if (enablementMockState.setEnabledError) throw enablementMockState.setEnabledError;
            // A reachable server's own `persistEnabled` call is the enablement
            // file's sole writer (the CLI writes nothing itself in this path —
            // see `applyLiveToggle`). `setEnabled` is persist-only: it writes
            // the requested preference for every outcome except `'rejected'`,
            // which never writes at all. This mock stands in for the
            // coordinator, so it reproduces that write here, keyed off
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
          if (subject === ExtensionSubjects.catalog) {
            return { entries: enablementMockState.catalogEntries };
          }
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

/**
 * Build a descriptor for a server-entrypoint extension.
 *
 * Such a descriptor may not declare `critical` — its exported packages own
 * that flag — so fixtures needing a critical extension write a real server
 * entry declaring it there.
 * @param name - Descriptor package name.
 * @param version - Descriptor version.
 * @param dependencies - Extension dependencies to declare, when any.
 * @returns Descriptor ready to be written to a fixture package.
 */
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

/**
 * Build a descriptor with no server entrypoint.
 *
 * The runtime synthesizes such a descriptor's single package from descriptor
 * metadata, which makes it the one shape that may declare `critical` on the
 * descriptor itself — a descriptor that does declare a server entrypoint has
 * its exported packages own that flag, and the schema rejects the combination.
 * @param name - Descriptor package name.
 * @param version - Descriptor version.
 * @param critical - Critical flag to declare, when the fixture needs one.
 * @returns Descriptor ready to be written to a fixture package.
 */
function browserOnlyDescriptor(name: string, version: string, critical?: boolean): ExtensionDescriptor {
  return {
    name,
    displayName: name,
    version,
    makaio: { framework: '>=0.1.0' },
    entrypoints: { browser: true },
    ...(critical === undefined ? {} : { critical }),
  };
}

/**
 * Render a server entry module exporting the given packages.
 * @param packages - Packages the entry exports, in export order. One must
 *   carry the descriptor's own name; every other must be dot-prefixed under it.
 * @returns Module source ready to be written at a convention entrypoint.
 */
function serverEntrySource(
  packages: ReadonlyArray<{ readonly name: string; readonly version?: string; readonly critical?: boolean }>,
): string {
  const entries = packages
    .map(
      (pkg) =>
        `  { name: ${JSON.stringify(pkg.name)}, displayName: ${JSON.stringify(pkg.name)}, ` +
        `version: ${JSON.stringify(pkg.version ?? '0.1.0')}, critical: ${pkg.critical ?? false} },\n`,
    )
    .join('');
  return `export default [\n${entries}];\n`;
}

/**
 * Install a real extension package under the data home's `node_modules` — the
 * registry-install tier the runtime's own discovery scans, and therefore the
 * one the offline listing reads.
 *
 * Writes exactly what discovery reads: the npm manifest carrying the
 * dependency identifier, `descriptor.json`, and — when the fixture supplies a
 * module body — the convention-resolved `dist/server.mjs` the listing imports.
 * Fixtures drive the production discovery and import path this way instead of
 * an installer mock's in-memory answer.
 * @param packageDescriptor - Descriptor written into the package.
 * @param options - `npmName` when the shipping package name differs from the
 *   descriptor identity, and `entrySource` for the server entry module body.
 *   Omitting `entrySource` for a descriptor that declares a server entrypoint
 *   leaves that entrypoint unresolvable, which is its own covered case.
 */
async function installNpmExtension(
  packageDescriptor: ExtensionDescriptor,
  options: { readonly npmName?: string; readonly entrySource?: string } = {},
): Promise<void> {
  const npmName = options.npmName ?? packageDescriptor.name;
  const packageRoot = path.join(packageManagerMockState.makaioHome, 'node_modules', ...npmName.split('/'));
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    path.join(packageRoot, 'package.json'),
    `${JSON.stringify({ name: npmName, version: packageDescriptor.version }, null, 2)}\n`,
    'utf-8',
  );
  await writeFile(
    path.join(packageRoot, 'descriptor.json'),
    `${JSON.stringify(packageDescriptor, null, 2)}\n`,
    'utf-8',
  );
  if (options.entrySource !== undefined) {
    await mkdir(path.join(packageRoot, 'dist'), { recursive: true });
    await writeFile(path.join(packageRoot, 'dist', 'server.mjs'), options.entrySource, 'utf-8');
  }
}

/**
 * Install a real extension as a symlink under the data home's `extensions/` —
 * the managed-install tier, reached through a link to a source directory
 * rather than a directory of its own.
 * @param packageDescriptor - Descriptor written into the link target.
 * @param options - `entrySource` for the server entry module body, when the
 *   fixture declares a resolvable server entrypoint.
 */
async function installSymlinkedExtension(
  packageDescriptor: ExtensionDescriptor,
  options: { readonly entrySource?: string } = {},
): Promise<void> {
  const sourceRoot = path.join(packageManagerMockState.makaioHome, 'extension-sources', packageDescriptor.name);
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, 'descriptor.json'), `${JSON.stringify(packageDescriptor, null, 2)}\n`, 'utf-8');
  if (options.entrySource !== undefined) {
    await mkdir(path.join(sourceRoot, 'dist'), { recursive: true });
    await writeFile(path.join(sourceRoot, 'dist', 'server.mjs'), options.entrySource, 'utf-8');
  }
  const extensionsDir = path.join(packageManagerMockState.makaioHome, 'extensions');
  await mkdir(extensionsDir, { recursive: true });
  await symlink(sourceRoot, path.join(extensionsDir, packageDescriptor.name), 'dir');
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
    // The update path resolves through the dependency resolver, which reads
    // each installed package's own `descriptor.json` — so the published
    // fixtures have to exist, exactly as they do for an install.
    await writePublishedPackage('@acme/weather-tools', descriptor('weather-tools', '1.1.0'));
    await writePublishedPackage('@acme/local-only', descriptor('local-only', '2.0.0'));
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

  it('re-pins a transitively upgraded package the project manifest already declares', async () => {
    // `@acme/child` is never a requested root — the update only asks for
    // `@acme/parent`, whose new version pulls the child forward. The project
    // pins both, so leaving the child's pin at its pre-update version would
    // make the next manifest reconciliation reinstall the superseded copy the
    // new parent cannot use.
    const repo = await makeTestRepo('makaio-extension-update-transitive-');
    const manifestPath = await writeTestManifest(repo, {
      extensions: ['@acme/parent@1.0.0', '@acme/child@1.0.0'],
    });
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(repo);
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await writePublishedPackage(
      '@acme/parent',
      descriptor('@acme/parent', '1.0.0', [{ type: 'extension', name: '@acme/child', version: '>=1.0.0' }]),
    );
    await writePublishedPackage('@acme/child', descriptor('@acme/child', '1.0.0'));
    await program.parseAsync(['node', 'test', 'extension', 'install', '@acme/parent']);

    await writePublishedPackage(
      '@acme/parent',
      descriptor('@acme/parent', '2.0.0', [{ type: 'extension', name: '@acme/child', version: '>=2.0.0' }]),
    );
    await writePublishedPackage('@acme/child', descriptor('@acme/child', '2.0.0'));
    packageManagerMockState.packages = [{ name: '@acme/parent', version: '1.0.0', hasDescriptor: true }];
    packageManagerMockState.latestVersions.set('@acme/parent', '2.0.0');

    await program.parseAsync(['node', 'test', 'extension', 'update']);

    expect(JSON.parse(await readFile(manifestPath, 'utf-8')).extensions).toEqual([
      '@acme/child@2.0.0',
      '@acme/parent@2.0.0',
    ]);
    cwdSpy.mockRestore();
  });

  it('refuses an update whose new version claims an extension name another installed package already holds', async () => {
    // The update path must be governed by the same descriptor-identity guard
    // the install path is: installing the package directly would leave two
    // packages in `$MAKAIO_HOME/node_modules` declaring one extension name,
    // which the next boot's discovery aborts on — long after the operator
    // could still act on it.
    await writePublishedPackage('@acme/alpha', descriptor('alpha', '1.0.0'));
    await writePublishedPackage('@acme/beta', descriptor('beta', '1.0.0'));
    vi.spyOn(console, 'info').mockImplementation(() => {});
    await program.parseAsync(['node', 'test', 'extension', 'install', '@acme/alpha', '@acme/beta']);

    // `@acme/beta@2.0.0` renames its descriptor onto the identity `@acme/alpha`
    // already holds.
    await writePublishedPackage('@acme/beta', descriptor('alpha', '2.0.0'));
    packageManagerMockState.packages = [{ name: '@acme/beta', version: '1.0.0', hasDescriptor: true }];
    packageManagerMockState.latestVersions.set('@acme/beta', '2.0.0');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const restoresBefore = packageManagerMockState.manifestRestores;

    await program.parseAsync(['node', 'test', 'extension', 'update', '@acme/beta']);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Package @acme/beta declares extension name "alpha", which is already installed from @acme/alpha@1.0.0',
      ),
    );
    expect(process.exitCode).toBe(1);
    // Rolled back: the transaction restores the pre-update manifest instead of
    // leaving the renamed package installed alongside the name's owner.
    expect(packageManagerMockState.manifestRestores).toBeGreaterThan(restoresBefore);
  });
});

/**
 * Framework module resolver that records its install window in a file.
 *
 * A real {@link FrameworkModuleResolver} implementation, not a stub: the
 * fixture server entry reads the marker it writes, so the listing's install
 * ordering is asserted through the resolved export rather than through call
 * bookkeeping. The native loader hook `NodeFrameworkModuleResolver` installs
 * cannot be observed from here — Vitest's module runner resolves a fixture's
 * own imports itself — so that hook keeps its spawned-Node coverage in
 * `framework-module-resolver.test.ts`, and this asserts the seam the CLI owns:
 * the host's resolver is installed before, and uninstalled after, the listing's
 * server-entry imports.
 */
class MarkerFrameworkModuleResolver implements FrameworkModuleResolver {
  /** Whether {@link uninstall} has run, so a leaked install window is visible to assertions. */
  public uninstalled = false;

  /** Unused by this implementation; the marker file stands in for a resolved dist. */
  public readonly frameworkDistPath = '';

  /**
   * @param markerPath - File this resolver records its install state in.
   */
  public constructor(private readonly markerPath: string) {}

  /** Record that framework resolution is available. */
  public async install(): Promise<void> {
    await writeFile(this.markerPath, 'installed', 'utf-8');
  }

  /** Record that framework resolution is no longer available. */
  public async uninstall(): Promise<void> {
    this.uninstalled = true;
    await writeFile(this.markerPath, 'uninstalled', 'utf-8');
  }
}

describe('extension enable/disable commands', () => {
  let program: InstanceType<typeof Command>;
  /** Working directory these invocations run in, kept distinct from the data home. */
  let projectCwd: string;

  beforeEach(() => {
    enablementMockState.disabled.clear();
    enablementMockState.health = null;
    enablementMockState.setEnabledResult = { success: true, outcome: 'applied' };
    enablementMockState.setEnabledError = null;
    enablementMockState.setEnabledCallCount = 0;
    enablementMockState.enablementStoreLoadCount = 0;
    enablementMockState.catalogEntries = [];
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
    // Runtime-config resolution falls back to searching the working directory
    // for a `makaio.config.*`, and the unconfigured offline listing scans that
    // directory's own `node_modules` as the runtime's highest-priority tier.
    // Both are pointed at a fresh, empty directory per test, so the test
    // runner's own checkout contributes neither config nor extensions and
    // these fixtures' data-home tiers are the whole view.
    projectCwd = mkdtempSync(path.join(tmpdir(), 'makaio-cli-enable-cwd-'));
    vi.spyOn(process, 'cwd').mockReturnValue(projectCwd);
    program = new Command();
    registerExtensionCommands(program);
  });

  afterEach(() => {
    process.exitCode = undefined;
    delete process.env.MAKAIO_BUS_URL;
  });

  it('writes the enablement file and reports offline when no server is running', async () => {
    await installNpmExtension(browserOnlyDescriptor('my-ext', '1.0.0'));
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await program.parseAsync(['extension', 'enable', 'my-ext'], { from: 'user' });
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Persisted; no running server'));
    expect(enablementMockState.disabled.has('my-ext')).toBe(false);
  });

  it('writes the disabled entry and reports offline when no server is running', async () => {
    await installNpmExtension(browserOnlyDescriptor('my-ext', '1.0.0'));
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
    await installNpmExtension(browserOnlyDescriptor('remote-ext', '1.0.0'));
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
    await installNpmExtension(browserOnlyDescriptor('my-ext', '1.0.0'));
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
    await installNpmExtension(browserOnlyDescriptor('local-only-ext', '1.0.0'));
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
    await installNpmExtension(browserOnlyDescriptor('my-ext', '1.0.0'));
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'list'], { from: 'user' });

    expect(infoSpy).toHaveBeenCalledWith('my-ext (1.0.0, npm) [enabled]');
    expect(process.exitCode).toBeUndefined();
  });

  it('reports live-applied when server is reachable and RPC succeeds', async () => {
    enablementMockState.health = { url: 'ws://localhost:1234' };
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await program.parseAsync(['extension', 'enable', 'my-ext'], { from: 'user' });
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('already matches this state'));
  });

  it('writes nothing locally when the server throws applying the request outright', async () => {
    enablementMockState.health = { url: 'ws://localhost:1234' };
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
    enablementMockState.setEnabledError = new Error('transition failed');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'disable', 'my-ext'], { from: 'user' });

    expect(enablementMockState.disabled.has('my-ext')).toBe(true);
  });

  it('reports the critical refusal the running server answered with, writing nothing', async () => {
    // The server owns this decision: it holds the loaded extension, or the
    // installed package behind the name, and refuses the disable as a
    // response the CLI renders rather than a fault it has to interpret.
    enablementMockState.health = { url: 'ws://localhost:1234' };
    enablementMockState.setEnabledResult = { success: false, outcome: 'rejected', reason: 'critical' };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await program.parseAsync(['extension', 'disable', 'core-ext'], { from: 'user' });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('it is a critical extension'));
    expect(enablementMockState.disabled.has('core-ext')).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it("reports the server's fail-closed refusal for a name whose criticality it could not resolve", async () => {
    enablementMockState.health = { url: 'ws://localhost:1234' };
    enablementMockState.setEnabledResult = { success: false, outcome: 'rejected', reason: 'criticality-unknown' };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await program.parseAsync(['extension', 'disable', 'broken-ext'], { from: 'user' });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('its server entry could not be read, so whether it is critical is unknown'),
    );
    expect(enablementMockState.disabled.has('broken-ext')).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it("reports a server that cannot enumerate its installed packages, instead of writing this machine's file", async () => {
    // A runtime with no installed-extension catalog cannot tell a real
    // installed name from a typo, so it refuses — and the CLI must surface
    // that rather than quietly persisting to its own enablement file, which
    // may not even be the one that server reads.
    enablementMockState.health = { url: 'ws://localhost:1234' };
    enablementMockState.setEnabledResult = { success: false, outcome: 'rejected', reason: 'no-catalog' };
    await installNpmExtension(browserOnlyDescriptor('local-ext', '1.0.0'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'disable', 'local-ext'], { from: 'user' });

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('cannot enumerate its installed packages'));
    expect(enablementMockState.disabled.has('local-ext')).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it('refuses to disable a critical extension offline, reading the flag from a descriptor with no exported package', async () => {
    // No `serverImportPath`: a detached, CLI-only, or browser-only descriptor,
    // whose single package the runtime synthesizes from descriptor metadata —
    // the one case where the descriptor field *is* the package field.
    await installNpmExtension(browserOnlyDescriptor('core-ext', '1.0.0', true));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await program.parseAsync(['extension', 'disable', 'core-ext'], { from: 'user' });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('it is a critical extension'));
    expect(enablementMockState.disabled.has('core-ext')).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it('refuses to disable a critical extension installed from a local path, reading the flag exactly as it would for an npm install', async () => {
    // A symlink under the data home's `extensions/` is its own discovery tier,
    // reached through a link rather than a directory — the offline critical
    // check must read the descriptor behind it identically to an npm install.
    await installSymlinkedExtension(browserOnlyDescriptor('core-local-ext', '1.0.0', true));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await program.parseAsync(['extension', 'disable', 'core-local-ext'], { from: 'user' });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('it is a critical extension'));
    expect(enablementMockState.disabled.has('core-local-ext')).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it('enabling a critical extension is never refused', async () => {
    await installNpmExtension(browserOnlyDescriptor('core-ext', '1.0.0', true));
    enablementMockState.disabled.add('core-ext');
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await program.parseAsync(['extension', 'enable', 'core-ext'], { from: 'user' });
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Persisted; no running server'));
    expect(enablementMockState.disabled.has('core-ext')).toBe(false);
  });

  it('reports a rejected request as unwritten when the server refuses it outright', async () => {
    enablementMockState.health = { url: 'ws://localhost:1234' };
    enablementMockState.setEnabledResult = { success: false, outcome: 'rejected' };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await program.parseAsync(['extension', 'disable', 'dep-ext'], { from: 'user' });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('the request was rejected. Nothing was written.'));
    expect(enablementMockState.disabled.has('dep-ext')).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it('reports "not installed" when the server refuses a name it cannot find on its own host', async () => {
    // A name nothing has installed is a typo, and the server is the one that
    // can tell — including for tiers this process cannot see. Its refusal
    // must never be second-guessed by writing this machine's file anyway.
    enablementMockState.health = { url: 'ws://localhost:1234' };
    enablementMockState.setEnabledResult = { success: false, outcome: 'rejected', reason: 'not-installed' };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await program.parseAsync(['extension', 'enable', 'my-ext'], { from: 'user' });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('no installed extension with this name'));
    expect(enablementMockState.disabled.has('my-ext')).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it('reports the server-persisted preference for an installed name its coordinator never loaded', async () => {
    // Installed on the server's host but absent from its coordinator —
    // interactive-only on a headless server, unmet `requires`, or
    // `MAKAIO_SKIP_EXTENSIONS`. The server validates the name against its own
    // installed-extension catalog and persists it; the CLI writes nothing.
    enablementMockState.health = { url: 'ws://localhost:1234' };
    enablementMockState.setEnabledResult = { success: false, outcome: 'restart-required', reason: 'not-loaded' };
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await program.parseAsync(['extension', 'enable', 'my-ext'], { from: 'user' });
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('not loaded in the running server'));
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Takes effect on next boot.'));
    expect(process.exitCode).toBeUndefined();
  });

  it("never writes this machine's enablement file while a server is reachable", async () => {
    // Whatever the outcome, the reachable server is the single writer: its
    // enablement file, its installed packages, its discovery roots. A local
    // write here would be validated against the wrong host — a local server
    // can have been started from a different project directory.
    enablementMockState.health = { url: 'ws://localhost:1234' };
    enablementMockState.setEnabledResult = { success: false, outcome: 'rejected', reason: 'not-installed' };
    await installNpmExtension(browserOnlyDescriptor('local-ext', '1.0.0'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'disable', 'local-ext'], { from: 'user' });

    expect(enablementMockState.enablementStoreLoadCount).toBe(0);
    expect(packageManagerMockState.listPackagesCallCount).toBe(0);
  });

  it('lists a hand-disabled critical extension as enabled, matching what boot does with it', async () => {
    await installNpmExtension(browserOnlyDescriptor('core-ext', '1.0.0', true));
    await installNpmExtension(browserOnlyDescriptor('plain-ext', '2.0.0'));
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
   * Install an extension whose real, dynamically-importable server entry
   * exports the descriptor's own package alongside one dot-prefixed child
   * package, at the convention path the runtime resolves.
   *
   * The listing imports that entry for real (unmocked — this is the
   * production code path), so the child package's presence and criticality
   * come from the module itself, exactly as they would at boot.
   * @param descriptorName - Parent descriptor package name.
   * @param childName - Dot-prefixed child package name.
   * @param childCritical - Critical flag the child package declares on itself.
   * @param parentCritical - Critical flag the descriptor's own package declares on itself.
   */
  async function installMultiPackageExtension(
    descriptorName: string,
    childName: string,
    childCritical = false,
    parentCritical = false,
  ): Promise<void> {
    await installNpmExtension(descriptor(descriptorName, '0.1.0'), {
      entrySource: serverEntrySource([
        { name: descriptorName, critical: parentCritical },
        { name: childName, critical: childCritical },
      ]),
    });
  }

  /**
   * Write a server entry that imports `@makaio/framework/*`, as a locally
   * linked extension's server graph routinely does.
   *
   * The entry lives outside this process's module tree, so nothing resolves
   * that import unless a host supplies the resolver the packaged runtime
   * installs — which is what makes its export unreadable, and its criticality
   * unresolved, without one.
   * @param descriptorName - Descriptor identity the entry exports itself under.
   */
  async function installFrameworkImportingExtension(descriptorName: string): Promise<void> {
    await installNpmExtension(descriptor(descriptorName, '0.1.0'), {
      entrySource:
        "import { FRAMEWORK_IMPORT_RESOLVED } from '@makaio/framework/bus';\n" +
        `export default { name: ${JSON.stringify(descriptorName)}, displayName: 'Linked', version: '0.1.0', ` +
        'critical: FRAMEWORK_IMPORT_RESOLVED };\n',
    });
  }

  it('leaves criticality unresolved offline when an extension imports @makaio/framework and no host resolver is supplied', async () => {
    // Baseline for the test below: without the host's resolver the framework
    // subpath is unresolvable from an extension outside this process's module
    // tree, so the export cannot be read at all and the disable must be
    // refused as unresolved rather than silently treated as non-critical.
    await installFrameworkImportingExtension('unresolved-framework-ext');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'disable', 'unresolved-framework-ext'], { from: 'user' });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('its server entry could not be read, so whether it is critical is unknown'),
    );
    expect(enablementMockState.disabled.has('unresolved-framework-ext')).toBe(false);
  });

  /**
   * Write a server entry whose exported `critical` flag mirrors the host
   * resolver's install state at import time.
   *
   * The entry reads the marker {@link MarkerFrameworkModuleResolver} writes, so
   * a resolved `critical: true` can only mean the listing installed the host's
   * resolver before importing it — the property a packaged CLI depends on for a
   * locally linked extension whose server graph imports `@makaio/framework/*`.
   * @param descriptorName - Descriptor identity the entry exports itself under.
   * @param markerPath - File the resolver records its install state in.
   */
  async function installResolverStateExtension(descriptorName: string, markerPath: string): Promise<void> {
    await writeFile(markerPath, 'uninstalled', 'utf-8');
    await installNpmExtension(descriptor(descriptorName, '0.1.0'), {
      entrySource:
        "import { readFileSync } from 'node:fs';\n" +
        `const resolverState = readFileSync(${JSON.stringify(markerPath)}, 'utf-8');\n` +
        `export default { name: ${JSON.stringify(descriptorName)}, displayName: 'Linked', version: '0.1.0', ` +
        "critical: resolverState === 'installed' };\n",
    });
  }

  it("installs the host's framework module resolver around the offline listing's server-entry imports", async () => {
    // A packaged host installs its resolver before loading extensions at boot,
    // which is how the runtime can import a locally linked extension whose
    // server graph imports `@makaio/framework/*`. The offline listing imports
    // on this process's own registry, so it needs that same capability handed
    // in — without it the export is unreadable and this disable is refused as
    // unresolved even though the server package is perfectly valid.
    const markerPath = path.join(packageManagerMockState.makaioHome, 'resolver-state');
    await installResolverStateExtension('hosted-resolver-ext', markerPath);
    const resolver = new MarkerFrameworkModuleResolver(markerPath);
    const hostedProgram = new Command();
    registerExtensionCommands(hostedProgram, { frameworkModuleResolver: resolver });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await hostedProgram.parseAsync(['extension', 'disable', 'hosted-resolver-ext'], { from: 'user' });

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('it is a critical extension'));
    expect(enablementMockState.disabled.has('hosted-resolver-ext')).toBe(false);
    // The hook is process-wide loader state: the listing owns it only while it
    // is importing extension code.
    expect(resolver.uninstalled).toBe(true);
  });

  it('lists every executable child package a descriptor exports, each with its own persisted preference', async () => {
    await installMultiPackageExtension('makaio-dev', 'makaio-dev.relay-connection');
    enablementMockState.disabled.add('makaio-dev.relay-connection');
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'list'], { from: 'user' });

    expect(infoSpy).toHaveBeenCalledWith('makaio-dev (0.1.0, npm) [enabled]');
    expect(infoSpy).toHaveBeenCalledWith('makaio-dev.relay-connection (0.1.0, npm) [disabled]');
  });

  it('reports an indeterminate effective state, not "disabled", for a hand-disabled name whose criticality is unresolved', async () => {
    // Same unreadable-entrypoint fixture `extension disable` already refuses
    // to act on (see the test above this describe block) — the descriptor
    // may be critical, so `extension list` must not print the flat `disabled`
    // label a merely-non-critical hand-disabled name would get: that would
    // read as the effective state, when in fact this name force-starts on
    // the next boot if its export turns out critical.
    // Declares a server entrypoint, but no convention candidate file is ever
    // written for it — the "declared, but unresolvable" case.
    await installNpmExtension(descriptor('broken-ext', '1.0.0'));
    enablementMockState.disabled.add('broken-ext');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'list'], { from: 'user' });

    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('preference: disabled, effective state unknown (criticality unresolved)'),
    );
  });

  it('refuses to disable a descriptor whose own exported package declares itself critical, even though the installer listing reports nothing', async () => {
    // The descriptor declares a server entrypoint, so its `descriptor.json`
    // may not declare `critical` at all — the exported package owns the flag
    // (one server entry can export several packages, each with its own).
    // Reading the installer's descriptor metadata here would let this disable
    // through for an extension boot force-starts anyway.
    await installMultiPackageExtension('parent-ext', 'parent-ext.child', false, true);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'disable', 'parent-ext'], { from: 'user' });

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('it is a critical extension'));
    expect(enablementMockState.disabled.has('parent-ext')).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it('refuses to disable a descriptor whose exported package declares a non-boolean critical value, treating it as unresolved rather than non-critical', async () => {
    // `normalizePackageExport`'s structural check never inspects `critical`,
    // so a malformed export like `critical: 'yes'` still passes it. The
    // offline listing must not let that string masquerade as a resolved
    // `false` — it refuses the disable exactly as an unreadable entrypoint
    // would.
    await installNpmExtension(descriptor('stringly-critical-ext', '0.1.0'), {
      entrySource: `export default { name: 'stringly-critical-ext', displayName: 'Stringly', version: '0.1.0', critical: 'yes' };\n`,
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'disable', 'stringly-critical-ext'], { from: 'user' });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('its server entry could not be read, so whether it is critical is unknown'),
    );
    expect(enablementMockState.disabled.has('stringly-critical-ext')).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it("reads the descriptor's own row from its exported package, not from a critical sibling it exports", async () => {
    // A descriptor with a server entrypoint may not declare `critical` at all
    // (the schema rejects it), so the only possible drift is between the
    // descriptor's own exported package and the other packages it exports.
    // Its own row must follow its own package, which declares itself optional
    // here, even though the child it exports is critical.
    await installMultiPackageExtension('parent-ext', 'parent-ext.child', true, false);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'disable', 'parent-ext'], { from: 'user' });

    expect(errorSpy).not.toHaveBeenCalled();
    expect(enablementMockState.disabled.has('parent-ext')).toBe(true);
  });

  it('refuses to disable a server-backed extension offline when its entrypoint cannot be imported, leaving the enablement file untouched', async () => {
    // A server-backed descriptor may not declare `critical` on itself (the
    // schema forbids it), so an unreadable entrypoint leaves criticality
    // genuinely unresolved rather than falling back to any descriptor
    // metadata. This must refuse the disable exactly as a known-critical
    // extension would — the next boot, which can read the export, might
    // force-start it.
    // Declares a server entrypoint, but no convention candidate file is ever
    // written for it — the "declared, but unresolvable" case.
    await installNpmExtension(descriptor('broken-ext', '1.0.0'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'disable', 'broken-ext'], { from: 'user' });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('its server entry could not be read, so whether it is critical is unknown'),
    );
    expect(enablementMockState.disabled.has('broken-ext')).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it('still allows enabling a server-backed extension offline when its entrypoint cannot be imported', async () => {
    // Enabling is harmless regardless of criticality, so the same unresolved
    // entrypoint that refuses a disable must not block an enable.
    // Declares a server entrypoint, but no convention candidate file is ever
    // written for it — the "declared, but unresolvable" case.
    await installNpmExtension(descriptor('broken-ext', '1.0.0'));
    enablementMockState.disabled.add('broken-ext');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'enable', 'broken-ext'], { from: 'user' });

    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Persisted; no running server'));
    expect(enablementMockState.disabled.has('broken-ext')).toBe(false);
    expect(process.exitCode).toBeUndefined();
  });

  it('still allows disabling a descriptor with no server entrypoint that declares no critical flag (legitimately non-critical, not unknown)', async () => {
    // No `serverImportPath` at all: criticality is legitimately absent, the
    // exact case the `criticalityUnknown` marker must not apply to — contrast
    // with the unreadable-entrypoint case above, which does refuse.
    await installNpmExtension(browserOnlyDescriptor('plain-ext', '1.0.0'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'disable', 'plain-ext'], { from: 'user' });

    expect(errorSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Persisted; no running server'));
    expect(enablementMockState.disabled.has('plain-ext')).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it("keeps a child package's persisted disabled preference visible in the offline listing after the server stops", async () => {
    await installMultiPackageExtension('makaio-dev', 'makaio-dev.relay-connection');

    // Server is running, so it owns the write: the CLI forwards the request
    // and the server persists the preference for this child package name.
    enablementMockState.health = { url: 'ws://localhost:1234' };
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
    await installMultiPackageExtension('makaio-dev', 'makaio-dev.relay-connection');
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
    await installNpmExtension(browserOnlyDescriptor('plain-ext', '2.0.0'));
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
    await installNpmExtension(browserOnlyDescriptor('plain-ext', '2.0.0'));
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
    await installNpmExtension(browserOnlyDescriptor('plain-ext', '2.0.0'));
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
    await installNpmExtension(browserOnlyDescriptor('local-only-ext', '1.0.0'));
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'list'], { from: 'user' });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('the configured server at ws://build-server.internal:6252/bus is unreachable'),
    );
    expect(infoSpy).not.toHaveBeenCalledWith(expect.stringContaining('local-only-ext'));
    expect(process.exitCode).toBe(1);
  });

  it('defers to the next boot when the server persisted a preference its runtime state diverges from', async () => {
    enablementMockState.health = { url: 'ws://localhost:1234' };
    enablementMockState.setEnabledResult = {
      success: false,
      outcome: 'restart-required',
      reason: 'runtime-state-diverges',
    };
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await program.parseAsync(['extension', 'enable', 'my-ext'], { from: 'user' });
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("the running server's process is not in the requested state"),
    );
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Takes effect on next boot.'));
  });

  it('warns and exits non-zero when the enablement file could not be read, but still lists installed extensions', async () => {
    enablementMockState.readFailure = {
      reason: 'not-json',
      diagnostic:
        'Enablement file at "/fake/config/extensions.json" contains invalid JSON; treating all extensions as enabled.',
    };
    await installNpmExtension(browserOnlyDescriptor('plain-ext', '2.0.0'));
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

  it('never loads or warns about a broken local enablement file when a server answers the live listing', async () => {
    // A live listing reports the server's own preferences, from its own
    // snapshot and catalog — this machine's enablement file is not part of
    // the answer for a local bus any more than for a remote one, so a broken
    // local file must not even be opened, let alone warned about.
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

  it("merges the server's installed-but-not-loaded packages into the live listing with their persisted preference", async () => {
    enablementMockState.health = { url: 'ws://localhost:1234' };
    enablementMockState.listExtensions = [
      { name: 'loaded-ext', displayName: 'Loaded Ext', state: 'active', enabled: true },
    ];
    // Installed on the server's host but absent from its coordinator
    // (interactive-only, unmet requires, or MAKAIO_SKIP_EXTENSIONS) — exactly
    // the names `extension enable`/`disable` still address, so the listing
    // must surface them, with the preference the server recorded.
    enablementMockState.catalogEntries = [
      {
        name: 'never-loaded',
        version: '1.0.0',
        origin: 'npm',
        extensionManaged: true,
        persistedEnabled: false,
      },
    ];
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'list'], { from: 'user' });

    expect(infoSpy).toHaveBeenCalledWith('Loaded Ext (loaded-ext) [active]');
    expect(infoSpy).toHaveBeenCalledWith('never-loaded (1.0.0, npm) [not loaded, disabled]');
  });

  it("reports a not-loaded package from the server's own project-local tier, which this process cannot see", async () => {
    // The gap this catalog closes: a package installed under the server's
    // working directory is invisible to every client, including one on the
    // same machine started from elsewhere. Only the server can report it.
    enablementMockState.health = { url: 'ws://localhost:1234' };
    enablementMockState.listExtensions = [
      { name: 'loaded-ext', displayName: 'Loaded Ext', state: 'active', enabled: true },
    ];
    enablementMockState.catalogEntries = [
      { name: 'server-project-ext', version: '2.0.0', origin: 'project-local', extensionManaged: true },
    ];
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'list'], { from: 'user' });

    expect(infoSpy).toHaveBeenCalledWith('server-project-ext (2.0.0, project-local) [not loaded, enabled]');
  });

  it("keeps a critical package's durable disable visible as unresolved when the server could not read its criticality", async () => {
    enablementMockState.health = { url: 'ws://localhost:1234' };
    enablementMockState.listExtensions = [
      { name: 'loaded-ext', displayName: 'Loaded Ext', state: 'active', enabled: true },
    ];
    enablementMockState.catalogEntries = [
      {
        name: 'broken-ext',
        version: '1.0.0',
        origin: 'npm',
        extensionManaged: true,
        persistedEnabled: false,
        criticalityUnknown: true,
      },
    ];
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'list'], { from: 'user' });

    expect(infoSpy).toHaveBeenCalledWith(
      'broken-ext (1.0.0, npm) [not loaded, preference: disabled, effective state unknown (criticality unresolved)]',
    );
  });

  it("surfaces an installed override's presence on a same-named framework package's row instead of silently hiding it", async () => {
    // The live snapshot already contains an entry named `collided-ext` (the
    // framework package), so the not-loaded merge's dedup would otherwise make
    // the installed override completely invisible — neither its own row (the
    // coordinator never created one) nor a merged not-loaded row (the name
    // looks "seen"). The framework package's own row carries a note instead.
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
    enablementMockState.catalogEntries = [
      { name: 'collided-ext', version: '1.0.0', origin: 'npm', extensionManaged: false },
    ];
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'list'], { from: 'user' });

    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Collided (framework) (collided-ext) [active]'));
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('installed override present'));
    // No separate "not loaded" row for the same name — the note lives on the
    // framework package's own row instead of a second listing entry.
    expect(infoSpy).not.toHaveBeenCalledWith(expect.stringContaining('not loaded'));
  });

  it("merges the server's catalog for a remote bus exactly as for a local one", async () => {
    // The listing describes one host end to end, so a remote server's
    // installed-but-not-loaded packages are as reportable as a local one's.
    process.env.MAKAIO_BUS_URL = 'ws://build-server.internal:6252/bus';
    enablementMockState.health = { url: 'ws://build-server.internal:6252/bus' };
    enablementMockState.listExtensions = [
      { name: 'loaded-ext', displayName: 'Loaded Ext', state: 'active', enabled: true },
    ];
    enablementMockState.catalogEntries = [
      { name: 'remote-never-loaded', version: '3.0.0', origin: 'npm', extensionManaged: true },
    ];
    // Installed on *this* machine only — never part of the remote host's answer.
    await installNpmExtension(browserOnlyDescriptor('local-only-ext', '1.0.0'));
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'list'], { from: 'user' });

    expect(infoSpy).toHaveBeenCalledWith('Loaded Ext (loaded-ext) [active]');
    expect(infoSpy).toHaveBeenCalledWith('remote-never-loaded (3.0.0, npm) [not loaded, enabled]');
    expect(infoSpy).not.toHaveBeenCalledWith(expect.stringContaining('local-only-ext'));
  });

  it('notes that a server without an installed-extension catalog cannot report its unloaded packages', async () => {
    enablementMockState.health = { url: 'ws://localhost:1234' };
    enablementMockState.listExtensions = [
      { name: 'loaded-ext', displayName: 'Loaded Ext', state: 'active', enabled: true },
    ];
    enablementMockState.catalogEntries = null;
    // Installed here, but this machine's view is never spliced into the
    // server's listing — an absent catalog is reported as such instead.
    await installNpmExtension(browserOnlyDescriptor('local-only-ext', '1.0.0'));
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'list'], { from: 'user' });

    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('does not expose an installed-extension catalog'));
    expect(infoSpy).not.toHaveBeenCalledWith(expect.stringContaining('local-only-ext'));
  });

  it('reports the empty-list note for a server with nothing registered and nothing installed', async () => {
    enablementMockState.health = { url: 'ws://localhost:1234' };
    enablementMockState.listExtensions = [];
    // A local-only install must never surface as if it were the server's.
    await installNpmExtension(browserOnlyDescriptor('local-only-ext', '1.0.0'));
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'list'], { from: 'user' });

    expect(infoSpy).toHaveBeenCalledWith('No extensions registered in the running server.');
    expect(infoSpy).not.toHaveBeenCalledWith(expect.stringContaining('local-only-ext'));
  });

  it('forwards a remote toggle to the server instead of refusing it', async () => {
    // The refusal this replaces existed only because the CLI could not write
    // another machine's enablement file. The server writes its own, so a
    // remote target is now an ordinary request.
    process.env.MAKAIO_BUS_URL = 'ws://build-server.internal:6252/bus';
    enablementMockState.health = { url: 'ws://build-server.internal:6252/bus' };
    enablementMockState.setEnabledResult = { success: true, outcome: 'applied', reason: 'not-loaded' };
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'disable', 'remote-ext'], { from: 'user' });

    expect(enablementMockState.setEnabledCallCount).toBe(1);
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('not loaded in the running server'));
    expect(process.exitCode).toBeUndefined();
  });

  it('reports a preference persisted for a name a framework package currently shadows', async () => {
    enablementMockState.health = { url: 'ws://localhost:1234' };
    enablementMockState.setEnabledResult = {
      success: false,
      outcome: 'restart-required',
      reason: 'framework-package-shadowed',
    };
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'enable', 'collided-ext'], { from: 'user' });

    expect(enablementMockState.setEnabledCallCount).toBe(1);
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('a framework package currently holds this name'));
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Takes effect on next boot.'));
    expect(process.exitCode).toBeUndefined();
  });

  it("renders the running server's refusal of a contested name, writing nothing locally", async () => {
    // The server loaded a single copy at boot, so its live snapshot still
    // reports a healthy managed entry — but a second copy was installed since,
    // and only the server's own catalog sees it. The refusal therefore comes
    // back as a `setEnabled` outcome rather than being decided here.
    enablementMockState.health = { url: 'ws://localhost:1234' };
    enablementMockState.setEnabledResult = { success: false, outcome: 'rejected', reason: 'name-collision' };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'disable', 'weather'], { from: 'user' });

    expect(enablementMockState.setEnabledCallCount).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('more than one installed copy claims this name'));
    expect(enablementMockState.disabled.has('weather')).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it('keys the offline listing and unmanaged toggle by the descriptor name, not the npm dependency identifier', async () => {
    // `@makaio/extension-opencode` installs a descriptor named `opencode` —
    // the enablement file, the runtime loader, and this listing must all key
    // on `opencode`, never on the npm package name it shipped under.
    await installNpmExtension(browserOnlyDescriptor('opencode', '1.0.0'), {
      npmName: '@makaio/extension-opencode',
    });
    enablementMockState.disabled.add('opencode');
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await program.parseAsync(['extension', 'list'], { from: 'user' });

    // Keyed by the descriptor identity, with the differing npm dependency
    // identifier retained only as a display extra.
    expect(infoSpy).toHaveBeenCalledWith('opencode (1.0.0, npm, npm package: @makaio/extension-opencode) [disabled]');
  });

  it('enables an npm-installed extension by its descriptor name even though the npm dependency identifier differs', async () => {
    await installNpmExtension(browserOnlyDescriptor('opencode', '1.0.0'), {
      npmName: '@makaio/extension-opencode',
    });
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
      // The tier order under test only exists for a host that boots with it,
      // so the commands are handed the very discovery that host would use —
      // project-local `node_modules` first, then the data-home tiers. The
      // offline listing describes a discovery, never a hardcoded tier list, so
      // supplying it here is what makes these assertions about the runtime's
      // precedence rather than about the listing's own invention.
      program = new Command();
      registerExtensionCommands(program, {
        discovery: new FilesystemDescriptorDiscovery(projectRoot, {
          extensionsDir: path.join(packageManagerMockState.makaioHome, 'extensions'),
          nodeModulesDir: path.join(packageManagerMockState.makaioHome, 'node_modules'),
        }),
      });
    });

    afterEach(async () => {
      cwdSpy.mockRestore();
      await rm(projectRoot, { recursive: true, force: true });
    });

    it('leaves a project-local-only extension unaddressable when the discovery this invocation resolved does not scan that tier', async () => {
      // The counterpart to every assertion in this block: the project-local
      // tier is visible because the host handed the commands a discovery that
      // scans it. Runtime config's own no-`discoveryPaths` default covers the
      // data home's two roots and nothing else, and that same default is what
      // `serve` boots with — so a descriptor found only in `{cwd}/node_modules`
      // is one no server started here would load, and offering a preference for
      // it would promise an effect the next boot cannot deliver. Declaring
      // `extensions.discoveryPaths` is what opts that tier in, for boot and for
      // this listing alike.
      await writeProjectLocalDescriptor(projectRoot, browserOnlyDescriptor('project-only-ext', '1.0.0'));
      const configured = new Command();
      registerExtensionCommands(configured, {
        discovery: (await buildConfiguredRuntimeOptions({ makaioHome: packageManagerMockState.makaioHome })).discovery,
      });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await configured.parseAsync(['extension', 'disable', 'project-only-ext'], { from: 'user' });

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('no installed extension with this name'));
      expect(enablementMockState.disabled.has('project-only-ext')).toBe(false);
      expect(process.exitCode).toBe(1);
    });

    it('refuses to disable a critical extension found only in the project-local node_modules tier', async () => {
      // `$MAKAIO_HOME` knows nothing about this name — it is a dependency of
      // the project the CLI is invoked from, discoverable only through the
      // runtime's highest-priority `{cwd}/node_modules` tier.
      await writeProjectLocalDescriptor(projectRoot, descriptor('project-critical-ext', '1.0.0'));
      await writeProjectLocalServerEntry(projectRoot, 'project-critical-ext', [
        { name: 'project-critical-ext', critical: true },
      ]);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await program.parseAsync(['extension', 'disable', 'project-critical-ext'], { from: 'user' });

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('it is a critical extension'));
      expect(enablementMockState.disabled.has('project-critical-ext')).toBe(false);
      expect(process.exitCode).toBe(1);
    });

    it('refuses to disable a project-local extension whose declared server entrypoint has no resolvable candidate file, rather than treating the declaration as known non-critical', async () => {
      // `descriptor()` always declares `entrypoints: { server: true }`, but
      // this fixture never writes a `dist/server.mjs` or `src/server.ts` for
      // it — the exact "declared, but unresolvable" case `serverImportPath`
      // alone cannot distinguish from "no entrypoint declared at all" (see
      // `InstallerListingEntry.declaresServerEntrypoint`). Both leave
      // `serverImportPath` undefined; only the descriptor's own
      // `entrypoints.server` tells them apart, and only the unresolvable case
      // must refuse the disable.
      await writeProjectLocalDescriptor(projectRoot, descriptor('unresolvable-entry-ext', '1.0.0'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await program.parseAsync(['extension', 'disable', 'unresolvable-entry-ext'], { from: 'user' });

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('its server entry could not be read, so whether it is critical is unknown'),
      );
      expect(enablementMockState.disabled.has('unresolvable-entry-ext')).toBe(false);
      expect(process.exitCode).toBe(1);
    });

    it('still allows enabling a project-local extension whose declared server entrypoint has no resolvable candidate file', async () => {
      // Enabling is harmless regardless of criticality — mirrors the
      // unreadable-entrypoint enable test for the mocked npm tier above.
      await writeProjectLocalDescriptor(projectRoot, descriptor('unresolvable-entry-enable-ext', '1.0.0'));
      enablementMockState.disabled.add('unresolvable-entry-enable-ext');
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

      await program.parseAsync(['extension', 'enable', 'unresolvable-entry-enable-ext'], { from: 'user' });

      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Persisted; no running server'));
      expect(enablementMockState.disabled.has('unresolvable-entry-enable-ext')).toBe(false);
      expect(process.exitCode).toBeUndefined();
    });

    it("lets a project-local override's critical flag win over the $MAKAIO_HOME-installed version of the same name", async () => {
      // `$MAKAIO_HOME/node_modules` reports this name as ordinary, but the
      // project-local tier the runtime prioritizes above it overrides the
      // same name as critical — the higher-priority tier must decide.
      await installNpmExtension(browserOnlyDescriptor('shared-ext', '1.0.0'));
      await writeProjectLocalDescriptor(projectRoot, descriptor('shared-ext', '2.0.0'));
      await writeProjectLocalServerEntry(projectRoot, 'shared-ext', [{ name: 'shared-ext', critical: true }]);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await program.parseAsync(['extension', 'disable', 'shared-ext'], { from: 'user' });

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('it is a critical extension'));
      expect(enablementMockState.disabled.has('shared-ext')).toBe(false);
      expect(process.exitCode).toBe(1);
    });

    it('lists a cross-tier shadowed extension instead of dropping it from the listing', async () => {
      // The npm copy is installed but unloadable: the project-local tier wins
      // the name. Omitting it made a just-installed extension look like it had
      // never been installed, with nothing to tell the operator why.
      await installNpmExtension(browserOnlyDescriptor('shared-ext', '1.0.0'));
      await writeProjectLocalDescriptor(projectRoot, browserOnlyDescriptor('shared-ext', '2.0.0'));
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

      await program.parseAsync(['extension', 'list'], { from: 'user' });

      const rows = infoSpy.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith('shared-ext '));
      expect(rows).toEqual([
        'shared-ext (2.0.0, project-local) [enabled]',
        'shared-ext (1.0.0, npm) [shadowed by project-local, not loaded]',
      ]);
    });

    it("reports a project-local same-tier name collision on both rows, with each copy's provenance", async () => {
      // Two hand-placed packages in the project-local tier claiming one
      // identity: there is no precedence within a tier, so the next boot
      // refuses outright. The listing does not refuse — it exists to show what
      // is installed — so both copies are reported as contesting the name, the
      // command exits non-zero, and the provenance the operator needs to fix
      // it is warned alongside.
      const firstPath = await writeCollidingProjectLocalPackage('first-copy', 'shared-ext');
      const secondPath = await writeCollidingProjectLocalPackage('second-copy', 'shared-ext');
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await program.parseAsync(['extension', 'list'], { from: 'user' });

      const rows = infoSpy.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith('shared-ext '));
      expect(rows).toEqual([
        'shared-ext (1.0.0, project-local) [name collision with project-local, nothing loads under this name until it is resolved]',
        'shared-ext (1.0.0, project-local) [name collision with project-local, nothing loads under this name until it is resolved]',
      ]);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Extension name collision: shared-ext'));
      const provenance = warnSpy.mock.calls.map((call) => String(call[0])).find((line) => line.includes('shared-ext'));
      expect(provenance).toContain(firstPath);
      expect(provenance).toContain(secondPath);
      expect(process.exitCode).toBe(1);
    });

    /**
     * Write a project-local package whose directory name differs from the
     * descriptor name, so two of them can claim one identity in a single tier.
     * @param directoryName - Package directory under the project `node_modules`.
     * @param descriptorName - Descriptor name both packages claim.
     * @returns Absolute package root the discovery reports as provenance.
     */
    async function writeCollidingProjectLocalPackage(directoryName: string, descriptorName: string): Promise<string> {
      const packageRoot = path.join(projectRoot, 'node_modules', directoryName);
      await mkdir(packageRoot, { recursive: true });
      await writeFile(
        path.join(packageRoot, 'descriptor.json'),
        `${JSON.stringify(browserOnlyDescriptor(descriptorName, '1.0.0'), null, 2)}\n`,
        'utf-8',
      );
      return packageRoot;
    }

    it('lists a project-local extension offline even though it is absent from every $MAKAIO_HOME tier', async () => {
      await writeProjectLocalDescriptor(projectRoot, descriptor('project-only-ext', '1.0.0'));
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

      await program.parseAsync(['extension', 'list'], { from: 'user' });

      expect(infoSpy).toHaveBeenCalledWith('project-only-ext (1.0.0, project-local) [enabled]');
    });

    /**
     * Write a real, dynamically-importable `dist/server.mjs` for a
     * project-local package at the runtime's own convention path (see
     * `resolveConventionEntrypoint` in `load-extensions.ts`).
     *
     * The exported packages are the only place `critical` may be declared for
     * a descriptor with a server entrypoint, so every project-local fixture
     * that needs a critical extension writes one of these.
     * @param root - Project root the project-local `node_modules` tier is scanned from.
     * @param descriptorName - Descriptor package name owning the entrypoint.
     * @param packages - Packages the entry exports, in export order. One must
     *   carry `descriptorName`; every other name must be dot-prefixed under it.
     */
    async function writeProjectLocalServerEntry(
      root: string,
      descriptorName: string,
      packages: ReadonlyArray<{
        readonly name: string;
        readonly critical?: boolean;
        readonly surface?: 'interactive' | 'headless';
      }>,
    ): Promise<void> {
      const distDir = path.join(root, 'node_modules', ...descriptorName.split('/'), 'dist');
      await mkdir(distDir, { recursive: true });
      const entries = packages
        .map(
          (pkg) =>
            `  { name: ${JSON.stringify(pkg.name)}, displayName: ${JSON.stringify(pkg.name)}, version: '0.1.0', critical: ${pkg.critical ?? false}` +
            `${pkg.surface === undefined ? '' : `, surface: ${JSON.stringify(pkg.surface)}`} },\n`,
        )
        .join('');
      await writeFile(path.join(distDir, 'server.mjs'), `export default [\n${entries}];\n`, 'utf-8');
    }

    /**
     * Install a data-home npm extension whose single exported package declares
     * one runtime surface.
     *
     * The scan reads `surface` from the exported package the coordinator would
     * load, exactly as it reads `critical` — so the fixture has to be a real,
     * importable module rather than descriptor metadata.
     * @param descriptorName - Descriptor identity the entry exports itself under.
     * @param surface - Runtime surface the exported package restricts itself to.
     * @param critical - Whether the exported package declares itself critical.
     */
    async function installSurfacedNpmExtension(
      descriptorName: string,
      surface: 'interactive' | 'headless',
      critical = false,
    ): Promise<void> {
      await installNpmExtension(descriptor(descriptorName, '9.0.0'), {
        entrySource:
          `export default { name: ${JSON.stringify(descriptorName)}, displayName: 'Surfaced', version: '9.0.0', ` +
          `critical: ${critical}, surface: ${JSON.stringify(surface)} };\n`,
      });
    }

    it("reports a higher-priority tier's child package name against a lower-priority tier's own descriptor of the same name as a collision, not as a resolved shadowing", async () => {
      // The project-local tier (highest priority) exports child package
      // `parent-ext.child` from descriptor `parent-ext`, non-critical. A
      // lower-priority $MAKAIO_HOME npm install happens to have its own,
      // unrelated descriptor literally named `parent-ext.child`, critical.
      //
      // Tier precedence cannot settle this. Discovery deduplicates by
      // *descriptor* name, and `parent-ext` and `parent-ext.child` are two
      // different descriptor names, so both descriptors are admitted — and
      // both then register the package name `parent-ext.child`, which
      // `coalesceExtensionOverrides` refuses. The boot aborts, so presenting
      // either row as the loaded copy would be a listing that contradicts the
      // runtime.
      await writeProjectLocalDescriptor(projectRoot, descriptor('parent-ext', '1.0.0'));
      await writeProjectLocalServerEntry(projectRoot, 'parent-ext', [
        { name: 'parent-ext' },
        { name: 'parent-ext.child' },
      ]);
      await installNpmExtension(browserOnlyDescriptor('parent-ext.child', '9.0.0', true));
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await program.parseAsync(['extension', 'list'], { from: 'user' });

      const childListings = infoSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.startsWith('parent-ext.child '));
      expect(childListings).toEqual([
        'parent-ext.child (0.1.0, project-local) [name collision with npm, nothing loads under this name until it is resolved]',
        'parent-ext.child (9.0.0, npm) [name collision with project-local, nothing loads under this name until it is resolved]',
      ]);
      // The descriptor that won its own name is unaffected and still loadable,
      // reported at the version its server entry exports.
      expect(infoSpy).toHaveBeenCalledWith('parent-ext (0.1.0, project-local) [enabled]');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Extension name collision: parent-ext.child'));
      expect(process.exitCode).toBe(1);

      // Nothing resolves under the contested name, so a preference written for
      // it could never be acted on — the toggle refuses instead of persisting.
      process.exitCode = undefined;
      errorSpy.mockClear();
      await program.parseAsync(['extension', 'disable', 'parent-ext.child'], { from: 'user' });
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('more than one installed copy claims this name'));
      expect(enablementMockState.disabled.has('parent-ext.child')).toBe(false);
      expect(process.exitCode).toBe(1);
    });

    it('does not report a cross-tier child/descriptor contest as a collision when the two copies target different surfaces', async () => {
      // The coordinator filters by surface *before* it resolves names, so an
      // interactive-only child package and a headless-only descriptor of the
      // same name are never handed to that resolution together: each boots on
      // its own surface and neither displaces the other. Reporting a collision
      // would exit non-zero and refuse a toggle for a name that resolves fine
      // on every surface a host can actually be.
      await writeProjectLocalDescriptor(projectRoot, descriptor('surfaced-parent', '1.0.0'));
      await writeProjectLocalServerEntry(projectRoot, 'surfaced-parent', [
        { name: 'surfaced-parent' },
        { name: 'surfaced-parent.child', surface: 'interactive' },
      ]);
      await installSurfacedNpmExtension('surfaced-parent.child', 'headless');
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await program.parseAsync(['extension', 'list'], { from: 'user' });

      const rows = infoSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.startsWith('surfaced-parent.child '));
      expect(rows).toEqual([
        'surfaced-parent.child (0.1.0, project-local) [enabled]',
        'surfaced-parent.child (9.0.0, npm) [enabled]',
      ]);
      expect(errorSpy).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();

      // The name resolves on both surfaces, so a preference written for it is
      // acted on — the toggle must not be refused as contested.
      await program.parseAsync(['extension', 'disable', 'surfaced-parent.child'], { from: 'user' });
      expect(enablementMockState.disabled.has('surfaced-parent.child')).toBe(true);
      expect(process.exitCode).toBeUndefined();
    });

    it("judges a two-surface name against the interactive copy when the host's serve boots interactive", async () => {
      // A desktop host hands `serve` `surface: 'interactive'`, so that is the
      // copy its next start loads and the only one whose `critical` flag can
      // decide this disable. Resolving as headless here would persist a
      // preference the interactive start refuses to honour — and the host
      // surface is the one thing this process cannot infer for itself.
      await writeProjectLocalDescriptor(projectRoot, descriptor('host-surfaced', '1.0.0'));
      await writeProjectLocalServerEntry(projectRoot, 'host-surfaced', [
        { name: 'host-surfaced' },
        { name: 'host-surfaced.child', surface: 'interactive', critical: true },
      ]);
      await installSurfacedNpmExtension('host-surfaced.child', 'headless');
      const interactive = new Command();
      registerExtensionCommands(interactive, {
        discovery: new FilesystemDescriptorDiscovery(projectRoot, {
          extensionsDir: path.join(packageManagerMockState.makaioHome, 'extensions'),
          nodeModulesDir: path.join(packageManagerMockState.makaioHome, 'node_modules'),
        }),
        surface: 'interactive',
      });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await interactive.parseAsync(['extension', 'disable', 'host-surfaced.child'], { from: 'user' });

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('it is a critical extension'));
      expect(enablementMockState.disabled.has('host-surfaced.child')).toBe(false);
      expect(process.exitCode).toBe(1);
    });

    it('refuses an offline disable of a two-surface name whose headless copy is the critical one', async () => {
      // The two copies target different surfaces, so neither collides and the
      // name toggles fine — but only one of them is the copy a server started
      // here would load. `makaio serve` boots headless, so the headless copy's
      // `critical` flag is the one that decides, no matter which row the scan
      // happened to list first (the project-local tier leads, and its copy is
      // the interactive, non-critical one).
      await writeProjectLocalDescriptor(projectRoot, descriptor('two-faced', '1.0.0'));
      await writeProjectLocalServerEntry(projectRoot, 'two-faced', [
        { name: 'two-faced' },
        { name: 'two-faced.child', surface: 'interactive' },
      ]);
      await installSurfacedNpmExtension('two-faced.child', 'headless', true);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await program.parseAsync(['extension', 'disable', 'two-faced.child'], { from: 'user' });

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('it is a critical extension'));
      expect(enablementMockState.disabled.has('two-faced.child')).toBe(false);
      expect(process.exitCode).toBe(1);
    });

    it('reports two npm packages declaring one descriptor name as a collision instead of one shadowing the other', async () => {
      // Both sit in `$MAKAIO_HOME/node_modules` — one tier, no precedence to
      // appeal to — so the next boot refuses to resolve the name. Labelling the
      // second row "shadowed by npm" claimed the first one loads, which it
      // does not.
      await installNpmExtension(browserOnlyDescriptor('weather', '1.0.0'), { npmName: '@acme/weather-a' });
      await installNpmExtension(browserOnlyDescriptor('weather', '2.0.0'), { npmName: '@acme/weather-b' });
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await program.parseAsync(['extension', 'list'], { from: 'user' });

      // Sorted before comparing: two packages in one tier have no precedence
      // over each other, so the order they appear in is the filesystem's and
      // asserting it would encode a ranking the runtime explicitly refuses.
      const rows = infoSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.startsWith('weather '))
        .sort();
      expect(rows).toEqual([
        'weather (1.0.0, npm, npm package: @acme/weather-a) [name collision with npm, nothing loads under this name until it is resolved]',
        'weather (2.0.0, npm, npm package: @acme/weather-b) [name collision with npm, nothing loads under this name until it is resolved]',
      ]);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Extension name collision: weather'));
      expect(process.exitCode).toBe(1);

      process.exitCode = undefined;
      errorSpy.mockClear();
      await program.parseAsync(['extension', 'enable', 'weather'], { from: 'user' });
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('more than one installed copy claims this name'));
      expect(process.exitCode).toBe(1);
    });

    it('still resolves a descriptor name claimed by two tiers by tier precedence', async () => {
      // Guard against the collision marking above swallowing the one contest
      // that *is* resolvable: two descriptors, different tiers, same name.
      await installNpmExtension(browserOnlyDescriptor('tiered-ext', '1.0.0'));
      await writeProjectLocalDescriptor(projectRoot, browserOnlyDescriptor('tiered-ext', '2.0.0'));
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await program.parseAsync(['extension', 'list'], { from: 'user' });

      const rows = infoSpy.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith('tiered-ext '));
      expect(rows).toEqual([
        'tiered-ext (2.0.0, project-local) [enabled]',
        'tiered-ext (1.0.0, npm) [shadowed by project-local, not loaded]',
      ]);
      expect(errorSpy).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    });
  });

  describe('unconfigured offline discovery', () => {
    let projectRoot: string;

    beforeEach(async () => {
      projectRoot = await makeTestRepo('makaio-cli-unconfigured-');
      vi.spyOn(process, 'cwd').mockReturnValue(projectRoot);
      // No discovery injected: this is the host that assembled the command
      // tree without resolving runtime config. Its `serve` hands the runtime
      // no boot discovery either, so the runtime falls back to its own
      // filesystem default — and the offline listing must describe that same
      // default, project-local tier included.
      program = new Command();
      registerExtensionCommands(program);
    });

    afterEach(async () => {
      await rm(projectRoot, { recursive: true, force: true });
    });

    it('lists and toggles an extension installed only in the project node_modules', async () => {
      // Nothing under `$MAKAIO_HOME` knows this name, and no config file
      // declares a discovery root — the only tier that can see it is the
      // working directory's own dependency tree.
      await writeProjectLocalDescriptor(projectRoot, browserOnlyDescriptor('project-only-ext', '1.0.0'));
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

      await program.parseAsync(['extension', 'list'], { from: 'user' });
      expect(infoSpy).toHaveBeenCalledWith('project-only-ext (1.0.0, project-local) [enabled]');

      await program.parseAsync(['extension', 'disable', 'project-only-ext'], { from: 'user' });
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Persisted; no running server'));
      expect(enablementMockState.disabled.has('project-only-ext')).toBe(true);
      expect(process.exitCode).toBeUndefined();
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

    it("does not splice this process's project-local installs into a reachable server's listing", async () => {
      // This process's working directory says nothing about the server's: a
      // local server can have been started from anywhere. Only the server's
      // own catalog describes its project-local tier, so a name found only
      // here must never appear in a live listing.
      await writeProjectLocalDescriptor(projectRoot, descriptor('project-only-live-ext', '1.0.0'));
      enablementMockState.health = { url: 'ws://localhost:1234' };
      enablementMockState.listExtensions = [
        { name: 'loaded-ext', displayName: 'Loaded Ext', state: 'active', enabled: true },
      ];
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

      await program.parseAsync(['extension', 'list'], { from: 'user' });

      expect(infoSpy).toHaveBeenCalledWith('Loaded Ext (loaded-ext) [active]');
      // The offline listing does report this name (see the offline describe
      // block above) — a live listing must not.
      expect(infoSpy).not.toHaveBeenCalledWith(expect.stringContaining('project-only-live-ext'));
    });

    it("reports an empty live listing without consulting this process's project-local installs", async () => {
      await writeProjectLocalDescriptor(projectRoot, descriptor('project-only-live-ext', '1.0.0'));
      enablementMockState.health = { url: 'ws://localhost:1234' };
      enablementMockState.listExtensions = [];
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

      await program.parseAsync(['extension', 'list'], { from: 'user' });

      expect(infoSpy).toHaveBeenCalledWith('No extensions registered in the running server.');
      expect(infoSpy).not.toHaveBeenCalledWith(expect.stringContaining('project-only-live-ext'));
    });

    it("lets the server refuse a name that exists only in this process's project-local tier", async () => {
      // Installed here, but the server is the authority on its own host: if it
      // cannot find the name, the request is refused rather than persisted
      // against this machine's unrelated install.
      await writeProjectLocalDescriptor(projectRoot, descriptor('project-only-live-ext', '1.0.0'));
      enablementMockState.health = { url: 'ws://localhost:1234' };
      enablementMockState.setEnabledResult = { success: false, outcome: 'rejected', reason: 'not-installed' };
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await program.parseAsync(['extension', 'disable', 'project-only-live-ext'], { from: 'user' });

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('no installed extension with this name'));
      expect(enablementMockState.disabled.has('project-only-live-ext')).toBe(false);
      expect(process.exitCode).toBe(1);
    });

    it("resolves a name from the server's own project-local tier, which no client can see", async () => {
      // The inverse of the previous case, and the reason the catalog exists:
      // the server accepts a name only its own working directory provides,
      // and persists it — something no client-side validation could allow.
      enablementMockState.health = { url: 'ws://localhost:1234' };
      enablementMockState.setEnabledResult = { success: true, outcome: 'applied', reason: 'not-loaded' };
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

      await program.parseAsync(['extension', 'disable', 'server-project-ext'], { from: 'user' });

      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('not loaded in the running server'));
      expect(enablementMockState.disabled.has('server-project-ext')).toBe(true);
      expect(process.exitCode).toBeUndefined();
    });
  });
});
