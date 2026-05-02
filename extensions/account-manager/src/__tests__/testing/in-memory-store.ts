import type { Account } from '../../bus/schemas.js';
import type { UsageEntry } from '../../bus/usage-entry.js';
import type {
  AccountTimelineEntry,
  AccountTimelineReason,
  IAccountCredentialStore,
  IAccountMetadataStore,
  IAccountUsageSnapshotStore,
  StoredAccount,
  StoredAccountCredential,
} from '../../interfaces/account-store.js';
import {
  getStoredAccount,
  listStoredAccounts,
  removeStoredAccount,
  upsertStoredAccount,
} from '../../storage/joined-account-store.js';
import { applyJsonMergePatch, metadataPatchChanges } from '../../utils/json-merge-patch.js';

/**
 * In-memory credential store for tests.
 */
export class InMemoryAccountCredentialStore implements IAccountCredentialStore {
  private readonly data = new Map<string, StoredAccountCredential[]>();

  public async list(clientId: string): Promise<StoredAccountCredential[]> {
    return (this.data.get(clientId) ?? []).map(cloneCredential);
  }

  public async upsert(clientId: string, account: StoredAccountCredential): Promise<void> {
    const accounts = this.data.get(clientId) ?? [];
    const index = accounts.findIndex((candidate) => candidate.id === account.id);
    const clone = cloneCredential(account);
    if (index >= 0) {
      accounts[index] = clone;
    } else {
      accounts.push(clone);
    }
    this.data.set(clientId, accounts);
  }

  public async remove(clientId: string, accountId: string): Promise<void> {
    const accounts = this.data.get(clientId);
    if (!accounts) return;
    this.data.set(
      clientId,
      accounts.filter((account) => account.id !== accountId),
    );
  }

  public async get(clientId: string, accountId: string): Promise<StoredAccountCredential | null> {
    const account = (this.data.get(clientId) ?? []).find((candidate) => candidate.id === accountId);
    return account ? cloneCredential(account) : null;
  }

  public clear(): void {
    this.data.clear();
  }
}

/**
 * In-memory metadata + timeline store for tests.
 */
export class InMemoryAccountMetadataStore implements IAccountMetadataStore {
  private readonly data = new Map<string, Account[]>();
  private readonly timeline = new Map<string, Array<AccountTimelineEntry & { sequence: number }>>();
  private readonly metadataGenerations = new Map<string, number>();
  private nextTimelineSequence = 1;

  public async list(clientId: string): Promise<Account[]> {
    return (this.data.get(clientId) ?? []).map(cloneAccount);
  }

  public async listByLinkedClientAccountId(clientId: string, linkedClientAccountId: string): Promise<Account[]> {
    return (this.data.get(clientId) ?? [])
      .filter((account) => account.linkedClientAccountId === linkedClientAccountId)
      .map(cloneAccount);
  }

  public async get(clientId: string, accountId: string): Promise<Account | null> {
    const account = (this.data.get(clientId) ?? []).find((candidate) => candidate.id === accountId);
    return account ? cloneAccount(account) : null;
  }

  public async upsert(clientId: string, account: Account): Promise<void> {
    const accounts = this.data.get(clientId) ?? [];
    const index = accounts.findIndex((candidate) => candidate.id === account.id);
    const clone = cloneAccount(account);
    if (index >= 0) {
      accounts[index] = clone;
    } else {
      accounts.push(clone);
    }
    this.data.set(clientId, accounts);
    this.metadataGenerations.set(
      createMetadataGenerationKey(clientId, account.id),
      this.getStoredGeneration(clientId, account.id),
    );
  }

  public async remove(clientId: string, accountId: string): Promise<void> {
    const accounts = this.data.get(clientId);
    if (!accounts) return;
    this.data.set(
      clientId,
      accounts.filter((account) => account.id !== accountId),
    );
    this.metadataGenerations.delete(createMetadataGenerationKey(clientId, accountId));
  }

