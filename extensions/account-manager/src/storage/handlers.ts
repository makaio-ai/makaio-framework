/* eslint max-lines-per-function: ["error", { "max": 90 }] */
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { didAffectRows, type MakaioDatabase } from '@makaio/storage-drizzle';
import type { IMakaioBus } from '@makaio/bus-core';
import type { Account } from '../bus/schemas.js';
import type { UsageEntry } from '../bus/usage-entry.js';
import { metadataPatchChanges } from '../utils/json-merge-patch.js';
import { AccountManagerStorageSubjects } from './namespace.js';
import { accounts, accountTimeline, usageSnapshots } from './schema.js';

interface AccountManagerStorageHandlerDeps {
  bus: IMakaioBus;
  db: MakaioDatabase;
}

/**
 * Converts one accounts table row into the public account shape.
 * @param row - Selected accounts table row
 * @returns Public account payload
 */
function rowToAccount(row: typeof accounts.$inferSelect): Account {
  return {
    id: row.id,
    label: row.label ?? undefined,
    linkedClientAccountId: row.linkedClientAccountId ?? undefined,
    metadata: row.metadata,
    active: row.active,
    detectedAt: row.detectedAt,
    lastSeenAt: row.lastSeenAt,
  };
}

/**
 * Converts one usage_snapshots table row into the bus usage-entry shape.
 * @param row - Selected usage snapshot row
 * @returns Usage entry payload
 */
function rowToUsageEntry(row: typeof usageSnapshots.$inferSelect): UsageEntry {
  return {
    ts: row.fetchedAt,
    windowId: row.windowId,
    utilization: row.utilization,
    resetsAt: row.resetsAt,
    blocked: row.blocked,
  };
}

/**
 * Registers account metadata list handlers.
 * @param deps - Shared bus/database dependencies
 * @returns Cleanup functions for the registered handlers
 */
function registerMetadataListHandlers({ bus, db }: AccountManagerStorageHandlerDeps): Array<() => void> {
  return [
    bus.on(AccountManagerStorageSubjects.metadata.list, async (ctx) => {
      const rows = await db
        .select()
        .from(accounts)
        .where(eq(accounts.clientId, ctx.payload.clientId))
        .orderBy(desc(accounts.active), desc(accounts.lastSeenAt));
      ctx.setResult({ accounts: rows.map(rowToAccount) });
    }),
    bus.on(AccountManagerStorageSubjects.metadata.listByLinkedClientAccountId, async (ctx) => {
      const rows = await db
        .select()
        .from(accounts)
        .where(
          and(
            eq(accounts.clientId, ctx.payload.clientId),
            eq(accounts.linkedClientAccountId, ctx.payload.linkedClientAccountId),
          ),
        )
        .orderBy(desc(accounts.active), desc(accounts.lastSeenAt));
      ctx.setResult({ accounts: rows.map(rowToAccount) });
    }),
  ];
}

/**
 * Registers account metadata read handlers.
 * @param deps - Shared bus/database dependencies
 * @returns Cleanup functions for the registered handlers
 */
