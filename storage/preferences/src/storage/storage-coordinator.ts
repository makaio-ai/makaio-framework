import { resolveSchema, type MakaioDatabase } from '@makaio/storage-drizzle';
import { eq, and } from 'drizzle-orm';
import { PreferenceValueSchema, type PreferenceKey, type PreferenceItem } from '@makaio/services-core/preferences';
import type { StoredPreference } from './types.js';
import type { ConflictResolver } from './conflict-resolvers.js';
import { lastWriteWinsResolver } from './conflict-resolvers.js';
import { getStorageKey, parseStoredPreference, keyToRow } from './utils-common.js';
import { queryPreferenceItems, getPreferenceRow } from './utils-drizzle.js';
import { preferencesSchema } from './schema.variants.js';

/**
 * Configuration for hybrid storage coordinator.
 */
export interface StorageCoordinatorConfig {
  /** Drizzle database instance */
  db: MakaioDatabase<Record<string, unknown>>;
  /** Optional conflict resolution strategy (default: last-write-wins) */
  conflictResolver?: ConflictResolver;
}

/**
 * Coordinates preference storage across browser localStorage and database backends.
 *
 * Read strategy: Database (source of truth)
 * Write strategy: Write to both, sync immediately
 * Conflict resolution: Last-write wins (timestamp comparison)
 */
export class StorageCoordinator {
  private db: MakaioDatabase<Record<string, unknown>>;
  private conflictResolver: ConflictResolver;

  /**
   * Creates a new StorageCoordinator instance.
   * @param config - Configuration for the coordinator
   */
  public constructor(config: StorageCoordinatorConfig) {
    this.db = config.db;
    this.conflictResolver = config.conflictResolver ?? lastWriteWinsResolver;
  }

  /**
   * Reads preference from database (source of truth).
   * @param key - Preference key
   * @param category - Preference category
   * @returns Preference value or null if not found
   */
  public async get(key: PreferenceKey, category: string): Promise<unknown | null> {
    const database = await this.readFromDb(key, category);
    const local = this.readFromLocalStorage(key, category);
    const localCandidate = local?.updatedAt === 0 ? local : null;

    if (!database && local && !localCandidate) {
      this.removeFromLocalStorage(key, category);
    }

    const resolved = this.conflictResolver.resolve(localCandidate, database);
    if (!resolved) {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(resolved.value);
    } catch {
      return null;
    }

    const parsedResult = PreferenceValueSchema.safeParse(parsed);
    if (!parsedResult.success) {
      return null;
    }

    await this.syncResolvedPreference(key, category, resolved, local, database);
    return parsedResult.data;
  }

  /**
   * Writes preference to both backends.
   * @param key - Preference key
   * @param category - Preference category
   * @param value - Value to store
   */
  public async set(key: PreferenceKey, category: string, value: unknown): Promise<void> {
    const timestamp = Date.now();
    const serialized = JSON.stringify(value ?? null);

    // 1. Write to localStorage (sync, fast) - with error tolerance
    this.writeToLocalStorage(key, category, { value: serialized, updatedAt: timestamp });

    // 2. Write to database (async, durable) - must succeed
    await this.writeToDb(key, category, serialized, timestamp);
  }

  /**
   * Deletes preference from both backends.
   * @param key - Preference key
   * @param category - Preference category
   */
  public async delete(key: PreferenceKey, category: string): Promise<void> {
    // 1. Delete from localStorage (sync, fast) - with error tolerance
    this.removeFromLocalStorage(key, category);

    // 2. Delete from database (async, durable) - must succeed
    await this.deleteFromDb(key, category);
  }

  /**
   * Lists preferences matching criteria from database.
   * @param keyFilter - Optional partial key filter
   * @param categoryFilter - Optional category filter
   * @returns Array of matching preference items
   */
  public async list(keyFilter?: Partial<PreferenceKey>, categoryFilter?: string): Promise<PreferenceItem[]> {
    return queryPreferenceItems(this.db, keyFilter, categoryFilter);
  }

