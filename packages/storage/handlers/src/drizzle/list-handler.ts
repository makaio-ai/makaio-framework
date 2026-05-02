import { and } from 'drizzle-orm';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import type { RequestContext } from '@makaio/core';
import type { IMakaioBus } from '@makaio/bus-core';
import type { DrizzleListConfig } from './types.js';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';

/**
 * Creates a list handler with customizable query predicates.
 *
 * Type safety is maintained at the call site through DrizzleListConfig type
 * parameters and runtime Zod schema validation.
 * @param config - List handler configuration
 * @returns Function that registers the handler and returns cleanup
 * @example
 * ```typescript
 * const registerList = createDrizzleListHandler({
 *   table: profileDefinitions,
 *   subject: ProfileStorageSubjects.list,
 *   pluralKey: 'profiles',
 *   mapper: mapProfile,
 *   buildPredicates: (payload, table) => [
 *     ...buildScopePredicates(table, payload.projectId),
 *     ...(payload.name ? [eq(table.name, payload.name)] : []),
 *   ],
 * });
 *
 * const cleanup = registerList(bus, db);
 * ```
 */
export function createDrizzleListHandler<
  TTable extends SQLiteTable,
  ApiType,
  QueryPayload extends Record<string, unknown> = Record<string, unknown>,
  TPluralKey extends string = string,
>(
  config: DrizzleListConfig<TTable, ApiType, QueryPayload, TPluralKey>,
): (bus: IMakaioBus, db: MakaioDatabase) => () => void {
  const { table, subject, pluralKey, mapper, buildPredicates } = config;

  return (bus: IMakaioBus, db: MakaioDatabase) => {
    type ListPayload = QueryPayload;
    type ListResponse = Record<TPluralKey, ApiType[]>;
    const createRecord = <K extends string, V>(key: K, value: V): Record<K, V> => {
      return { [key]: value } as Record<K, V>;
    };
    return bus.on(subject, async (ctx: RequestContext<ListPayload, ListResponse>) => {
      const predicates = buildPredicates(ctx.payload, table);
      const whereClause = predicates.length > 0 ? and(...predicates) : undefined;

      const rows = whereClause ? await db.select().from(table).where(whereClause) : await db.select().from(table);

      ctx.setResult(createRecord(pluralKey, rows.map(mapper)));
    });
  };
}
