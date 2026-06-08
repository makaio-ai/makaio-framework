/**
 * Drizzle-backed persistence handler for client profiles.
 *
 * Registers bus handlers for CRUD operations on profile records on the
 * `client-profile:storage.*` subjects. All DB access is encapsulated here —
 * no caller outside this module should query the `client_profiles` table
 * directly.
 * @packageDocumentation
 */

import { and, eq } from 'drizzle-orm';
import { didAffectRows, executeTransaction, type MakaioDatabase } from '@makaio/storage-drizzle';
import type { IMakaioBus } from '@makaio/bus-core';
import type { ExtensionContext } from '@makaio/contracts';
import { clientProfiles } from './profile-schema.js';
import { ClientProfileStorageSubjects } from './profile-storage-namespace.js';
import type { SelectClientProfile } from './profile-schema.js';
import type { ClientProfileRecord } from './profile-storage-namespace.js';

export { ClientProfileStorageNamespace, ClientProfileStorageSubjects } from './profile-storage-namespace.js';

// ---------------------------------------------------------------------------
// DB row mapper
// ---------------------------------------------------------------------------

type ProfileRow = SelectClientProfile;

/**
 * Maps a `client_profiles` database row to a bus record.
 * @param row - Raw row from the `client_profiles` table
 * @returns Mapped profile record
 */
function mapRow(row: ProfileRow): ClientProfileRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    name: row.name,
    description: row.description ?? null,
    configDir: row.configDir,
    isDefault: row.isDefault,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Promote one profile to default and clear the previous default in one
 * transaction.
 * @param db - Drizzle database instance
 * @param clientId - Stable client identifier
 * @param name - Profile name to promote
 * @returns Updated default profile, or `null` when the profile does not exist
 */
async function setDefaultProfile(
  db: MakaioDatabase,
  clientId: string,
  name: string,
): Promise<ClientProfileRecord | null> {
  const now = Date.now();
  return executeTransaction(db, async (tx) => {
    const [existing] = await tx
      .select()
      .from(clientProfiles)
      .where(and(eq(clientProfiles.clientId, clientId), eq(clientProfiles.name, name)))
      .limit(1);
    if (existing === undefined) {
      return null;
    }

    await tx
      .update(clientProfiles)
      .set({ isDefault: false, updatedAt: now })
      .where(and(eq(clientProfiles.clientId, clientId), eq(clientProfiles.isDefault, true)));
    await tx
      .update(clientProfiles)
      .set({ isDefault: true, updatedAt: now })
      .where(and(eq(clientProfiles.clientId, clientId), eq(clientProfiles.name, name)));

    const [updated] = await tx
      .select()
      .from(clientProfiles)
      .where(and(eq(clientProfiles.clientId, clientId), eq(clientProfiles.name, name)))
      .limit(1);
    return updated === undefined ? null : mapRow(updated);
  });
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

/**
 * Registers Drizzle-backed bus handlers for client profile storage.
 *
 * The following subjects are handled:
 * - `client-profile:storage.get` — return a profile by `(clientId, name)`.
 * - `client-profile:storage.getById` — return a profile by stable row ID.
 * - `client-profile:storage.list` — return all profiles for a client.
 * - `client-profile:storage.set` — insert or update a profile by stable row ID.
 * - `client-profile:storage.delete` — delete a profile by `(clientId, name)`.
 * - `client-profile:storage.clearDefault` — reset the default flag for all profiles of a client.
 * - `client-profile:storage.setDefault` — atomically promote one profile to default.
 * @param bus - Bus instance to register handlers on
 * @param db - Drizzle database instance
 * @param _ctx - Extension context (unused; reserved for future use)
 * @returns Cleanup function to unregister all handlers
 */
export function registerDrizzleProfileStorage(bus: IMakaioBus, db: MakaioDatabase, _ctx: ExtensionContext): () => void {
  const cleanups = [
    bus.on(ClientProfileStorageSubjects.get, async (ctx) => {
      const { clientId, name } = ctx.payload;
      const [row] = await db
        .select()
        .from(clientProfiles)
        .where(and(eq(clientProfiles.clientId, clientId), eq(clientProfiles.name, name)))
        .limit(1);
      ctx.setResult({ record: row ? mapRow(row) : null });
    }),

    bus.on(ClientProfileStorageSubjects.getById, async (ctx) => {
      const [row] = await db.select().from(clientProfiles).where(eq(clientProfiles.id, ctx.payload.id)).limit(1);
      ctx.setResult({ record: row ? mapRow(row) : null });
    }),

    bus.on(ClientProfileStorageSubjects.list, async (ctx) => {
      const rows = await db.select().from(clientProfiles).where(eq(clientProfiles.clientId, ctx.payload.clientId));
      ctx.setResult({ records: rows.map(mapRow) });
    }),

    bus.on(ClientProfileStorageSubjects.set, async (ctx) => {
      const record = ctx.payload;
      const values = {
        id: record.id,
        clientId: record.clientId,
        name: record.name,
        description: record.description ?? null,
        configDir: record.configDir,
        isDefault: record.isDefault,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      };
      await db
        .insert(clientProfiles)
        .values(values)
        .onConflictDoUpdate({
          target: clientProfiles.id,
          set: {
            name: record.name,
            description: record.description ?? null,
            configDir: record.configDir,
            isDefault: record.isDefault,
            updatedAt: record.updatedAt,
          },
        });
      ctx.setResult({ success: true });
    }),

    bus.on(ClientProfileStorageSubjects.delete, async (ctx) => {
      const { clientId, name } = ctx.payload;
      const result = await db
        .delete(clientProfiles)
        .where(and(eq(clientProfiles.clientId, clientId), eq(clientProfiles.name, name)));
      ctx.setResult({ success: didAffectRows(result) });
    }),

    bus.on(ClientProfileStorageSubjects.clearDefault, async (ctx) => {
      await db
        .update(clientProfiles)
        .set({ isDefault: false, updatedAt: Date.now() })
        .where(and(eq(clientProfiles.clientId, ctx.payload.clientId), eq(clientProfiles.isDefault, true)));
      ctx.setResult({ success: true });
    }),

    bus.on(ClientProfileStorageSubjects.setDefault, async (ctx) => {
      const { clientId, name } = ctx.payload;
      const record = await setDefaultProfile(db, clientId, name);
      ctx.setResult({ record });
    }),
  ];

  return () => {
    for (const cleanup of cleanups) {
      cleanup();
    }
  };
}
