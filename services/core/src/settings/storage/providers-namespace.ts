import { z } from 'zod';
import { createStorageNamespaceDefinition } from '@makaio/storage-core';
import { AIModelSchema, ModelFilterModeSchema, ProtocolEndpointsSchema, ProtocolIdSchema } from '@makaio/contracts';
import { StorageIdRequestSchema } from './shared-schemas.js';

/**
 * Schema for a provider record returned from storage.
 *
 * Mirrors the `providers` table columns with nulls converted to undefined.
 * This is a read-only view — all writes are owned by the provider sync service.
 */
export const ProviderRecordSchema = z.object({
  /** Stable provider identifier (e.g., `'anthropic'`, `'z-ai'`). */
  id: z.string(),
  /** npm package name that contributed this provider (e.g., `'@makaio/provider-anthropic'`). */
  packageName: z.string(),
  /** Display name for the provider (e.g., `'Anthropic'`). */
  name: z.string(),
  /** Short human-readable description of the provider. */
  description: z.string().optional(),
  /** Wire protocol endpoint URLs — maps protocol ids to base URLs. */
  endpoints: ProtocolEndpointsSchema.optional(),
  /** Default model identifier for general-purpose tasks. */
  defaultModel: z.string().optional(),
  /** Fast/cheap model identifier for cost-sensitive operations. */
  fastModel: z.string().optional(),
  /** Static model catalog declared by the provider package. */
  availableModels: z.array(AIModelSchema),
  /** Default model filter mode applied when a provider record is first created. */
  defaultModelFilterMode: ModelFilterModeSchema,
  /** Credential environment variable names — maps field names to env var names. */
  credentialEnvVars: z.record(z.string(), z.string()).optional(),
  /** Whether this provider is enabled. */
  enabled: z.boolean(),
  /** Timestamp when record was created (Unix milliseconds). */
  createdAt: z.number(),
  /** Timestamp when record was last updated (Unix milliseconds). */
  updatedAt: z.number(),
});

/**
 * Storage namespace for system-managed provider records.
 *
 * Exposes read-only bus subjects for querying provider data.
 * All writes are internal — owned by the provider sync service at boot time.
 *
 * - `get`: Retrieve a single provider by ID
 * - `list`: Retrieve all providers
 * - `listByProtocol`: Retrieve all providers that support a given wire protocol
 */
export const ProviderStorageNamespace = createStorageNamespaceDefinition('provider', {
  schemas: {
    get: {
      request: StorageIdRequestSchema,
      response: z.object({ provider: ProviderRecordSchema.nullable() }),
    },
    list: {
      request: z.object({}),
      response: z.object({ providers: z.array(ProviderRecordSchema) }),
    },
    listByProtocol: {
      request: z.object({ protocol: ProtocolIdSchema }),
      response: z.object({ providers: z.array(ProviderRecordSchema) }),
    },
  },
});

export const ProviderStorageSubjects = ProviderStorageNamespace.subjects;

export type ProviderRecord = z.infer<typeof ProviderRecordSchema>;
