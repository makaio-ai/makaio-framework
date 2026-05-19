import { eq, getTableColumns, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import type { IMakaioBus } from '@makaio/bus-core';
import type { RequestContext } from '@makaio/core';
import type { DrizzleCrudConfig } from './types.js';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';

type GetPayload = { id: string };
type DeletePayload = { id: string };
type DeleteResponse = { deleted: boolean };
type ConflictTarget = SQLiteColumn | SQL | (SQLiteColumn | SQL)[];

/**
 * Builds a typed single-key object.
 * @param key - Record key.
 * @param value - Record value.
 * @returns Record with one key/value pair.
 */
function createRecord<TKey extends string, TValue>(key: TKey, value: TValue): Record<TKey, TValue> {
  return { [key]: value } as Record<TKey, TValue>;
}

/**
 * Resolves the ON CONFLICT target once at handler construction time.
 * @param table - Drizzle table definition.
 * @param idField - Primary key field name.
 * @param conflictTarget - Optional natural-key conflict target resolver.
 * @returns Concrete conflict target for downstream upserts.
 */
function resolveConflictTarget<
  TTable extends SQLiteTable,
  TIdField extends Extract<keyof TTable['_']['columns'], string>,
>(table: TTable, idField: TIdField, conflictTarget?: (table: TTable) => (SQLiteColumn | SQL)[]): ConflictTarget {
  const columns = getTableColumns(table);

  if (!conflictTarget) {
    return columns[idField];
  }

  const resolved = conflictTarget(table);

  if (resolved.length === 0) {
    throw new Error(
      'createDrizzleCrudHandlers: conflictTarget returned an empty array. ' +
        'Provide at least one column for the conflict target.',
    );
  }

  return resolved;
}

/**
 * Registers get-by-id handler.
 * @param bus - Bus instance.
 * @param db - Database client.
 * @param config - Handler configuration.
 * @returns Cleanup function.
 */
function registerGetHandler<
  TTable extends SQLiteTable,
  ApiType extends Record<string, unknown>,
  TIdField extends Extract<keyof TTable['_']['columns'], string>,
  TSingularKey extends string,
>(
  bus: IMakaioBus,
  db: MakaioDatabase,
  config: {
    table: TTable;
    idField: TIdField;
    singularKey: TSingularKey;
    mapper: (row: TTable['$inferSelect']) => ApiType;
    getSubject: DrizzleCrudConfig<TTable, ApiType, TIdField, Record<TIdField, string>, TSingularKey>['subjects']['get'];
  },
): () => void {
  const { table, idField, singularKey, mapper, getSubject } = config;
  type GetResponse = Record<TSingularKey, ApiType | null>;

  return bus.on(getSubject, async (ctx: RequestContext<GetPayload, GetResponse>) => {
    const { id } = ctx.payload;
    const column = getTableColumns(table)[idField];
    const [row] = await db.select().from(table).where(eq(column, id)).limit(1);
    ctx.setResult(createRecord(singularKey, row ? mapper(row) : null));
  });
}

/**
 * Registers upsert handler.
 * @param bus - Bus instance.
 * @param db - Database client.
 * @param config - Handler configuration.
 * @returns Cleanup function.
 */
function registerSetHandler<
  TTable extends SQLiteTable,
  ApiType extends Record<string, unknown>,
  TIdField extends Extract<keyof TTable['_']['columns'], string>,
  InputType extends Record<TIdField, string> & Record<string, unknown>,
  TSingularKey extends string,
>(
  bus: IMakaioBus,
  db: MakaioDatabase,
  config: {
    table: TTable;
    idField: TIdField;
    singularKey: TSingularKey;
    mapper: (row: TTable['$inferSelect']) => ApiType;
    toDbValues: (input: InputType) => Partial<TTable['$inferInsert']>;
    setSubject: DrizzleCrudConfig<TTable, ApiType, TIdField, InputType, TSingularKey>['subjects']['set'];
    /** Concrete conflict target resolved once during factory construction. */
    resolvedConflictTarget: ConflictTarget;
    lifecycle?: NonNullable<DrizzleCrudConfig<TTable, ApiType, TIdField, InputType, TSingularKey>['lifecycle']>;
  },
): () => void {
  const { table, idField, singularKey, mapper, toDbValues, setSubject, resolvedConflictTarget, lifecycle } = config;
  type SetPayload = Record<TSingularKey, InputType>;
  type SetResponse = { id: string };

  return bus.on(setSubject, async (ctx: RequestContext<SetPayload, SetResponse>) => {
    const input = ctx.payload[singularKey];
    const id = input[idField];
    const now = Date.now();
    const columns = getTableColumns(table);
    const mappedValues = toDbValues(input);
    const insertValues: TTable['$inferInsert'] = {
      ...mappedValues,
      [idField]: id,
      createdAt: now,
      updatedAt: now,
    };

    if (!lifecycle) {
      // Natural-key upserts intentionally do not add a second fallback path.
      // If the incoming PK already belongs to a different row than the natural
      // key target, SQLite must surface the constraint violation instead of the
      // handler guessing which row identity should win.
      await db
        .insert(table)
        .values(insertValues)
        .onConflictDoUpdate({
          target: resolvedConflictTarget,
          set: {
            ...mappedValues,
            [idField]: id,
            updatedAt: now,
            createdAt: sql`COALESCE(${columns.createdAt}, excluded.created_at)`,
          },
        });

      ctx.setResult({ id });
      return;
    }

    const insertedRows = await db
      .insert(table)
      .values(insertValues)
      .onConflictDoNothing({
        target: resolvedConflictTarget,
      })
      .returning();

    if (insertedRows.length > 0) {
      // Intentionally awaited: lifecycle emissions are part of the mutation contract.
      await bus.emit(lifecycle.created, mapper(insertedRows[0]));
      ctx.setResult({ id });
      return;
    }

    const [updatedRow] = await db
      .update(table)
      .set({
        ...mappedValues,
        updatedAt: now,
      })
      .where(eq(columns[idField], id))
      .returning();

    if (updatedRow) {
      // Intentionally awaited: lifecycle emissions are part of the mutation contract.
      await bus.emit(lifecycle.updated, mapper(updatedRow));
    }

    ctx.setResult({ id });
  });
}

/**
 * Registers delete-by-id handler.
 * @param bus - Bus instance.
 * @param db - Database client.
 * @param config - Handler configuration.
 * @returns Cleanup function.
 */
function registerDeleteHandler<
  TTable extends SQLiteTable,
  ApiType extends Record<string, unknown>,
  TIdField extends Extract<keyof TTable['_']['columns'], string>,
  InputType extends Record<TIdField, string> & Record<string, unknown>,
  TSingularKey extends string,
>(
  bus: IMakaioBus,
  db: MakaioDatabase,
  config: {
    table: TTable;
    idField: TIdField;
    deleteSubject: DrizzleCrudConfig<TTable, ApiType, TIdField, InputType, TSingularKey>['subjects']['delete'];
  },
): () => void {
  const { table, idField, deleteSubject } = config;

  return bus.on(deleteSubject, async (ctx: RequestContext<DeletePayload, DeleteResponse>) => {
    const { id } = ctx.payload;
    const column = getTableColumns(table)[idField];
    const result = await db.delete(table).where(eq(column, id));
    // `result.rowsAffected` is the libsql / @libsql/client property name.
    // `bun:sqlite` via drizzle-orm/bun-sqlite exposes the same count as
    // `changes`. Both properties are read to support either runtime driver.
    const affected = (result.rowsAffected ?? Reflect.get(result, 'changes') ?? 0) as number;
    ctx.setResult({ deleted: affected > 0 });
  });
}

/**
 * Registers lifecycle wrapper for delete operations.
 * @param bus - Bus instance.
 * @param db - Database client.
 * @param config - Handler configuration.
 * @returns Cleanup function.
 */
function registerDeleteLifecycleHandler<
  TTable extends SQLiteTable,
  ApiType extends Record<string, unknown>,
  TIdField extends Extract<keyof TTable['_']['columns'], string>,
  InputType extends Record<TIdField, string> & Record<string, unknown>,
  TSingularKey extends string,
>(
  bus: IMakaioBus,
  db: MakaioDatabase,
  config: {
    table: TTable;
    idField: TIdField;
    singularKey: TSingularKey;
    getSubject: DrizzleCrudConfig<TTable, ApiType, TIdField, InputType, TSingularKey>['subjects']['get'];
    deleteSubject: DrizzleCrudConfig<TTable, ApiType, TIdField, InputType, TSingularKey>['subjects']['delete'];
    lifecycle: NonNullable<DrizzleCrudConfig<TTable, ApiType, TIdField, InputType, TSingularKey>['lifecycle']>;
  },
): () => void {
  const { table, idField, singularKey, getSubject, deleteSubject, lifecycle } = config;

  return bus.on(deleteSubject, async (ctx: RequestContext<DeletePayload, DeleteResponse>) => {
    const { id } = ctx.payload;
    const column = getTableColumns(table)[idField];
    const [existing] = await db.select({ id: column }).from(table).where(eq(column, id)).limit(1);

    await ctx.next();
    if (!existing) {
      return;
    }

    const entityResult = await bus.request(getSubject, { id });
    if (entityResult[singularKey]) {
      return;
    }
    await bus.emit(lifecycle.deleted, { id });
  });
}

/**
 * Creates standard get, set, delete handlers for a Drizzle table.
 * @param config - CRUD handler configuration.
 * @returns Function that registers handlers and returns cleanup.
 */
export function createDrizzleCrudHandlers<
  TTable extends SQLiteTable,
  ApiType extends Record<string, unknown>,
  TIdField extends Extract<keyof TTable['_']['columns'], string> = Extract<keyof TTable['_']['columns'], string>,
  InputType extends Record<TIdField, string> & Record<string, unknown> = ApiType extends Record<TIdField, string>
    ? ApiType
    : Record<TIdField, string> & Record<string, unknown>,
  TSingularKey extends string = string,
>(
  config: DrizzleCrudConfig<TTable, ApiType, TIdField, InputType, TSingularKey>,
): (bus: IMakaioBus, db: MakaioDatabase) => () => void {
  if (config.conflictTarget && config.lifecycle) {
    throw new Error(
      'createDrizzleCrudHandlers: conflictTarget is not yet compatible with lifecycle events. ' +
        'The lifecycle path uses a PK-based UPDATE fallback that cannot resolve rows by natural key.',
    );
  }

  const { table, subjects, idField, singularKey, mapper, toDbValues, conflictTarget, lifecycle } = config;
  const resolvedConflictTarget = resolveConflictTarget(table, idField, conflictTarget);

  return (bus: IMakaioBus, db: MakaioDatabase) => {
    const cleanups: Array<() => void> = [];

    cleanups.push(
      registerGetHandler(bus, db, {
        table,
        idField,
        singularKey,
        mapper,
        getSubject: subjects.get,
      }),
    );

    cleanups.push(
      registerSetHandler(bus, db, {
        table,
        idField,
        singularKey,
        mapper,
        toDbValues,
        setSubject: subjects.set,
        resolvedConflictTarget,
        lifecycle,
      }),
    );

    if (lifecycle) {
      cleanups.push(
        registerDeleteLifecycleHandler(bus, db, {
          table,
          idField,
          singularKey,
          getSubject: subjects.get,
          deleteSubject: subjects.delete,
          lifecycle,
        }),
      );
    }

    cleanups.push(
      registerDeleteHandler(bus, db, {
        table,
        idField,
        deleteSubject: subjects.delete,
      }),
    );

    return () => cleanups.forEach((fn) => fn());
  };
}
