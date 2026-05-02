/**
 * Package Management Bus Namespace — has side effects (registers on the bus).
 *
 * For pure Zod schemas without side effects, import `./schemas` instead.
 * @packageDocumentation
 */
import { MakaioBus } from '@makaio/bus-core';
import {
  PackageInstallResultSchema,
  PackageUninstallResultSchema,
  PackageInfoSchema,
  PackageVersionInfoSchema,
  RegistryPackageSchema,
  PackageRegistrySchema,
  PackageUpdateInfoSchema,
  PackageManagementSchemas,
} from './schemas.js';

export type {
  PackageInstallResult,
  PackageUninstallResult,
  PackageInfo,
  PackageVersionInfo,
  RegistryPackage,
  PackageRegistry,
  PackageUpdateInfo,
} from './schemas.js';
export {
  PackageInstallResultSchema,
  PackageUninstallResultSchema,
  PackageInfoSchema,
  PackageVersionInfoSchema,
  RegistryPackageSchema,
  PackageRegistrySchema,
  PackageUpdateInfoSchema,
};

/**
 * Package Management namespace registration.
 */
export const PackageManagementNamespace = MakaioBus.registerNamespace('packages', PackageManagementSchemas);

/**
 * Typed subjects for package management operations.
 */
export const PackageSubjects = PackageManagementNamespace.subjects;
