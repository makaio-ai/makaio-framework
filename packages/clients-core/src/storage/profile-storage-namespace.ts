/**
 * Bus namespace for client profile storage operations.
 *
 * Separated from the Drizzle handler so that higher-level components can
 * import the subjects without pulling in `drizzle-orm` and the storage
 * implementation at module evaluation time.
 * @packageDocumentation
 */

import { createBusNamespace } from '@makaio/core';
import { z } from 'zod';
import { ClientProfileNameSchema, ClientProfileSchema } from '@makaio/contracts/client';

// ---------------------------------------------------------------------------
// Shared payload schemas
// ---------------------------------------------------------------------------

/**
 * Zod schema for a persisted client profile record transported over the bus.
 *
 * Reuses {@link ClientProfileSchema} from contracts so the storage namespace
 * and the public client contract share a single source of truth.
 */
export const ClientProfileRecordSchema = ClientProfileSchema;

/** Non-empty identifier used by internal profile storage subjects. */
const NonEmptyIdSchema = z.string().trim().min(1);

// ---------------------------------------------------------------------------
// Namespace registration
// ---------------------------------------------------------------------------

/**
 * Internal bus namespace for client profile storage operations.
 *
 * Subjects registered here are consumed exclusively by the Drizzle handler
 * and the profile manager — they are not part of the public `client.*` namespace.
 */
export const ClientProfileStorageNamespace = createBusNamespace('client-profile:storage', {
  /** Return a single profile record identified by `(clientId, name)`, or `null` when not found. */
  get: {
    request: z.object({
      /** Stable client identifier. */
      clientId: NonEmptyIdSchema,
      /** Profile name to look up. */
      name: ClientProfileNameSchema,
    }),
    response: z.object({ record: ClientProfileRecordSchema.nullable() }),
  },
  /** Return a single profile record by its stable row ID, or `null` when not found. */
  getById: {
    request: z.object({
      /** Stable row identifier (UUID v4). */
      id: NonEmptyIdSchema,
    }),
    response: z.object({ record: ClientProfileRecordSchema.nullable() }),
  },
  /** Return all profile records for a given client. */
  list: {
    request: z.object({
      /** Stable client identifier. */
      clientId: NonEmptyIdSchema,
    }),
    response: z.object({ records: z.array(ClientProfileRecordSchema) }),
  },
  /**
   * Insert or update a profile record identified by its stable row ID.
   *
   * On conflict, all mutable fields (`name`, `description`, `configDir`,
   * `isDefault`, `updatedAt`) are overwritten. `createdAt` is preserved on
   * subsequent upserts.
   */
  set: {
    request: ClientProfileRecordSchema,
    response: z.object({ success: z.boolean() }),
  },
  /**
   * Delete the profile record identified by `(clientId, name)`.
   *
   * Returns `{ success: true }` when a row was deleted and
   * `{ success: false }` when no matching row was found.
   */
  delete: {
    request: z.object({
      /** Stable client identifier. */
      clientId: NonEmptyIdSchema,
      /** Profile name to delete. */
      name: ClientProfileNameSchema,
    }),
    response: z.object({ success: z.boolean() }),
  },
  /**
   * Clear the `isDefault` flag on all profiles for a given client.
   *
   * Low-level maintenance operation. Normal default promotion must use
   * `setDefault` so clearing and promotion share one storage transaction.
   */
  clearDefault: {
    request: z.object({
      /** Stable client identifier. */
      clientId: NonEmptyIdSchema,
    }),
    response: z.object({ success: z.boolean() }),
  },
  /**
   * Atomically promote one profile to default and clear the previous default.
   */
  setDefault: {
    request: z.object({
      /** Stable client identifier. */
      clientId: NonEmptyIdSchema,
      /** Profile name to promote. */
      name: ClientProfileNameSchema,
    }),
    response: z.object({ record: ClientProfileRecordSchema.nullable() }),
  },
});

/** Typed bus subjects for client profile storage. */
export const ClientProfileStorageSubjects = ClientProfileStorageNamespace.subjects;

// ---------------------------------------------------------------------------
// Inferred TypeScript types (derived from the Zod schemas above)
// ---------------------------------------------------------------------------

/** Persisted client profile record as exchanged over the bus. */
export type ClientProfileRecord = z.infer<typeof ClientProfileRecordSchema>;
