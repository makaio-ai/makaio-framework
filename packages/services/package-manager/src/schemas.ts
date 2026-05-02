/**
 * Package Management bus schemas — pure Zod, no side effects.
 *
 * Defines Zod schemas for package installation, uninstallation, listing,
 * and registry operations, plus the `PackageManagementSchemas` aggregate
 * used for namespace registration.
 *
 * Import this module when you only need types or validation shapes without
 * registering the namespace on the bus. To register the namespace, import
 * `./register` instead.
 * @packageDocumentation
 */

import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';

/**
 * Package installation result.
 */
export const PackageInstallResultSchema = z.object({
  /**
   * Whether installation succeeded.
   */
  success: z.boolean(),

  /**
   * Package name that was installed.
   */
  packageName: z.string(),

  /**
   * Installed version (if successful).
   */
  version: z.string().optional(),

  /**
   * Whether applying the change requires an app restart.
   */
  restartRequired: z.boolean(),

  /**
   * Error message (if failed).
   */
  error: z.string().optional(),
});

export type PackageInstallResult = z.infer<typeof PackageInstallResultSchema>;

/**
 * Package uninstallation result.
 */
export const PackageUninstallResultSchema = z.object({
  /**
   * Whether uninstallation succeeded.
   */
  success: z.boolean(),

  /**
   * Package name that was uninstalled.
   */
  packageName: z.string(),

  /**
   * Error message (if failed).
   */
  error: z.string().optional(),

  /**
   * Whether applying the change requires an app restart.
   */
  restartRequired: z.boolean(),
});

export type PackageUninstallResult = z.infer<typeof PackageUninstallResultSchema>;

/**
 * Installed package information.
 */
export const PackageInfoSchema = z.object({
  /**
   * Package name (e.g., `@acme/weather-tools`).
   */
  name: z.string(),

  /**
   * Installed version (e.g., "1.2.3").
   */
  version: z.string(),

  /**
   * Package description (if available).
   */
  description: z.string().optional(),

  /**
   * Whether the package contains a valid extension descriptor.
   */
  hasDescriptor: z.boolean().default(false),
});

export type PackageInfo = z.infer<typeof PackageInfoSchema>;

/**
 * Package version information from registry.
 */
export const PackageVersionInfoSchema = z.object({
  /**
   * Package name.
   */
  packageName: z.string(),

  /**
   * Latest version available.
   */
  latestVersion: z.string(),

  /**
   * Whether version check succeeded.
   */
  success: z.boolean(),

  /**
   * Error message (if failed).
   */
  error: z.string().optional(),
});

export type PackageVersionInfo = z.infer<typeof PackageVersionInfoSchema>;

/**
 * Registry package entry.
 */
export const RegistryPackageSchema = z.object({
  /**
   * npm package name (e.g., `@acme/weather-tools`).
   */
  name: z.string(),

  /**
   * Human-readable display name.
   */
  displayName: z.string(),

  /**
   * Package description.
   */
  description: z.string(),

  /**
   * Icon key or URL.
   */
  icon: z.string().optional(),

  /**
   * Package tags (official, community, integration).
   */
  tags: z.array(z.string()).optional(),
});

export type RegistryPackage = z.infer<typeof RegistryPackageSchema>;

/**
 * Package registry response.
 */
export const PackageRegistrySchema = z.object({
  /**
   * Schema version.
   */
  $schema: z.string(),

  /**
   * Last update timestamp.
   */
  updatedAt: z.string(),

  /**
   * Available adapters.
   */
  adapters: z.array(RegistryPackageSchema),

  /**
   * Available extensions.
   */
  extensions: z.array(RegistryPackageSchema),
});

export type PackageRegistry = z.infer<typeof PackageRegistrySchema>;

/**
 * Package update information.
 */
export const PackageUpdateInfoSchema = z.object({
  /**
   * Package name.
   */
  name: z.string(),

  /**
   * Current installed version.
   */
  currentVersion: z.string(),

  /**
   * Latest available version.
   */
  latestVersion: z.string(),

  /**
   * Package description (if available).
   */
  description: z.string().optional(),
});

export type PackageUpdateInfo = z.infer<typeof PackageUpdateInfoSchema>;

/**
 * Package Management service bus schemas.
 *
 * Each key becomes a subject identifier as `packages.<key>`.
 */
export const PackageManagementSchemas = {
  /**
   * List installed packages.
   *
   * Returns all installed extension packages.
   */
  list: {
    request: z.object({}),
    response: z.object({
      packages: z.array(PackageInfoSchema),
    }),
  },

  /**
   * Install a package.
   *
   * Install an extension package from the configured source.
   */
  install: {
    request: z.object({
      /** Package name or path to install. */
      packageName: z.string(),
      /** Install source type. When omitted, defaults to npm. */
      source: z.enum(['npm', 'local']).optional(),
    }),
    response: PackageInstallResultSchema,
  },

  /**
   * Uninstall a package.
   *
   * Removes a package from ~/.makaio/.
   */
  uninstall: {
    request: z.object({
      packageName: z.string(),
    }),
    response: PackageUninstallResultSchema,
  },

  /**
   * Get latest version from registry.
   *
   * Checks npm registry for the latest available version.
   */
  getLatestVersion: {
    request: z.object({
      packageName: z.string(),
    }),
    response: PackageVersionInfoSchema,
  },

  /**
   * Get package registry.
   *
   * Fetches the GitHub-hosted packages.json registry.
   */
  getRegistry: {
    request: z.object({}),
    response: PackageRegistrySchema,
  },

  /**
   * Check for package updates.
   *
   * Compares installed packages against npm registry to find available updates.
   */
  checkUpdates: {
    request: z.object({}),
    response: z.object({
      /**
       * Packages with available updates.
       */
      updates: z.array(PackageUpdateInfoSchema),
    }),
  },

  /**
   * Emitted after a package is successfully installed.
   *
   * Fire-and-forget event — no response expected. Subscribers can use this
   * for UI refresh, hot-reload triggers, or logging.
   */
  installed: z.object({
    /** Installed package name. */
    packageName: z.string(),
    /** Installed version string. */
    version: z.string(),
  }),

  /**
   * Emitted after a package is successfully uninstalled.
   *
   * Fire-and-forget event — no response expected.
   */
  uninstalled: z.object({
    /** Uninstalled package name. */
    packageName: z.string(),
  }),
} as const satisfies SchemaRecord;
