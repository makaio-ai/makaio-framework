/**
 * Persisted Store Factory
 *
 * Encapsulates the Zustand `persist()` + `createJSONStorage()` boilerplate for
 * all framework stores. Provides a single SSR-safe `noopStorage` definition and
 * a typed configuration interface that covers every persist option used across
 * the codebase.
 * @packageDocumentation
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { StateCreator, StoreMutatorIdentifier } from 'zustand';
import type { PersistOptions } from 'zustand/middleware';

/**
 * Storage engine selection.
 *
 * - `'sessionStorage'` – tab-scoped; cleared when the tab is closed.
 * - `'localStorage'`  – cross-tab; survives browser restart.
 */
export type StorageType = 'sessionStorage' | 'localStorage';

/**
 * SSR-safe no-op storage used when the requested browser storage is unavailable
 * (e.g., server-side rendering, private-browsing mode, or unit tests).
 */
export const noopStorage: Storage = {
  length: 0,
  clear: () => {},
  getItem: () => null,
  key: () => null,
  removeItem: () => {},
  setItem: () => {},
};

/**
 * Configuration options for `createPersistedStore`.
 * @typeParam T - The Zustand state type.
 */
export interface PersistedStoreConfig<T> {
  /**
   * Unique storage key (e.g., `'makaio-agent-selection'`).
   * Must be globally unique across all stores.
   */
  name: string;

  /**
   * Which browser storage to use.
   * Defaults to `'sessionStorage'`.
   */
  storage?: StorageType;

  /**
   * Schema version for migrations.
   * Increment when persisted shape changes; supply a `migrate` function in
   * `extraPersistOptions` when doing so.
   */
  version?: number;

  /**
   * Subset of state to persist.
   * When omitted the full state is persisted.
   * @param state - Full store state.
   * @returns Partial state to write to storage.
   */
  partialize?: PersistOptions<T, Partial<T>>['partialize'];

  /**
   * Custom merge function for rehydration.
   * Useful for schema migrations that need to clean up persisted data.
   * @param persistedState - Data read from storage (possibly stale shape).
   * @param currentState - Current in-memory state (initial values).
   * @returns Merged state.
   */
  merge?: (persistedState: unknown, currentState: T) => T;

  /**
   * Extra persist options forwarded verbatim to the Zustand `persist`
   * middleware. Use this for advanced options such as `onRehydrateStorage` or
   * `migrate`. Values here take precedence over other config fields when there
   * is a key conflict (except `name` and `storage`, which are always set by
   * this factory).
   */
  extraPersistOptions?: Omit<PersistOptions<T>, 'name' | 'storage'>;
}

/**
 * Resolve the browser storage implementation for the given type.
 * Falls back to `noopStorage` when the API is not available in the current
 * environment (SSR, private mode, etc.).
 * @param type - Storage type to resolve.
 * @returns The native storage object, or `noopStorage`.
 */
function resolveStorage(type: StorageType): Storage {
  const probeKey = '__makaio_storage_probe__';

  const probeStorage = (storage: Storage): boolean => {
    let previousValue: string | null = null;
    let hadValue = false;
    try {
      previousValue = storage.getItem(probeKey);
      hadValue = previousValue !== null;
      storage.setItem(probeKey, '1');
      return true;
    } catch {
      return false;
    } finally {
      try {
        if (hadValue && previousValue !== null) {
          storage.setItem(probeKey, previousValue);
        } else {
          storage.removeItem(probeKey);
        }
      } catch (error) {
        // Keep probe failures isolated from caller state updates.
        console.warn('[createPersistedStore] Storage probe cleanup failed', { type, error });
      }
    }
  };

  try {
    if (type === 'localStorage') {
      if (typeof localStorage === 'undefined') {
        return noopStorage;
      }
      return probeStorage(localStorage) ? localStorage : noopStorage;
    }

    if (typeof sessionStorage === 'undefined') {
      return noopStorage;
    }
    return probeStorage(sessionStorage) ? sessionStorage : noopStorage;
  } catch {
    return noopStorage;
  }
}

/**
 * Factory that creates a Zustand store with Zustand `persist` middleware
 * pre-configured.
 *
 * All framework stores that need persistence should use this factory instead of
 * calling `create(persist(...))` directly. This keeps the boilerplate in one
 * place and guarantees SSR-safe storage resolution everywhere.
 * @param stateCreator - Zustand state creator (same as the first arg to `create`).
 * @param config - Persistence configuration for this store.
 * @returns A Zustand store hook identical to what `create()` returns.
 * @example
 * ```ts
 * export const useMyStore = createPersistedStore<MyState>(
 *   (set) => ({
 *     count: 0,
 *     increment: () => set((s) => ({ count: s.count + 1 })),
 *   }),
 *   { name: 'makaio-my-store', storage: 'sessionStorage' },
 * );
 * ```
 */
export function createPersistedStore<T>(
  stateCreator: StateCreator<T, [StoreMutatorIdentifier, unknown][], []>,
  config: PersistedStoreConfig<T>,
) {
  const { name, storage: storageType = 'sessionStorage', version, partialize, merge, extraPersistOptions } = config;

  const persistOptions: PersistOptions<T, Partial<T>> = {
    name,
    storage: createJSONStorage(() => resolveStorage(storageType)),
    ...(version !== undefined ? { version } : {}),
    ...(partialize ? { partialize } : {}),
    ...(merge ? { merge } : {}),
    ...extraPersistOptions,
  };

  return create<T>()(persist(stateCreator, persistOptions));
}
