/**
 * Drizzle-backed persistence handler for client binary installation state.
 *
 * Registers bus handlers for version records and per-client active-version
 * state on the `client-binary:storage.*` subjects. All DB
 * access is encapsulated here — no caller outside this module should query
 * the `client_binary_versions` or `client_binary_state` tables directly.
 * @packageDocumentation
 */

import { eq, and } from 'drizzle-orm';
import { executeTransaction, type MakaioDatabase, type TransactionCallback } from '@makaio/storage-drizzle';
import type { IMakaioBus } from '@makaio/bus-core';
import type { ExtensionContext } from '@makaio/contracts';
import { clientBinaryVersions, clientBinaryState } from './client-binary-schema.js';
import { ClientBinaryStorageSubjects } from './client-binary-storage-namespace.js';
import type {
  InsertClientBinaryState,
  InsertClientBinaryVersion,
  SelectClientBinaryVersion,
  SelectClientBinaryState,
} from './client-binary-schema.js';
import type { ClientBinaryVersionRecord, ClientBinaryStateRecord } from './client-binary-storage-namespace.js';

export { ClientBinaryStorageNamespace, ClientBinaryStorageSubjects } from './client-binary-storage-namespace.js';

// ---------------------------------------------------------------------------
// DB row mappers
// ---------------------------------------------------------------------------

type VersionRow = SelectClientBinaryVersion;
type StateRow = SelectClientBinaryState;
type StorageExecutor = MakaioDatabase | Parameters<TransactionCallback<void>>[0];

/**
 * Maps a `client_binary_versions` database row to a bus record.
 * @param row - Raw row from the `client_binary_versions` table
 * @returns Mapped version record
 */
function mapVersionRow(row: VersionRow): ClientBinaryVersionRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    version: row.version,
    installPath: row.installPath,
    installedAt: row.installedAt,
    createdAt: row.createdAt,
  };
}

/**
 * Maps a `client_binary_state` database row to a bus record.
 * @param row - Raw row from the `client_binary_state` table
 * @returns Mapped state record
 */
