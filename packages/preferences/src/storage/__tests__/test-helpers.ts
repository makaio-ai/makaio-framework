import { sql } from 'drizzle-orm';
import { createDatabaseClient } from '@makaio/storage-drizzle/client';
import type { MakaioDatabase } from '@makaio/storage-drizzle';

export interface PreferencesTestDbContext {
  db: MakaioDatabase;
  close: () => void;
}

export interface LocalStorageMock {
  storage: Storage;
  backingStore: Map<string, string>;
}

/**
 * Creates an in-memory SQLite database with the preferences table initialized.
 * @returns Database context with db and close function
 */
export async function createPreferencesTestDb(): Promise<PreferencesTestDbContext> {
  const { db, close } = await createDatabaseClient({ url: ':memory:' });

  await db.run(sql`
    CREATE TABLE IF NOT EXISTS preferences (
      scope TEXT NOT NULL,
      surface TEXT NOT NULL DEFAULT 'any',
      context TEXT NOT NULL DEFAULT 'any',
      viewport TEXT NOT NULL DEFAULT 'any',
      category TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  await db.run(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS preferences_pk
    ON preferences(scope, surface, context, viewport, category)
  `);

  return { db, close };
}

/**
 * Creates a localStorage mock backed by a Map.
 * @returns Storage mock with backing Map
 */
export function createLocalStorageMock(): LocalStorageMock {
  const backingStore = new Map<string, string>();
  const storage = {
    getItem: (key: string) => backingStore.get(key) ?? null,
    setItem: (key: string, value: string) => backingStore.set(key, value),
    removeItem: (key: string) => backingStore.delete(key),
    clear: () => backingStore.clear(),
    key: (index: number) => Array.from(backingStore.keys())[index] ?? null,
    get length() {
      return backingStore.size;
    },
  } as Storage;

  return { storage, backingStore };
}
