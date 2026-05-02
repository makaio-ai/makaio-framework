/**
 * Bus namespace for client runtime storage operations.
 *
 * Separated from the Drizzle handler so that the registry can import
 * the subjects without pulling in `drizzle-orm` and the storage
 * implementation at module evaluation time.
 * @packageDocumentation
 */

import { MakaioBus } from '@makaio/bus-core';
import { z } from 'zod';
import { CLIENT_RUNTIME_STATUSES } from '../client-runtime-registry-types.js';

/**
 * Zod schema for a fully-populated runtime record transported over the bus.
 *
 * Mirrors {@link ClientRuntimeRecord} with explicit Zod types so the bus can
 * validate payloads at runtime.
 */
export const RuntimeRecordSchema = z.object({
  clientRuntimeId: z.string(),
  clientId: z.string(),
  status: z.enum(CLIENT_RUNTIME_STATUSES),
  supervisorSessionId: z.string().optional(),
  pid: z.number().int().positive().optional(),
  parentPid: z.number().int().positive().optional(),
  adapterSessionId: z.string().optional(),
  sessionId: z.string().optional(),
  cwd: z.string().optional(),
  argv: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  observedAt: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

/**
 * Internal bus namespace for client runtime storage operations.
 *
 * Subjects registered here are consumed exclusively by the Drizzle handler
 * and the registry — they are not part of the public `client.*` namespace.
 */
export const ClientRuntimeStorageNamespace = MakaioBus.registerNamespace('client-runtime:storage', {
  upsert: {
    request: RuntimeRecordSchema,
    response: z.object({ success: z.boolean() }),
  },
  loadAll: {
    request: z.object({}),
    response: z.object({ records: z.array(RuntimeRecordSchema) }),
  },
});

/** Typed bus subjects for client runtime storage. */
export const ClientRuntimeStorageSubjects = ClientRuntimeStorageNamespace.subjects;
