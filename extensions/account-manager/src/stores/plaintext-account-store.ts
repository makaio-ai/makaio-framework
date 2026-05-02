import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { IAccountCredentialStore, StoredAccountCredential } from '../interfaces/account-store.js';
import {
  type CredentialStoreData,
  cloneStoredAccountCredential,
  normalizeCredentialStoreData,
} from './account-store-normalization.js';

/**
 * File-based account store with no encryption.
 *
 * Stores accounts as plaintext JSON at the path provided to the constructor,
 * with `0o600` file permissions. Suitable for Linux and Windows where the
 * AI tools themselves also store credentials in plaintext.
 */
export class PlaintextAccountStore implements IAccountCredentialStore {
  private writeChain: Promise<void> = Promise.resolve();

  /**
   * @param storePath - Absolute path to the persisted JSON store file.
   */
  public constructor(private readonly storePath: string) {}

  /**
   * Lists all accounts for a client.
   * @param clientId - The client identifier
   * @returns Array of stored accounts
   */
  public async list(clientId: string): Promise<StoredAccountCredential[]> {
    const data = await this.loadCredentials();
    return (data[clientId] ?? []).map(cloneStoredAccountCredential);
  }

  /**
   * Stores or updates an account.
   * @param clientId - The client identifier
   * @param account - The account to upsert
   */
  public async upsert(clientId: string, account: StoredAccountCredential): Promise<void> {
    // The load/modify/save sequence lives entirely inside the lock so each
    // mutation works from one serialized snapshot.
    await this.withWriteLock(async () => {
      const data = await this.loadCredentials();
      const accounts = data[clientId] ?? [];
      const index = accounts.findIndex((a) => a.id === account.id);
      if (index >= 0) {
        accounts[index] = account;
      } else {
        accounts.push(account);
      }
      data[clientId] = accounts;
      await this.saveRaw(data);
    });
  }

  /**
   * Removes an account.
   * @param clientId - The client identifier
   * @param accountId - The account ID to remove
   */
  public async remove(clientId: string, accountId: string): Promise<void> {
    // The load/modify/save sequence lives entirely inside the lock so each
    // mutation works from one serialized snapshot.
    await this.withWriteLock(async () => {
      const data = await this.loadCredentials();
      const accounts = data[clientId];
      if (!accounts) return;
      data[clientId] = accounts.filter((a) => a.id !== accountId);
      await this.saveRaw(data);
    });
  }

  /**
   * Retrieves a single account by ID.
   * @param clientId - The client identifier
   * @param accountId - The account ID to find
   * @returns The account, or null if not found
   */
  public async get(clientId: string, accountId: string): Promise<StoredAccountCredential | null> {
    const data = await this.loadCredentials();
    const accounts = data[clientId] ?? [];
    const found = accounts.find((a) => a.id === accountId);
    return found ? cloneStoredAccountCredential(found) : null;
  }

  /**
   * Loads the store data from disk.
   *
   * Only treats `ENOENT` (file not found) as an empty store. All other
   * errors (e.g. JSON parse failures, permission errors) are rethrown so
   * callers surface the real problem rather than silently losing data.
   * @returns The parsed store data, or an empty object if the file doesn't exist
   */
  private async loadRaw(): Promise<unknown> {
    try {
      const raw = await readFile(this.storePath, 'utf-8');
      return JSON.parse(raw) as unknown;
    } catch (error) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {};
      }
      throw error;
    }
  }

  private async loadCredentials(): Promise<CredentialStoreData> {
    return normalizeCredentialStoreData(await this.loadRaw());
  }

  /**
   * Saves the store data to disk atomically.
   *
   * Writes to a `.tmp` sibling file first, then renames to the final path
   * to prevent partial writes from corrupting the store.
   * @param data - The store data to persist
   */
  private async saveRaw(data: Record<string, unknown>): Promise<void> {
    const storeDir = dirname(this.storePath);
    await mkdir(storeDir, { recursive: true, mode: 0o700 });
    const tmpPath = `${this.storePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
      await rename(tmpPath, this.storePath);
    } finally {
      await rm(tmpPath, { force: true }).catch(() => undefined);
    }
  }

  /**
   * Serializes the read-modify-write cycle so concurrent mutations do not
   * overwrite each other's snapshots within the same process.
   * @param mutate - Mutation work to run exclusively
   * @returns The mutation result
   */
  private async withWriteLock<T>(mutate: () => Promise<T>): Promise<T> {
    const previous = this.writeChain;
    let release!: () => void;
    this.writeChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await mutate();
    } finally {
      release();
    }
  }
}
