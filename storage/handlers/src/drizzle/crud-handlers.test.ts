import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { text, integer, sqliteTable, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { MakaioBus, RequestError } from '@makaio/bus-core';
import { createBusNamespace } from '@makaio/core';
import { z } from 'zod';
import { createTempDb, createDbCleanup, type TestDbContext } from '@makaio/test-utils/drizzle-harness';
import { createStorageNamespaceDefinition } from '@makaio/storage-core';
import { createDrizzleCrudHandlers } from './crud-handlers';
import type { DrizzleCrudConfig } from './types';

// Test schema and types
const testTable = sqliteTable('test_entities', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  value: integer('value'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

type DbRow = typeof testTable.$inferSelect;

type TestEntity = {
  id: string;
  name: string;
  description?: string;
  value?: number;
  createdAt: number;
  updatedAt: number;
};

type TestEntityInput = Omit<TestEntity, 'createdAt' | 'updatedAt'>;

const TestEntitySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  value: z.number().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const TestEntityInputSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  value: z.number().optional(),
});

const TestStorageNamespace = createStorageNamespaceDefinition('test', {
  schemas: {
    get: {
      request: z.object({ id: z.string() }),
      response: z.object({ entity: TestEntitySchema.nullable() }),
    },
    set: {
      request: z.object({ entity: TestEntityInputSchema }),
      response: z.object({ id: z.string() }),
    },
    delete: {
      request: z.object({ id: z.string() }),
      response: z.object({ deleted: z.boolean() }),
    },
  },
});

const TestStorageSubjects = TestStorageNamespace.subjects;

function mapEntity(row: DbRow): TestEntity {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    value: row.value ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toDbValues(entity: TestEntityInput): Partial<DbRow> {
  return {
    id: entity.id,
    name: entity.name,
    description: entity.description ?? null,
    value: entity.value ?? null,
  };
}

describe('createDrizzleCrudHandlers', () => {
  let cleanup: () => void;
  let ctx: TestDbContext;

  beforeEach(async () => {
    ctx = await createTempDb('crud-handlers');

    // Create test table
    await ctx.exec(sql`
      CREATE TABLE test_entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        value INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // Register handlers
    const registerCrud = createDrizzleCrudHandlers({
      table: testTable,
      subjects: {
        get: TestStorageSubjects.get,
        set: TestStorageSubjects.set,
        delete: TestStorageSubjects.delete,
      },
      idField: 'id' as const,
      singularKey: 'entity',
      mapper: mapEntity,
      toDbValues,
    });

    const handlerCleanup = registerCrud(MakaioBus, ctx.db);
    cleanup = createDbCleanup(handlerCleanup, ctx.close, ctx.dbPath);
  });

  afterEach(() => cleanup());

  describe('set handler (upsert)', () => {
    it('creates new entity with timestamps', async () => {
      const beforeCreate = Date.now();

      const { id } = await MakaioBus.request(TestStorageSubjects.set, {
        entity: {
          id: 'test-1',
          name: 'Test Entity',
          description: 'A test entity',
          value: 42,
        },
      });

      expect(id).toBe('test-1');

      const { entity } = await MakaioBus.request(TestStorageSubjects.get, { id: 'test-1' });
      expect(entity).not.toBeNull();
      expect(entity?.name).toBe('Test Entity');
      expect(entity?.description).toBe('A test entity');
      expect(entity?.value).toBe(42);
      expect(entity?.createdAt).toBeGreaterThanOrEqual(beforeCreate);
      expect(entity?.updatedAt).toBe(entity?.createdAt);
    });

    it('creates entity with optional fields as undefined', async () => {
      const { id } = await MakaioBus.request(TestStorageSubjects.set, {
        entity: {
          id: 'test-2',
          name: 'Minimal Entity',
        },
      });

      expect(id).toBe('test-2');

      const { entity } = await MakaioBus.request(TestStorageSubjects.get, { id: 'test-2' });
      expect(entity?.description).toBeUndefined();
      expect(entity?.value).toBeUndefined();
    });

    it('preserves createdAt and updates updatedAt on update', async () => {
      // Create entity
      await MakaioBus.request(TestStorageSubjects.set, {
        entity: {
          id: 'test-3',
          name: 'Original Name',
          value: 10,
        },
      });

      const { entity: original } = await MakaioBus.request(TestStorageSubjects.get, { id: 'test-3' });
      expect(original).not.toBeNull();

      // Wait to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Update entity
      await MakaioBus.request(TestStorageSubjects.set, {
        entity: {
          id: 'test-3',
          name: 'Updated Name',
          value: 20,
        },
      });

      const { entity: updated } = await MakaioBus.request(TestStorageSubjects.get, { id: 'test-3' });
      expect(updated?.createdAt).toBe(original?.createdAt);
      expect(updated?.updatedAt).toBeGreaterThan(original?.updatedAt ?? 0);
      expect(updated?.name).toBe('Updated Name');
      expect(updated?.value).toBe(20);
    });

    it('updates entity and maintains field types', async () => {
      await MakaioBus.request(TestStorageSubjects.set, {
        entity: {
          id: 'test-4',
          name: 'Entity',
          description: 'Has description',
          value: 5,
        },
      });

      // Update to remove optional fields
      await MakaioBus.request(TestStorageSubjects.set, {
        entity: {
          id: 'test-4',
          name: 'Updated Entity',
        },
      });

      const { entity } = await MakaioBus.request(TestStorageSubjects.get, { id: 'test-4' });
      expect(entity?.name).toBe('Updated Entity');
      expect(entity?.description).toBeUndefined();
      expect(entity?.value).toBeUndefined();
    });
  });

  describe('get handler', () => {
    it('returns correctly mapped entity', async () => {
      await MakaioBus.request(TestStorageSubjects.set, {
        entity: {
          id: 'map-test',
          name: 'Mapper Test',
          description: 'Testing mapper',
          value: 99,
        },
      });

      const { entity } = await MakaioBus.request(TestStorageSubjects.get, { id: 'map-test' });
      expect(entity).toMatchObject({
        id: 'map-test',
        name: 'Mapper Test',
        description: 'Testing mapper',
        value: 99,
      });
      expect(typeof entity?.createdAt).toBe('number');
      expect(typeof entity?.updatedAt).toBe('number');
    });

    it('returns null for non-existent entity', async () => {
      const { entity } = await MakaioBus.request(TestStorageSubjects.get, { id: 'non-existent' });
      expect(entity).toBeNull();
    });

    it('maps null database values to undefined', async () => {
      await MakaioBus.request(TestStorageSubjects.set, {
        entity: {
          id: 'null-test',
          name: 'Null Test',
        },
      });

      const { entity } = await MakaioBus.request(TestStorageSubjects.get, { id: 'null-test' });
      expect(entity?.description).toBeUndefined();
      expect(entity?.value).toBeUndefined();
    });
  });

  describe('delete handler', () => {
    it('deletes existing entity and returns deleted: true', async () => {
      await MakaioBus.request(TestStorageSubjects.set, {
        entity: {
          id: 'delete-1',
          name: 'To Delete',
        },
      });

      const { deleted } = await MakaioBus.request(TestStorageSubjects.delete, { id: 'delete-1' });
      expect(deleted).toBe(true);

      const { entity } = await MakaioBus.request(TestStorageSubjects.get, { id: 'delete-1' });
      expect(entity).toBeNull();
    });

    it('returns deleted: false for non-existent entity', async () => {
      const { deleted } = await MakaioBus.request(TestStorageSubjects.delete, { id: 'never-existed' });
      expect(deleted).toBe(false);
    });

    it('allows re-creation after deletion', async () => {
      await MakaioBus.request(TestStorageSubjects.set, {
        entity: { id: 'delete-2', name: 'First' },
      });

      await MakaioBus.request(TestStorageSubjects.delete, { id: 'delete-2' });

      await MakaioBus.request(TestStorageSubjects.set, {
        entity: { id: 'delete-2', name: 'Second' },
      });

      const { entity } = await MakaioBus.request(TestStorageSubjects.get, { id: 'delete-2' });
      expect(entity?.name).toBe('Second');
    });
  });

  describe('integration: full lifecycle', () => {
    it('handles complete create-read-update-delete cycle', async () => {
      // Create
      const { id: createId } = await MakaioBus.request(TestStorageSubjects.set, {
        entity: { id: 'lifecycle', name: 'Initial', value: 1 },
      });
      expect(createId).toBe('lifecycle');

      // Read
      const { entity: created } = await MakaioBus.request(TestStorageSubjects.get, { id: 'lifecycle' });
      expect(created?.name).toBe('Initial');
      expect(created?.value).toBe(1);

      // Update
      await new Promise((resolve) => setTimeout(resolve, 100));
      await MakaioBus.request(TestStorageSubjects.set, {
        entity: { id: 'lifecycle', name: 'Updated', value: 2 },
      });

      // Read again
      const { entity: updated } = await MakaioBus.request(TestStorageSubjects.get, { id: 'lifecycle' });
      expect(updated?.name).toBe('Updated');
      expect(updated?.value).toBe(2);
      expect(updated?.createdAt).toBe(created?.createdAt);
      expect(updated?.updatedAt).toBeGreaterThan(created?.updatedAt ?? 0);

      // Delete
      const { deleted } = await MakaioBus.request(TestStorageSubjects.delete, { id: 'lifecycle' });
      expect(deleted).toBe(true);

      // Verify deletion
      const { entity: deletedEntity } = await MakaioBus.request(TestStorageSubjects.get, { id: 'lifecycle' });
      expect(deletedEntity).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// conflictTarget option
// ---------------------------------------------------------------------------

const conflictTargetTable = sqliteTable(
  'conflict_target_entities',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    scope: text('scope').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [uniqueIndex('uniq_conflict_target_entities_name_scope').on(t.name, t.scope)],
);

type ConflictTargetRow = typeof conflictTargetTable.$inferSelect;

type ConflictTargetEntity = {
  id: string;
  name: string;
  scope: string;
  createdAt: number;
  updatedAt: number;
};

type ConflictTargetInput = Omit<ConflictTargetEntity, 'createdAt' | 'updatedAt'>;
type ConflictTargetSubjectsConfig<
  TInput extends Record<'id', string> & Record<string, unknown> = ConflictTargetInput,
  TSingularKey extends string = 'entity',
> = DrizzleCrudConfig<typeof conflictTargetTable, ConflictTargetEntity, 'id', TInput, TSingularKey>['subjects'];
type ConflictTargetFixtureConfig<
  TInput extends Record<'id', string> & Record<string, unknown> = ConflictTargetInput,
  TSingularKey extends string = 'entity',
> = {
  dbName: string;
  subjects: ConflictTargetSubjectsConfig<TInput, TSingularKey>;
  singularKey: TSingularKey;
  toDbValues: (input: TInput) => Partial<ConflictTargetRow>;
  conflictTarget: NonNullable<
    DrizzleCrudConfig<typeof conflictTargetTable, ConflictTargetEntity, 'id', TInput, TSingularKey>['conflictTarget']
  >;
};

const ConflictTargetEntitySchema = z.object({
  id: z.string(),
  name: z.string(),
  scope: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const ConflictTargetInputSchema = z.object({
  id: z.string(),
  name: z.string(),
  scope: z.string(),
});

const ConflictTargetNamespace = createStorageNamespaceDefinition('conflict-target-test', {
  schemas: {
    get: {
      request: z.object({ id: z.string() }),
      response: z.object({ entity: ConflictTargetEntitySchema.nullable() }),
    },
    set: {
      request: z.object({ entity: ConflictTargetInputSchema }),
      response: z.object({ id: z.string() }),
    },
    delete: {
      request: z.object({ id: z.string() }),
      response: z.object({ deleted: z.boolean() }),
    },
  },
});

const ConflictTargetSubjects = ConflictTargetNamespace.subjects;

function mapConflictTargetEntity(row: ConflictTargetRow): ConflictTargetEntity {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toConflictTargetDbValues(input: ConflictTargetInput): Partial<ConflictTargetRow> {
  return {
    id: input.id,
    name: input.name,
    scope: input.scope,
  };
}

const defaultConflictTarget = (table: typeof conflictTargetTable) => [table.name, table.scope];

const defaultConflictTargetFixtureConfig: ConflictTargetFixtureConfig = {
  dbName: 'crud-handlers-conflict-target',
  subjects: ConflictTargetSubjects,
  singularKey: 'entity',
  toDbValues: toConflictTargetDbValues,
  conflictTarget: defaultConflictTarget,
};

async function createConflictTargetDb(dbName: string): Promise<TestDbContext> {
  const ctx = await createTempDb(dbName);

  await ctx.exec(sql`
    CREATE TABLE conflict_target_entities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      scope TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  await ctx.exec(sql`
    CREATE UNIQUE INDEX uniq_conflict_target_entities_name_scope
    ON conflict_target_entities (name, scope)
  `);

  return ctx;
}

async function setupConflictTargetFixture<
  TInput extends Record<'id', string> & Record<string, unknown>,
  TSingularKey extends string,
>(config: ConflictTargetFixtureConfig<TInput, TSingularKey>): Promise<{ cleanup: () => void; ctx: TestDbContext }> {
  const ctx = await createConflictTargetDb(config.dbName);
  const registerCrud = createDrizzleCrudHandlers<
    typeof conflictTargetTable,
    ConflictTargetEntity,
    'id',
    TInput,
    TSingularKey
  >({
    table: conflictTargetTable,
    subjects: config.subjects,
    idField: 'id' as const,
    singularKey: config.singularKey,
    mapper: mapConflictTargetEntity,
    toDbValues: config.toDbValues,
    conflictTarget: config.conflictTarget,
  });

  return {
    ctx,
    cleanup: createDbCleanup(registerCrud(MakaioBus, ctx.db), ctx.close, ctx.dbPath),
  };
}

describe('createDrizzleCrudHandlers with conflictTarget', () => {
  let cleanup: () => void;

  beforeEach(async () => {
    ({ cleanup } = await setupConflictTargetFixture(defaultConflictTargetFixtureConfig));
  });

  afterEach(() => cleanup());

  describe('set handler (natural-key upsert)', () => {
    it('updates existing row on natural-key conflict and does not create a duplicate', async () => {
      // Insert the original row with id-1.
      await MakaioBus.request(ConflictTargetSubjects.set, {
        entity: { id: 'id-1', name: 'foo', scope: 'default' },
      });

      const { entity: original } = await MakaioBus.request(ConflictTargetSubjects.get, { id: 'id-1' });
      expect(original).not.toBeNull();

      // Wait to ensure a measurable timestamp difference on update.
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Upsert with a different PK but the same natural key (name + scope).
      // onConflictDoUpdate fires on the (name, scope) unique index: the
      // existing row is updated in place, including its PK column which is
      // part of mappedValues. After the upsert the row is addressable via
      // id-2; id-1 no longer exists.
      const { id: upsertedId } = await MakaioBus.request(ConflictTargetSubjects.set, {
        entity: { id: 'id-2', name: 'foo', scope: 'default' },
      });

      expect(upsertedId).toBe('id-2');

      // After the upsert the row is accessible under the incoming id (id-2)
      // because the handler explicitly writes [idField] in the SET clause.
      const { entity: afterUpsert } = await MakaioBus.request(ConflictTargetSubjects.get, { id: 'id-2' });
      expect(afterUpsert).not.toBeNull();
      // createdAt is preserved via COALESCE(created_at, excluded.created_at).
      expect(afterUpsert?.createdAt).toBe(original?.createdAt);
      expect(afterUpsert?.updatedAt).toBeGreaterThan(original?.updatedAt ?? 0);

      // No second row was created — the original PK (id-1) is gone.
      const { entity: oldRow } = await MakaioBus.request(ConflictTargetSubjects.get, { id: 'id-1' });
      expect(oldRow).toBeNull();
    });

    it('updates PK even when toDbValues omits it', async () => {
      // Re-register handlers with a toDbValues that deliberately excludes the PK.
      // This proves the handler writes [idField] in the SET clause independently.
      cleanup();

      const NoPkNamespace = createStorageNamespaceDefinition('conflict-target-no-pk-test', {
        schemas: {
          get: {
            request: z.object({ id: z.string() }),
            response: z.object({ entity: ConflictTargetEntitySchema.nullable() }),
          },
          set: {
            request: z.object({ entity: ConflictTargetInputSchema }),
            response: z.object({ id: z.string() }),
          },
          delete: {
            request: z.object({ id: z.string() }),
            response: z.object({ deleted: z.boolean() }),
          },
        },
      });

      ({ cleanup } = await setupConflictTargetFixture({
        dbName: 'crud-handlers-conflict-target-no-pk',
        subjects: NoPkNamespace.subjects,
        singularKey: 'entity',
        // Deliberately omit `id` — only map natural-key and data columns.
        toDbValues: (input: ConflictTargetInput) => ({
          name: input.name,
          scope: input.scope,
        }),
        conflictTarget: defaultConflictTarget,
      }));

      // Insert with id-1.
      await MakaioBus.request(NoPkNamespace.subjects.set, {
        entity: { id: 'id-1', name: 'bar', scope: 'global' },
      });

      // Upsert with id-2 on the same natural key — toDbValues does not include id,
      // so only the handler's explicit [idField]: id keeps the PK in sync.
      await MakaioBus.request(NoPkNamespace.subjects.set, {
        entity: { id: 'id-2', name: 'bar', scope: 'global' },
      });

      const { entity } = await MakaioBus.request(NoPkNamespace.subjects.get, { id: 'id-2' });
      expect(entity).not.toBeNull();
      expect(entity?.name).toBe('bar');

      // Old PK is gone.
      const { entity: old } = await MakaioBus.request(NoPkNamespace.subjects.get, { id: 'id-1' });
      expect(old).toBeNull();
    });

    it('throws at construction time when conflictTarget returns an empty array', () => {
      expect(() =>
        createDrizzleCrudHandlers({
          table: conflictTargetTable,
          subjects: {
            get: ConflictTargetSubjects.get,
            set: ConflictTargetSubjects.set,
            delete: ConflictTargetSubjects.delete,
          },
          idField: 'id' as const,
          singularKey: 'entity',
          mapper: mapConflictTargetEntity,
          toDbValues: toConflictTargetDbValues,
          conflictTarget: () => [],
        }),
      ).toThrow('conflictTarget returned an empty array');
    });

    it('resolves conflictTarget once at construction time', async () => {
      let calls = 0;
      cleanup();
      ({ cleanup } = await setupConflictTargetFixture({
        dbName: 'crud-handlers-conflict-target-resolved-once',
        subjects: ConflictTargetSubjects,
        singularKey: 'entity',
        toDbValues: toConflictTargetDbValues,
        conflictTarget: (t) => {
          calls += 1;
          return calls === 1 ? [t.name, t.scope] : [];
        },
      }));

      expect(calls).toBe(1);

      await MakaioBus.request(ConflictTargetSubjects.set, {
        entity: { id: 'id-1', name: 'stable', scope: 'default' },
      });

      await MakaioBus.request(ConflictTargetSubjects.set, {
        entity: { id: 'id-2', name: 'stable', scope: 'default' },
      });

      expect(calls).toBe(1);

      const { entity } = await MakaioBus.request(ConflictTargetSubjects.get, { id: 'id-2' });
      expect(entity).not.toBeNull();
      expect(entity?.name).toBe('stable');
    });

    it('rejects when PK identity conflicts with a different natural-key owner', async () => {
      await MakaioBus.request(ConflictTargetSubjects.set, {
        entity: { id: 'id-1', name: 'a', scope: 's' },
      });

      await MakaioBus.request(ConflictTargetSubjects.set, {
        entity: { id: 'id-2', name: 'b', scope: 's' },
      });

      try {
        await MakaioBus.request(ConflictTargetSubjects.set, {
          entity: { id: 'id-1', name: 'b', scope: 's' },
        });
        expect.unreachable('Expected natural-key upsert with conflicting PK owner to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(RequestError);
        if (error instanceof RequestError) {
          expect(error.cause).toBeInstanceOf(Error);
          expect(error.message).toContain('Failed query:');
        }
      }

      const { entity: firstRow } = await MakaioBus.request(ConflictTargetSubjects.get, { id: 'id-1' });
      const { entity: secondRow } = await MakaioBus.request(ConflictTargetSubjects.get, { id: 'id-2' });

      expect(firstRow).toMatchObject({ id: 'id-1', name: 'a', scope: 's' });
      expect(secondRow).toMatchObject({ id: 'id-2', name: 'b', scope: 's' });
    });
  });

  describe('construction-time guard', () => {
    it('throws synchronously when both conflictTarget and lifecycle are provided', () => {
      const LifecycleEventNamespace = MakaioBus.registerNamespace(
        createBusNamespace('conflict-target-lifecycle-guard-test', {
          created: ConflictTargetEntitySchema,
          updated: ConflictTargetEntitySchema,
          deleted: z.object({ id: z.string() }),
        }),
      );

      expect(() =>
        createDrizzleCrudHandlers({
          table: conflictTargetTable,
          subjects: {
            get: ConflictTargetSubjects.get,
            set: ConflictTargetSubjects.set,
            delete: ConflictTargetSubjects.delete,
          },
          idField: 'id' as const,
          singularKey: 'entity',
          mapper: mapConflictTargetEntity,
          toDbValues: toConflictTargetDbValues,
          conflictTarget: (t) => [t.name, t.scope],
          lifecycle: {
            created: LifecycleEventNamespace.subjects.created,
            updated: LifecycleEventNamespace.subjects.updated,
            deleted: LifecycleEventNamespace.subjects.deleted,
          },
        }),
      ).toThrow('conflictTarget is not yet compatible with lifecycle events');
    });
  });
});
