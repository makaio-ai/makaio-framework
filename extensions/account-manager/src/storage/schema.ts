import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Public account metadata rows.
 */
export const accounts = sqliteTable(
  'accounts',
  {
    // Stable account ids are globally unique surrogate keys; clientId scopes
    // ownership and queries, but does not participate in row identity.
    id: text('id').primaryKey(),
    clientId: text('client_id').notNull(),
    label: text('label'),
    linkedClientAccountId: text('linked_client_account_id'),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    metadataGeneration: integer('metadata_generation').notNull().default(0),
    active: integer('active', { mode: 'boolean' }).notNull(),
    detectedAt: integer('detected_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
  },
  (table) => [
    index('idx_accounts_client_active').on(table.clientId, table.active),
    index('idx_accounts_client_linked_client_account').on(table.clientId, table.linkedClientAccountId),
    uniqueIndex('uniq_accounts_active_client')
      .on(table.clientId)
      .where(sql`${table.active} = 1`),
  ],
);

/**
 * Temporal account-switch history rows.
 */
export const accountTimeline = sqliteTable(
  'account_timeline',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    clientId: text('client_id').notNull(),
    fromAccountId: text('from_account_id'),
    toAccountId: text('to_account_id').notNull(),
    effectiveAt: integer('effective_at').notNull(),
    reason: text('reason', { enum: ['bootstrap', 'detected', 'switch'] }).notNull(),
  },
  (table) => [index('idx_account_timeline_client_effective').on(table.clientId, table.effectiveAt)],
);

/**
 * Append-only usage-window snapshots.
 */
export const usageSnapshots = sqliteTable(
  'usage_snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    clientId: text('client_id').notNull(),
    accountId: text('account_id').notNull(),
    windowId: text('window_id').notNull(),
    utilization: real('utilization').notNull(),
    resetsAt: integer('resets_at').notNull(),
    blocked: integer('blocked', { mode: 'boolean' }).notNull(),
    fetchedAt: integer('fetched_at').notNull(),
  },
  (table) => [
    index('idx_usage_snapshots_client_account_fetched').on(table.clientId, table.accountId, table.fetchedAt),
    uniqueIndex('uniq_usage_snapshots_identity').on(table.clientId, table.accountId, table.windowId, table.fetchedAt),
  ],
);
