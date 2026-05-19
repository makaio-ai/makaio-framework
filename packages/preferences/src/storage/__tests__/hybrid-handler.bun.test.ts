import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { makeStubExtensionContext } from '@makaio/test-utils';
import { registerHybridPreferencesStorage } from '../hybrid-handler.js';
import { PreferencesSubjects, type PreferenceKey } from '@makaio/services-core/preferences';
import { createLocalStorageMock, createPreferencesTestDb } from './test-helpers.js';

describe('registerHybridPreferencesStorage', () => {
  let db: Awaited<ReturnType<typeof createPreferencesTestDb>>['db'];
  let close: Awaited<ReturnType<typeof createPreferencesTestDb>>['close'];
  let cleanup: (() => void) | undefined;
  let mockStorage: Map<string, string>;

  beforeEach(async () => {
    ({ db, close } = await createPreferencesTestDb());

    const localStorageMock = createLocalStorageMock();
    mockStorage = localStorageMock.backingStore;
    globalThis.localStorage = localStorageMock.storage;

    // Register handlers
    cleanup = registerHybridPreferencesStorage(MakaioBus, db, makeStubExtensionContext(MakaioBus));
  });

  afterEach(() => {
    cleanup?.();
    close?.();
  });

  describe('registration', () => {
    it('returns cleanup function that unregisters all handlers', async () => {
      expect(typeof cleanup).toBe('function');

      const key: PreferenceKey = { scope: 'global' };
      await MakaioBus.request(PreferencesSubjects.set, { key, category: 'test', value: { a: 1 } });

      cleanup?.();

      await expect(MakaioBus.request(PreferencesSubjects.get, { key, category: 'test' })).rejects.toThrow();
    });
  });

  describe('get handler', () => {
    it('returns value from coordinator or null if missing', async () => {
      const key: PreferenceKey = { scope: 'global' };

      // Missing preference
      let result = await MakaioBus.request(PreferencesSubjects.get, { key, category: 'missing' });
      expect(result.value).toBeNull();

      // Set and get
      await MakaioBus.request(PreferencesSubjects.set, { key, category: 'test', value: { a: 1 } });
      result = await MakaioBus.request(PreferencesSubjects.get, { key, category: 'test' });
      expect(result.value).toEqual({ a: 1 });
    });

    it('handles complex values and all key components', async () => {
      const key: PreferenceKey = {
        scope: 'project-123',
        surface: 'ui',
        context: 'chat',
        viewport: 'desktop',
      };
      const complexValue = {
        widgets: [
          { id: 'w1', type: 'chat', position: { x: 0, y: 0 } },
          { id: 'w2', type: 'files', position: { x: 1, y: 0 } },
        ],
        layout: { columns: 12, gap: 8 },
      };

      await MakaioBus.request(PreferencesSubjects.set, { key, category: 'layout', value: complexValue });

      const result = await MakaioBus.request(PreferencesSubjects.get, { key, category: 'layout' });
      expect(result.value).toEqual(complexValue);
    });
  });

  describe('set handler', () => {
    it('delegates to coordinator and updates values', async () => {
      const key: PreferenceKey = { scope: 'global' };

      // Initial set
      const result = await MakaioBus.request(PreferencesSubjects.set, {
        key,
        category: 'theme',
        value: { color: 'dark' },
      });
      expect(result.success).toBe(true);

      // Verify stored
      let getResult = await MakaioBus.request(PreferencesSubjects.get, { key, category: 'theme' });
      expect(getResult.value).toEqual({ color: 'dark' });

      // Update
      await MakaioBus.request(PreferencesSubjects.set, { key, category: 'theme', value: { color: 'light' } });
      getResult = await MakaioBus.request(PreferencesSubjects.get, { key, category: 'theme' });
      expect(getResult.value).toEqual({ color: 'light' });
    });
  });

  describe('delete handler', () => {
    it('delegates to coordinator and deletes only matching preference', async () => {
      const key1: PreferenceKey = { scope: 'global' };
      const key2: PreferenceKey = { scope: 'project-123' };

      // Set two preferences
      await MakaioBus.request(PreferencesSubjects.set, { key: key1, category: 'theme', value: { color: 'dark' } });
      await MakaioBus.request(PreferencesSubjects.set, {
        key: key2,
        category: 'theme',
        value: { color: 'light' },
      });

      // Delete one
      const result = await MakaioBus.request(PreferencesSubjects.delete, { key: key1, category: 'theme' });
      expect(result.success).toBe(true);

      // Verify key1 is deleted, key2 remains
      const result1 = await MakaioBus.request(PreferencesSubjects.get, { key: key1, category: 'theme' });
      expect(result1.value).toBeNull();

      const result2 = await MakaioBus.request(PreferencesSubjects.get, { key: key2, category: 'theme' });
      expect(result2.value).toEqual({ color: 'light' });
    });
  });

  describe('list handler', () => {
    beforeEach(async () => {
      // Set up test data
      await MakaioBus.request(PreferencesSubjects.set, {
        key: { scope: 'global' },
        category: 'theme',
        value: { color: 'dark' },
      });
      await MakaioBus.request(PreferencesSubjects.set, {
        key: { scope: 'global' },
        category: 'layout',
        value: { width: 800 },
      });
      await MakaioBus.request(PreferencesSubjects.set, {
        key: { scope: 'project-123' },
        category: 'theme',
        value: { color: 'light' },
      });
      await MakaioBus.request(PreferencesSubjects.set, {
        key: { scope: 'project-123', surface: 'ui' },
        category: 'layout',
        value: { width: 1200 },
      });
    });

    it('delegates to coordinator and lists all without filters', async () => {
      const result = await MakaioBus.request(PreferencesSubjects.list, {});
      expect(result.items).toHaveLength(4);
    });

    it('filters by scope', async () => {
      const result = await MakaioBus.request(PreferencesSubjects.list, { key: { scope: 'global' } });

      expect(result.items).toHaveLength(2);
      expect(result.items.every((item) => item.key.scope === 'global')).toBe(true);
    });

    it('filters by category', async () => {
      const result = await MakaioBus.request(PreferencesSubjects.list, { category: 'theme' });

      expect(result.items).toHaveLength(2);
      expect(result.items.every((item) => item.category === 'theme')).toBe(true);
    });

    it('filters by scope and category combined', async () => {
      const result = await MakaioBus.request(PreferencesSubjects.list, {
        key: { scope: 'project-123' },
        category: 'theme',
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.key.scope).toBe('project-123');
      expect(result.items[0]?.category).toBe('theme');
    });

    it('filters by surface', async () => {
      const result = await MakaioBus.request(PreferencesSubjects.list, { key: { surface: 'ui' } });

      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.key.surface).toBe('ui');
    });

    it('returns items with correct structure including updatedAt', async () => {
      const result = await MakaioBus.request(PreferencesSubjects.list, {
        key: { scope: 'global' },
        category: 'theme',
      });

      expect(result.items).toHaveLength(1);

      const item = result.items[0]!;
      expect(item).toHaveProperty('key');
      expect(item).toHaveProperty('category');
      expect(item).toHaveProperty('value');
      expect(item).toHaveProperty('updatedAt');
      expect(item.key.scope).toBe('global');
      expect(item.category).toBe('theme');
      expect(item.value).toEqual({ color: 'dark' });
      expect(typeof item.updatedAt).toBe('number');
    });
  });

  describe('coordinator integration', () => {
    it('writes to both localStorage and database', async () => {
      const key: PreferenceKey = { scope: 'global' };

      await MakaioBus.request(PreferencesSubjects.set, { key, category: 'theme', value: { color: 'dark' } });

      // Check localStorage
      const storageKey = 'makaio:prefs:global:any:any:any:theme';
      const storedInLS = mockStorage.get(storageKey);
      expect(storedInLS).toBeDefined();
      const parsed = JSON.parse(storedInLS!);
      expect(JSON.parse(parsed.value)).toEqual({ color: 'dark' });

      // Check database via get
      const result = await MakaioBus.request(PreferencesSubjects.get, { key, category: 'theme' });
      expect(result.value).toEqual({ color: 'dark' });
    });

    it('reads from database even when localStorage is cleared', async () => {
      const key: PreferenceKey = { scope: 'global' };

      await MakaioBus.request(PreferencesSubjects.set, { key, category: 'test', value: { a: 1 } });

      // Clear localStorage to verify read comes from database
      mockStorage.clear();

      const result = await MakaioBus.request(PreferencesSubjects.get, { key, category: 'test' });
      expect(result.value).toEqual({ a: 1 });
    });

    it('deletes from both backends', async () => {
      const key: PreferenceKey = { scope: 'global' };

      await MakaioBus.request(PreferencesSubjects.set, { key, category: 'theme', value: { color: 'dark' } });
      await MakaioBus.request(PreferencesSubjects.delete, { key, category: 'theme' });

      // Check localStorage
      const storageKey = 'makaio:prefs:global:any:any:any:theme';
      expect(mockStorage.has(storageKey)).toBe(false);

      // Check database
      const result = await MakaioBus.request(PreferencesSubjects.get, { key, category: 'theme' });
      expect(result.value).toBeNull();
    });
  });
});
