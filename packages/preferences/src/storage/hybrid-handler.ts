import type { IMakaioBus } from '@makaio/bus-core';
import type { ExtensionContext } from '@makaio/contracts';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import { PreferencesSubjects } from '@makaio/services-core/preferences';
import { StorageCoordinator } from './storage-coordinator.js';

/**
 * Registers hybrid storage handler for preferences.
 *
 * Coordinates between browser localStorage (fast reads, immediate persistence)
 * and database (durability, multi-device sync future).
 * @param bus - The Makaio bus instance
 * @param db - Drizzle database instance for persistent storage
 * @param _ctx - Extension context (unused; reserved for future use)
 * @returns Cleanup function to unregister handlers
 */
export function registerHybridPreferencesStorage(
  bus: IMakaioBus,
  db: MakaioDatabase<Record<string, unknown>>,
  _ctx: ExtensionContext,
): () => void {
  const coordinator = new StorageCoordinator({ db });

  const unsubGet = bus.on(PreferencesSubjects.get, async (ctx) => {
    const { key, category } = ctx.payload;
    const value = await coordinator.get(key, category);
    ctx.setResult({ value });
  });

  const unsubSet = bus.on(PreferencesSubjects.set, async (ctx) => {
    const { key, category, value } = ctx.payload;
    await coordinator.set(key, category, value);
    ctx.setResult({ success: true });
  });

  const unsubDelete = bus.on(PreferencesSubjects.delete, async (ctx) => {
    const { key, category } = ctx.payload;
    await coordinator.delete(key, category);
    ctx.setResult({ success: true });
  });

  const unsubList = bus.on(PreferencesSubjects.list, async (ctx) => {
    const { key: keyFilter, category: categoryFilter } = ctx.payload;
    const items = await coordinator.list(keyFilter, categoryFilter);
    ctx.setResult({ items });
  });

  return () => {
    unsubGet();
    unsubSet();
    unsubDelete();
    unsubList();
  };
}