  /**
   * Writes preference to database using upsert.
   * @param key - Preference key
   * @param category - Preference category
   * @param value - JSON-serialized value
   * @param timestamp - Unix timestamp in milliseconds
   */
  private async writeToDb(key: PreferenceKey, category: string, value: string, timestamp: number): Promise<void> {
    const { preferences } = resolveSchema(this.db, preferencesSchema);
    const rowKey = keyToRow(key);

    await this.db
      .insert(preferences)
      .values({
        ...rowKey,
        category,
        value,
        updatedAt: timestamp,
      })
      .onConflictDoUpdate({
        target: [
          preferences.scope,
          preferences.surface,
          preferences.context,
          preferences.viewport,
          preferences.category,
        ],
        set: {
          value,
          updatedAt: timestamp,
        },
      });
  }

  /**
   * Reads preference from localStorage (if available).
   * @param key - Preference key
   * @param category - Preference category
   * @returns StoredPreference or null if missing/invalid
   */
  private readFromLocalStorage(key: PreferenceKey, category: string): StoredPreference | null {
    const storageKey = getStorageKey(key, category);
    const raw = globalThis.localStorage?.getItem(storageKey);
    if (!raw) {
      return null;
    }

    return parseStoredPreference(raw);
  }

  /**
   * Writes preference to localStorage (best-effort).
   * @param key - Preference key
   * @param category - Preference category
   * @param stored - StoredPreference value
   */
  private writeToLocalStorage(key: PreferenceKey, category: string, stored: StoredPreference): void {
    const storageKey = getStorageKey(key, category);
    try {
      globalThis.localStorage?.setItem(storageKey, JSON.stringify(stored));
    } catch (err) {
      console.warn('[StorageCoordinator] localStorage write failed:', err);
    }
  }

  /**
   * Removes preference from localStorage (best-effort).
   * @param key - Preference key
   * @param category - Preference category
   */
  private removeFromLocalStorage(key: PreferenceKey, category: string): void {
    const storageKey = getStorageKey(key, category);
    try {
      globalThis.localStorage?.removeItem(storageKey);
    } catch (err) {
      console.warn('[StorageCoordinator] localStorage delete failed:', err);
    }
  }

  /**
   * Syncs resolved preference across backends when needed.
   * @param key - Preference key
   * @param category - Preference category
   * @param resolved - Winning preference
   * @param local - LocalStorage preference (if any)
   * @param database - Database preference (if any)
   */
  private async syncResolvedPreference(
    key: PreferenceKey,
    category: string,
    resolved: StoredPreference,
    local: StoredPreference | null,
    database: StoredPreference | null,
  ): Promise<void> {
    if (!this.isSameStoredPreference(resolved, database)) {
      await this.writeToDb(key, category, resolved.value, resolved.updatedAt);
    }

    if (local && !this.isSameStoredPreference(resolved, local)) {
      this.writeToLocalStorage(key, category, resolved);
    }
  }

  /**
   * Checks if two StoredPreference values are identical.
   * @param left - First preference
   * @param right - Second preference
   * @returns True if both match by value + timestamp
   */
  private isSameStoredPreference(left: StoredPreference | null, right: StoredPreference | null): boolean {
    if (!left || !right) {
      return false;
    }

    return left.value === right.value && left.updatedAt === right.updatedAt;
  }

  /**
   * Reads preference from database.
   * @param key - Preference key
   * @param category - Preference category
   * @returns StoredPreference format or null if not found
   */
  private async readFromDb(key: PreferenceKey, category: string): Promise<StoredPreference | null> {
    const row = await getPreferenceRow(this.db, key, category);

    if (!row) {
      return null;
    }

    return {
      value: row.value,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Deletes preference from database.
   * @param key - Preference key
   * @param category - Preference category
   */
  private async deleteFromDb(key: PreferenceKey, category: string): Promise<void> {
    const { preferences } = resolveSchema(this.db, preferencesSchema);
    const rowKey = keyToRow(key);

    // Awaiting the Drizzle builder executes the statement (builders are QueryPromise thenables on
    // every dialect); no driver-specific terminal such as `.run()` is needed.
    await this.db
      .delete(preferences)
      .where(
        and(
          eq(preferences.scope, rowKey.scope),
          eq(preferences.surface, rowKey.surface),
          eq(preferences.context, rowKey.context),
          eq(preferences.viewport, rowKey.viewport),
          eq(preferences.category, category),
        ),
      );
  }
}
