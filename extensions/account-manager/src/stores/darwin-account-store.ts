import { randomBytes, createCipheriv, createDecipheriv, randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { IAccountCredentialStore, StoredAccountCredential } from '../interfaces/account-store.js';
import { keychainRead, keychainWrite } from '../utils/security-cli.js';
import {
  type CredentialStoreData,
  cloneStoredAccountCredential,
  normalizeCredentialStoreData,
} from './account-store-normalization.js';

const KEYCHAIN_SERVICE = 'makaio-account-manager';
const KEYCHAIN_ACCOUNT = 'encryption-key';
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Encrypted account store for macOS.
 *
 * Uses AES-256-GCM encryption with the key stored in the macOS keychain
 * (service: "makaio-account-manager", account: "encryption-key").
 * Account data is stored as an encrypted file at the path provided to the constructor.
 *
 * The encryption key is generated on first use and persisted in the keychain.
 */
export class DarwinAccountStore implements IAccountCredentialStore {
  /** Cached key after first successful resolution. */
  private key: Buffer | null = null;
  /** In-flight key resolution for concurrent first-use callers. */
  private keyPromise: Promise<Buffer> | null = null;
  /** Serializes read-modify-write mutations within this process. */
  private writeChain: Promise<void> = Promise.resolve();

  /**
   * @param storePath - Absolute path to the encrypted store file.
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
   * Gets the existing AES-256 encryption key for read-only flows.
   *
   * Read-only operations must not create keychain state. When ciphertext exists
   * but the key is missing, that is a real store corruption/configuration error
   * and should surface to the caller.
   * @returns The existing encryption key
   */
  private async getExistingKey(): Promise<Buffer> {
    if (this.key) {
      return this.key;
    }

    const existing = await keychainRead(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    if (!existing) {
      throw new Error('Encryption key is missing for the existing account-manager store');
    }

    this.key = Buffer.from(existing, 'hex');
    return this.key;
  }

  /**
   * Gets or creates the AES-256 encryption key.
   *
   * On first use, generates a random key and stores it in the macOS keychain
   * as a hex string. Subsequent calls retrieve and decode the stored key.
   *
   * The result is memoized as a Promise so concurrent callers on a fresh store
   * share a single keychain write rather than racing to generate different keys.
   * @returns The encryption key as a Buffer
   */
  private async getOrCreateKey(): Promise<Buffer> {
    if (this.key) {
      return this.key;
    }

    this.keyPromise ??= (async () => {
      try {
        const existing = await keychainRead(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
        if (existing) {
          this.key = Buffer.from(existing, 'hex');
          return this.key;
        }
        const key = randomBytes(KEY_LENGTH);
        await keychainWrite(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, key.toString('hex'));
        this.key = key;
        return key;
      } finally {
        // Clear the in-flight promise on both success and failure so later
        // callers reuse `this.key` or retry keychain access cleanly.
        this.keyPromise = null;
      }
    })();
    return this.keyPromise;
  }

  /**
   * Encrypts plaintext using AES-256-GCM.
   * @param plaintext - The string to encrypt
   * @param key - The 32-byte encryption key
   * @returns Buffer containing [IV (12 bytes)][AuthTag (16 bytes)][Ciphertext]
   */
  private encrypt(plaintext: string, key: Buffer): Buffer {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, encrypted]);
  }

  /**
   * Decrypts data using AES-256-GCM.
   * @param data - Buffer containing [IV (12 bytes)][AuthTag (16 bytes)][Ciphertext]
   * @param key - The 32-byte encryption key
   * @returns The decrypted plaintext string
   */
  private decrypt(data: Buffer, key: Buffer): string {
    const iv = data.subarray(0, IV_LENGTH);
    const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8');
  }

  /**
   * Loads and decrypts the store data from disk.
   *
   * Key/crypto errors propagate (locked keychain, corrupt key) — only
   * "file not found" is treated as an empty store (first-run).
   * @returns The parsed store data, or an empty object if the file doesn't exist
   */
  private async loadRaw(): Promise<unknown> {
    try {
      const raw = await readFile(this.storePath);
      const key = await this.getExistingKey();
      const plaintext = this.decrypt(raw, key);
      return JSON.parse(plaintext) as unknown;
    } catch (error) {
      // File not found is expected on first run
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
   * Encrypts and saves the store data to disk atomically.
   *
   * Writes to a `.tmp` sibling file first, then renames to avoid a partial
   * write leaving the store in a corrupt state if the process is interrupted.
   * @param data - The store data to persist
   */
  private async saveRaw(data: Record<string, unknown>): Promise<void> {
    const key = await this.getOrCreateKey();
    const plaintext = JSON.stringify(data);
    const encrypted = this.encrypt(plaintext, key);
    const storeDir = dirname(this.storePath);
    await mkdir(storeDir, { recursive: true, mode: 0o700 });
    const tmpPath = `${this.storePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmpPath, encrypted, { mode: 0o600 });
      await rename(tmpPath, this.storePath);
    } finally {
      await rm(tmpPath, { force: true }).catch(() => undefined);
    }
  }

  /**
   * Serializes the full mutation sequence so concurrent service workflows do
   * not load, mutate, and save divergent snapshots within the same process.
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
