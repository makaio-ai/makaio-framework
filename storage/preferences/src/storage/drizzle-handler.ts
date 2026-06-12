/**
 * Drizzle-based handlers for preferences subjects.
 *
 * Provides persistent database-backed storage for the Node.js runtime.
 * Mirrors browser-handler.ts API but uses Drizzle ORM.
 */

import { eq, and } from 'drizzle-orm';
import { resolveSchema, type MakaioDatabase } from '@makaio/storage-drizzle';
import type { IMakaioBus } from '@makaio/bus-core';
import { PreferencesSubjects } from '@makaio/services-core/preferences';
import { preferencesSchema } from './schema.variants.js';
import { keyToRow } from './utils-common.js';
import { queryPreferenceItems, getPreferenceRow } from './utils-drizzle.js';

/**
 * Registers Drizzle-based handlers for preferences subjects.
 * @param bus - The Makaio bus instance
 * @param db - Drizzle database instance
 * @returns Cleanup function to unregister all handlers
 */
export function registerDrizzlePreferencesStorage(bus: IMakaioBus, db: MakaioDatabase): () => void {
  const { preferences } = resolveSchema(db, preferencesSchema);
  const unsubGet = bus.on(PreferencesSubjects.get, async (ctx) => {
    const { key, category } = ctx.payload;
    const row = await getPreferenceRow(db, key, category);

    if (!row) {
      ctx.setResult({ value: null });
      return;
    }

    try {
      ctx.setResult({ value: JSON.parse(row.value) });
    } catch {
      ctx.setResult({ value: null });
    }
  });

  const unsubSet = bus.on(PreferencesSubjects.set, async (ctx) => {
    const { key, category, value } = ctx.payload;
    const rowKey = keyToRow(key);
    const now = Date.now();
    const serializedValue = JSON.stringify(value ?? null);

    await db
      .insert(preferences)
      .values({
        ...rowKey,
        category,
        value: serializedValue,
        updatedAt: now,
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
          value: serializedValue,
          updatedAt: now,
        },
      });

    ctx.setResult({ success: true });
  });

  const unsubDelete = bus.on(PreferencesSubjects.delete, async (ctx) => {
    const { key, category } = ctx.payload;
    const rowKey = keyToRow(key);

    await db
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

    ctx.setResult({ success: true });
  });

  const unsubList = bus.on(PreferencesSubjects.list, async (ctx) => {
    const { key: keyFilter, category: categoryFilter } = ctx.payload;
    const items = await queryPreferenceItems(db, keyFilter, categoryFilter);
    ctx.setResult({ items });
  });

  return () => {
    unsubGet();
    unsubSet();
    unsubDelete();
    unsubList();
  };
}
