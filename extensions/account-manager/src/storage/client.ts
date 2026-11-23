import type { IMakaioBus } from '@makaio/bus-core';
import type { CallContext } from '@makaio/core';
import type { Account } from '../bus/schemas.js';
import type { UsageEntry } from '../bus/usage-entry.js';
import type {
  AccountTimelineEntry,
  AccountTimelineReason,
  IAccountMetadataStore,
  IAccountUsageSnapshotStore,
} from '../interfaces/account-store.js';
import { AccountManagerStorageSubjects } from './namespace.js';

/**
 * Bus-backed account metadata store client.
 */
export class BusAccountMetadataStore implements IAccountMetadataStore {
  public constructor(private readonly bus: IMakaioBus) {}

  public async list(call: CallContext, clientId: string): Promise<Account[]> {
    const { accounts } = await this.bus.request(call, AccountManagerStorageSubjects.metadata.list, { clientId });
    return accounts;
  }

  public async listByLinkedClientAccountId(
    call: CallContext,
    clientId: string,
    linkedClientAccountId: string,
  ): Promise<Account[]> {
    const { accounts } = await this.bus.request(
      call,
      AccountManagerStorageSubjects.metadata.listByLinkedClientAccountId,
      {
        clientId,
        linkedClientAccountId,
      },
    );
    return accounts;
  }

  public async get(call: CallContext, clientId: string, accountId: string): Promise<Account | null> {
    const { account } = await this.bus.request(call, AccountManagerStorageSubjects.metadata.get, {
      clientId,
      accountId,
    });
    return account;
  }

  public async getWithMetadataGeneration(
    call: CallContext,
    clientId: string,
    accountId: string,
  ): Promise<{ account: Account; metadataGeneration: number } | null> {
    const result = await this.bus.request(call, AccountManagerStorageSubjects.metadata.getWithMetadataGeneration, {
      clientId,
      accountId,
    });
    return result.account && result.metadataGeneration !== null
      ? { account: result.account, metadataGeneration: result.metadataGeneration }
      : null;
  }

  public async upsert(call: CallContext, clientId: string, account: Account): Promise<void> {
    await this.bus.request(call, AccountManagerStorageSubjects.metadata.upsert, { clientId, account });
  }

  public async remove(call: CallContext, clientId: string, accountId: string): Promise<void> {
    await this.bus.request(call, AccountManagerStorageSubjects.metadata.remove, { clientId, accountId });
  }

  public async getActive(call: CallContext, clientId: string): Promise<Account | null> {
    const { account } = await this.bus.request(call, AccountManagerStorageSubjects.metadata.getActive, { clientId });
    return account;
  }

  public async getActiveAtTimestamp(call: CallContext, clientId: string, timestamp: number): Promise<string | null> {
    const { accountId } = await this.bus.request(call, AccountManagerStorageSubjects.metadata.getActiveAtTimestamp, {
      clientId,
      timestamp,
    });
    return accountId;
  }

  public async getLatestTimelineEntry(
    call: CallContext,
    clientId: string,
    reason?: AccountTimelineReason,
  ): Promise<AccountTimelineEntry | null> {
    const { entry } = await this.bus.request(call, AccountManagerStorageSubjects.metadata.getLatestTimelineEntry, {
      clientId,
      reason,
    });
    return entry;
  }

  public async deactivateAll(call: CallContext, clientId: string): Promise<void> {
    await this.bus.request(call, AccountManagerStorageSubjects.metadata.deactivateAll, { clientId });
  }

  public async setLabel(
    call: CallContext,
    clientId: string,
    accountId: string,
    label: string,
  ): Promise<Account | null> {
    const { account } = await this.bus.request(call, AccountManagerStorageSubjects.metadata.setLabel, {
      clientId,
      accountId,
      label,
    });
    return account;
  }

  public async setLinkedClientAccountId(
    call: CallContext,
    clientId: string,
    accountId: string,
    linkedClientAccountId: string | null,
  ): Promise<Account | null> {
    const { account } = await this.bus.request(call, AccountManagerStorageSubjects.metadata.setLinkedClientAccountId, {
      clientId,
      accountId,
      linkedClientAccountId,
    });
    return account;
  }

  public async getMetadataGeneration(call: CallContext, clientId: string, accountId: string): Promise<number | null> {
    const result = await this.bus.requestOptional(call, AccountManagerStorageSubjects.metadata.getMetadataGeneration, {
      clientId,
      accountId,
    });
    return result.handled ? result.data.generation : null;
  }

  public async bumpMetadataGeneration(call: CallContext, clientId: string, accountId: string): Promise<number | null> {
    const result = await this.bus.requestOptional(call, AccountManagerStorageSubjects.metadata.bumpMetadataGeneration, {
      clientId,
      accountId,
    });
    return result.handled ? result.data.generation : null;
  }

  public async patchMetadata(
    call: CallContext,
    clientId: string,
    accountId: string,
    expectedGeneration: number,
    patches: Record<string, unknown>,
  ): Promise<Account | null> {
    const { account } = await this.bus.request(call, AccountManagerStorageSubjects.metadata.patchMetadata, {
      clientId,
      accountId,
      expectedGeneration,
      patches,
    });
    return account;
  }

  public async appendTimeline(call: CallContext, entry: AccountTimelineEntry): Promise<void> {
    await this.bus.request(call, AccountManagerStorageSubjects.metadata.appendTimeline, entry);
  }

  public async hasAnyAccounts(call: CallContext): Promise<boolean> {
    const { hasAnyAccounts } = await this.bus.request(call, AccountManagerStorageSubjects.metadata.hasAnyAccounts, {});
    return hasAnyAccounts;
  }
}

/**
 * Bus-backed append-only usage snapshot store client.
 */
export class BusAccountUsageSnapshotStore implements IAccountUsageSnapshotStore {
  public constructor(private readonly bus: IMakaioBus) {}

  public async append(call: CallContext, clientId: string, accountId: string, entry: UsageEntry): Promise<boolean> {
    const { persisted } = await this.bus.request(call, AccountManagerStorageSubjects.snapshots.append, {
      clientId,
      accountId,
      entry,
    });
    return persisted;
  }

  public async *read(
    call: CallContext,
    clientId: string,
    accountId: string,
    opts: { from: number; to: number; windowId?: string },
  ): AsyncIterable<UsageEntry> {
    const { entries } = await this.bus.request(call, AccountManagerStorageSubjects.snapshots.read, {
      clientId,
      accountId,
      ...opts,
    });
    for (const entry of entries) {
      yield entry;
    }
  }

  public async hasAnySnapshots(call: CallContext): Promise<boolean> {
    const { hasAnySnapshots } = await this.bus.request(
      call,
      AccountManagerStorageSubjects.snapshots.hasAnySnapshots,
      {},
    );
    return hasAnySnapshots;
  }
}
