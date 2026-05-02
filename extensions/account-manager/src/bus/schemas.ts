/**
 * Account-manager domain Zod schemas.
 *
 * Subjects for multi-account credential management bus communication.
 * Dotted keys produce nested subject accessors on the namespace object.
 *
 * **Subject groups:**
 * - `credentials.*` — credential detection, switching, and configuration
 * - `usage.*` — volatile rate-limit and credit telemetry
 * - `accounts.*` — account identity and management operations
 * @packageDocumentation
 */

import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';
import { UsageEntrySchema } from './usage-entry.js';

export { UsageEntrySchema, type UsageEntry } from './usage-entry.js';

/** Maximum inclusive time window accepted by the `usage.history` RPC. */
export const MAX_USAGE_HISTORY_RANGE_MS = 31 * 24 * 60 * 60 * 1000;

/**
 * Shared optional-scope request schema used by RPCs that accept
 * `{ clientId?, accountId? }` with the constraint that `accountId`
 * is only meaningful when `clientId` is also provided.
 */
export const UsageScopedRequestSchema = z
  .object({
    clientId: z.string().optional(),
    accountId: z.string().optional(),
  })
  .refine((v) => v.accountId === undefined || v.clientId !== undefined, {
    message: 'accountId requires clientId',
  });

/** Payload schema for a single usage window in the reset-available state. */
export const WindowResetPayloadSchema = z.object({
  clientId: z.string(),
  accountId: z.string(),
  windowId: z.string(),
  expiredAt: z.number().int().finite(),
});

/** Inferred TypeScript type for {@link WindowResetPayloadSchema}. */
export type WindowResetPayload = z.infer<typeof WindowResetPayloadSchema>;

/** Shared request schema for the `usage.history` RPC. */
export const UsageHistoryRequestSchema = z
  .object({
    clientId: z.string().min(1),
    accountId: z.string().min(1),
    windowId: z.string().min(1).optional(),
    from: z.number().int().finite().nonnegative(),
    to: z.number().int().finite().nonnegative(),
  })
  .refine((v) => v.from <= v.to, {
    message: '`from` must be less than or equal to `to`',
  })
  .refine((v) => v.to - v.from <= MAX_USAGE_HISTORY_RANGE_MS, {
    message: '`usage.history` requests must not exceed 31 days',
  });

/**
 * Schema for a single account identity managed by the account-manager.
 *
 * An account maps a credential source (identified by `clientId`) to a
 * stable string `id`. Labels are optional and human-assigned.
 */
export const AccountSchema = z.object({
  /** Stable unique identifier for this account. */
  id: z.string(),
  /** Optional human-readable label. */
  label: z.string().optional(),
  /** Optional canonical client-account link from clients-core. */
  linkedClientAccountId: z.string().optional(),
  /** Arbitrary provider-specific metadata. */
  metadata: z.record(z.string(), z.unknown()),
  /** Whether this is the currently active account for its source. */
  active: z.boolean(),
  /** Epoch ms when the account was first detected. */
  detectedAt: z.number(),
  /** Epoch ms when the account was most recently observed. */
  lastSeenAt: z.number(),
});

/** Inferred TypeScript type for {@link AccountSchema}. */
export type Account = z.infer<typeof AccountSchema>;

/**
 * Schema for a single usage-window entry within an account's rate-limit data.
 *
 * Windows are identified by short slugs such as `"5h"`, `"7d"`, or
 * `"7d-sonnet"`.
 */
export const UsageWindowSchema = z.object({
  /**
   * Short slug that uniquely identifies this window, e.g. `"5h"`, `"7d"`,
   * `"7d-sonnet"`.
   */
  id: z.string().min(1),
  /** Human-readable label, e.g. `"5 Hour"`, `"Sonnet (7 Day)"`. */
  label: z.string().min(1),
  /** Logical group, e.g. `"overall"` or `"model"`. Free string — not an enum —
   *  so future providers can introduce new groups without a schema change. */
  group: z.string().min(1).optional(),
  /** Current utilization as a percentage in the range 0–100. */
  utilization: z.number().finite().min(0).max(100),
  /** Epoch ms at which this window resets. */
  resetsAt: z.number().int().finite(),
  /** Duration of the window in seconds, e.g. `18000` (5 h), `604800` (7 d). */
  windowSeconds: z.number().int().finite().nonnegative(),
});