  public async getActive(clientId: string): Promise<Account | null> {
    const [account] = (this.data.get(clientId) ?? [])
      .filter((candidate) => candidate.active)
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt || right.id.localeCompare(left.id));
    return account ? cloneAccount(account) : null;
  }

  public async getActiveAtTimestamp(clientId: string, timestamp: number): Promise<string | null> {
    const rows = (this.timeline.get(clientId) ?? [])
      .filter((row) => row.effectiveAt <= timestamp)
      .sort((a, b) => b.effectiveAt - a.effectiveAt || b.sequence - a.sequence);
    return rows[0]?.toAccountId ?? null;
  }

  public async getLatestTimelineEntry(
    clientId: string,
    reason?: AccountTimelineReason,
  ): Promise<AccountTimelineEntry | null> {
    const rows = (this.timeline.get(clientId) ?? [])
      .filter((row) => reason === undefined || row.reason === reason)
      .sort((a, b) => b.effectiveAt - a.effectiveAt || b.sequence - a.sequence);
    if (!rows[0]) {
      return null;
    }
    const { sequence: _sequence, ...entry } = rows[0];
    return structuredClone(entry);
  }

  public async deactivateAll(clientId: string): Promise<void> {
    const accounts = this.data.get(clientId) ?? [];
    this.data.set(
      clientId,
      accounts.map((account) => ({
        ...cloneAccount(account),
        active: false,
      })),
    );
  }

  public async setLabel(clientId: string, accountId: string, label: string): Promise<Account | null> {
    const account = await this.get(clientId, accountId);
    if (!account) return null;
    const updated = { ...cloneAccount(account), label };
    await this.upsert(clientId, updated);
    return updated;
  }

  public async setLinkedClientAccountId(
    clientId: string,
    accountId: string,
    linkedClientAccountId: string | null,
  ): Promise<Account | null> {
    const account = await this.get(clientId, accountId);
    if (!account) return null;
    const updated =
      linkedClientAccountId === null
        ? omitLinkedClientAccountId(cloneAccount(account))
        : { ...cloneAccount(account), linkedClientAccountId };
    await this.upsert(clientId, updated);
    return updated;
  }

  public async getWithMetadataGeneration(
    clientId: string,
    accountId: string,
  ): Promise<{ account: Account; metadataGeneration: number } | null> {
    const account = await this.get(clientId, accountId);
    return account ? { account, metadataGeneration: this.getStoredGeneration(clientId, accountId) } : null;
  }

  public async getMetadataGeneration(clientId: string, accountId: string): Promise<number | null> {
    return this.hasAccount(clientId, accountId) ? this.getStoredGeneration(clientId, accountId) : null;
  }

  public async bumpMetadataGeneration(clientId: string, accountId: string): Promise<number | null> {
    if (!this.hasAccount(clientId, accountId)) return null;
    const nextGeneration = this.getStoredGeneration(clientId, accountId) + 1;
    this.metadataGenerations.set(createMetadataGenerationKey(clientId, accountId), nextGeneration);
    return nextGeneration;
  }

  public async patchMetadata(
    clientId: string,
    accountId: string,
    expectedGeneration: number,
    patches: Record<string, unknown>,
  ): Promise<Account | null> {
    const account = await this.get(clientId, accountId);
    if (!account) return null;
    if (this.getStoredGeneration(clientId, accountId) !== expectedGeneration) return null;
    const changed = metadataPatchChanges(account.metadata, patches);
    if (!changed) return account;
    const updated = {
      ...cloneAccount(account),
      metadata: applyJsonMergePatch(account.metadata, patches),
    };
    await this.upsert(clientId, updated);
    this.metadataGenerations.set(
      createMetadataGenerationKey(clientId, accountId),
      this.getStoredGeneration(clientId, accountId) + 1,
    );
    return updated;
  }

  public async appendTimeline(entry: AccountTimelineEntry): Promise<void> {
    const rows = this.timeline.get(entry.clientId) ?? [];
    rows.push({
      ...structuredClone(entry),
      sequence: this.nextTimelineSequence++,
    });
    this.timeline.set(entry.clientId, rows);
  }

  public async hasAnyAccounts(): Promise<boolean> {
    return [...this.data.values()].some((accounts) => accounts.length > 0);
  }

  public clear(): void {
    this.data.clear();
    this.timeline.clear();
    this.metadataGenerations.clear();
    this.nextTimelineSequence = 1;
  }

  private hasAccount(clientId: string, accountId: string): boolean {
    return (this.data.get(clientId) ?? []).some((candidate) => candidate.id === accountId);
  }

  private getStoredGeneration(clientId: string, accountId: string): number {
    return this.metadataGenerations.get(createMetadataGenerationKey(clientId, accountId)) ?? 0;
  }
}

