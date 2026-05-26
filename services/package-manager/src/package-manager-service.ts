/**
 * Package Manager Service
 *
 * Bus-connected service for managing extension packages.
 * @packageDocumentation
 */
import * as path from 'node:path';
import type { IMakaioBus } from '@makaio/bus-core';
import { BaseService } from '@makaio/service-base';
import { PackageSubjects } from './namespace.js';
import type { PackageUpdateInfo } from './namespace.js';
import { YarnPackageManager, type FrameworkDependencySpec } from './yarn-integration.js';
import { LocalPathInstaller } from './local-path-installer.js';
import { parseInstallSource } from './install-source.js';
import type { PackageInfo, PackageInstallResult, PackageUninstallResult } from './schemas.js';
import { DependencyResolver, type ResolutionResult, type DependencyPackageManager } from './dependency-resolver.js';
import { DescriptorNameResolver } from './descriptor-name-resolver.js';
import { DevPortalPackageManager, type DevPortalMap } from './dev-portal-resolver.js';
import { RegistryService } from './registry-service.js';
import type { PackageRegistryClient } from './registry-client.js';
import * as semver from 'semver';
import packageMetadata from '../package.json' with { type: 'json' };

/**
 * Package manager client interface.
 *
 * Extends {@link DependencyPackageManager} so the Yarn manager satisfies both
 * the service layer and the dependency resolver without separate adapters.
 */
export interface PackageManagerClient extends DependencyPackageManager {
  /**
   * Initialize package manager storage.
   */
  initialize: () => Promise<void>;
  /**
   * Uninstall a package.
   * @param packageName - Package to uninstall
   */
  uninstallPackage: (packageName: string) => Promise<void>;
  /**
   * List installed packages.
   */
  listPackages: () => Promise<PackageInfo[]>;
  /**
   * Fetch latest available version for a package.
   * @param packageName - Package name to check
   */
  getLatestVersion: (packageName: string) => Promise<string>;
  /**
   * Ensure `@makaio/framework` is present as a dependency with the given version range.
   * @param dependency - Framework dependency source and compatible version range.
   */
  ensureFrameworkDependency: (dependency: FrameworkDependencySpec) => Promise<void>;
}

/**
 * Dependency resolver client used by the service layer.
 *
 * Narrowed to the single method consumed by the install handler so tests can
 * supply lightweight fakes without implementing the full resolver.
 */
export interface DependencyResolverClient {
  /**
   * Resolve and install root packages with all transitive descriptor dependencies.
   * @param roots - Ordered list of root npm package names to install.
   * @param options - Optional resolution control flags.
   * @returns Aggregate resolution result.
   */
  resolve: (
    roots: readonly string[],
    options?: { readonly force?: boolean; readonly snapshot?: unknown | null },
  ) => Promise<ResolutionResult>;
}

/**
 * Local install client interface for extensions installed from local filesystem paths.
 */
export interface LocalInstallClient {
  /**
   * Install an extension from a local source path.
   * @param sourcePath - Absolute or relative path to the extension directory
   */
  install: (sourcePath: string) => Promise<PackageInstallResult>;
  /**
   * Uninstall a locally installed extension by name.
   * @param extensionName - Extension name as declared in its descriptor
   */
  uninstall: (extensionName: string) => Promise<PackageUninstallResult>;
  /**
   * List all locally installed extensions.
   */
  list: () => Promise<
    Array<{ name: string; version: string; sourcePath: string; source: 'local'; serverImportPath?: string }>
  >;
}

/**
 * Options for PackageManagerService.
 */
export interface PackageManagerServiceOptions {
  /**
   * Package manager client (Yarn Berry integration).
   */
  yarnManager?: PackageManagerClient;
  /**
   * Registry service for package discovery.
   * When not provided, the framework-owned static registry client is used.
   */
  registryService?: PackageRegistryClient;
  /**
   * Local installer for extensions installed from the filesystem.
   */
  localInstaller?: LocalInstallClient;
  /**
   * Dependency resolver for npm installs.
   *
   * When not provided, the service constructs a {@link DependencyResolver}
   * from the Yarn manager and a {@link DescriptorNameResolver} backed by either
   * the injected `registryService` or a default {@link RegistryService}.
   */
  dependencyResolver?: DependencyResolverClient;
  /**
   * Framework peer dependency range for npm-installed extensions.
   *
   * When an npm-sourced extension is installed, `@makaio/framework` is
   * ensured as a dependency at this range before the extension itself.
   * Defaults to the package-manager package version range.
   */
  frameworkPeerRange?: string;
  /**
   * Host-provided framework package root used by packaged apps.
   *
   * When present, npm installs record `@makaio/framework` as a local portal
   * dependency so extension imports resolve to the app-provided singleton.
   */
  frameworkPackagePath?: string;
  /**
   * Dev-mode workspace package map used to rewrite install specs to `portal:` ranges.
   *
   * When provided and non-empty, the dependency resolver wraps the Yarn manager
   * with {@link DevPortalPackageManager} so that installs for known workspace
   * packages link directly to local source directories instead of the npm registry.
   *
   * Ignored when `dependencyResolver` is also supplied (caller owns the full
   * resolver in that case).
   */
  devPortalPackages?: DevPortalMap;
}