function mapStateRow(row: StateRow): ClientBinaryStateRecord {
  return {
    clientId: row.clientId,
    activeVersion: row.activeVersion ?? null,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Per-subject handler implementations
// ---------------------------------------------------------------------------

/**
 * Maps a bus version record to a database insert row.
 * @param record - Version record to persist
 * @returns Insert row for the `client_binary_versions` table
 */
function toVersionInsert(record: ClientBinaryVersionRecord): InsertClientBinaryVersion {
  return {
    id: record.id,
    clientId: record.clientId,
    version: record.version,
    installPath: record.installPath,
    installedAt: record.installedAt,
    createdAt: record.createdAt,
  };
}

/**
 * Insert a new installed-version row through the provided database executor.
 *
 * The conflict target is intentionally `(clientId, version)` only: repeated
 * install records are idempotent, while unexpected primary-key collisions still
 * surface as database errors.
 * @param db - Drizzle database or transaction executor
 * @param record - Version record to persist
 */
async function insertInstalledVersion(db: StorageExecutor, record: ClientBinaryVersionRecord): Promise<void> {
  await db
    .insert(clientBinaryVersions)
    .values(toVersionInsert(record))
    .onConflictDoNothing({ target: [clientBinaryVersions.clientId, clientBinaryVersions.version] });
}

/**
 * Build the minimal per-client state row used by active-version-only writes.
 * @param clientId - Stable client identifier
 * @param activeVersion - Version to mark active, or `null` to clear
 * @param updatedAt - Epoch ms of this mutation
 * @returns Insert row for the `client_binary_state` table
 */
function toActiveVersionStateInsert(
  clientId: string,
  activeVersion: string | null,
  updatedAt: number,
): InsertClientBinaryState {
  return {
    clientId,
    activeVersion,
    updatedAt,
  };
}

/**
 * Upsert active-version state.
 * @param db - Drizzle database or transaction executor
 * @param clientId - Stable client identifier
 * @param activeVersion - Version to mark active, or `null` to clear
 * @param updatedAt - Epoch ms of this mutation
 */
async function upsertActiveVersionState(
  db: StorageExecutor,
  clientId: string,
  activeVersion: string | null,
  updatedAt: number,
): Promise<void> {
  await db
    .insert(clientBinaryState)
    .values(toActiveVersionStateInsert(clientId, activeVersion, updatedAt))
    .onConflictDoUpdate({
      target: clientBinaryState.clientId,
      set: { activeVersion, updatedAt },
    });
}

/**
 * Insert a new installed-version row; silently ignores conflicts on the
 * `(clientId, version)` unique constraint while still surfacing unexpected
 * primary-key conflicts.
 * @param db - Drizzle database instance
 * @param record - Version record to persist
 */
async function handleInsertVersion(db: MakaioDatabase, record: ClientBinaryVersionRecord): Promise<void> {
  await insertInstalledVersion(db, record);
}

/**
 * Record an installed version and optionally activate it in one transaction.
 *
 * This is the storage boundary used by successful install/update jobs. Keeping
 * version persistence and activation in the same transaction prevents an
 * orphaned version row when activation cannot be committed.
 * @param db - Drizzle database instance
 * @param record - Version record to persist
 * @param makeActive - Whether to mark the installed version active
 * @param updatedAt - Epoch ms of the active-version mutation
 * @returns Previous and current active-version values
 */
async function handleRecordInstalledVersion(
  db: MakaioDatabase,
  record: ClientBinaryVersionRecord,
  makeActive: boolean,
  updatedAt: number,
): Promise<{
  previousActiveVersion: string | null;
  activeVersion: string | null;
}> {
  return executeTransaction(db, async (tx) => {
    const [stateRow] = await tx
      .select()
      .from(clientBinaryState)
      .where(eq(clientBinaryState.clientId, record.clientId))
      .limit(1);
    const previousActiveVersion = stateRow?.activeVersion ?? null;

    await insertInstalledVersion(tx, record);

    if (!makeActive) {
      return { previousActiveVersion, activeVersion: previousActiveVersion };
    }

    await upsertActiveVersionState(tx, record.clientId, record.version, updatedAt);

    return { previousActiveVersion, activeVersion: record.version };
  });
}

/**
 * Read one client's state and installed versions in a single transaction.
 * @param db - Drizzle database instance
 * @param clientId - Stable client identifier
 * @returns State row plus installed-version rows for the client
 */
async function handleGetSnapshot(
  db: MakaioDatabase,
  clientId: string,
): Promise<{
  state: ClientBinaryStateRecord | null;
  versions: ClientBinaryVersionRecord[];
}> {
  return executeTransaction(db, async (tx) => {
    const [stateRow] = await tx
      .select()
      .from(clientBinaryState)
      .where(eq(clientBinaryState.clientId, clientId))
      .limit(1);
    const versionRows = await tx.select().from(clientBinaryVersions).where(eq(clientBinaryVersions.clientId, clientId));
    return {
      state: stateRow ? mapStateRow(stateRow) : null,
      versions: versionRows.map(mapVersionRow),
    };
  });
}

/**
 * Read all client binary state and installed-version rows in one transaction.
 * @param db - Drizzle database instance
 * @returns All state rows and installed-version rows
 */
async function handleLoadSnapshot(db: MakaioDatabase): Promise<{
  states: ClientBinaryStateRecord[];
  versions: ClientBinaryVersionRecord[];
}> {
  return executeTransaction(db, async (tx) => {
    const stateRows = await tx.select().from(clientBinaryState);
    const versionRows = await tx.select().from(clientBinaryVersions);
    return {
      states: stateRows.map(mapStateRow),
      versions: versionRows.map(mapVersionRow),
    };
  });
}

/**
 * Upsert the per-client state row, overwriting all mutable columns.
 * @param db - Drizzle database instance
 * @param record - State record to persist
 */
async function handleUpsertState(db: MakaioDatabase, record: ClientBinaryStateRecord): Promise<void> {
  const values = {
    clientId: record.clientId,
    activeVersion: record.activeVersion ?? null,
    updatedAt: record.updatedAt,
  };
  await db
    .insert(clientBinaryState)
    .values(values)
    .onConflictDoUpdate({ target: clientBinaryState.clientId, set: values });
}

/**
 * Set the active-version pointer.
 *
 * Creates a minimal row when none exists yet so activation can be persisted.
 * @param db - Drizzle database instance
 * @param clientId - Stable client identifier
 * @param activeVersion - Version to mark active, or `null` to clear
 * @param updatedAt - Epoch ms of this mutation
 * @returns Previous and current active-version values
 */
async function handleSetActiveVersion(
  db: MakaioDatabase,
  clientId: string,
  activeVersion: string | null,
  updatedAt: number,
): Promise<{
  previousActiveVersion: string | null;
  activeVersion: string | null;
}> {
  return executeTransaction(db, async (tx) => {
    const [stateRow] = await tx
      .select()
      .from(clientBinaryState)
      .where(eq(clientBinaryState.clientId, clientId))
      .limit(1);
    const previousActiveVersion = stateRow?.activeVersion ?? null;

    await upsertActiveVersionState(tx, clientId, activeVersion, updatedAt);

    return { previousActiveVersion, activeVersion };
  });
}

/**
 * Atomically remove an installed-version row and clear the active-version
 * pointer when it points to the deleted version.
 *
 * All reads and writes execute inside a single SQLite transaction. The result
 * captures the pre-transaction active version so the caller can decide whether
 * to emit a `client.version.changed` event.
 * @param db - Drizzle database instance
 * @param clientId - Stable client identifier
 * @param version - Version string to remove
 * @param updatedAt - Epoch ms written to `updated_at` when the active pointer is cleared
 * @returns Outcome: the removed version (null if not found), previous active version, and new active version
 */
async function handleRemoveVersionAndClearActive(
  db: MakaioDatabase,
  clientId: string,
  version: string,
  updatedAt: number,
): Promise<{
  removedVersion: string | null;
  previousActiveVersion: string | null;
  activeVersion: string | null;
}> {
  return executeTransaction(db, async (tx) => {
    // Read current active version before any mutation.
    const [stateRow] = await tx
      .select()
      .from(clientBinaryState)
      .where(eq(clientBinaryState.clientId, clientId))
      .limit(1);

    const previousActiveVersion = stateRow?.activeVersion ?? null;

    // Delete the version row.
    const deleteResult = await tx
      .delete(clientBinaryVersions)
      .where(and(eq(clientBinaryVersions.clientId, clientId), eq(clientBinaryVersions.version, version)));

    const wasDeleted = (deleteResult.rowsAffected ?? 0) > 0;
    if (!wasDeleted) {
      return { removedVersion: null, previousActiveVersion, activeVersion: previousActiveVersion };
    }

    // Clear from the row's current value at delete time, not only from the
    // opening snapshot. The conditional WHERE keeps unrelated active-version
    // changes intact if another serialized mutation already moved the pointer.
    await tx
      .update(clientBinaryState)
      .set({ activeVersion: null, updatedAt })
      .where(and(eq(clientBinaryState.clientId, clientId), eq(clientBinaryState.activeVersion, version)));

    const [currentStateRow] = await tx
      .select()
      .from(clientBinaryState)
      .where(eq(clientBinaryState.clientId, clientId))
      .limit(1);

    return {
      removedVersion: version,
      previousActiveVersion,
      activeVersion: currentStateRow?.activeVersion ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

/**
 * Registers Drizzle-backed bus handlers for client binary storage.
 *
 * The following subjects are handled:
 * - `client-binary:storage.insertVersion` — insert a new installed-version row.
 * - `client-binary:storage.recordInstalledVersion` — atomically insert and optionally activate a version.
 * - `client-binary:storage.listVersions`  — return all versions for a client.
 * - `client-binary:storage.getSnapshot` — return one client's state and versions from one read transaction.
 * - `client-binary:storage.loadAllVersions` — return all version rows.
 * - `client-binary:storage.upsertState`   — upsert the per-client state row.
 * - `client-binary:storage.setActiveVersion` — update active version only.
 * - `client-binary:storage.getState`      — return the per-client state row.
 * - `client-binary:storage.loadAllState`  — return all state rows.
 * - `client-binary:storage.loadSnapshot` — return all state and version rows from one read transaction.
 * - `client-binary:storage.removeVersionAndClearActive` — atomic uninstall in one transaction.
 * @param bus - Bus instance to register handlers on
 * @param db - Drizzle database instance
 * @param _ctx - Extension context (unused; reserved for future use)
 * @returns Cleanup function to unregister all handlers
 */
export function registerDrizzleClientBinaryStorage(
  bus: IMakaioBus,
  db: MakaioDatabase,
  _ctx: ExtensionContext,
): () => void {
  const cleanups = [
    bus.on(ClientBinaryStorageSubjects.insertVersion, async (ctx) => {
      await handleInsertVersion(db, ctx.payload);
      ctx.setResult({ success: true });
    }),

    bus.on(ClientBinaryStorageSubjects.recordInstalledVersion, async (ctx) => {
      const { versionRecord, makeActive, updatedAt } = ctx.payload;
      const result = await handleRecordInstalledVersion(db, versionRecord, makeActive, updatedAt);
      ctx.setResult(result);
    }),

    bus.on(ClientBinaryStorageSubjects.listVersions, async (ctx) => {
      const rows = await db
        .select()
        .from(clientBinaryVersions)
        .where(eq(clientBinaryVersions.clientId, ctx.payload.clientId));
      ctx.setResult({ versions: rows.map(mapVersionRow) });
    }),

    bus.on(ClientBinaryStorageSubjects.getSnapshot, async (ctx) => {
      const { state, versions } = await handleGetSnapshot(db, ctx.payload.clientId);
      ctx.setResult({ state, versions });
    }),

    bus.on(ClientBinaryStorageSubjects.loadAllVersions, async (ctx) => {
      const rows = await db.select().from(clientBinaryVersions);
      ctx.setResult({ versions: rows.map(mapVersionRow) });
    }),

    bus.on(ClientBinaryStorageSubjects.upsertState, async (ctx) => {
      await handleUpsertState(db, ctx.payload);
      ctx.setResult({ success: true });
    }),

    bus.on(ClientBinaryStorageSubjects.setActiveVersion, async (ctx) => {
      const { clientId, activeVersion, updatedAt } = ctx.payload;
      const result = await handleSetActiveVersion(db, clientId, activeVersion, updatedAt);
      ctx.setResult(result);
    }),

    bus.on(ClientBinaryStorageSubjects.getState, async (ctx) => {
      const [row] = await db
        .select()
        .from(clientBinaryState)
        .where(eq(clientBinaryState.clientId, ctx.payload.clientId))
        .limit(1);
      ctx.setResult({ state: row ? mapStateRow(row) : null });
    }),

    bus.on(ClientBinaryStorageSubjects.loadAllState, async (ctx) => {
      const rows = await db.select().from(clientBinaryState);
      ctx.setResult({ states: rows.map(mapStateRow) });
    }),

    bus.on(ClientBinaryStorageSubjects.loadSnapshot, async (ctx) => {
      const { states, versions } = await handleLoadSnapshot(db);
      ctx.setResult({ states, versions });
    }),

    bus.on(ClientBinaryStorageSubjects.removeVersionAndClearActive, async (ctx) => {
      const { clientId, version, updatedAt } = ctx.payload;
      const result = await handleRemoveVersionAndClearActive(db, clientId, version, updatedAt);
      ctx.setResult(result);
    }),
  ];

  return () => {
    for (const cleanup of cleanups) {
      cleanup();
    }
  };
}

// ---------------------------------------------------------------------------
// Direct DB utilities (test / admin tooling only)
// ---------------------------------------------------------------------------

/**
 * Retrieve all installed-version rows for a client directly from the database.
 *
 * Intended for use in tests and admin tooling only. Production code must use
 * the bus subjects exposed by {@link registerDrizzleClientBinaryStorage}.
 * @param db - Drizzle database instance
 * @param clientId - Stable client identifier to query
 * @returns All version records for the client
 */
export async function selectVersionsByClientId(
  db: MakaioDatabase,
  clientId: string,
): Promise<ClientBinaryVersionRecord[]> {
  const rows = await db.select().from(clientBinaryVersions).where(eq(clientBinaryVersions.clientId, clientId));
  return rows.map(mapVersionRow);
}

/**
 * Retrieve the per-client state row directly from the database.
 *
 * Intended for use in tests and admin tooling only.
 * @param db - Drizzle database instance
 * @param clientId - Stable client identifier to query
 * @returns The state record, or `undefined` when not found
 */
export async function selectStateByClientId(
  db: MakaioDatabase,
  clientId: string,
): Promise<ClientBinaryStateRecord | undefined> {
  const [row] = await db.select().from(clientBinaryState).where(eq(clientBinaryState.clientId, clientId)).limit(1);
  return row ? mapStateRow(row) : undefined;
}