function registerMetadataReadHandlers(deps: AccountManagerStorageHandlerDeps): Array<() => void> {
  const { bus, db } = deps;
  return [
    ...registerMetadataListHandlers(deps),
    bus.on(AccountManagerStorageSubjects.metadata.get, async (ctx) => {
      const [row] = await db
        .select()
        .from(accounts)
        .where(and(eq(accounts.clientId, ctx.payload.clientId), eq(accounts.id, ctx.payload.accountId)))
        .limit(1);
      ctx.setResult({ account: row ? rowToAccount(row) : null });
    }),
    bus.on(AccountManagerStorageSubjects.metadata.getWithMetadataGeneration, async (ctx) => {
      const [row] = await db
        .select()
        .from(accounts)
        .where(and(eq(accounts.clientId, ctx.payload.clientId), eq(accounts.id, ctx.payload.accountId)))
        .limit(1);
      ctx.setResult({
        account: row ? rowToAccount(row) : null,
        metadataGeneration: row?.metadataGeneration ?? null,
      });
    }),
    bus.on(AccountManagerStorageSubjects.metadata.getActive, async (ctx) => {
      const [row] = await db
        .select()
        .from(accounts)
        .where(and(eq(accounts.clientId, ctx.payload.clientId), eq(accounts.active, true)))
        .orderBy(desc(accounts.lastSeenAt), desc(accounts.id))
        .limit(1);
      ctx.setResult({ account: row ? rowToAccount(row) : null });
    }),
    bus.on(AccountManagerStorageSubjects.metadata.getActiveAtTimestamp, async (ctx) => {
      const [row] = await db
        .select({ accountId: accountTimeline.toAccountId })
        .from(accountTimeline)
        .where(
          and(
            eq(accountTimeline.clientId, ctx.payload.clientId),
            lte(accountTimeline.effectiveAt, ctx.payload.timestamp),
          ),
        )
        .orderBy(desc(accountTimeline.effectiveAt), desc(accountTimeline.id))
        .limit(1);
      ctx.setResult({ accountId: row?.accountId ?? null });
    }),
    bus.on(AccountManagerStorageSubjects.metadata.getLatestTimelineEntry, async (ctx) => {
      const filters = [eq(accountTimeline.clientId, ctx.payload.clientId)];
      if (ctx.payload.reason !== undefined) {
        filters.push(eq(accountTimeline.reason, ctx.payload.reason));
      }
      const [row] = await db
        .select()
        .from(accountTimeline)
        .where(and(...filters))
        .orderBy(desc(accountTimeline.effectiveAt), desc(accountTimeline.id))
        .limit(1);
      ctx.setResult({
        entry: row
          ? {
              clientId: row.clientId,
              fromAccountId: row.fromAccountId,
              toAccountId: row.toAccountId,
              effectiveAt: row.effectiveAt,
              reason: row.reason,
            }
          : null,
      });
    }),
    bus.on(AccountManagerStorageSubjects.metadata.hasAnyAccounts, async (ctx) => {
      const [row] = await db.select({ count: sql<number>`count(*)` }).from(accounts).limit(1);
      ctx.setResult({ hasAnyAccounts: Number(row?.count ?? 0) > 0 });
    }),
  ];
}

/**
 * Registers basic account metadata write handlers.
 * @param deps - Shared bus/database dependencies
 * @returns Cleanup functions for the registered handlers
 */
