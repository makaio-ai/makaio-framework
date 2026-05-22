import { type IMakaioBus } from '@makaio/bus-core';
import { PreferencesSubjects, type PreferenceItem } from '@makaio/services-core/preferences';
import { getStorageKey, parseStorageKey, parseStoredPreference } from './utils-common.js';
import type { StoredPreference } from './types.js';

/**
 * Registers browser-based (localStorage) handlers for preferences subjects.
 * Must be called in the app bootstrap before React mounts (see main.tsx).
 *
 * Response format: get returns object with value or null, set/delete return success.
 * @param bus - The Makaio bus instance
 * @returns Cleanup function to unregister all handlers (important for React StrictMode)
 */
// eslint-disable-next-line max-lines-per-function -- Four CRUD handlers with storage format migration logic
export function registerBrowserPreferencesStorage(bus: IMakaioBus): () => void {
  const unsubGet = bus.on(PreferencesSubjects.get, (ctx) => {
    const { key, category } = ctx.payload;
    const storageKey = getStorageKey(key, category);
    const raw = globalThis.localStorage.getItem(storageKey);

    if (!raw) {
      ctx.setResult({ value: null });
      return;
    }

    const stored = parseStoredPreference(raw);
    if (!stored) {
      ctx.setResult({ value: null });
      return;
    }

    try {
      ctx.setResult({ value: JSON.parse(stored.value) });
    } catch {
      ctx.setResult({ value: null });
    }
  });

  const unsubSet = bus.on(PreferencesSubjects.set, (ctx) => {
    const { key, category, value } = ctx.payload;
    const storageKey = getStorageKey(key, category);
    const stored: StoredPreference = {
      value: JSON.stringify(value ?? null),
      updatedAt: Date.now(),
    };
    globalThis.localStorage.setItem(storageKey, JSON.stringify(stored));
    ctx.setResult({ success: true });
  });

  const unsubDelete = bus.on(PreferencesSubjects.delete, (ctx) => {
    const { key, category } = ctx.payload;
    const storageKey = getStorageKey(key, category);
    globalThis.localStorage.removeItem(storageKey);
    ctx.setResult({ success: true });
  });

  const unsubList = bus.on(PreferencesSubjects.list, (ctx) => {
    const { key: keyFilter, category: categoryFilter } = ctx.payload;
    const items: PreferenceItem[] = [];

    for (let i = 0; i < globalThis.localStorage.length; i++) {
      const storageKey = globalThis.localStorage.key(i);
      if (!storageKey) continue;

      const parsed = parseStorageKey(storageKey);
      if (!parsed) continue;

      // Apply filters
      if (categoryFilter && parsed.category !== categoryFilter) {
        continue;
      }

      if (keyFilter) {
        const { key } = parsed;
        if (keyFilter.scope !== undefined && key.scope !== keyFilter.scope) {
          continue;
        }
        if (keyFilter.surface !== undefined && key.surface !== keyFilter.surface) {
          continue;
        }
        if (keyFilter.context !== undefined && key.context !== keyFilter.context) {
          continue;
        }
        if (keyFilter.viewport !== undefined && key.viewport !== keyFilter.viewport) {
          continue;
        }
      }

      const raw = globalThis.localStorage.getItem(storageKey);
      if (!raw) continue;

      const stored = parseStoredPreference(raw);
      if (!stored) {
        continue;
      }

      try {
        const value = JSON.parse(stored.value);

        items.push({
          key: parsed.key,
          category: parsed.category,
          value,
          updatedAt: stored.updatedAt,
        });
      } catch {
        // Skip invalid JSON entries
        continue;
      }
    }

    ctx.setResult({ items });
  });

  return () => {
    unsubGet();
    unsubSet();
    unsubDelete();
    unsubList();
  };
}
