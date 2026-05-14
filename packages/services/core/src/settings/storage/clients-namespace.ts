import { z } from 'zod';
import { createStorageNamespaceDefinition } from '@makaio/storage-core';
import { ApprovalPolicySchema } from '@makaio/contracts/harness';
import {
  ClientBinaryCompatibilitySchema,
  ClientToolDefinitionSchema,
  LogSourceDefinitionSchema,
} from '@makaio/contracts/client';
import { StorageIdRequestSchema } from './shared-schemas.js';

/**
 * Schema for a client record returned from storage.
 *
 * Mirrors the `clients` table columns with nulls converted to undefined.
 * This is a read-only view — all writes are owned by the client sync service.
 */
export const ClientRecordSchema = z.object({
  /** Stable client identifier (e.g. `'claude-code'`). */
  id: z.string(),
  /** npm package name that contributed this client (e.g. `'@makaio/client-claude-code'`). */
  packageName: z.string(),
  /** Display name for the client (e.g. `'Claude Code'`). */
  name: z.string(),
  /** Short human-readable description of the client. */
  description: z.string().optional(),
  /** Binary compatibility used for CLI detection and version gating. */
  binary: ClientBinaryCompatibilitySchema.optional(),
  /** Native tools the binary exposes to the harness. */
  nativeTools: z.array(ClientToolDefinitionSchema),
  /** Default approval policy applied when creating a harness for this client. */
  defaultApprovalPolicy: ApprovalPolicySchema,
  /** Log source definitions used by the log-import service. */
  logSources: z.array(LogSourceDefinitionSchema).optional(),
  /**
   * Provider definition ID to use for client-managed auth (sentinel
   * ProviderConfig). References a ProviderDefinition.id.
   */
  defaultProviderId: z.string().optional(),
  /** Static environment variable overrides contributed by the client package. */
  env: z.record(z.string(), z.string()).optional(),
  /** Maps credential field names to environment variable names.
   *  Values are env var names, not secrets — actual credential storage
   *  is handled by the platform's CredentialService. */
  credentials: z.record(z.string(), z.string()).optional(),
  /** Default working directory for new sessions using this client. */
  cwd: z.string().optional(),
  /** Whether this client is enabled. */
  enabled: z.boolean(),
  /** Timestamp when record was created (Unix milliseconds). */
  createdAt: z.number().int().nonnegative().finite(),
  /** Timestamp when record was last updated (Unix milliseconds). */
  updatedAt: z.number().int().nonnegative().finite(),
});

export type ClientRecord = z.infer<typeof ClientRecordSchema>;

/**
 * Storage namespace for system-managed client records.
 *
 * Exposes read-only bus subjects for querying client data.
 * All writes are internal — owned by the client sync service at boot time.
 *
 * - `get`: Retrieve a single client by ID
 * - `list`: Retrieve all clients
 * - `listByBinaryName`: Retrieve all clients that use a given binary name
 */
export const ClientStorageNamespace = createStorageNamespaceDefinition('client', {
  schemas: {
    get: {
      request: StorageIdRequestSchema,
      response: z.object({ client: ClientRecordSchema.nullable() }),
    },
    list: {
      request: z.object({}),
      response: z.object({ clients: z.array(ClientRecordSchema) }),
    },
    listByBinaryName: {
      request: z.object({ binaryName: z.string() }),
      response: z.object({ clients: z.array(ClientRecordSchema) }),
    },
  },
});

export const ClientStorageSubjects = ClientStorageNamespace.subjects;
