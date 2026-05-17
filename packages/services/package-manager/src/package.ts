import type { IMakaioBus } from '@makaio/bus-core';
import type { MakaioNodeExtension } from '@makaio/contracts';
import { PackageManagerService, type DependencyResolverClient } from './package-manager-service.js';
import type { PackageRegistryClient } from './registry-client.js';
import { PackageManagementNamespace } from './namespace.js';

/**
 * Options for creating the framework package-manager runtime package.
 */
export interface PackageManagerPackageOptions {
  /**
   * Optional registry provider. Framework-only runtime leaves this unset;
   * the package manager service then uses the default framework registry client.
   */
  readonly registryService?: PackageRegistryClient;
  /**
   * Optional dependency resolver override.
   *
   * When not provided, the service constructs a default resolver from the
   * Yarn manager and a registry-backed name resolver.
   */
  readonly dependencyResolver?: DependencyResolverClient;
  /**
   * Framework peer dependency range installed alongside npm-sourced extensions.
   */
  readonly frameworkPeerRange?: string;
  /**
   * Host-provided `@makaio/framework` package root used by packaged apps.
   */
  readonly frameworkPackagePath?: string;
}

/**
 * Create the framework-owned package-manager runtime package.
 *
 * Package installation is framework infrastructure: extension authors need it
 * without loading any host-owned Makaio Dev package.
 * @param options - Optional package-manager dependencies.
 * @returns Runtime extension package for the package manager service.
 */
export function createPackageManagerPackage(
  options: PackageManagerPackageOptions = {},
): MakaioNodeExtension<IMakaioBus> {
  return {
    name: 'makaio.package-manager',
    displayName: 'Package Manager',
    version: '0.1.0',
    critical: true,
    namespaces: [PackageManagementNamespace],
    create: (ctx) =>
      new PackageManagerService(ctx.bus, ctx.makaioHome, {
        registryService: options.registryService,
        dependencyResolver: options.dependencyResolver,
        frameworkPeerRange: options.frameworkPeerRange,
        frameworkPackagePath: options.frameworkPackagePath,
      }),
  };
}
