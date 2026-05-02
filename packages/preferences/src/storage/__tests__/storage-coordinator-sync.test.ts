import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { StorageCoordinator } from '../storage-coordinator.js';
import type { PreferenceKey } from '@makaio/services-core/preferences';
import type { StoredPreference } from '../types.js';
import { createLocalStorageMock, createPreferencesTestDb } from './test-helpers.js';

describe('StorageCoordinator sync behavior', () => {
  let db: Awaited<ReturnType<typeof createPreferencesTestDb>>['db'];
  let close: Awaited<ReturnType<typeof createPreferencesTestDb>>['close'] = () => {};
  let coordinator: StorageCoordinator;
  let mockStorage: Map<string, string>;

  beforeEach(async () => {
    ({ db, close } = await createPreferencesTestDb());

    const localStorageMock = createLocalStorageMock();
    mockStorage = localStorageMock.backingStore;
    globalThis.localStorage = localStorageMock.storage;

    coordinator = new StorageCoordinator({ db });
  });

  afterEach(() => {
    close();
  });

  it('uses legacy localStorage when database is missing and syncs to database', async () => {
    const key: PreferenceKey = { scope: 'global' };
    const category = 'theme';
    const value = { color: 'dark' };
    const stored: StoredPreference = { value: JSON.stringify(value), updatedAt: 0 };
    const storageKey = 'makaio:prefs:global:any:any:any:theme';

    mockStorage.set(storageKey, JSON.stringify(stored));

    const result = await coordinator.get(key, category);

    expect(result).toEqual(value);

    const row = await db.get<{ value: string; updated_at: number }>(
      sql`SELECT value, updated_at FROM preferences WHERE scope = 'global' AND category = 'theme'`,
    );
    expect(row).toBeDefined();
    expect(row?.value).toBe(JSON.stringify(value));
    expect(row?.updated_at).toBe(0);
  });

  it('prefers database when it is newer and refreshes localStorage', async () => {
    const key: PreferenceKey = { scope: 'global' };
    const category = 'theme';
    const dbValue = { color: 'db' };
    const localValue = { color: 'local' };
    const storageKey = 'makaio:prefs:global:any:any:any:theme';

    await db.run(sql`
      INSERT INTO preferences (scope, surface, context, viewport, category, value, updated_at)
      VALUES ('global', 'any', 'any', 'any', 'theme', ${JSON.stringify(dbValue)}, 2000)
    `);

    const stored: StoredPreference = { value: JSON.stringify(localValue), updatedAt: 1000 };
    mockStorage.set(storageKey, JSON.stringify(stored));

    const result = await coordinator.get(key, category);

    expect(result).toEqual(dbValue);

    const storedInLocal = JSON.parse(mockStorage.get(storageKey)!) as StoredPreference;
    expect(storedInLocal.value).toBe(JSON.stringify(dbValue));
    expect(storedInLocal.updatedAt).toBe(2000);
  });

  it('ignores non-legacy localStorage when database is missing and clears localStorage', async () => {
    const key: PreferenceKey = { scope: 'global' };
    const category = 'theme';
    const localValue = { color: 'local' };
    const storageKey = 'makaio:prefs:global:any:any:any:theme';

    const stored: StoredPreference = { value: JSON.stringify(localValue), updatedAt: 2000 };
    mockStorage.set(storageKey, JSON.stringify(stored));

    const result = await coordinator.get(key, category);

    expect(result).toBeNull();
    expect(mockStorage.has(storageKey)).toBe(false);
  });
});
