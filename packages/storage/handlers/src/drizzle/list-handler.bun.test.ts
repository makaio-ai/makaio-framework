import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { sql, eq } from 'drizzle-orm';
import { text, integer, sqliteTable } from 'drizzle-orm/sqlite-core';
import { MakaioBus } from '@makaio/bus-core';
import { z } from 'zod';
import { createTempDb, createDbCleanup, type TestDbContext } from '@makaio/test-utils/drizzle-harness';
import { createStorageNamespaceDefinition } from '@makaio/storage-core';
import { createDrizzleListHandler } from './list-handler.js';
import { buildScopePredicates } from './scope-predicates.js';

// Test schema and types
const testTable = sqliteTable('test_items', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  category: text('category').notNull(),
  scope: text('scope').notNull(),
  value: integer('value'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

type DbRow = typeof testTable.$inferSelect;

type TestItem = {
  id: string;
  name: string;
  category: string;
  scope: string;
  value?: number;
  createdAt: number;
  updatedAt: number;
};

const TestItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string(),
  scope: z.string(),
  value: z.number().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const TestListQuerySchema = z.object({
  projectId: z.string().optional(),
  category: z.string().optional(),
  name: z.string().optional(),
});

type TestListQuery = z.infer<typeof TestListQuerySchema>;

const TestStorageNamespace = createStorageNamespaceDefinition('test-list', {
  schemas: {
    list: {
      request: TestListQuerySchema,
      response: z.object({ items: z.array(TestItemSchema) }),
    },
  },
});

const TestStorageSubjects = TestStorageNamespace.subjects;

function mapItem(row: DbRow): TestItem {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    scope: row.scope,
    value: row.value ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

describe('createDrizzleListHandler', () => {
  let cleanup: () => void;
  let ctx: TestDbContext;

  beforeEach(async () => {
    ctx = await createTempDb('list-handler');

    // Create test table
    await ctx.db.run(sql`
      CREATE TABLE test_items (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        scope TEXT NOT NULL,
        value INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // Register list handler with predicates
    const registerList = createDrizzleListHandler({
      table: testTable,
      subject: TestStorageSubjects.list,
      pluralKey: 'items',
      mapper: mapItem,
      buildPredicates: (payload: TestListQuery, table) => [
        ...buildScopePredicates(table, payload.projectId),
        ...(payload.category ? [eq(table.category, payload.category)] : []),
        ...(payload.name ? [eq(table.name, payload.name)] : []),
      ],
    });

    const handlerCleanup = registerList(MakaioBus, ctx.db);
    cleanup = createDbCleanup(handlerCleanup, ctx.close, ctx.dbPath);
  });

  afterEach(() => cleanup());

  describe('filtering with predicates', () => {
    beforeEach(async () => {
      const now = Date.now();
      // Insert test data
      await ctx.db.insert(testTable).values([
        {
          id: 'item-1',
          name: 'Widget A',
          category: 'widgets',
          scope: 'default',
          value: 10,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'item-2',
          name: 'Widget B',
          category: 'widgets',
          scope: 'default',
          value: 20,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'item-3',
          name: 'Gadget A',
          category: 'gadgets',
          scope: 'default',
          value: 30,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'item-4',
          name: 'Widget A',
          category: 'widgets',
          scope: 'project-1',
          value: 40,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'item-5',
          name: 'Widget C',
          category: 'widgets',
          scope: 'project-2',
          value: 50,
          createdAt: now,
          updatedAt: now,
        },
      ]);
    });

    it('filters by scope (default only)', async () => {
      const { items } = await MakaioBus.request(TestStorageSubjects.list, {});
      expect(items).toHaveLength(3);
      expect(items.every((item) => item.scope === 'default')).toBe(true);
    });

    it('filters by scope (default + projectId)', async () => {
      const { items } = await MakaioBus.request(TestStorageSubjects.list, {
        projectId: 'project-1',
      });
      expect(items).toHaveLength(4);
      const scopes = items.map((item) => item.scope);
      expect(scopes).toContain('default');
      expect(scopes).toContain('project-1');
      expect(scopes).not.toContain('project-2');
    });

    it('filters by scope and category', async () => {
      const { items } = await MakaioBus.request(TestStorageSubjects.list, {
        category: 'widgets',
      });
      expect(items).toHaveLength(2);
      expect(items.every((item) => item.category === 'widgets')).toBe(true);
      expect(items.every((item) => item.scope === 'default')).toBe(true);
    });

    it('filters by scope, category, and name', async () => {
      const { items } = await MakaioBus.request(TestStorageSubjects.list, {
        name: 'Widget A',
      });
      expect(items).toHaveLength(1);
      expect(items[0]?.name).toBe('Widget A');
      expect(items[0]?.scope).toBe('default');
    });

    it('filters with projectId and category', async () => {
      const { items } = await MakaioBus.request(TestStorageSubjects.list, {
        projectId: 'project-1',
        category: 'widgets',
      });
      expect(items).toHaveLength(3);
      expect(items.every((item) => item.category === 'widgets')).toBe(true);
    });

    it('filters with all predicates', async () => {
      const { items } = await MakaioBus.request(TestStorageSubjects.list, {
        projectId: 'project-1',
        category: 'widgets',
        name: 'Widget A',
      });
      expect(items).toHaveLength(2);
      const ids = items.map((item) => item.id);
      expect(ids).toContain('item-1');
      expect(ids).toContain('item-4');
    });

    it('returns empty array when no matches', async () => {
      const { items } = await MakaioBus.request(TestStorageSubjects.list, {
        category: 'non-existent',
      });
      expect(items).toHaveLength(0);
    });

    it('handles project scope with no matches', async () => {
      const { items } = await MakaioBus.request(TestStorageSubjects.list, {
        projectId: 'project-3',
      });
      expect(items).toHaveLength(3);
      expect(items.every((item) => item.scope === 'default')).toBe(true);
    });
  });

  describe('query with no optional predicates', () => {
    it('returns only scope-filtered results when no optional predicates match', async () => {
      const now = Date.now();
      await ctx.db.insert(testTable).values([
        {
          id: 'no-filter-1',
          name: 'Item 1',
          category: 'cat-a',
          scope: 'default',
          value: 1,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'no-filter-2',
          name: 'Item 2',
          category: 'cat-b',
          scope: 'default',
          value: 2,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'no-filter-3',
          name: 'Item 3',
          category: 'cat-c',
          scope: 'project-1',
          value: 3,
          createdAt: now,
          updatedAt: now,
        },
      ]);

      // Query with no optional filters (only scope predicates apply)
      const { items } = await MakaioBus.request(TestStorageSubjects.list, {});
      expect(items).toHaveLength(2);
      expect(items.every((item) => item.scope === 'default')).toBe(true);
    });
  });

  describe('mapper integration', () => {
    it('correctly maps all database rows to API type', async () => {
      const now = Date.now();
      await ctx.db.insert(testTable).values([
        {
          id: 'map-1',
          name: 'Mapped Item',
          category: 'test',
          scope: 'default',
          value: 42,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'map-2',
          name: 'Minimal Item',
          category: 'test',
          scope: 'default',
          value: null,
          createdAt: now,
          updatedAt: now,
        },
      ]);

      const { items } = await MakaioBus.request(TestStorageSubjects.list, {
        category: 'test',
      });

      expect(items).toHaveLength(2);
      expect(items[0]?.value).toBe(42);
      expect(items[1]?.value).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('handles empty table', async () => {
      const { items } = await MakaioBus.request(TestStorageSubjects.list, {});
      expect(items).toHaveLength(0);
      expect(items).toEqual([]);
    });

    it('handles single result', async () => {
      const now = Date.now();
      await ctx.db.insert(testTable).values({
        id: 'single',
        name: 'Only One',
        category: 'unique',
        scope: 'default',
        value: null,
        createdAt: now,
        updatedAt: now,
      });

      const { items } = await MakaioBus.request(TestStorageSubjects.list, {
        category: 'unique',
      });

      expect(items).toHaveLength(1);
      expect(items[0]?.id).toBe('single');
    });
  });
});
