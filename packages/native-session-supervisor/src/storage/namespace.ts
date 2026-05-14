/**
 * Storage namespace for native session supervisor runtimes.
 *
 * Defines the `storage:supervisor-runtime` bus namespace and provides typed
 * subjects for CRUD operations on supervised runtime metadata.
 *
 * Consumers emit these subjects to read/write supervisor runtime state;
 * the Drizzle handler registered in `drizzle-handler.ts` processes them.
 * @packageDocumentation
 */

import { z } from 'zod';
import { createStorageNamespaceDefinition } from '@makaio/storage-core';
import { SupervisorSessionStatusSchema } from '@makaio/contracts/native-session-supervisor';
import { supervisorRuntimes } from './schema.js';

/**
 * Zod schema for a full supervisor runtime record as stored/retrieved.
 *
 * Mirrors {@link SupervisorRuntime} but expressed as a Zod schema for bus
 * validation.
 */
const SupervisorRuntimeRecordSchema = z.object({
  supervisorSessionId: z.string(),
  clientId: z.string(),
  pid: z.number().int().positive().nullable(),
  status: SupervisorSessionStatusSchema,
  cwd: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()).optional(),
  sessionId: z.string().optional(),
  adapterSessionId: z.string().optional(),
  startedAt: z.number().int().nonnegative(),
  stoppedAt: z.number().int().nonnegative().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Zod schema for a partial update payload.
 */
const SupervisorRuntimeUpdateSchema = z.object({
  supervisorSessionId: z.string(),
  pid: z.number().int().positive().nullable().optional(),
  status: SupervisorSessionStatusSchema.optional(),
  sessionId: z.string().optional(),
  adapterSessionId: z.string().optional(),
  stoppedAt: z.number().int().nonnegative().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Native session supervisor runtime storage namespace.
 *
 * Provides typed bus subjects for managing supervised runtime metadata.
 * Runtime composition roots register it under `storage:supervisor-runtime`.
 *
 * Storage backends register handlers; consumers communicate through
 * subjects only, never importing directly from storage implementations.
 * @example
 * ```typescript
 * import { SupervisorRuntimeStorageSubjects } from '@makaio/native-session-supervisor';
 *
 * // Retrieve a runtime by its canonical ID
 * const { runtime } = await bus.request(SupervisorRuntimeStorageSubjects.get, {
 *   supervisorSessionId: 'sup_abc123',
 * });
 * ```
 */
export const SupervisorRuntimeStorageNamespace = createStorageNamespaceDefinition('supervisor-runtime', {
  schemas: {
    /**
     * Get a single supervisor runtime by any correlation key.
     *
     * Exactly one of the locator fields must be provided.
     *
     * Subject: `storage:supervisor-runtime.get`
     * Type: Request (RPC)
     */
    get: {
      request: z.union([
        z.object({ supervisorSessionId: z.string() }).strict(),
        z.object({ sessionId: z.string() }).strict(),
        z.object({ adapterSessionId: z.string() }).strict(),
      ]),
      response: z.object({
        runtime: SupervisorRuntimeRecordSchema.nullable(),
      }),
    },

    /**
     * Insert or fully replace a supervisor runtime record.
     *
     * Subject: `storage:supervisor-runtime.set`
     * Type: Request (RPC)
     */
    set: {
      request: SupervisorRuntimeRecordSchema,
      response: z.object({
        success: z.boolean(),
      }),
    },

    /**
     * Apply a partial update to an existing supervisor runtime.
     *
     * Subject: `storage:supervisor-runtime.update`
     * Type: Request (RPC)
     */
    update: {
      request: SupervisorRuntimeUpdateSchema,
      response: z.object({
        success: z.boolean(),
      }),
    },

    /**
     * Delete a supervisor runtime record by its canonical ID.
     *
     * Subject: `storage:supervisor-runtime.delete`
     * Type: Request (RPC)
     */
    delete: {
      request: z.object({
        supervisorSessionId: z.string(),
      }),
      response: z.object({
        success: z.boolean(),
      }),
    },

    /**
     * List supervisor runtimes with optional status filter.
     *
     * Returns full runtime records (not just snapshots) to allow the registry
     * to fully hydrate its in-memory cache from a single storage query.
     *
     * Subject: `storage:supervisor-runtime.list`
     * Type: Request (RPC)
     */
    list: {
      request: z.object({
        /** Filter by lifecycle status. Omit to return all runtimes. */
        status: SupervisorSessionStatusSchema.optional(),
        /** Maximum number of results to return. */
        limit: z.number().int().min(1).optional(),
      }),
      response: z.object({
        runtimes: z.array(SupervisorRuntimeRecordSchema),
      }),
    },
  },
  extensions: {
    drizzle: { supervisorRuntimes },
  },
});

/**
 * Typed bus subjects for supervisor runtime storage operations.
 */
export const SupervisorRuntimeStorageSubjects = SupervisorRuntimeStorageNamespace.subjects;

export { SupervisorRuntimeRecordSchema, SupervisorRuntimeUpdateSchema };
