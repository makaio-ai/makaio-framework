import type { SQL } from 'drizzle-orm';
import type { RequestMessagePayload, SubjectDefinition } from '@makaio/core';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';

type RequestSubjectDefinition<
  Req extends Record<string, unknown>,
  Res extends Record<string, unknown>,
> = SubjectDefinition & {
  $meta: {
    payload: RequestMessagePayload<Req, Res>;
  };
};

type EventSubjectDefinition<Payload> = SubjectDefinition & {
  $meta: {
    payload: Payload;
  };
};

type TableRow<TTable extends SQLiteTable> = TTable['$inferSelect'];
type TableInsert<TTable extends SQLiteTable> = TTable['$inferInsert'];
type ColumnKey<TTable extends SQLiteTable> = Extract<keyof TTable['_']['columns'], string>;
type TimestampedRow = {
  createdAt: number;
  updatedAt: number;
};
type TimestampedTable<TTable extends SQLiteTable> = TableRow<TTable> extends TimestampedRow ? TTable : never;

/**
 * Lifecycle event subjects for CRUD operations.
 * @typeParam TEntity - API entity type emitted for create/update events
 */
export interface CrudLifecycleConfig<TEntity> {
  /** Emitted when a new entity is inserted */
  created: EventSubjectDefinition<TEntity>;
  /** Emitted when an existing entity is updated */
  updated: EventSubjectDefinition<TEntity>;
  /** Emitted when an entity is deleted */
  deleted: EventSubjectDefinition<{ id: string }>;
}

/**
 * Configuration for creating standard CRUD handlers.
 *
 * Type safety is enforced at the call site and validated at runtime through Zod schemas.
 * @typeParam TTable - Drizzle SQLite table type (unconstrained for flexibility)
 * @typeParam ApiType - API response entity type
 * @typeParam InputType - API input entity type (defaults to ApiType)
 * @typeParam DbRow - Database row type (explicitly specified for type safety)
 */
export interface DrizzleCrudConfig<
  TTable extends SQLiteTable,
  ApiType,
  TIdField extends ColumnKey<TTable> = ColumnKey<TTable>,
  InputType extends Record<TIdField, string> & Record<string, unknown> = ApiType extends Record<TIdField, string>
    ? ApiType
    : Record<TIdField, string> & Record<string, unknown>,
  TSingularKey extends string = string,
> {
  /** Drizzle table definition */
  table: TimestampedTable<TTable>;

  /** Storage subjects object with get, set, delete properties */
  subjects: {
    /** Subject for getting a single entity by ID */
    get: RequestSubjectDefinition<{ id: string }, Record<TSingularKey, ApiType | null>>;
    /** Subject for creating or updating an entity */
    set: RequestSubjectDefinition<Record<TSingularKey, InputType>, { id: string }>;
    /** Subject for deleting an entity by ID */
    delete: RequestSubjectDefinition<{ id: string }, { deleted: boolean }>;
  };

  /** Primary key field name on the table */
  idField: TIdField;

  /** Response key for single entity (e.g., 'profile') */
  singularKey: TSingularKey;

  /** Maps database row to API type */
  mapper: (row: TableRow<TTable>) => ApiType;

  /** Maps API input to database values for insert/update */
  toDbValues: (input: InputType) => Partial<TableInsert<TTable>>;

  /**
   * Optional conflict target columns for upsert identity.
   *
   * Defaults to the primary key column ({@link idField}). Override this when
   * the table has a natural-key unique index that should govern upsert identity
   * instead of the synthetic PK. The callback receives the table so callers can
   * reference column objects directly.
   *
   * **PK mutation:** When a conflict fires on the natural key and the incoming
   * `id` differs from the stored PK, the handler updates the PK column to the
   * incoming `id` (and returns it). Callers that enable this option must
   * tolerate non-stable primary keys across upserts.
   * @example
   * ```ts
   * // extension_configs has uniqueIndex('uniq_extension_configs_name_scope')
   * conflictTarget: (t) => [t.extensionName, t.scope],
   * ```
   */
  conflictTarget?: (table: TTable) => (SQLiteColumn | SQL)[];

  /**
   * Optional lifecycle event configuration.
   *
   * When provided, the factory emits created/updated/deleted events after
   * successful mutations via wrapper handlers.
   */
  lifecycle?: CrudLifecycleConfig<ApiType>;
}

/**
 * Configuration for creating a list handler.
 *
 * Type safety is enforced at the call site and validated at runtime through Zod schemas.
 * @typeParam TTable - Drizzle SQLite table type (unconstrained for flexibility)
 * @typeParam ApiType - API response entity type
 * @typeParam QueryPayload - Query payload type
 * @typeParam DbRow - Database row type (explicitly specified for type safety)
 */
export interface DrizzleListConfig<
  TTable extends SQLiteTable,
  ApiType,
  QueryPayload extends Record<string, unknown> = Record<string, unknown>,
  TPluralKey extends string = string,
  TSubject extends RequestSubjectDefinition<QueryPayload, Record<TPluralKey, ApiType[]>> = RequestSubjectDefinition<
    QueryPayload,
    Record<TPluralKey, ApiType[]>
  >,
> {
  /** Drizzle table definition */
  table: TTable;

  /** List subject from storage namespace */
  subject: TSubject;

  /** Response key for entity array (e.g., 'profiles') */
  pluralKey: TPluralKey;

  /** Maps database row to API type */
  mapper: (row: TableRow<TTable>) => ApiType;

  /** Builds query predicates from payload */
  buildPredicates: (payload: QueryPayload, table: TTable) => SQL[];
}
