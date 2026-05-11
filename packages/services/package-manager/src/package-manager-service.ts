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
import type { PackageUpdateInfo, PackageRegistry } from './namespace.js';
import { YarnPackageManager } from './yarn-integration.js';
import { LocalPathInstaller } from './local-path-installer.js';
import { parseInstallSource } from './install-source.js';
import type { PackageInfo, PackageInstallResult, PackageUninstallResult } from './schemas.js';
import * as semver from 'semver';
import packageMetadata from '../package.json' with { type: 'json' };

/**
 * Package manager client interface.
 */
export interface PackageManagerClient {
  /**
   * Initialize package manager storage.
   */
  initialize: () => Promise<void>;
  /**
   * Install a package and return its version.
   * @param packageName - Package to install
   */
  installPackage: (packageName: string) => Promise<string>;
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
   * @param versionRange - Semver range for the framework dependency (e.g. `^0.1.0`).
   */
  ensureFrameworkDependency: (versionRange: string) => Promise<void>;
}

/**
 * Package registry client interface.
 */
export interface PackageRegistryClient {
  /**
   * Fetch package registry data.
   */
  getRegistry: () => Promise<PackageRegistry>;
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
  list: () => Promise<Array<{ name: string; version: string; sourcePath: string; source: 'local' }>>;
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
   * When not provided, the `getRegistry` subject remains unhandled so products
   * can own registry policy explicitly.
   */
  registryService?: PackageRegistryClient;
  /**
   * Local installer for extensions installed from the filesystem.
   */
  localInstaller?: LocalInstallClient;
  /**
   * Framework peer dependency range for npm-installed extensions.
   *
   * When an npm-sourced extension is installed, `@makaio/framework` is
   * ensured as a dependency at this range before the extension itself.
   * Defaults to the package-manager package version range.
   */
  frameworkPeerRange?: string;
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
 * - packages.getRegistry - Get package registry (empty when no registry service provided)
 * - packages.checkUpdates - Check for available updates
 *
 * All npm operations use Yarn Berry against the makaio home directory.
 * Local installs are routed to {@link LocalInstallClient}.
 */
export class PackageManagerService extends BaseService {
  private readonly yarnManager: PackageManagerClient;
  private readonly registryService: PackageRegistryClient | undefined;
  private readonly localInstaller: LocalInstallClient;
  private readonly frameworkPeerRange: string;

  /**
   * Create a new PackageManagerService.
   * @param bus - Makaio event bus
   * @param makaioHome - Resolved `.makaio` home directory used for Yarn package management
   * @param options - Optional dependency overrides for testing
   */
  public constructor(bus: IMakaioBus, makaioHome: string, options: PackageManagerServiceOptions = {}) {
    super(bus);
    this.yarnManager = options.yarnManager ?? new YarnPackageManager(makaioHome);
    this.registryService = options.registryService;
    this.localInstaller = options.localInstaller ?? new LocalPathInstaller(path.join(makaioHome, 'extensions'));
    this.frameworkPeerRange = options.frameworkPeerRange ?? DEFAULT_FRAMEWORK_PEER_RANGE;
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
   * Register the package installation handler.
   */
  private registerInstallHandler(): void {
    this.registerHandler(PackageSubjects.install, async (ctx) => {
      const packageName = this.validatePackageNamePayload(ctx.payload.packageName, () => {
        ctx.setResult(this.createInvalidPackageNameResult());
      });
      if (!packageName) {
        return;
      }

      const source = ctx.payload.source === undefined ? parseInstallSource(packageName) : { kind: ctx.payload.source };

      if (source.kind === 'local') {
        const result = await this.localInstaller.install(packageName);
        if (result.success) {
          await this.emitInstalled(result.packageName, result.version ?? 'unknown');
        }
        ctx.setResult(result);
        return;
      }

      if (source.kind === 'git') {
        ctx.setResult({
          success: false,
          packageName,
          error: 'Git URL installs are not yet supported',
          restartRequired: false,
        });
        return;
      }

      try {
        try {
          await this.yarnManager.ensureFrameworkDependency(this.frameworkPeerRange);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Failed to ensure @makaio/framework dependency ${this.frameworkPeerRange}: ${message}`, {
            cause: error,
          });
        }
        const version = await this.yarnManager.installPackage(packageName);
        await this.emitInstalled(packageName, version);
        ctx.setResult({
          success: true,
          packageName,
          version,
          restartRequired: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[PackageManagerService] Install failed:', message);
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

    const registryService = this.registryService;
    if (registryService) {
      this.registerHandler(PackageSubjects.getRegistry, async (ctx) => {
        try {
          const registry = await registryService.getRegistry();
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
    }

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
