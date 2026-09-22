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
 * A single package resolved (installed, upgraded, or confirmed present) during
 * a batch install via the dependency resolver.
 */
export const ResolvedPackageSchema = z.object({
  /**
   * npm package name.
   */
  npmName: z.string(),
  /**
   * Installed or pre-existing version string.
   */
  version: z.string(),
  /**
   * Installation outcome:
   * - `'new'` — the package was not present before this resolution.
   * - `'upgraded'` — the package existed but a newer version was installed.
   * - `'already-present'` — the existing version satisfies the requested range.
   */
  source: z.enum(['new', 'upgraded', 'already-present']),
});

export type ResolvedPackage = z.infer<typeof ResolvedPackageSchema>;

/**
 * A package skipped because it is optional and its installation failed.
 */
export const SkippedPackageSchema = z.object({
  /**
   * npm package name.
   */
  npmName: z.string(),
  /**
   * Human-readable reason the installation was skipped.
   */
  reason: z.string(),
});

export type SkippedPackage = z.infer<typeof SkippedPackageSchema>;

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

  /**
   * All packages installed or confirmed already-present during resolution.
   * Populated for npm batch installs that go through the dependency resolver.
   */
  installed: z.array(ResolvedPackageSchema).optional(),

  /**
   * Optional dependencies that failed and were skipped during resolution.
   */
  skipped: z.array(SkippedPackageSchema).optional(),

  /**
   * Non-fatal diagnostic messages produced during resolution.
   */
  warnings: z.array(z.string()).optional(),
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

  /**
   * Extension identity declared in the package's `descriptor.json` (its
   * `name` field), when the package has one.
   *
   * This is the identity the runtime loader, the enablement file, and
   * `normalizePackageExport` all key on — it can differ from `name` above,
   * which is the npm dependency identifier (e.g. `@makaio/extension-opencode`
   * installing a descriptor named `opencode`). Present whenever
   * `hasDescriptor` is `true`; absent otherwise.
   */
  descriptorName: z.string().min(1).optional(),

  /**
   * Absolute import path for the package's resolved server entrypoint, when
   * its descriptor declares one and the installed files satisfy the runtime
   * entrypoint convention.
   */
  serverImportPath: z.string().min(1).optional(),

  /**
   * Whether the descriptor declares `entrypoints.server` at all, independent
   * of whether `serverImportPath` could be resolved.
   *
   * `serverImportPath` alone cannot distinguish "no server entrypoint
   * declared" (this descriptor legitimately has no exported package, so its
   * own `critical` metadata is authoritative) from "a server entrypoint is
   * declared but its convention-resolved file is missing or unreadable"
   * (criticality is genuinely unknown, not "not critical") — both leave
   * `serverImportPath` unset. Consumers that gate a decision on criticality
   * must check this field before treating an absent `critical` as "known
   * non-critical".
   */
  declaresServerEntrypoint: z.boolean().optional(),

  /**
   * Whether the descriptor's executable package declares itself critical.
   *
   * A descriptor with no server entrypoint has no exported package: the
   * runtime synthesizes its single package straight from `descriptor.json`,
   * so this is that descriptor's own `critical` field. A descriptor that
   * declares a server entrypoint may not declare `critical` itself — the
   * schema rejects that combination — because the entrypoint can export
   * several packages (`example`, `example.child`), each with its own
   * criticality; the listing producers (`YarnPackageManager.listPackages`,
   * `PackageManagerService`'s local-path listing) resolve this field from the
   * exported package matching the descriptor's own name in that case, by
   * importing `serverImportPath` the same way the runtime would at boot.
   * Absent when nothing declares the flag, or when that import failed —
   * never synthesized as `false`.
   */
  critical: z.boolean().optional(),
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

  /**
   * Descriptor name used in `descriptor.json`.
   *
   * When omitted, descriptor-name resolution falls back to scoped passthrough
   * and then the `@makaio/<descriptorName>` convention.
   */
  descriptorName: z.string().min(1).optional(),
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
   * Install one or more packages.
   *
   * Local installs must use a single entry in `packageNames`.
   * The optional `force` flag bypasses inverse-dependency version checks
   * when going through the dependency resolver.
   */
  install: {
    request: z
      .object({
        /** Backward-compatible single package name or path to install. */
        packageName: z.string().optional(),
        /** Package names or paths to install. */
        packageNames: z.array(z.string()).min(1).optional(),
        /** Install source type. When omitted, defaults to npm. */
        source: z.enum(['npm', 'local']).optional(),
        /** When `true`, bypass inverse-dependency version checks in the resolver. */
        force: z.boolean().optional(),
      })
      .refine((value) => value.packageName !== undefined || value.packageNames !== undefined, {
        message: 'Expected packageName or packageNames',
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
