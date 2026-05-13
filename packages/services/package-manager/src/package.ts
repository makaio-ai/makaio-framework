import type { MakaioExtension } from '@makaio/contracts';
import { PackageManagerService, type PackageRegistryClient } from './package-manager-service.js';

/**
 * Options for creating the framework package-manager runtime package.
 */
export interface PackageManagerPackageOptions {
  /**
   * Optional registry provider. Framework-only runtime leaves this unset;
   * host runtimes can contribute their own registry handler separately.
   */
  readonly registryService?: PackageRegistryClient;
  /**
   * Framework peer dependency range installed alongside npm-sourced extensions.
   */
  readonly frameworkPeerRange?: string;
}

/**
 * Create the framework-owned package-manager runtime package.
 *
 * Package installation is framework infrastructure: extension authors need it
 * without loading any host-owned Makaio Dev package.
 * @param options - Optional package-manager dependencies.
 * @returns Runtime extension package for the package manager service.
 */
export function createPackageManagerPackage(options: PackageManagerPackageOptions = {}): MakaioExtension {
  return {
    name: 'makaio.package-manager',
    displayName: 'Package Manager',
    version: '0.1.0',
    critical: true,
    create: (ctx) =>
      new PackageManagerService(ctx.bus, ctx.makaioHome, {
        registryService: options.registryService,
        frameworkPeerRange: options.frameworkPeerRange,
      }),
  };
}