/** Inferred TypeScript type for {@link UsageWindowSchema}. */
export type UsageWindow = z.infer<typeof UsageWindowSchema>;

/**
 * Schema for the full usage snapshot of an account at a point in time.
 *
 * Fetched on-demand via `usage.get` and pushed reactively via `usage.updated`.
 */
export const AccountUsageSchema = z.object({
  /** Epoch ms when this snapshot was retrieved from the upstream source. */
  fetchedAt: z.number().int().finite(),
  /** All rate-limit windows reported for this account. */
  windows: z.array(UsageWindowSchema),
  /**
   * When `true` the account is rate-limited and cannot accept new requests.
   * Omitted (or `false`) when the account is not blocked.
   */
  blocked: z.boolean().optional(),
  /**
   * When `true`, the snapshot reflects the last-known good data but the most
   * recent fetch attempt failed (e.g. 429, timeout). Consumers should render
   * the data as not-authoritative. Omitted on fresh snapshots.
   */
  stale: z.boolean().optional(),
  /**
   * Epoch ms of the last successful upstream fetch that produced the data
   * currently in `windows`. Equal to `fetchedAt` on fresh snapshots; older
   * than `fetchedAt` when `stale` is `true`.
   */
  lastOkAt: z.number().int().finite().optional(),
  /**
   * Credit balance information, present only when the account uses a
   * credit-based billing model.
   */
  credits: z
    .object({
      /** Whether credit-based billing is active for this account. */
      enabled: z.boolean(),
      /** Current credit balance as a formatted string, e.g. `"$4.20"`. */
      balance: z.string().optional(),
      /** Credit limit as a formatted string, e.g. `"$25.00"`. */
      limit: z.string().optional(),
      /** Credit utilization as a percentage in the range 0–100. */
      utilization: z.number().finite().min(0).max(100).optional(),
    })
    .optional(),
});

/** Inferred TypeScript type for {@link AccountUsageSchema}. */
export type AccountUsage = z.infer<typeof AccountUsageSchema>;

/** Schema for a credential source's availability and configuration status. */
export const SourceInfoSchema = z.object({
  clientId: z.string(),
  displayName: z.string(),
  available: z.boolean(),
  configIssue: z
    .object({
      reason: z.string(),
      action: z.string(),
    })
    .optional(),
});

/** Inferred TypeScript type for {@link SourceInfoSchema}. */
export type SourceInfo = z.infer<typeof SourceInfoSchema>;

/**
 * Account-manager domain schemas.
 *
 * Maps every subject to its request/response or event schema.
 */