function registerMetadataMutationHandlers({ bus, db }: AccountManagerStorageHandlerDeps): Array<() => void> {
  return [
    bus.on(AccountManagerStorageSubjects.metadata.upsert, async (ctx) => {
      const linkedClientAccountId = ctx.payload.account.linkedClientAccountId;
      const insertAccountFields = {
        label: ctx.payload.account.label ?? null,
        linkedClientAccountId: linkedClientAccountId ?? null,
        metadata: ctx.payload.account.metadata,
        active: ctx.payload.account.active,
        detectedAt: ctx.payload.account.detectedAt,
        lastSeenAt: ctx.payload.account.lastSeenAt,
      };
      const updateAccountFields = {
        label: ctx.payload.account.label ?? null,
        metadata: ctx.payload.account.metadata,
        active: ctx.payload.account.active,
        detectedAt: ctx.payload.account.detectedAt,
        lastSeenAt: ctx.payload.account.lastSeenAt,
        ...(linkedClientAccountId !== undefined ? { linkedClientAccountId } : {}),
      };
      await db
        .insert(accounts)
        .values({
          id: ctx.payload.account.id,
          clientId: ctx.payload.clientId,
          ...insertAccountFields,
          metadataGeneration: 0,
        })
        .onConflictDoNothing({ target: accounts.id });
      await db
        .update(accounts)
        .set(updateAccountFields)
        .where(and(eq(accounts.id, ctx.payload.account.id), eq(accounts.clientId, ctx.payload.clientId)));
      ctx.setResult({});
    }),
    bus.on(AccountManagerStorageSubjects.metadata.remove, async (ctx) => {
      await db
        .delete(accounts)
        .where(and(eq(accounts.clientId, ctx.payload.clientId), eq(accounts.id, ctx.payload.accountId)));
      ctx.setResult({});
    }),
    bus.on(AccountManagerStorageSubjects.metadata.deactivateAll, async (ctx) => {
      await db
        .update(accounts)
        .set({ active: false })
        .where(and(eq(accounts.clientId, ctx.payload.clientId), eq(accounts.active, true)));
      ctx.setResult({});
    }),
    bus.on(AccountManagerStorageSubjects.metadata.setLabel, async (ctx) => {
      const [updated] = await db
        .update(accounts)
        .set({ label: ctx.payload.label })
        .where(and(eq(accounts.clientId, ctx.payload.clientId), eq(accounts.id, ctx.payload.accountId)))
        .returning();
      ctx.setResult({ account: updated ? rowToAccount(updated) : null });
    }),
    bus.on(AccountManagerStorageSubjects.metadata.setLinkedClientAccountId, async (ctx) => {
      const [updated] = await db
        .update(accounts)
        .set({ linkedClientAccountId: ctx.payload.linkedClientAccountId })
        .where(and(eq(accounts.clientId, ctx.payload.clientId), eq(accounts.id, ctx.payload.accountId)))
        .returning();
      ctx.setResult({ account: updated ? rowToAccount(updated) : null });
    }),
  ];
}

/**
 * Registers generation-aware metadata patch handlers.
 * @param deps - Shared bus/database dependencies
 * @returns Cleanup functions for the registered handlers
 */
function registerMetadataGenerationHandlers({ bus, db }: AccountManagerStorageHandlerDeps): Array<() => void> {
  return [
    bus.on(AccountManagerStorageSubjects.metadata.getMetadataGeneration, async (ctx) => {
      const [row] = await db
        .select({ generation: accounts.metadataGeneration })
        .from(accounts)
        .where(and(eq(accounts.clientId, ctx.payload.clientId), eq(accounts.id, ctx.payload.accountId)))
        .limit(1);
      ctx.setResult({ generation: row?.generation ?? null });
    }),
    bus.on(AccountManagerStorageSubjects.metadata.bumpMetadataGeneration, async (ctx) => {
      const [updated] = await db
        .update(accounts)
        .set({ metadataGeneration: sql`${accounts.metadataGeneration} + 1` })
        .where(and(eq(accounts.clientId, ctx.payload.clientId), eq(accounts.id, ctx.payload.accountId)))
        .returning({ generation: accounts.metadataGeneration });
      ctx.setResult({ generation: updated?.generation ?? null });
    }),
    bus.on(AccountManagerStorageSubjects.metadata.patchMetadata, async (ctx) => {
      const [existing] = await db
        .select()
        .from(accounts)
        .where(and(eq(accounts.clientId, ctx.payload.clientId), eq(accounts.id, ctx.payload.accountId)))
        .limit(1);
      if (!existing) {
        ctx.setResult({ account: null });
        return;
      }
      if (existing.metadataGeneration !== ctx.payload.expectedGeneration) {
        ctx.setResult({ account: null });
        return;
      }
      const changed = metadataPatchChanges(existing.metadata, ctx.payload.patches);
      if (!changed) {
        ctx.setResult({ account: rowToAccount(existing) });
        return;
      }
      const [updated] = await db
        .update(accounts)
        .set({
          metadata: sql<
            Record<string, unknown>
          >`json_patch(${accounts.metadata}, ${JSON.stringify(ctx.payload.patches)})`,
          metadataGeneration: sql`${accounts.metadataGeneration} + 1`,
        })
        .where(
          and(
            eq(accounts.clientId, ctx.payload.clientId),
            eq(accounts.id, ctx.payload.accountId),
            eq(accounts.metadataGeneration, ctx.payload.expectedGeneration),
          ),
        )
        .returning();
      ctx.setResult({ account: updated ? rowToAccount(updated) : null });
    }),
  ];
}

