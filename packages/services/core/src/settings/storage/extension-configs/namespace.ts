import { z } from 'zod';
import { createStorageNamespace } from '@makaio/storage-core';

/** Extension configuration data model. */
const ExtensionConfigSchema = z.object({
  /** Unique identifier */
  id: z.string(),
  /** Extension name */
  extensionName: z.string(),
  /** Extension configuration object */
  config: z.record(z.string(), z.unknown()).optional(),
  /** Scope: 'default' for global, projectId for project-specific */
  scope: z.string(),
  /** Whether this config is enabled */
  enabled: z.boolean(),
  /** Unix timestamp of creation */
  createdAt: z.number(),
  /** Unix timestamp of last update */
  updatedAt: z.number(),
});

/** Input schema for extension configuration (omits timestamps). */
const ExtensionConfigInputSchema = ExtensionConfigSchema.omit({
  createdAt: true,
  updatedAt: true,
});

/** Query schema for listing extension configs. */
const ExtensionConfigListQuerySchema = z
  .object({
    /** Filter by scope (optional). Use 'default' for global or a project ID for project scope. */
    scope: z.string().optional(),
    /** Deprecated alias for scope. Kept temporarily while callers migrate. */
    projectId: z.string().optional(),
    /** Filter by extension name (optional) */
    extensionName: z.string().optional(),
  })
  .refine((value) => value.scope === undefined || value.projectId === undefined, {
    message: 'Extension config list query accepts either "scope" or deprecated "projectId", not both.',
  });

/** Input schema for atomic enabled-only updates. */
const ExtensionConfigSetEnabledSchema = z.object({
  /** Extension name */
  extensionName: z.string(),
  /** Scope to update */
  scope: z.string(),
  /** Enabled state to persist */
  enabled: z.boolean(),
});

/**
 * Storage namespace for extension configurations.
 *
 * Provides CRUD operations for extension-level settings with two-tier scoping.
 * The drizzle schema extension is attached by the host-tier storage wiring,
 * not here — this file defines only the bus contract.
 */
export const ExtensionConfigStorageNamespace = createStorageNamespace('extensionConfig', {
  schemas: {
    get: {
      request: z.object({ id: z.string() }),
      response: z.object({ extensionConfig: ExtensionConfigSchema.nullable() }),
    },
    set: {
      request: z.object({ extensionConfig: ExtensionConfigInputSchema }),
      response: z.object({ id: z.string() }),
    },
    setEnabled: {
      request: ExtensionConfigSetEnabledSchema,
      response: z.object({ id: z.string() }),
    },
    delete: {
      request: z.object({ id: z.string() }),
      response: z.object({ deleted: z.boolean() }),
    },
    list: {
      request: ExtensionConfigListQuerySchema,
      response: z.object({ extensionConfigs: z.array(ExtensionConfigSchema) }),
    },
  },
});

export const ExtensionConfigStorageSubjects = ExtensionConfigStorageNamespace.subjects;

export type ExtensionConfig = z.infer<typeof ExtensionConfigSchema>;
export type ExtensionConfigInput = z.infer<typeof ExtensionConfigInputSchema>;
export type ExtensionConfigListQuery = z.infer<typeof ExtensionConfigListQuerySchema>;
export type ExtensionConfigSetEnabledInput = z.infer<typeof ExtensionConfigSetEnabledSchema>;
