import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { MakaioBus } from '@makaio/bus-core';
import { z } from 'zod';
import { createStorageNamespace } from '@makaio/storage-core';
import { createDbCleanup, createTempDb, type TestDbContext } from '@makaio/test-utils/drizzle-harness';
import { createDrizzleCrudHandlers } from './crud-handlers.js';

const lifecycleTable = sqliteTable('lifecycle_entities', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

type LifecycleRow = typeof lifecycleTable.$inferSelect;
type LifecycleEntity = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
};
type LifecycleInput = {
  id: string;
  name: string;
};

const LifecycleEntitySchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const LifecycleStorageNamespace = createStorageNamespace('lifecycle-test-storage', {
  schemas: {
    get: {
      request: z.object({ id: z.string() }),
      response: z.object({ entity: LifecycleEntitySchema.nullable() }),
    },
    set: {
      request: z.object({ entity: z.object({ id: z.string(), name: z.string() }) }),
      response: z.object({ id: z.string() }),
    },
    delete: {
      request: z.object({ id: z.string() }),
      response: z.object({ deleted: z.boolean() }),
    },
  },
});

const LifecycleEventNamespace = MakaioBus.registerNamespace('lifecycle-test-events', {
  created: LifecycleEntitySchema,
  updated: LifecycleEntitySchema,
  deleted: z.object({ id: z.string() }),
});

const LifecycleStorageSubjects = LifecycleStorageNamespace.subjects;
const LifecycleEventSubjects = LifecycleEventNamespace.subjects;

function mapLifecycleEntity(row: LifecycleRow): LifecycleEntity {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toLifecycleDbValues(input: LifecycleInput): Partial<LifecycleRow> {
  return {
    id: input.id,
    name: input.name,
  };
}

describe('createDrizzleCrudHandlers lifecycle events', () => {
  let cleanup: () => void;
  let ctx: TestDbContext;

  beforeEach(async () => {
    ctx = await createTempDb('crud-handlers-lifecycle');
    await ctx.db.run(sql`
      CREATE TABLE lifecycle_entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    const registerCrud = createDrizzleCrudHandlers({
      table: lifecycleTable,
      subjects: {
        get: LifecycleStorageSubjects.get,
        set: LifecycleStorageSubjects.set,
        delete: LifecycleStorageSubjects.delete,
      },
      idField: 'id' as const,
      singularKey: 'entity',
      mapper: mapLifecycleEntity,
      toDbValues: toLifecycleDbValues,
      lifecycle: {
        created: LifecycleEventSubjects.created,
        updated: LifecycleEventSubjects.updated,
        deleted: LifecycleEventSubjects.deleted,
      },
    });

    cleanup = createDbCleanup(registerCrud(MakaioBus, ctx.db), ctx.close, ctx.dbPath);
  });

  afterEach(() => cleanup());

  it('emits created for inserts and updated for upserts', async () => {
    const created = vi.fn();
    const updated = vi.fn();
    const offCreated = MakaioBus.on(LifecycleEventSubjects.created, (event) => created(event.payload));
    const offUpdated = MakaioBus.on(LifecycleEventSubjects.updated, (event) => updated(event.payload));

    await MakaioBus.request(LifecycleStorageSubjects.set, { entity: { id: 'e1', name: 'first' } });
    await MakaioBus.request(LifecycleStorageSubjects.set, { entity: { id: 'e1', name: 'second' } });

    offCreated();
    offUpdated();

    expect(created).toHaveBeenCalledTimes(1);
    expect(updated).toHaveBeenCalledTimes(1);
    expect(created).toHaveBeenCalledWith(expect.objectContaining({ id: 'e1', name: 'first' }));
    expect(updated).toHaveBeenCalledWith(expect.objectContaining({ id: 'e1', name: 'second' }));
  });

  it('emits exactly one created + one updated for concurrent upserts on the same id', async () => {
    const created = vi.fn();
    const updated = vi.fn();
    const offCreated = MakaioBus.on(LifecycleEventSubjects.created, (event) => created(event.payload));
    const offUpdated = MakaioBus.on(LifecycleEventSubjects.updated, (event) => updated(event.payload));

    await Promise.all([
      MakaioBus.request(LifecycleStorageSubjects.set, { entity: { id: 'race-1', name: 'first-write' } }),
      MakaioBus.request(LifecycleStorageSubjects.set, { entity: { id: 'race-1', name: 'second-write' } }),
    ]);

    offCreated();
    offUpdated();

    expect(created).toHaveBeenCalledTimes(1);
    expect(updated).toHaveBeenCalledTimes(1);
  });

  it('emits deleted only when a row existed and was removed', async () => {
    const deleted = vi.fn();
    const offDeleted = MakaioBus.on(LifecycleEventSubjects.deleted, (event) => deleted(event.payload));

    await MakaioBus.request(LifecycleStorageSubjects.delete, { id: 'missing' });
    await MakaioBus.request(LifecycleStorageSubjects.set, { entity: { id: 'e2', name: 'to-delete' } });
    await MakaioBus.request(LifecycleStorageSubjects.delete, { id: 'e2' });

    offDeleted();

    expect(deleted).toHaveBeenCalledTimes(1);
    expect(deleted).toHaveBeenCalledWith({ id: 'e2' });
  });
});