export const AccountManagerSchemas = {
  // --- credentials.* — credential detection & switching ---

  /**
   * Emitted after an account switch completes successfully.
   *
   * Payload: `clientId` identifies the source; `from` is the previously active
   * account (`null` if none was active); `to` is the newly active account.
   */
  'credentials.switched': z.object({
    clientId: z.string(),
    from: AccountSchema.nullable(),
    to: AccountSchema,
  }),

  /**
   * Emitted when an existing account's credential data has been refreshed
   * from the upstream source, or when label resolution should retry against an
   * unchanged active account.
   *
   * Payload: `clientId` identifies the source; `account` is the updated record;
   * `reason` distinguishes real credential updates from label-only retries.
   */
  'credentials.refreshed': z.object({
    clientId: z.string(),
    account: AccountSchema,
    reason: z.enum(['credential-updated', 'label-retry']).optional(),
  }),

  /**
   * Emitted when a new account is first observed by a credential source.
   *
   * Payload: `clientId` identifies the source; `account` is the new record;
   * `autoLabeled` indicates whether an automatic label was applied on detection.
   */
  'credentials.detected': z.object({
    clientId: z.string(),
    account: AccountSchema,
    autoLabeled: z.boolean().optional(),
  }),

  /**
   * RPC to switch the active account for a given credential source.
   *
   * Request: `clientId` — the source to switch on; `accountId` — the target.
   * Response: `success` — whether it worked; `error` — message if it did not.
   */
  'credentials.switch': {
    request: z.object({ clientId: z.string(), accountId: z.string() }),
    response: z.object({ success: z.boolean(), error: z.string().optional() }),
  },

  /**
   * RPC to configure a credential source to operate in file-based mode.
   *
   * Request: `clientId` — the source to configure.
   * Response: `success` — whether it worked; `error` — message if it did not.
   */
  'credentials.configureFileMode': {
    request: z.object({ clientId: z.string() }),
    response: z.object({ success: z.boolean(), error: z.string().optional() }),
  },

  /**
   * Emitted when a credential source encounters a non-fatal error.
   *
   * Payload: `clientId` identifies the source; `message` is a human-readable
   * description of the error.
   */
  'credentials.error': z.object({
    clientId: z.string(),
    message: z.string(),
  }),

  // --- usage.* — volatile rate limit / credit telemetry ---

  /**
   * RPC to fetch the current usage snapshot for a specific account.
   *
   * Request: `clientId` — the source that owns the account; `accountId` — the
   * target account.
   * Response: `usage` — the snapshot, or `null` if unavailable.
   */
  'usage.get': {
    request: z.object({ clientId: z.string(), accountId: z.string() }),
    response: z.object({ usage: AccountUsageSchema.nullable() }),
  },

  /**
   * Emitted when a usage snapshot has been refreshed for an account.
   *
   * Payload: `clientId` — the source; `accountId` — the account whose usage
   * was updated; `usage` — the new snapshot.
   */
  'usage.updated': z.object({
    clientId: z.string(),
    accountId: z.string(),
    usage: AccountUsageSchema,
  }),

  /**
   * RPC to force a fresh usage fetch for one or more accounts.
   *
   * Scope is determined by the request fields:
   * - `{ clientId, accountId }` — refresh one account
   * - `{ clientId }` — refresh all accounts owned by that source
   * - `{}` — refresh all accounts across all usage-capable sources
   *
   * Each scheduled fetch emits `usage.updated` on success. The RPC returns
   * the number of accounts for which a fetch was scheduled; individual
   * fetches run asynchronously and may emit `usage.updated` after the RPC
   * response has already been returned.
   *
   * Request: optional `clientId` / `accountId` scoping.
   * Response: `refreshed` — count of accounts scheduled for refresh.
   */
  'usage.refresh': {
    request: UsageScopedRequestSchema,
    response: z.object({ refreshed: z.number().int().nonnegative() }),
  },

  /**
   * RPC to retrieve historical usage entries for a specific account within a
   * time range.
   *
   * Request: `clientId` — the source that owns the account; `accountId` — the
   * target account; `windowId` — optional window filter (e.g. `"5h"`);
   * `from` — inclusive lower bound (epoch ms); `to` — inclusive upper bound
   * (epoch ms). The schema rejects requests where `from > to` or the requested
   * range exceeds 31 days. Current analytics surfaces only expose rolling
   * 24 h / 7 d / 30 d windows, so bounding the RPC keeps the read-side cost
   * predictable without introducing partial-result pagination semantics.
   * Response: `entries` — all matching usage observations in ts-ascending order.
   */
  'usage.history': {
    request: UsageHistoryRequestSchema,
    response: z.object({ entries: z.array(UsageEntrySchema) }),
  },

  /**
   * Emitted **once** per state transition when the UsageTracker first observes
   * that a usage window's `resetsAt` has passed — i.e. the window has expired
   * but the provider has not yet started a new one.
   *
   * The event fires only on verified (non-stale) snapshots. It is deduplicated
   * per window instance: a second poll with the same expired `resetsAt` is a
   * no-op. When a subsequent poll yields a future `resetsAt` for the same
   * window, the pending-reset entry is cleared so a fresh expiry can fire a
   * new event.
   *
   * Payload: `clientId` — the source; `accountId` — the account whose window
   * expired; `windowId` — the window slug (e.g. `"5h"`, `"7d"`); `expiredAt`
   * — the expired `resetsAt` value in epoch ms (not `Date.now()`), allowing
   * consumers to compute how long the reset has been pending.
   */
  'usage.windowResetAvailable': WindowResetPayloadSchema,

  /**
   * RPC for late-joining consumers to retrieve the current set of usage windows
   * that are in the "reset available" state — i.e. `resetsAt < Date.now()` in
   * the most recently cached snapshot.
   *
   * Results are computed live from the usage cache on every call, so they
   * always reflect the current state even if event tracking has drifted.
   * Scoping follows the same pattern as `usage.refresh`:
   * - `{ clientId, accountId }` — query one account
   * - `{ clientId }` — query all accounts owned by that source
   * - `{}` — query all accounts across all usage-capable sources
   *
   * The schema rejects requests where `accountId` is provided without
   * `clientId` — an account is only meaningful within its source.
   *
   * Request: optional `clientId` / `accountId` scoping.
   * Response: `pending` — all windows currently in the reset-available state.
   */
  'usage.getPendingResets': {
    request: UsageScopedRequestSchema,
    response: z.object({
      pending: z.array(WindowResetPayloadSchema),
    }),
  },

  /**
   * Emitted after the auto-activation feature successfully sends a ping message
   * to start a new usage window. Consumers can use this for observability; the
   * activator owns the follow-up usage refresh after a successful ping.
   *
   * Payload: `clientId` — the source; `accountId` — the account that was
   * pinged; `windowId` — the window that triggered the activation;
   * `model` — the model used for the ping.
   */
  'usage.windowActivated': z.object({
    clientId: z.string(),
    accountId: z.string(),
    windowId: z.string(),
    model: z.string(),
  }),

  // --- accounts.* — identity & management ---

  /**
   * Emitted when an enrichment source (e.g. usage provider) updates account
   * metadata outside the credential-detection flow.
   *
   * Payload: `clientId` — the source; `account` — the record with updated metadata.
   */
  'accounts.metadataPatched': z.object({
    clientId: z.string(),
    account: AccountSchema,
  }),

  /**
   * RPC to list all known accounts for a credential source.
   *
   * Request: `clientId` — the source to query.
   * Response: `accounts` — all accounts known to that source.
   */
  'accounts.list': {
    request: z.object({ clientId: z.string() }),
    response: z.object({ accounts: z.array(AccountSchema) }),
  },

  /**
   * RPC to retrieve the currently active account for a credential source.
   *
   * Request: `clientId` — the source to query.
   * Response: `account` — the active account, or `null` if none is active.
   */
  'accounts.getActive': {
    request: z.object({ clientId: z.string() }),
    response: z.object({ account: AccountSchema.nullable() }),
  },

  /**
   * RPC to resolve which account was active at a historical timestamp.
   *
   * Request: `clientId` — the source to query; `timestamp` — historical epoch ms.
   * Response: `accountId` — the most recent `toAccountId` whose `effectiveAt`
   * is less than or equal to the timestamp, or `null` when no timeline row was
   * known yet.
   */
  'accounts.getActiveAtTimestamp': {
    request: z.object({ clientId: z.string(), timestamp: z.number().int().finite().nonnegative() }),
    response: z.object({ accountId: z.string().nullable() }),
  },

  /**
   * RPC to assign a human-readable label to an account.
   *
   * Request: `clientId` — the source that owns the account; `accountId` — the
   * target; `label` — the label to assign.
   * Response: `success` — whether the label was applied.
   */
  'accounts.label': {
    request: z.object({ clientId: z.string(), accountId: z.string(), label: z.string() }),
    response: z.object({ success: z.boolean() }),
  },

  /**
   * Emitted after an account's label has been updated.
   *
   * Payload: `clientId` — the source that owns the account; `account` — the
   * record with its updated label.
   */
  'accounts.labeled': z.object({
    clientId: z.string(),
    account: AccountSchema,
  }),

  /**
   * RPC to remove an account from the known-accounts list.
   *
   * Request: `clientId` — the source that owns the account; `accountId` — the
   * account to remove.
   * Response: `success` — whether the removal succeeded.
   */
  'accounts.remove': {
    request: z.object({ clientId: z.string(), accountId: z.string() }),
    response: z.object({ success: z.boolean() }),
  },

  /**
   * RPC to list all registered credential sources and their availability.
   *
   * Response: `sources` — all registered sources with status information.
   */
  'accounts.getSources': {
    request: z.object({}),
    response: z.object({
      sources: z.array(SourceInfoSchema),
    }),
  },
} satisfies SchemaRecord;
