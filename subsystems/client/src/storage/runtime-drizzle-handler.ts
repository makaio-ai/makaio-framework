/**
 * Drizzle-backed persistence handler for client runtime records.
 *
 * Registers bus handlers for upsert and bulk-load of runtime records on the
 * `client-runtime:storage.*` subjects. All DB access is encapsulated here —
 * no caller outside this module should query the `client_runtimes` table
 * directly.
 * @packageDocumentation
 */

import { and, eq, gt, sql } from 'drizzle-orm';
import { resolveSchema, type MakaioDatabase } from '@makaio/storage-drizzle';
import type { IMakaioBus } from '@makaio/bus-core';
import { CLIENT_RUNTIME_STATUSES } from '../client-runtime-registry-types.js';
import type { ClientRuntimeRecord, ClientRuntimeStatus } from '../client-runtime-registry-types.js';
import { clientRuntimesSchema } from './runtime-schema.variants.js';
import { ClientRuntimeStorageSubjects } from './runtime-storage-namespace.js';

/** Resolved type alias for the `client_runtimes` table, dialect-independent. */
type ClientRuntimesTable = typeof clientRuntimesSchema.sqlite.clientRuntimes;

export { ClientRuntimeStorageNamespace, ClientRuntimeStorageSubjects } from './runtime-storage-namespace.js';

// ---------------------------------------------------------------------------
// DB row mapper
// ---------------------------------------------------------------------------

type DbRow = ClientRuntimesTable['$inferSelect'];

/** All valid {@link ClientRuntimeStatus} values, used to guard DB reads. */
const VALID_STATUSES: ReadonlySet<string> = new Set(CLIENT_RUNTIME_STATUSES);

/**
 * Maps a database row to a {@link ClientRuntimeRecord}.
 * @param row - Raw row from the `client_runtimes` table
 * @returns Mapped runtime record
 * @throws When the persisted status is not a known {@link ClientRuntimeStatus}
 */
function mapRow(row: DbRow): ClientRuntimeRecord {
  if (!VALID_STATUSES.has(row.status)) {
    throw new Error(`Unknown ClientRuntimeStatus in DB: '${row.status}'`);
  }
  return {
    clientRuntimeId: row.id,
    clientId: row.clientId,
    status: row.status as ClientRuntimeStatus,
    supervisorSessionId: row.supervisorSessionId ?? undefined,
    pid: row.pid ?? undefined,
    parentPid: row.parentPid ?? undefined,
    adapterSessionId: row.adapterSessionId ?? undefined,
    sessionId: row.sessionId ?? undefined,
    cwd: row.cwd ?? undefined,
    argv: row.argv ?? undefined,
    metadata: row.metadata ?? undefined,
    observedAt: row.observedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

/**
 * Registers Drizzle-backed bus handlers for client runtime storage.
 *
 * Two subjects are handled:
 * - `client-runtime:storage.upsert` — insert or update a runtime record by ID.
 * - `client-runtime:storage.loadAll` — return all persisted runtime records.
 *
 * The registry calls `upsert` after every mutation so that state survives
 * restarts. `loadAll` is called once at registry boot to hydrate the in-memory
 * map.
 * @param bus - Bus instance to register handlers on
 * @param db - Drizzle database instance
 * @returns Cleanup function to unregister all handlers
 */
export function registerDrizzleRuntimeStorage(bus: IMakaioBus, db: MakaioDatabase): () => void {
  const { clientRuntimes } = resolveSchema(db, clientRuntimesSchema);
  const upsertCleanup = bus.on(ClientRuntimeStorageSubjects.upsert, async (ctx) => {
    const record = ctx.payload;

    /**
     * Mutable column values shared by insert and the ON CONFLICT update branch.
     * `createdAt` is intentionally excluded — it is set on first insert and
     * must not change on subsequent upserts.
     */
    const mutableFields = {
      clientId: record.clientId,
      status: record.status,
      supervisorSessionId: record.supervisorSessionId ?? null,
      pid: record.pid ?? null,
      parentPid: record.parentPid ?? null,
      adapterSessionId: record.adapterSessionId ?? null,
      sessionId: record.sessionId ?? null,
      cwd: record.cwd ?? null,
      argv: record.argv ?? null,
      metadata: record.metadata ?? null,
      observedAt: record.observedAt,
      updatedAt: record.updatedAt,
    };

    await db
      .insert(clientRuntimes)
      .values({
        id: record.clientRuntimeId,
        createdAt: record.createdAt,
        ...mutableFields,
      })
      .onConflictDoUpdate({
        target: clientRuntimes.id,
        set: mutableFields,
        // The registry guarantees strictly monotonic updatedAt values for
        // canonical writes; equal timestamps are treated as stale replays here.
        setWhere: gt(sql`excluded.updated_at`, clientRuntimes.updatedAt),
      });

    ctx.setResult({ success: true });
  });

  const loadAllCleanup = bus.on(ClientRuntimeStorageSubjects.loadAll, async (ctx) => {
    const rows = await db.select().from(clientRuntimes);
    ctx.setResult({ records: rows.map(mapRow) });
  });

  return () => {
    upsertCleanup();
    loadAllCleanup();
  };
}

// ---------------------------------------------------------------------------
// Utility for index lookups (used in tests with direct DB access)
// ---------------------------------------------------------------------------

/**
 * Retrieve a single runtime record by its stable ID from the database.
 *
 * Intended for use in tests and admin tooling only. Production code must go
 * through the bus subjects exposed by {@link registerDrizzleRuntimeStorage}.
 * @param db - Drizzle database instance
 * @param clientRuntimeId - Stable runtime identifier to look up
 * @returns The record, or `undefined` when not found
 */
export async function selectRuntimeById(
  db: MakaioDatabase,
  clientRuntimeId: string,
): Promise<ClientRuntimeRecord | undefined> {
  const { clientRuntimes } = resolveSchema(db, clientRuntimesSchema);
  const [row] = await db.select().from(clientRuntimes).where(eq(clientRuntimes.id, clientRuntimeId)).limit(1);
  return row ? mapRow(row) : undefined;
}

/**
 * Retrieve runtime records by supervisorSessionId from the database.
 *
 * Intended for use in tests and admin tooling only.
 * @param db - Drizzle database instance
 * @param supervisorSessionId - Supervisor session ID to match
 * @returns Matching records
 */
export async function selectRuntimeBySupervisorSessionId(
  db: MakaioDatabase,
  supervisorSessionId: string,
): Promise<ClientRuntimeRecord[]> {
  const { clientRuntimes } = resolveSchema(db, clientRuntimesSchema);
  const rows = await db
    .select()
    .from(clientRuntimes)
    .where(eq(clientRuntimes.supervisorSessionId, supervisorSessionId));
  return rows.map(mapRow);
}

/**
 * Retrieve a runtime record by pid+clientId from the database.
 *
 * Intended for use in tests and admin tooling only.
 * @param db - Drizzle database instance
 * @param pid - OS process ID
 * @param clientId - Stable client identifier
 * @returns The record, or `undefined` when not found
 */
export async function selectRuntimeByPidAndClientId(
  db: MakaioDatabase,
  pid: number,
  clientId: string,
): Promise<ClientRuntimeRecord | undefined> {
  const { clientRuntimes } = resolveSchema(db, clientRuntimesSchema);
  const [row] = await db
    .select()
    .from(clientRuntimes)
    .where(and(eq(clientRuntimes.pid, pid), eq(clientRuntimes.clientId, clientId)))
    .limit(1);
  return row ? mapRow(row) : undefined;
}