/**
 * Resolve the fallback framework peer range from package metadata.
 * @returns Semver range used when composition roots do not pass an override.
 */
function resolveDefaultFrameworkPeerRange(): string {
  const version = (packageMetadata as { version?: unknown }).version;
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('Package manager package metadata must include a string version.');
  }
  return `^${version}`;
}

const DEFAULT_FRAMEWORK_PEER_RANGE = resolveDefaultFrameworkPeerRange();

/**
 * Package Manager Service.
 *
 * Registers bus handlers for package management operations:
 * - packages.list - List installed packages
 * - packages.install - Install a package (npm or local path)
 * - packages.uninstall - Uninstall a package
 * - packages.getLatestVersion - Check npm registry for latest version
 * - packages.getRegistry - Get package registry from the configured or default registry service
 * - packages.checkUpdates - Check for available updates
 *
 * All npm operations use Yarn Berry against the makaio home directory.
 * Local installs are routed to {@link LocalInstallClient}.
 */
export class PackageManagerService extends BaseService {
  private readonly yarnManager: PackageManagerClient;
  private readonly registryService: PackageRegistryClient;
  private readonly localInstaller: LocalInstallClient;
  private readonly dependencyResolver: DependencyResolverClient;
  private readonly frameworkPeerRange: string;
  private readonly frameworkPackagePath: string | undefined;

  /**
   * Create a new PackageManagerService.
   * @param bus - Makaio event bus
   * @param makaioHome - Resolved `.makaio` home directory used for Yarn package management
   * @param options - Optional dependency overrides for testing
   */
  public constructor(bus: IMakaioBus, makaioHome: string, options: PackageManagerServiceOptions = {}) {
    super(bus);
    this.yarnManager = options.yarnManager ?? new YarnPackageManager(makaioHome);
    this.registryService = options.registryService ?? new RegistryService();
    this.localInstaller = options.localInstaller ?? new LocalPathInstaller(path.join(makaioHome, 'extensions'));
    this.frameworkPeerRange = options.frameworkPeerRange ?? DEFAULT_FRAMEWORK_PEER_RANGE;
    this.frameworkPackagePath = options.frameworkPackagePath;
    const resolverPackages = options.devPortalPackages?.size
      ? new DevPortalPackageManager(this.yarnManager, options.devPortalPackages)
      : this.yarnManager;
    this.dependencyResolver =
      options.dependencyResolver ??
      new DependencyResolver(resolverPackages, new DescriptorNameResolver(this.registryService));
  }

  /**
   * Initialize package storage then register bus handlers.
   */
  protected async onInit(): Promise<void> {
    await this.yarnManager.initialize();
    console.info('[PackageManagerService] Initialized');

    this.registerPackageHandlers();
    this.registerRegistryHandlers();
  }