/**
 * Registers account timeline handlers.
 * @param deps - Shared bus/database dependencies
 * @returns Cleanup functions for the registered handlers
 */
function registerTimelineHandlers({ bus, db }: AccountManagerStorageHandlerDeps): Array<() => void> {
  return [
    bus.on(AccountManagerStorageSubjects.metadata.appendTimeline, async (ctx) => {
      await db.insert(accountTimeline).values({
        clientId: ctx.payload.clientId,
        fromAccountId: ctx.payload.fromAccountId ?? null,
        toAccountId: ctx.payload.toAccountId,
        effectiveAt: ctx.payload.effectiveAt,
        reason: ctx.payload.reason,
      });
      ctx.setResult({});
    }),
  ];
}

/**
 * Registers usage snapshot storage handlers.
 * @param deps - Shared bus/database dependencies
 * @returns Cleanup functions for the registered handlers
 */
function registerSnapshotHandlers({ bus, db }: AccountManagerStorageHandlerDeps): Array<() => void> {
  return [
    bus.on(AccountManagerStorageSubjects.snapshots.append, async (ctx) => {
      const result = await db
        .insert(usageSnapshots)
        .values({
          clientId: ctx.payload.clientId,
          accountId: ctx.payload.accountId,
          windowId: ctx.payload.entry.windowId,
          utilization: ctx.payload.entry.utilization,
          resetsAt: ctx.payload.entry.resetsAt,
          blocked: ctx.payload.entry.blocked,
          fetchedAt: ctx.payload.entry.ts,
        })
        .onConflictDoNothing({
          target: [
            usageSnapshots.clientId,
            usageSnapshots.accountId,
            usageSnapshots.windowId,
            usageSnapshots.fetchedAt,
          ],
        });
      ctx.setResult({ persisted: didAffectRows(result) });
    }),
    bus.on(AccountManagerStorageSubjects.snapshots.read, async (ctx) => {
      const filters = [
        eq(usageSnapshots.clientId, ctx.payload.clientId),
        eq(usageSnapshots.accountId, ctx.payload.accountId),
        gte(usageSnapshots.fetchedAt, ctx.payload.from),
        lte(usageSnapshots.fetchedAt, ctx.payload.to),
      ];
      if (ctx.payload.windowId !== undefined) {
        filters.push(eq(usageSnapshots.windowId, ctx.payload.windowId));
      }
      const rows = await db
        .select()
        .from(usageSnapshots)
        .where(and(...filters))
        .orderBy(usageSnapshots.fetchedAt, usageSnapshots.id);
      ctx.setResult({ entries: rows.map(rowToUsageEntry) });
    }),
    bus.on(AccountManagerStorageSubjects.snapshots.hasAnySnapshots, async (ctx) => {
      const [row] = await db.select({ count: sql<number>`count(*)` }).from(usageSnapshots).limit(1);
      ctx.setResult({ hasAnySnapshots: Number(row?.count ?? 0) > 0 });
    }),
  ];
}

/**
 * Registers all Drizzle-backed account-manager storage handlers.
 * @param bus - Bus used for handler registration
 * @param db - Drizzle database instance
 * @returns Cleanup function that unregisters every handler
 */
export function registerDrizzleAccountManagerStorage(bus: IMakaioBus, db: MakaioDatabase): () => void {
  const deps: AccountManagerStorageHandlerDeps = { bus, db };
  const cleanups = [
    ...registerMetadataReadHandlers(deps),
    ...registerMetadataMutationHandlers(deps),
    ...registerMetadataGenerationHandlers(deps),
    ...registerTimelineHandlers(deps),
    ...registerSnapshotHandlers(deps),
  ];
  return () => cleanups.forEach((cleanup) => cleanup());
}