/**
 * In-memory append-only usage snapshot store for tests.
 */
export class InMemoryAccountUsageSnapshotStore implements IAccountUsageSnapshotStore {
  private readonly entries = new Map<string, UsageEntry[]>();

  public async append(clientId: string, accountId: string, entry: UsageEntry): Promise<boolean> {
    const key = `${clientId}:${accountId}`;
    const rows = this.entries.get(key) ?? [];
    if (rows.some((candidate) => candidate.ts === entry.ts && candidate.windowId === entry.windowId)) {
      return false;
    }
    rows.push(structuredClone(entry));
    this.entries.set(key, rows);
    return true;
  }

  public async *read(
    clientId: string,
    accountId: string,
    opts: { from: number; to: number; windowId?: string },
  ): AsyncIterable<UsageEntry> {
    const rows = (this.entries.get(`${clientId}:${accountId}`) ?? [])
      .filter((entry) => entry.ts >= opts.from && entry.ts <= opts.to)
      .filter((entry) => opts.windowId === undefined || entry.windowId === opts.windowId)
      .sort((a, b) => a.ts - b.ts);
    for (const row of rows) {
      yield structuredClone(row);
    }
  }

  public async hasAnySnapshots(): Promise<boolean> {
    return [...this.entries.values()].some((entries) => entries.length > 0);
  }

  public clear(): void {
    this.entries.clear();
  }
}

/**
 * Joined in-memory account store bundle for tests.
 */
export class InMemoryAccountStore {
  public readonly credentialStore = new InMemoryAccountCredentialStore();
  public readonly metadataStore = new InMemoryAccountMetadataStore();
  public readonly usageSnapshotStore = new InMemoryAccountUsageSnapshotStore();

  public async list(clientId: string): Promise<StoredAccount[]> {
    return listStoredAccounts(this.metadataStore, this.credentialStore, clientId);
  }

  public async get(clientId: string, accountId: string): Promise<StoredAccount | null> {
    return getStoredAccount(this.metadataStore, this.credentialStore, clientId, accountId);
  }

  public async upsert(clientId: string, account: StoredAccount): Promise<void> {
    await upsertStoredAccount(this.metadataStore, this.credentialStore, clientId, account);
  }

  public async remove(clientId: string, accountId: string): Promise<void> {
    await removeStoredAccount(this.metadataStore, this.credentialStore, clientId, accountId);
  }

  public clear(): void {
    this.credentialStore.clear();
    this.metadataStore.clear();
    this.usageSnapshotStore.clear();
  }
}

function cloneAccount(account: Account): Account {
  return structuredClone(account);
}

function omitLinkedClientAccountId(account: Account): Account {
  const { linkedClientAccountId: _linkedClientAccountId, ...rest } = account;
  return rest;
}

function cloneCredential(account: StoredAccountCredential): StoredAccountCredential {
  return structuredClone(account);
}

function createMetadataGenerationKey(clientId: string, accountId: string): string {
  return `${clientId}:${accountId}`;
}
