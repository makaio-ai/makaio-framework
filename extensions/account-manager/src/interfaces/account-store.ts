import type { Account } from '../bus/schemas.js';
import type { RawCredential } from './credential-source.js';
import type { UsageEntry } from '../bus/usage-entry.js';

/**
 * Internal joined account representation used by orchestrators and handlers.
 *
 * Built by joining the credential store record with the public metadata row.
 * Never crosses the public API or bus boundary.
 */
export interface StoredAccount extends Account {
  /** Full credential payload for write-back to the client's native location. */
  credential: RawCredential;
  /**
   * Deduplication key derived from the credential payload (e.g., SHA-256 of refresh token).
   *
   * Used by {@link CredentialTracker} for change detection and secondary dedup
   * when the primary fingerprint format transitions (UUID ↔ hash). Unlike `id`
   * (a stable UUID assigned at first detection), this value is recomputed from
   * the credential on every read and may change format across restarts.
   */
  fingerprint: string;
}

/**
 * Credential-only storage record.
 *
 * Public metadata lives in {@link IAccountMetadataStore}; credential stores
 * keep only the bytes needed to switch accounts and the fingerprint needed to
 * detect/deduplicate them.
 */
export interface StoredAccountCredential {
  /** Stable account identifier shared with metadata rows. */
  id: string;
  /** Full credential payload for write-back to the client's native location. */
  credential: RawCredential;
  /** Deduplication key derived from the credential payload. */
  fingerprint: string;
}

/**
 * One durable account activation timeline row.
 */
export interface AccountTimelineEntry {
  /** Stable client identifier. */
  clientId: string;
  /** Previously active account, or null when no known predecessor exists. */
  fromAccountId: string | null;
  /** Newly active account. */
  toAccountId: string;
  /** Epoch milliseconds when the row became effective. */
  effectiveAt: number;
  /** Timeline row reason. */
  reason: AccountTimelineReason;
}

/**
 * File/keychain-backed credential storage.
 *
 * **Mutability contract:** Objects returned by `list()` and `get()` are
 * caller-owned copies. Callers may mutate fields before passing back to
 * `upsert()`. Implementations must not return shared references.
 */
export interface IAccountCredentialStore {
  /**
   * All credential records for a client.
   * @param clientId - Stable client identifier, e.g. 'claude-code'
   */
  list(clientId: string): Promise<StoredAccountCredential[]>;
  /**
   * Store or update a credential record.
   * @param clientId - Stable client identifier
   * @param account - Credential record keyed by the stable account id
   */
  upsert(clientId: string, account: StoredAccountCredential): Promise<void>;
  /**
   * Remove a credential record.
   * @param clientId - Stable client identifier
   * @param accountId - Account to remove
   */
  remove(clientId: string, accountId: string): Promise<void>;
  /**
   * Retrieve a single account by ID.
   * @param clientId - Stable client identifier
   * @param accountId - Account to retrieve
   * @returns The account, or null if not found
   */
  get(clientId: string, accountId: string): Promise<StoredAccountCredential | null>;
}

/** Reasons recorded in the account activation timeline. */
export type AccountTimelineReason = 'bootstrap' | 'detected' | 'switch';

/**
 * Drizzle-backed public account metadata and activation history storage.
 *
 * The live service owns orchestration; this store owns durable public state
 * and targeted mutations that must not clobber concurrent label/metadata
 * updates.
 */
