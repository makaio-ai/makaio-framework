import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';
import { AccountSchema, UsageHistoryRequestSchema } from '../bus/schemas.js';
import { UsageEntrySchema } from '../bus/usage-entry.js';

const TimelineEntrySchema = z.object({
  clientId: z.string().min(1),
  fromAccountId: z.string().min(1).nullable(),
  toAccountId: z.string().min(1),
  effectiveAt: z.number().int().finite().nonnegative(),
  reason: z.enum(['bootstrap', 'detected', 'switch']),
});

/**
 * Internal bus schemas for account-manager storage handlers.
 *
 * These subjects are package-local implementation details used by the service's
 * bus-backed store adapters.
 */
export const AccountManagerStorageSchemas = {
  'metadata.list': {
    request: z.object({ clientId: z.string().min(1) }),
    response: z.object({ accounts: z.array(AccountSchema) }),
  },
  'metadata.listByLinkedClientAccountId': {
    request: z.object({ clientId: z.string().min(1), linkedClientAccountId: z.string().min(1) }),
    response: z.object({ accounts: z.array(AccountSchema) }),
  },
  'metadata.get': {
    request: z.object({ clientId: z.string().min(1), accountId: z.string().min(1) }),
    response: z.object({ account: AccountSchema.nullable() }),
  },
  'metadata.getWithMetadataGeneration': {
    request: z.object({ clientId: z.string().min(1), accountId: z.string().min(1) }),
    response: z.object({
      account: AccountSchema.nullable(),
      metadataGeneration: z.number().int().nonnegative().nullable(),
    }),
  },
  'metadata.upsert': {
    request: z.object({ clientId: z.string().min(1), account: AccountSchema }),
    response: z.object({}),
  },
  'metadata.remove': {
    request: z.object({ clientId: z.string().min(1), accountId: z.string().min(1) }),
    response: z.object({}),
  },
  'metadata.getActive': {
    request: z.object({ clientId: z.string().min(1) }),
    response: z.object({ account: AccountSchema.nullable() }),
  },
  'metadata.getActiveAtTimestamp': {
    request: z.object({ clientId: z.string().min(1), timestamp: z.number().int().finite().nonnegative() }),
    response: z.object({ accountId: z.string().nullable() }),
  },
  'metadata.getLatestTimelineEntry': {
    request: z.object({
      clientId: z.string().min(1),
      reason: z.enum(['bootstrap', 'detected', 'switch']).optional(),
    }),
    response: z.object({ entry: TimelineEntrySchema.nullable() }),
  },
  'metadata.deactivateAll': {
    request: z.object({ clientId: z.string().min(1) }),
    response: z.object({}),
  },
  'metadata.setLabel': {
    request: z.object({ clientId: z.string().min(1), accountId: z.string().min(1), label: z.string() }),
    response: z.object({ account: AccountSchema.nullable() }),
  },
  'metadata.setLinkedClientAccountId': {
    request: z.object({
      clientId: z.string().min(1),
      accountId: z.string().min(1),
      linkedClientAccountId: z.string().min(1).nullable(),
    }),
    response: z.object({ account: AccountSchema.nullable() }),
  },
  'metadata.getMetadataGeneration': {
    request: z.object({ clientId: z.string().min(1), accountId: z.string().min(1) }),
    response: z.object({ generation: z.number().int().nonnegative().nullable() }),
  },
  'metadata.bumpMetadataGeneration': {
    request: z.object({ clientId: z.string().min(1), accountId: z.string().min(1) }),
    response: z.object({ generation: z.number().int().nonnegative().nullable() }),
  },
  'metadata.patchMetadata': {
    request: z.object({
      clientId: z.string().min(1),
      accountId: z.string().min(1),
      expectedGeneration: z.number().int().nonnegative(),
      patches: z.record(z.string(), z.unknown()),
    }),
    response: z.object({ account: AccountSchema.nullable() }),
  },
  'metadata.appendTimeline': {
    request: TimelineEntrySchema,
    response: z.object({}),
  },
  'metadata.hasAnyAccounts': {
    request: z.object({}),
    response: z.object({ hasAnyAccounts: z.boolean() }),
  },
  'snapshots.append': {
    request: z.object({
      clientId: z.string().min(1),
      accountId: z.string().min(1),
      entry: UsageEntrySchema,
    }),
    response: z.object({ persisted: z.boolean() }),
  },
  'snapshots.read': {
    request: UsageHistoryRequestSchema,
    response: z.object({ entries: z.array(UsageEntrySchema) }),
  },
  'snapshots.hasAnySnapshots': {
    request: z.object({}),
    response: z.object({ hasAnySnapshots: z.boolean() }),
  },
} satisfies SchemaRecord;
