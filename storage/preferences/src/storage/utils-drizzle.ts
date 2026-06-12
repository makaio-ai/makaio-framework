import { eq, and } from 'drizzle-orm';
import { resolveSchema, type MakaioDatabase } from '@makaio/storage-drizzle';
import { PreferenceValueSchema, type PreferenceKey, type PreferenceItem } from '@makaio/services-core/preferences';
import { preferencesSchema } from './schema.variants.js';
import { keyToRow, rowToKey } from './utils-common.js';

/**
 * Table type alias derived from the preferences dialect variants.
 *
 * Used to type the `preferences` parameter in helpers that do not have a
 * database handle available. Callers must supply the dialect-resolved table
 * obtained via `resolveSchema`.
 */
type PreferencesTable = typeof preferencesSchema.sqlite.preferences;

/**
 * Build Drizzle equality predicates from optional key/category filters.
 *
 * The caller is responsible for passing the dialect-resolved table obtained
 * via `resolveSchema(db, preferencesSchema)`, so that predicates reference
 * the correct SQLite or Postgres twin.
 * @param preferences - Dialect-resolved preferences table, obtained via
 *   `resolveSchema` from the caller's database handle.
 * @param keyFilter - Optional partial key filter
 * @param categoryFilter - Optional category filter
 * @returns Array of Drizzle eq() predicates
 */
export function buildPreferencePredicates(
  preferences: PreferencesTable,
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
  const { preferences } = resolveSchema(db, preferencesSchema);
  const predicates = buildPreferencePredicates(preferences, keyFilter, categoryFilter);

  const rows =
    predicates.length > 0
      ? await db
          .select()
          .from(preferences)
          .where(and(...predicates))
      : await db.select().from(preferences);

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
): Promise<PreferencesTable['$inferSelect'] | undefined> {
  const { preferences } = resolveSchema(db, preferencesSchema);
  const rowKey = keyToRow(key);
  const [row] = await db
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
    .limit(1);
  return row;
}
