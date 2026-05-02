import { eq, and } from 'drizzle-orm';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import { PreferenceValueSchema, type PreferenceKey, type PreferenceItem } from '@makaio/services-core/preferences';
import { preferences } from './schema.js';
import { keyToRow, rowToKey } from './utils-common.js';

/**
 * Build Drizzle equality predicates from optional key/category filters.
 * @param keyFilter - Optional partial key filter
 * @param categoryFilter - Optional category filter
 * @returns Array of Drizzle eq() predicates
 */
export function buildPreferencePredicates(
  keyFilter?: Partial<PreferenceKey>,
  categoryFilter?: string,
): ReturnType<typeof eq>[] {
  const predicates: ReturnType<typeof eq>[] = [];

  if (categoryFilter !== undefined) {
    predicates.push(eq(preferences.category, categoryFilter));
  }

  if (keyFilter) {
    if (keyFilter.scope !== undefined) {
      predicates.push(eq(preferences.scope, keyFilter.scope));
    }
    if (keyFilter.surface !== undefined) {
      predicates.push(eq(preferences.surface, keyFilter.surface));
    }
    if (keyFilter.context !== undefined) {
      predicates.push(eq(preferences.context, keyFilter.context));
    }
    if (keyFilter.viewport !== undefined) {
      predicates.push(eq(preferences.viewport, keyFilter.viewport));
    }
  }

  return predicates;
}

/**
 * Query preferences rows from database with optional filters, and map to PreferenceItem[].
 * @param db - The Drizzle database instance
 * @param keyFilter - Optional partial key filter
 * @param categoryFilter - Optional category filter
 * @returns Array of matching PreferenceItem objects
 */
export async function queryPreferenceItems(
  db: MakaioDatabase<Record<string, unknown>>,
  keyFilter?: Partial<PreferenceKey>,
  categoryFilter?: string,
): Promise<PreferenceItem[]> {
  const predicates = buildPreferencePredicates(keyFilter, categoryFilter);

  const rows =
    predicates.length > 0
      ? await db
          .select()
          .from(preferences)
          .where(and(...predicates))
          .all()
      : await db.select().from(preferences).all();

  return rows.map((row) => {
    let value: unknown;
    try {
      value = JSON.parse(row.value);
    } catch {
      value = null;
    }
    const parsed = PreferenceValueSchema.safeParse(value);
    return {
      key: rowToKey(row),
      category: row.category,
      value: parsed.success ? parsed.data : null,
      updatedAt: row.updatedAt,
    };
  });
}

/**
 * Query a single preference row by exact key and category.
 * @param db - The Drizzle database instance
 * @param key - The preference key
 * @param category - The preference category
 * @returns The matching row or undefined
 */
export async function getPreferenceRow(
  db: MakaioDatabase<Record<string, unknown>>,
  key: PreferenceKey,
  category: string,
): Promise<typeof preferences.$inferSelect | undefined> {
  const rowKey = keyToRow(key);
  return db
    .select()
    .from(preferences)
    .where(
      and(
        eq(preferences.scope, rowKey.scope),
        eq(preferences.surface, rowKey.surface),
        eq(preferences.context, rowKey.context),
        eq(preferences.viewport, rowKey.viewport),
        eq(preferences.category, category),
      ),
    )
    .get();
}
