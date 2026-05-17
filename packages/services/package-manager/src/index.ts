export {
  PackageManagementNamespace,
  PackageSubjects,
  PackageInstallResultSchema,
  PackageUninstallResultSchema,
  PackageInfoSchema,
  PackageVersionInfoSchema,
  RegistryPackageSchema,
  PackageRegistrySchema,
  PackageUpdateInfoSchema,
  ResolvedPackageSchema,
  SkippedPackageSchema,
} from './namespace.js';
export type {
  PackageInstallResult,
  PackageUninstallResult,
  PackageInfo,
  PackageVersionInfo,
  RegistryPackage,
  PackageRegistry,
  PackageUpdateInfo,
  ResolvedPackage,
  SkippedPackage,
} from './namespace.js';
export { RegistryService } from './registry-service.js';
export type { RegistryServiceOptions } from './registry-service.js';
export { YarnPackageManager, packageSpecWithRange } from './yarn-integration.js';
export type { InstalledExtensionDescriptor } from './yarn-integration.js';
export { LocalPathInstaller } from './local-path-installer.js';
export type { LocalExtensionEntry } from './local-path-installer.js';
export { parseInstallSource } from './install-source.js';
export type { InstallSource } from './install-source.js';
export { PackageManagerService } from './package-manager-service.js';
export type { PackageManagerClient, LocalInstallClient, DependencyResolverClient } from './package-manager-service.js';
export type { PackageRegistryClient } from './registry-client.js';
export { createPackageManagerPackage } from './package.js';
export type { PackageManagerPackageOptions } from './package.js';
export { DescriptorNameResolver } from './descriptor-name-resolver.js';
export type { IDescriptorNameResolver } from './descriptor-name-resolver.js';
export { DependencyResolver } from './dependency-resolver.js';
export type { DependencyPackageManager, ResolutionOptions, ResolutionResult } from './dependency-resolver.js';
