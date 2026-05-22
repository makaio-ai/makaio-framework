/**
 * Bus namespace for client binary storage operations.
 *
 * Separated from the Drizzle handler so that higher-level components can
 * import the subjects without pulling in `drizzle-orm` and the storage
 * implementation at module evaluation time.
 * @packageDocumentation
 */

import { createBusNamespace } from '@makaio/core';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared payload schemas
// ---------------------------------------------------------------------------

/**
 * Zod schema for a persisted installed-version record transported over the bus.
 */
export const ClientBinaryVersionRecordSchema = z.object({
  /** Stable row identifier (UUID v4). */
  id: z.string(),
  /** Stable client identifier (e.g. `'claude-code'`). */
  clientId: z.string(),
  /** Resolved version string. */
  version: z.string(),
  /** Absolute path to the directory containing the installed binary. */
  installPath: z.string(),
  /** Epoch timestamp in milliseconds when the binary was installed. */
  installedAt: z.number().int().nonnegative(),
  /** Epoch timestamp in milliseconds when this row was created. */
  createdAt: z.number().int().nonnegative(),
});

/**
 * Zod schema for the per-client binary state record transported over the bus.
 */
export const ClientBinaryStateRecordSchema = z.object({
  /** Stable client identifier. */
  clientId: z.string(),
  /** Currently active version, or `null` when no version is active. */
  activeVersion: z.string().nullable(),
  /** Epoch timestamp in milliseconds of the last mutation. */
  updatedAt: z.number().int().nonnegative(),
});

/**
 * Shared response shape for operations that transition the active version.
 *
 * Used by `recordInstalledVersion`, `setActiveVersion`, and
 * `removeVersionAndClearActive` to keep the before/after active-version
 * contract consistent.
 */
const ActiveVersionTransitionSchema = z.object({
  /** Active version before the transaction, or `null`. */
  previousActiveVersion: z.string().nullable(),
  /** Active version after the transaction, or `null`. */
  activeVersion: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Namespace registration
// ---------------------------------------------------------------------------

/**
 * Internal bus namespace for client binary storage operations.
 *
 * Subjects registered here are consumed exclusively by the Drizzle handler
 * and the binary manager — they are not part of the public `client.*` namespace.
 */
export const ClientBinaryStorageNamespace = createBusNamespace('client-binary:storage', {
  /** Insert a new installed-version row. */
  insertVersion: {
    request: ClientBinaryVersionRecordSchema,
    response: z.object({ success: z.boolean() }),
  },
  /**
   * Atomically record an installed version and optionally mark it active.
   *
   * Used by successful install/update jobs so storage never commits a version
   * row without the requested active pointer update.
   */
  recordInstalledVersion: {
    request: z.object({
      /** Installed-version row to persist. */
      versionRecord: ClientBinaryVersionRecordSchema,
      /** Whether this version should become the active version in the same transaction. */
      makeActive: z.boolean(),
      /** Epoch ms of the active-version mutation when `makeActive` is true. */
      updatedAt: z.number().int().nonnegative(),
    }),
    response: ActiveVersionTransitionSchema,
  },
  /** Return all installed-version rows for a given client. */
  listVersions: {
    request: z.object({ clientId: z.string() }),
    response: z.object({ versions: z.array(ClientBinaryVersionRecordSchema) }),
  },
  /**
   * Return a single-client state + installed-version snapshot from one storage
   * read boundary.
   */
  getSnapshot: {
    request: z.object({ clientId: z.string() }),
    response: z.object({
      state: ClientBinaryStateRecordSchema.nullable(),
      versions: z.array(ClientBinaryVersionRecordSchema),
    }),
  },
  /** Return all installed-version rows across every client (used for boot hydration). */
  loadAllVersions: {
    request: z.object({}),
    response: z.object({ versions: z.array(ClientBinaryVersionRecordSchema) }),
  },
  /** Upsert the per-client binary state row. */
  upsertState: {
    request: ClientBinaryStateRecordSchema,
    response: z.object({ success: z.boolean() }),
  },
  /**
   * Set the active version, creating a state row when one does not exist yet.
   */
  setActiveVersion: {
    request: z.object({
      /** Stable client identifier. */
      clientId: z.string(),
      /** Version to mark active, or `null` to clear the active pointer. */
      activeVersion: z.string().nullable(),
      /** Epoch ms of this mutation. */
      updatedAt: z.number().int().nonnegative(),
    }),
    response: ActiveVersionTransitionSchema,
  },
  /** Return the per-client binary state row, or `null` when it does not exist. */
  getState: {
    request: z.object({ clientId: z.string() }),
    response: z.object({ state: ClientBinaryStateRecordSchema.nullable() }),
  },
  /** Return the state rows for all clients (used for boot hydration). */
  loadAllState: {
    request: z.object({}),
    response: z.object({ states: z.array(ClientBinaryStateRecordSchema) }),
  },
  /** Return all state and installed-version rows from one storage read boundary. */
  loadSnapshot: {
    request: z.object({}),
    response: z.object({
      states: z.array(ClientBinaryStateRecordSchema),
      versions: z.array(ClientBinaryVersionRecordSchema),
    }),
  },
  /**
   * Atomically remove an installed-version row and clear the active-version
   * pointer when it currently points to the deleted version.
   *
   * Both operations are executed inside a single SQLite transaction so that
   * concurrent reads never observe a state where the version row is absent but
   * the active pointer still references it.
   */
  removeVersionAndClearActive: {
    request: z.object({
      /** Stable client identifier. */
      clientId: z.string(),
      /** Version string to remove. */
      version: z.string(),
      /** Epoch ms of this mutation (written to `updated_at` when active is cleared). */
      updatedAt: z.number().int().nonnegative(),
    }),
    response: ActiveVersionTransitionSchema.extend({
      /** The version that was removed, or `null` when no row matched. */
      removedVersion: z.string().nullable(),
    }),
  },
});

/** Typed bus subjects for client binary storage. */
export const ClientBinaryStorageSubjects = ClientBinaryStorageNamespace.subjects;

// ---------------------------------------------------------------------------
// Inferred TypeScript types (derived from the Zod schemas above)
// ---------------------------------------------------------------------------

/** Persisted installed-version record as exchanged over the bus. */
export type ClientBinaryVersionRecord = z.infer<typeof ClientBinaryVersionRecordSchema>;

/** Per-client binary state record as exchanged over the bus. */
export type ClientBinaryStateRecord = z.infer<typeof ClientBinaryStateRecordSchema>;