  /**
   * Validate a package name from runtime payload before delegating to yarn.
   * Schema validation can be disabled in some production deployments.
   * @param packageName - Runtime payload value to validate.
   * @returns Trimmed package name when valid; otherwise null.
   */
  private normalizePackageName(packageName: unknown): string | null {
    if (typeof packageName !== 'string') {
      return null;
    }
    const trimmed = packageName.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  /**
   * Validates and normalizes packageName from a handler payload.
   * @param packageName - Raw `packageName` payload value
   * @param onInvalid - Callback that writes a handler-specific invalid result
   * @returns Normalized package name or null when invalid
   */
  private validatePackageNamePayload(packageName: unknown, onInvalid: () => void): string | null {
    const normalized = this.normalizePackageName(packageName);
    if (!normalized) {
      onInvalid();
      return null;
    }
    return normalized;
  }

  /**
   * Shared invalid-result payload used by package handlers.
   * @param options - Optional operation-specific fields
   * @returns Standardized invalid-package response
   */
  private createInvalidPackageNameResult(): { success: false; packageName: ''; error: string; restartRequired: false };
  private createInvalidPackageNameResult(options: { latestVersion: 'unknown' }): {
    success: false;
    packageName: '';
    latestVersion: 'unknown';
    error: string;
  };
  private createInvalidPackageNameResult(options?: { latestVersion: 'unknown' }) {
    if (options) {
      return {
        success: false as const,
        packageName: '' as const,
        latestVersion: options.latestVersion,
        error: 'Invalid packageName',
      };
    }

    return {
      success: false,
      packageName: '',
      error: 'Invalid packageName',
      restartRequired: false,
    };
  }

  /**
   * Emit `packages.installed` before resolving the install RPC.
   * @param packageName - Installed package name.
   * @param version - Installed version.
   */
  private async emitInstalled(packageName: string, version: string): Promise<void> {
    try {
      await this.bus.emit(PackageSubjects.installed, { packageName, version });
    } catch (err) {
      console.error('[PackageManagerService] installed emit failed:', err);
    }
  }

  /**
   * Emit `packages.uninstalled` before resolving the uninstall RPC.
   * @param packageName - Uninstalled package name.
   */
  private async emitUninstalled(packageName: string): Promise<void> {
    try {
      await this.bus.emit(PackageSubjects.uninstalled, { packageName });
    } catch (err) {
      console.error('[PackageManagerService] uninstalled emit failed:', err);
    }
  }

  /**
   * Register package management handlers.
   */
  private registerPackageHandlers(): void {
    this.registerListHandler();
    this.registerInstallHandler();
    this.registerUninstallHandler();
  }

  /**
   * Register the installed package listing handler.
   */
  private registerListHandler(): void {
    this.registerHandler(PackageSubjects.list, async (ctx) => {
      try {
        const [npmPackages, localExtensions] = await Promise.all([
          this.yarnManager.listPackages(),
          this.localInstaller.list(),
        ]);
        const packages: PackageInfo[] = [
          ...npmPackages,
          ...localExtensions.map((extension) => ({
            name: extension.name,
            version: extension.version,
            hasDescriptor: true,
            ...(extension.serverImportPath !== undefined && { serverImportPath: extension.serverImportPath }),
          })),
        ];
        ctx.setResult({ packages });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[PackageManagerService] List failed:', message);
        ctx.setResult({ packages: [] });
      }
    });
  }

  /**
   * Ensure the framework peer dependency is present before installing extensions.
   * @throws When `yarnManager.ensureFrameworkDependency` fails.
   */
  private async ensureFrameworkPeer(): Promise<void> {
    try {
      await this.yarnManager.ensureFrameworkDependency({
        versionRange: this.frameworkPeerRange,
        ...(this.frameworkPackagePath ? { localPackagePath: this.frameworkPackagePath } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to ensure @makaio/framework dependency ${this.frameworkPeerRange}: ${message}`, {
        cause: error,
      });
    }
  }

  /**
   * Install a batch of npm packages through the dependency resolver and emit
   * `packages.installed` for each newly-installed package.
   * @param names - Normalized npm package names.
   * @param force - When `true`, bypass inverse-dependency version checks.
   * @returns Resolved install result payload.
   */
  private async installNpmPackages(names: readonly string[], force?: boolean): Promise<PackageInstallResult> {
    const snapshot = await this.yarnManager.readManifestSnapshot();
    let resolution: ResolutionResult;
    try {
      await this.ensureFrameworkPeer();
      resolution = await this.dependencyResolver.resolve(names, { force, snapshot: null });
    } catch (error) {
      try {
        await this.yarnManager.writeManifestAndReinstall(snapshot);
      } catch (rollbackError) {
        const message = error instanceof Error ? error.message : String(error);
        throw new AggregateError([error, rollbackError], `Package install failed and rollback failed: ${message}`);
      }
      throw error;
    }
    for (const resolved of resolution.installed) {
      if (resolved.source !== 'already-present') {
        await this.emitInstalled(resolved.npmName, resolved.version);
      }
    }
    const first = resolution.installed[0];
    return {
      success: true,
      packageName: first?.npmName ?? names[0] ?? '',
      version: first?.version,
      restartRequired: true,
      installed: [...resolution.installed],
      skipped: [...resolution.skipped],
      warnings: [...resolution.warnings],
    };
  }

  /**
   * Register the package installation handler.
   *
   * Local installs are restricted to a single entry; npm installs go through the
   * dependency resolver for transitive resolution and rollback support.
   */
  private registerInstallHandler(): void {
    this.registerHandler(PackageSubjects.install, async (ctx) => {
      const packageNames =
        ctx.payload.packageNames ?? (ctx.payload.packageName !== undefined ? [ctx.payload.packageName] : []);
      const normalizedNames = packageNames
        .map((name) => this.normalizePackageName(name))
        .filter((name): name is string => name !== null);

      if (normalizedNames.length !== packageNames.length || normalizedNames.length === 0) {
        ctx.setResult(this.createInvalidPackageNameResult());
        return;
      }

      let source: { kind: 'npm' | 'local' | 'git' };
      if (ctx.payload.source !== undefined) {
        source = { kind: ctx.payload.source };
      } else {
        const sources = normalizedNames.map((name) => parseInstallSource(name));
        source = sources[0]!;
        const mixedSource = sources.find((s) => s.kind !== source.kind);
        if (mixedSource) {
          ctx.setResult({
            success: false,
            packageName: '',
            error: `Cannot mix install sources: ${source.kind} and ${mixedSource.kind}`,
            restartRequired: false,
          });
          return;
        }
      }

      if (source.kind === 'git') {
        ctx.setResult({
          success: false,
          packageName: normalizedNames[0]!,
          error: 'Git URL installs are not yet supported',
          restartRequired: false,
        });
        return;
      }

      if (source.kind === 'local') {
        if (normalizedNames.length > 1) {
          ctx.setResult({
            success: false,
            packageName: '',
            error: 'Local installs only support a single path',
            restartRequired: false,
          });
          return;
        }
        const result = await this.localInstaller.install(normalizedNames[0]!);
        if (result.success) {
          await this.emitInstalled(result.packageName, result.version ?? 'unknown');
        }
        ctx.setResult(result);
        return;
      }

      try {
        ctx.setResult(await this.installNpmPackages(normalizedNames, ctx.payload.force));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[PackageManagerService] Install failed:', message);
        ctx.setResult({
          success: false,
          packageName: normalizedNames[0] ?? '',
          error: message,
          restartRequired: false,
        });
      }
    });
  }

  /**
   * Register the package uninstallation handler.
   */
  private registerUninstallHandler(): void {
    this.registerHandler(PackageSubjects.uninstall, async (ctx) => {
      const packageName = this.validatePackageNamePayload(ctx.payload.packageName, () => {
        ctx.setResult(this.createInvalidPackageNameResult());
      });
      if (!packageName) {
        return;
      }
      const localExtensions = await this.localInstaller.list();
      const localExtension = localExtensions.find((extension) => extension.name === packageName);
      if (localExtension) {
        const result = await this.localInstaller.uninstall(packageName);
        if (result.success) {
          await this.emitUninstalled(packageName);
        }
        ctx.setResult(result);
        return;
      }

      try {
        await this.yarnManager.uninstallPackage(packageName);
        await this.emitUninstalled(packageName);
        ctx.setResult({
          success: true,
          packageName,
          restartRequired: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[PackageManagerService] Uninstall failed:', message);
        ctx.setResult({
          success: false,
          packageName,
          error: message,
          restartRequired: false,
        });
      }
    });
  }

  /**
   * Register registry and version handlers.
   */
  private registerRegistryHandlers(): void {
    this.registerHandler(PackageSubjects.getLatestVersion, async (ctx) => {
      const packageName = this.validatePackageNamePayload(ctx.payload.packageName, () => {
        ctx.setResult(this.createInvalidPackageNameResult({ latestVersion: 'unknown' }));
      });
      if (!packageName) {
        return;
      }
      try {
        const latestVersion = await this.yarnManager.getLatestVersion(packageName);
        ctx.setResult({
          success: true,
          packageName,
          latestVersion,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[PackageManagerService] Version check failed:', message);
        ctx.setResult({
          success: false,
          packageName,
          latestVersion: 'unknown',
          error: message,
        });
      }
    });

    this.registerHandler(PackageSubjects.getRegistry, async (ctx) => {
      try {
        const registry = await this.registryService.getRegistry();
        ctx.setResult(registry);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[PackageManagerService] Registry fetch failed:', message);
        ctx.setResult({
          $schema: 'makaio/package-registry/v1',
          updatedAt: new Date().toISOString(),
          adapters: [],
          extensions: [],
        });
      }
    });

    this.registerHandler(PackageSubjects.checkUpdates, async (ctx) => {
      try {
        const updates = await this.checkForUpdates();
        ctx.setResult({ updates });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[PackageManagerService] Update check failed:', message);
        ctx.setResult({ updates: [] });
      }
    });
  }

  /**
   * Check for available package updates.
   *
   * Compares installed packages against npm registry using semver.
   * @returns Array of packages with available updates
   */
  private async checkForUpdates(): Promise<PackageUpdateInfo[]> {
    try {
      const installedPackages = await this.yarnManager.listPackages();

      const updates: PackageUpdateInfo[] = [];

      await Promise.all(
        installedPackages.map(async (pkg) => {
          try {
            const latestVersion = await this.yarnManager.getLatestVersion(pkg.name);
            if (semver.valid(pkg.version) && semver.valid(latestVersion) && semver.gt(latestVersion, pkg.version)) {
              updates.push({
                name: pkg.name,
                currentVersion: pkg.version,
                latestVersion,
                description: pkg.description,
              });
            }
          } catch (error) {
            console.warn('[PackageManagerService] Failed to check updates for %s:', pkg.name, error);
          }
        }),
      );
      console.info('[PackageManagerService] Found %d package updates', updates.length);
      return updates;
    } catch (error) {
      throw new Error('Failed to check for updates', { cause: error });
    }
  }
}