export interface IAccountMetadataStore {
  /**
   * Lists public account rows for a client.
   * @param clientId - Stable client identifier
   * @returns Public account rows
   */
  list(clientId: string): Promise<Account[]>;
  /**
   * Lists public account rows linked to a canonical clients-core account.
   * @param clientId - Stable client identifier
   * @param linkedClientAccountId - Canonical clients-core account identifier
   * @returns Matching public account rows
   */
  listByLinkedClientAccountId(clientId: string, linkedClientAccountId: string): Promise<Account[]>;
  /**
   * Retrieves one public account row.
   * @param clientId - Stable client identifier
   * @param accountId - Account to retrieve
   * @returns Public account row, or null when absent
   */
  get(clientId: string, accountId: string): Promise<Account | null>;
  /**
   * Retrieves one public account row together with its current metadata generation.
   * @param clientId - Stable client identifier
   * @param accountId - Account to retrieve
   * @returns Public account row plus generation, or null when absent
   */
  getWithMetadataGeneration(
    clientId: string,
    accountId: string,
  ): Promise<{ account: Account; metadataGeneration: number } | null>;
  /**
   * Upserts a full public account row.
   * @param clientId - Stable client identifier
   * @param account - Public account row
   */
  upsert(clientId: string, account: Account): Promise<void>;
  /**
   * Removes a public account row.
   * @param clientId - Stable client identifier
   * @param accountId - Account to remove
   */
  remove(clientId: string, accountId: string): Promise<void>;
  /**
   * Returns the currently active account row for a client.
   * @param clientId - Stable client identifier
   * @returns Active account row, or null when none is active
   */
  getActive(clientId: string): Promise<Account | null>;
  /**
   * Returns the active account id at a historical timestamp.
   * @param clientId - Stable client identifier
   * @param timestamp - Historical lookup timestamp in epoch milliseconds
   * @returns Account id, or null when no timeline row is known yet
   */
  getActiveAtTimestamp(clientId: string, timestamp: number): Promise<string | null>;
  /**
   * Returns the latest activation timeline row for a client.
   * @param clientId - Stable client identifier
   * @param reason - Optional reason filter
   * @returns Most recent matching timeline row, or null when absent
   */
  getLatestTimelineEntry(clientId: string, reason?: AccountTimelineReason): Promise<AccountTimelineEntry | null>;
  /**
   * Deactivates every active row for the client.
   * @param clientId - Stable client identifier
   */
  deactivateAll(clientId: string): Promise<void>;
  /**
   * Updates an account label without replacing other fields.
   * @param clientId - Stable client identifier
   * @param accountId - Account to update
   * @param label - Human-readable label
   * @returns Updated account row, or null when absent
   */
  setLabel(clientId: string, accountId: string, label: string): Promise<Account | null>;
  /**
   * Updates or clears the linked clients-core account ID without replacing other fields.
   * @param clientId - Stable client identifier
   * @param accountId - Account to update
   * @param linkedClientAccountId - Canonical clients-core account identifier, or null to unlink
   * @returns Updated account row, or null when absent
   */
  setLinkedClientAccountId(
    clientId: string,
    accountId: string,
    linkedClientAccountId: string | null,
  ): Promise<Account | null>;
  /**
   * Returns the current metadata generation for an account row.
   * @param clientId - Stable client identifier
   * @param accountId - Account to inspect
   * @returns Current metadata generation, or null when absent
   */
  getMetadataGeneration(clientId: string, accountId: string): Promise<number | null>;
  /**
   * Bumps the durable metadata generation for an account row.
   * @param clientId - Stable client identifier
   * @param accountId - Account to invalidate
   * @returns Updated metadata generation, or null when absent
   */
  bumpMetadataGeneration(clientId: string, accountId: string): Promise<number | null>;
  /**
   * Merges provider-derived metadata patches into an account row.
   *
   * Generation is an ownership invalidation token captured before a fetch.
   * Successful patches advance it so later writes can detect that the
   * metadata row has changed since the fetch began.
   * @param clientId - Stable client identifier
   * @param accountId - Account to update
   * @param expectedGeneration - Durable metadata generation captured before the fetch
   * @param patches - Partial metadata patch
   * @returns Updated account row, or null when absent or stale
   */
  patchMetadata(
    clientId: string,
    accountId: string,
    expectedGeneration: number,
    patches: Record<string, unknown>,
  ): Promise<Account | null>;
  /**
   * Appends one activation timeline row.
   * @param entry - Timeline row to append
   */
  appendTimeline(entry: AccountTimelineEntry): Promise<void>;
  /**
   * Returns whether any public account rows already exist.
   * @returns `true` when durable account state already exists
   */
  hasAnyAccounts(): Promise<boolean>;
}

/**
 * Drizzle-backed append-only usage snapshot storage.
 */
export interface IAccountUsageSnapshotStore {
  /**
   * Appends one usage-window snapshot.
   * @param clientId - Stable client identifier
   * @param accountId - Stable account identifier
   * @param entry - Window snapshot to append
   * @returns `true` when the snapshot was durably recorded
   */
  append(clientId: string, accountId: string, entry: UsageEntry): Promise<boolean>;
  /**
   * Streams usage-window snapshots for one account and time range.
   * @param clientId - Stable client identifier
   * @param accountId - Stable account identifier
   * @param opts - Inclusive time range and optional window filter
   * @returns Async stream ordered by timestamp ascending
   */
  read(
    clientId: string,
    accountId: string,
    opts: { from: number; to: number; windowId?: string },
  ): AsyncIterable<UsageEntry>;
  /**
   * Returns whether any snapshots already exist.
   * @returns `true` when durable usage snapshots already exist
   */
  hasAnySnapshots(): Promise<boolean>;
}
