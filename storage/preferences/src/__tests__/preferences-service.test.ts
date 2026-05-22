import { describe, it, expect, beforeEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { registerBrowserPreferencesStorage } from '../storage/browser-handler.js';
import { PreferencesSubjects, type PreferenceKey } from '@makaio/services-core/preferences';
import type { StoredPreference } from '../storage/types.js';

describe('registerBrowserPreferencesStorage', () => {
  let mockLocalStorage: Map<string, string>;

  beforeEach(() => {
    // Reset bus handlers between tests
    MakaioBus.__resetHandlers?.();

    // Reset localStorage mock
    mockLocalStorage = new Map();

    const localStorageMock = {
      getItem: (key: string) => mockLocalStorage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        mockLocalStorage.set(key, value);
      },
      removeItem: (key: string) => {
        mockLocalStorage.delete(key);
      },
      clear: () => {
        mockLocalStorage.clear();
      },
      key: (index: number) => {
        const keys = Array.from(mockLocalStorage.keys());
        return keys[index] ?? null;
      },
      has: (key: string) => mockLocalStorage.has(key),
      length: 0,
    };

    // Make length reactive to mockLocalStorage size
    Object.defineProperty(localStorageMock, 'length', {
      get: () => mockLocalStorage.size,
    });

    // Directly assign to globalThis instead of using vi.stubGlobal
    globalThis.localStorage = localStorageMock as typeof globalThis.localStorage;

    // Register the browser storage handlers
    registerBrowserPreferencesStorage(MakaioBus);
  });

  describe('get handler', () => {
    it('retrieves and parses JSON from localStorage', async () => {
      const key: PreferenceKey = {
        scope: 'global',
        surface: 'ui',
        context: 'editor',
        viewport: 'desktop',
      };
      const category = 'layout';
      const expectedStorageKey = 'makaio:prefs:global:ui:editor:desktop:layout';
      const testValue = { width: 800, height: 600 };

      mockLocalStorage.set(expectedStorageKey, JSON.stringify(testValue));

      const result = await MakaioBus.request(PreferencesSubjects.get, { key, category });

      expect(result.value).toEqual(testValue);
    });

    it('returns null when key does not exist', async () => {
      const key: PreferenceKey = { scope: 'global' };
      const category = 'layout';

      const result = await MakaioBus.request(PreferencesSubjects.get, { key, category });

      expect(result.value).toBeNull();
    });

    it('returns null when JSON parsing fails', async () => {
      const key: PreferenceKey = { scope: 'global' };
      const category = 'layout';
      const storageKey = 'makaio:prefs:global:any:any:any:layout';

      mockLocalStorage.set(storageKey, 'invalid-json{');

      const result = await MakaioBus.request(PreferencesSubjects.get, { key, category });

      expect(result.value).toBeNull();
    });

    it('generates stable storage keys with optional fields as "any"', async () => {
      const key: PreferenceKey = {
        scope: 'project-123',
      };
      const category = 'theme';
      const expectedStorageKey = 'makaio:prefs:project-123:any:any:any:theme';
      const testValue = { darkMode: true };

      mockLocalStorage.set(expectedStorageKey, JSON.stringify(testValue));

      const result = await MakaioBus.request(PreferencesSubjects.get, { key, category });

      expect(result.value).toEqual(testValue);
    });
  });

  describe('set handler', () => {
    it('stores JSON-stringified value in localStorage', async () => {
      const key: PreferenceKey = {
        scope: 'global',
        surface: 'app',
      };
      const category = 'settings';
      const value = { fontSize: 14, theme: 'dark' };
      const expectedStorageKey = 'makaio:prefs:global:app:any:any:settings';

      await MakaioBus.request(PreferencesSubjects.set, { key, category, value });

      const stored = mockLocalStorage.get(expectedStorageKey);
      expect(stored).toBeDefined();
      const parsed: StoredPreference = JSON.parse(stored!);
      expect(parsed.value).toBe(JSON.stringify(value));
      expect(parsed.updatedAt).toBeGreaterThan(0);
    });

    it('handles complex nested objects', async () => {
      const key: PreferenceKey = { scope: 'global' };
      const category = 'layout';
      const value = {
        panels: [
          { id: 'panel1', width: 200 },
          { id: 'panel2', width: 300 },
        ],
        metadata: { lastUpdated: Date.now() },
      };
      const expectedStorageKey = 'makaio:prefs:global:any:any:any:layout';

      await MakaioBus.request(PreferencesSubjects.set, { key, category, value });

      const stored = mockLocalStorage.get(expectedStorageKey);
      expect(stored).toBeDefined();
      const parsed: StoredPreference = JSON.parse(stored!);
      expect(JSON.parse(parsed.value)).toEqual(value);
      expect(parsed.updatedAt).toBeGreaterThan(0);
    });
  });

  describe('delete handler', () => {
    it('removes key from localStorage', async () => {
      const key: PreferenceKey = { scope: 'global' };
      const category = 'layout';
      const storageKey = 'makaio:prefs:global:any:any:any:layout';

      mockLocalStorage.set(storageKey, JSON.stringify({ test: true }));
      expect(mockLocalStorage.has(storageKey)).toBe(true);

      await MakaioBus.request(PreferencesSubjects.delete, { key, category });

      expect(mockLocalStorage.has(storageKey)).toBe(false);
    });

    it('handles deletion of non-existent keys gracefully', async () => {
      const key: PreferenceKey = { scope: 'global' };
      const category = 'nonexistent';

      // Should not throw
      await expect(MakaioBus.request(PreferencesSubjects.delete, { key, category })).resolves.not.toThrow();
    });
  });

  describe('storage key generation', () => {
    it('includes all preference key fields in storage key', async () => {
      const key: PreferenceKey = {
        scope: 'project-456',
        surface: 'ui',
        context: 'sidebar',
        viewport: 'mobile',
      };
      const category = 'dimensions';
      const value = { width: 320 };
      const expectedStorageKey = 'makaio:prefs:project-456:ui:sidebar:mobile:dimensions';

      await MakaioBus.request(PreferencesSubjects.set, { key, category, value });

      const stored = mockLocalStorage.get(expectedStorageKey);
      expect(stored).toBeDefined();
      const parsed: StoredPreference = JSON.parse(stored!);
      expect(JSON.parse(parsed.value)).toEqual(value);
    });
  });

  describe('list handler', () => {
    it('verifies localStorage mock is working', async () => {
      // Sanity check: verify the mock works as expected
      await MakaioBus.request(PreferencesSubjects.set, {
        key: { scope: 'test' },
        category: 'test',
        value: { test: true },
      });

      // The mock should have the item
      expect(mockLocalStorage.size).toBe(1);

      // Check globalThis.localStorage.length directly
      expect(globalThis.localStorage.length).toBe(1);

      // Check globalThis.localStorage.key(0) directly
      expect(globalThis.localStorage.key(0)).toBe('makaio:prefs:test:any:any:any:test');

      // Test iteration manually
      const keys: string[] = [];
      for (let i = 0; i < globalThis.localStorage.length; i++) {
        const key = globalThis.localStorage.key(i);
        if (key) keys.push(key);
      }
      expect(keys).toHaveLength(1);
      expect(keys[0]).toBe('makaio:prefs:test:any:any:any:test');

      // And we should be able to retrieve it via the bus
      const result = await MakaioBus.request(PreferencesSubjects.get, {
        key: { scope: 'test' },
        category: 'test',
      });
      expect(result.value).toEqual({ test: true });

      // Test list handler with one item
      const listResult = await MakaioBus.request(PreferencesSubjects.list, {});
      expect(listResult.items).toHaveLength(1);
      expect(listResult.items[0].value).toEqual({ test: true });
    });

    it('returns all preferences when no filters provided', async () => {
      // Use the bus's set method to populate localStorage
      await MakaioBus.request(PreferencesSubjects.set, {
        key: { scope: 'global', surface: 'ui', context: 'editor', viewport: 'desktop' },
        category: 'layout',
        value: { width: 800 },
      });
      await MakaioBus.request(PreferencesSubjects.set, {
        key: { scope: 'global' },
        category: 'theme',
        value: { darkMode: true },
      });
      await MakaioBus.request(PreferencesSubjects.set, {
        key: { scope: 'project-123', surface: 'app', context: 'settings' },
        category: 'layout',
        value: { columns: 3 },
      });

      // Debug: Check mock size
      expect(mockLocalStorage.size).toBe(3);
      expect(globalThis.localStorage.length).toBe(3);

      const result = await MakaioBus.request(PreferencesSubjects.list, {});

      expect(result.items).toHaveLength(3);
      expect(result.items[0].value).toEqual({ width: 800 });
      expect(result.items[1].value).toEqual({ darkMode: true });
      expect(result.items[2].value).toEqual({ columns: 3 });
    });

    it('filters by category', async () => {
      await MakaioBus.request(PreferencesSubjects.set, {
        key: { scope: 'global', surface: 'ui', context: 'editor', viewport: 'desktop' },
        category: 'layout',
        value: { width: 800 },
      });
      await MakaioBus.request(PreferencesSubjects.set, {
        key: { scope: 'global' },
        category: 'theme',
        value: { darkMode: true },
      });
      await MakaioBus.request(PreferencesSubjects.set, {
        key: { scope: 'project-123', surface: 'app', context: 'settings' },
        category: 'layout',
        value: { columns: 3 },
      });

      const result = await MakaioBus.request(PreferencesSubjects.list, { category: 'layout' });

      expect(result.items).toHaveLength(2);
      expect(result.items.every((item) => item.category === 'layout')).toBe(true);
    });

    it('filters by key scope', async () => {
      await MakaioBus.request(PreferencesSubjects.set, {
        key: { scope: 'global', surface: 'ui', context: 'editor', viewport: 'desktop' },
        category: 'layout',
        value: { width: 800 },
      });
      await MakaioBus.request(PreferencesSubjects.set, {
        key: { scope: 'project-123' },
        category: 'theme',
        value: { darkMode: true },
      });

      const result = await MakaioBus.request(PreferencesSubjects.list, {
        key: { scope: 'global' },
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].key.scope).toBe('global');
    });

    it('filters by multiple key fields', async () => {
      await MakaioBus.request(PreferencesSubjects.set, {
        key: { scope: 'global', surface: 'ui', context: 'editor', viewport: 'desktop' },
        category: 'layout',
        value: { width: 800 },
      });
      await MakaioBus.request(PreferencesSubjects.set, {
        key: { scope: 'global', surface: 'app', context: 'settings' },
        category: 'layout',
        value: { columns: 3 },
      });
      await MakaioBus.request(PreferencesSubjects.set, {
        key: { scope: 'global', surface: 'ui', context: 'sidebar', viewport: 'mobile' },
        category: 'layout',
        value: { collapsed: true },
      });

      const result = await MakaioBus.request(PreferencesSubjects.list, {
        key: { scope: 'global', surface: 'ui' },
        category: 'layout',
      });

      expect(result.items).toHaveLength(2);
      expect(result.items.every((item) => item.key.scope === 'global' && item.key.surface === 'ui')).toBe(true);
    });

    it('skips entries with invalid JSON', async () => {
      await MakaioBus.request(PreferencesSubjects.set, {
        key: { scope: 'global', surface: 'ui', context: 'editor', viewport: 'desktop' },
        category: 'layout',
        value: { width: 800 },
      });
      // Directly set invalid JSON
      mockLocalStorage.set('makaio:prefs:global:any:any:any:invalid', 'invalid-json{');

      const result = await MakaioBus.request(PreferencesSubjects.list, {});

      expect(result.items).toHaveLength(1);
      expect(result.items[0].value).toEqual({ width: 800 });
    });

    it('returns empty array when no preferences match', async () => {
      await MakaioBus.request(PreferencesSubjects.set, {
        key: { scope: 'global', surface: 'ui', context: 'editor', viewport: 'desktop' },
        category: 'layout',
        value: { width: 800 },
      });

      const result = await MakaioBus.request(PreferencesSubjects.list, { category: 'nonexistent' });

      expect(result.items).toHaveLength(0);
    });

    it('parses storage key components correctly', async () => {
      await MakaioBus.request(PreferencesSubjects.set, {
        key: { scope: 'project-456', surface: 'ui', context: 'sidebar', viewport: 'mobile' },
        category: 'dimensions',
        value: { width: 320 },
      });

      const result = await MakaioBus.request(PreferencesSubjects.list, {});

      expect(result.items).toHaveLength(1);
      expect(result.items[0].key).toEqual({
        scope: 'project-456',
        surface: 'ui',
        context: 'sidebar',
        viewport: 'mobile',
      });
      expect(result.items[0].category).toBe('dimensions');
    });
  });
});
