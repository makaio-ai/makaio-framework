/**
 * Package Management Bus Namespace — pure namespace definition.
 *
 * For Zod schemas only, import `./schemas` instead.
 * @packageDocumentation
 */
import { createBusNamespace } from '@makaio/core';
import {
  PackageInstallResultSchema,
  PackageUninstallResultSchema,
  PackageInfoSchema,
  PackageVersionInfoSchema,
  RegistryPackageSchema,
  PackageRegistrySchema,
  PackageUpdateInfoSchema,
  ResolvedPackageSchema,
  SkippedPackageSchema,
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
  ResolvedPackage,
  SkippedPackage,
} from './schemas.js';
export {
  PackageInstallResultSchema,
  PackageUninstallResultSchema,
  PackageInfoSchema,
  PackageVersionInfoSchema,
  RegistryPackageSchema,
  PackageRegistrySchema,
  PackageUpdateInfoSchema,
  ResolvedPackageSchema,
  SkippedPackageSchema,
};

/**
 * Pure bus namespace definition for package management subjects.
 */
export const PackageManagementNamespace = createBusNamespace('packages', PackageManagementSchemas);

/**
 * Typed subjects for package management operations.
 */
export const PackageSubjects = PackageManagementNamespace.subjects;
