import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { getRawSqlExecutor } from '@makaio/storage-drizzle';
import { StorageCoordinator } from '../storage-coordinator.js';
import type { PreferenceKey } from '@makaio/services-core/preferences';
import { createLocalStorageMock, createPreferencesTestDb } from './test-helpers.js';

describe('StorageCoordinator', () => {
  let db: Awaited<ReturnType<typeof createPreferencesTestDb>>['db'];
  let close: Awaited<ReturnType<typeof createPreferencesTestDb>>['close'];
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

  describe('get', () => {
    it('returns value from database', async () => {
      const key: PreferenceKey = { scope: 'global' };
      const category = 'theme';
      const value = { color: 'dark' };

      await coordinator.set(key, category, value);
      const result = await coordinator.get(key, category);

      expect(result).toEqual(value);
    });

    it('returns null for missing preference', async () => {
      const key: PreferenceKey = { scope: 'global' };
      const result = await coordinator.get(key, 'missing');

      expect(result).toBeNull();
    });

    it('handles JSON parse errors gracefully', async () => {
      const key: PreferenceKey = { scope: 'global' };
      const category = 'broken';

      // Insert invalid JSON directly into database
      await getRawSqlExecutor(db).run(sql`
        INSERT INTO preferences (scope, surface, context, viewport, category, value, updated_at)
        VALUES ('global', 'any', 'any', 'any', 'broken', 'invalid json{', ${Date.now()})
      `);

      const result = await coordinator.get(key, category);
      expect(result).toBeNull();
    });

    it('reads from database with all key components', async () => {
      const key: PreferenceKey = {
        scope: 'project-123',
        surface: 'ui',
        context: 'chat',
        viewport: 'desktop',
      };
      const category = 'layout';
      const value = { width: 800 };

      await coordinator.set(key, category, value);
      const result = await coordinator.get(key, category);

      expect(result).toEqual(value);
    });
  });

  describe('set', () => {
    it('writes to both localStorage and database', async () => {
      const key: PreferenceKey = { scope: 'global' };
      const category = 'theme';
      const value = { color: 'dark' };

      await coordinator.set(key, category, value);

      // Check localStorage
      const storageKey = 'makaio:prefs:global:any:any:any:theme';
      const storedInLS = mockStorage.get(storageKey);
      expect(storedInLS).toBeDefined();
      const parsed = JSON.parse(storedInLS!);
      expect(JSON.parse(parsed.value)).toEqual(value);

      // Check database
      const result = await coordinator.get(key, category);
      expect(result).toEqual(value);
    });

    it('continues when localStorage fails and logs warning', async () => {
      const key: PreferenceKey = { scope: 'global' };
      const category = 'theme';
      const value = { color: 'dark' };

      // Mock localStorage to throw
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const originalLocalStorage = globalThis.localStorage;
      Object.defineProperty(globalThis, 'localStorage', {
        value: {
          ...originalLocalStorage,
          setItem: () => {
            throw new Error('localStorage full');
          },
        },
        writable: true,
        configurable: true,
      });

      // Should not throw
      await coordinator.set(key, category, value);

      // Should log warning
      expect(consoleWarnSpy).toHaveBeenCalledWith('[StorageCoordinator] localStorage write failed:', expect.any(Error));

      // Database should still have value
      const result = await coordinator.get(key, category);
      expect(result).toEqual(value);

      consoleWarnSpy.mockRestore();
    });

    it('throws when database write fails', async () => {
      const key: PreferenceKey = { scope: 'global' };
      const category = 'theme';
      const value = { color: 'dark' };

      // Close the database to cause failure
      close();

      await expect(coordinator.set(key, category, value)).rejects.toThrow();
    });

    it('updates existing preference', async () => {
      const key: PreferenceKey = { scope: 'global' };
      const category = 'theme';

      await coordinator.set(key, category, { color: 'dark' });
      await coordinator.set(key, category, { color: 'light' });

      const result = await coordinator.get(key, category);
      expect(result).toEqual({ color: 'light' });
    });

    it('stores timestamp with preference', async () => {
      const key: PreferenceKey = { scope: 'global' };
      const category = 'theme';
      const value = { color: 'dark' };
      const beforeWrite = Date.now();

      await coordinator.set(key, category, value);

      const afterWrite = Date.now();

      // Check database timestamp by querying directly
      const [result] = await getRawSqlExecutor(db).all<{ updated_at: number }>(
        sql`SELECT updated_at FROM preferences WHERE scope = 'global' AND category = 'theme'`,
      );

      expect(result).toBeDefined();
      const timestamp = result!.updated_at;
      expect(timestamp).toBeGreaterThanOrEqual(beforeWrite);
      expect(timestamp).toBeLessThanOrEqual(afterWrite);
    });
  });

  describe('delete', () => {
    it('removes from both backends', async () => {
      const key: PreferenceKey = { scope: 'global' };
      const category = 'theme';
      const value = { color: 'dark' };

      await coordinator.set(key, category, value);
      await coordinator.delete(key, category);

      // Check localStorage
      const storageKey = 'makaio:prefs:global:any:any:any:theme';
      expect(mockStorage.has(storageKey)).toBe(false);

      // Check database
      const result = await coordinator.get(key, category);
      expect(result).toBeNull();
    });

    it('continues when localStorage fails and logs warning', async () => {
      const key: PreferenceKey = { scope: 'global' };
      const category = 'theme';
      const value = { color: 'dark' };

      await coordinator.set(key, category, value);

      // Mock localStorage to throw
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const originalLocalStorage = globalThis.localStorage;
      Object.defineProperty(globalThis, 'localStorage', {
        value: {
          ...originalLocalStorage,
          removeItem: () => {
            throw new Error('localStorage error');
          },
        },
        writable: true,
        configurable: true,
      });

      // Should not throw
      await coordinator.delete(key, category);

      // Should log warning
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '[StorageCoordinator] localStorage delete failed:',
        expect.any(Error),
      );

      // Database should still be deleted
      const result = await coordinator.get(key, category);
      expect(result).toBeNull();

      consoleWarnSpy.mockRestore();
    });

    it('deletes only matching preference', async () => {
      const key1: PreferenceKey = { scope: 'global' };
      const key2: PreferenceKey = { scope: 'project-123' };
      const category = 'theme';

      await coordinator.set(key1, category, { color: 'dark' });
      await coordinator.set(key2, category, { color: 'light' });

      await coordinator.delete(key1, category);

      expect(await coordinator.get(key1, category)).toBeNull();
      expect(await coordinator.get(key2, category)).toEqual({ color: 'light' });
    });
  });

  describe('list', () => {
    beforeEach(async () => {
      // Set up test data
      await coordinator.set({ scope: 'global' }, 'theme', { color: 'dark' });
      await coordinator.set({ scope: 'global' }, 'layout', { width: 800 });
      await coordinator.set({ scope: 'project-123' }, 'theme', { color: 'light' });
      await coordinator.set({ scope: 'project-123', surface: 'ui' }, 'layout', { width: 1200 });
    });

    it('lists all preferences when no filter', async () => {
      const items = await coordinator.list();
      expect(items).toHaveLength(4);
    });

    it('filters by scope', async () => {
      const items = await coordinator.list({ scope: 'global' });
      expect(items).toHaveLength(2);
      expect(items.every((item) => item.key.scope === 'global')).toBe(true);
    });

    it('filters by category', async () => {
      const items = await coordinator.list(undefined, 'theme');
      expect(items).toHaveLength(2);
      expect(items.every((item) => item.category === 'theme')).toBe(true);
    });

    it('filters by scope and category', async () => {
      const items = await coordinator.list({ scope: 'project-123' }, 'theme');
      expect(items).toHaveLength(1);
      expect(items[0]?.key.scope).toBe('project-123');
      expect(items[0]?.category).toBe('theme');
    });

    it('filters by surface', async () => {
      const items = await coordinator.list({ surface: 'ui' });
      expect(items).toHaveLength(1);
      expect(items[0]?.key.surface).toBe('ui');
    });

    it('returns items with correct structure', async () => {
      const items = await coordinator.list({ scope: 'global' }, 'theme');
      expect(items).toHaveLength(1);

      const item = items[0]!;
      expect(item).toHaveProperty('key');
      expect(item).toHaveProperty('category');
      expect(item).toHaveProperty('value');
      expect(item).toHaveProperty('updatedAt');
      expect(item.key.scope).toBe('global');
      expect(item.category).toBe('theme');
      expect(item.value).toEqual({ color: 'dark' });
      expect(typeof item.updatedAt).toBe('number');
    });

    it('handles multiple key filters', async () => {
      const items = await coordinator.list({
        scope: 'project-123',
        surface: 'ui',
      });
      expect(items).toHaveLength(1);
      expect(items[0]?.key.scope).toBe('project-123');
      expect(items[0]?.key.surface).toBe('ui');
    });

    it('returns empty array when no matches', async () => {
      const items = await coordinator.list({ scope: 'nonexistent' });
      expect(items).toHaveLength(0);
    });

    it('handles malformed JSON in list results', async () => {
      // Insert invalid JSON directly
      await getRawSqlExecutor(db).run(sql`
        INSERT INTO preferences (scope, surface, context, viewport, category, value, updated_at)
        VALUES ('broken', 'any', 'any', 'any', 'test', 'invalid{json', ${Date.now()})
      `);

      const items = await coordinator.list({ scope: 'broken' });
      expect(items).toHaveLength(1);
      expect(items[0]?.value).toBeNull();
    });
  });

  describe('key normalization', () => {
    it('normalizes undefined key components to "any" in database', async () => {
      const key: PreferenceKey = { scope: 'global' };
      await coordinator.set(key, 'test', { value: 1 });

      // Query database directly
      const [row] = await getRawSqlExecutor(db).all<{ surface: string; context: string; viewport: string }>(sql`
        SELECT surface, context, viewport
        FROM preferences
        WHERE scope = 'global' AND category = 'test'
      `);

      expect(row).toBeDefined();
      expect(row).toEqual({ surface: 'any', context: 'any', viewport: 'any' });
    });

    it('restores "any" to undefined when reading', async () => {
      const key: PreferenceKey = { scope: 'global' };
      await coordinator.set(key, 'test', { value: 1 });

      const items = await coordinator.list({ scope: 'global' });
      const item = items[0]!;

      expect(item.key.surface).toBeUndefined();
      expect(item.key.context).toBeUndefined();
      expect(item.key.viewport).toBeUndefined();
    });

    it('preserves explicit key components', async () => {
      const key: PreferenceKey = {
        scope: 'project-123',
        surface: 'ui',
        context: 'chat',
        viewport: 'desktop',
      };
      await coordinator.set(key, 'test', { value: 1 });

      const items = await coordinator.list({ scope: 'project-123' });
      const item = items[0]!;

      expect(item.key.surface).toBe('ui');
      expect(item.key.context).toBe('chat');
      expect(item.key.viewport).toBe('desktop');
    });
  });
});
