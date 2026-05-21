import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { text, integer, sqliteTable } from 'drizzle-orm/sqlite-core';
import { createTempDb, createDbCleanup, type TestDbContext } from '@makaio/test-utils/drizzle-harness';
import { buildScopePredicates } from './scope-predicates';

const scopedTable = sqliteTable('scoped_entities', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  scope: text('scope').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

describe('buildScopePredicates', () => {
  let cleanup: () => void;
  let ctx: TestDbContext;

  beforeEach(async () => {
    ctx = await createTempDb('scope-predicates');

    await ctx.db.run(sql`
      CREATE TABLE scoped_entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        scope TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    const now = Date.now();
    // Insert test data with various scopes
    await ctx.db.insert(scopedTable).values([
      { id: 'default-1', name: 'Default Entity 1', scope: 'default', createdAt: now, updatedAt: now },
      { id: 'default-2', name: 'Default Entity 2', scope: 'default', createdAt: now, updatedAt: now },
      { id: 'project-1-a', name: 'Project 1 Entity A', scope: 'project-1', createdAt: now, updatedAt: now },
      { id: 'project-1-b', name: 'Project 1 Entity B', scope: 'project-1', createdAt: now, updatedAt: now },
      { id: 'project-2-a', name: 'Project 2 Entity A', scope: 'project-2', createdAt: now, updatedAt: now },
      { id: 'other', name: 'Other Scope', scope: 'other-scope', createdAt: now, updatedAt: now },
    ]);

    cleanup = createDbCleanup(() => {}, ctx.close, ctx.dbPath);
  });

  afterEach(() => cleanup());

  describe('with projectId', () => {
    it('returns inArray predicate for default and projectId', async () => {
      const predicates = buildScopePredicates(scopedTable, 'project-1');

      expect(predicates).toHaveLength(1);

      // Query with the generated predicate
      const rows = await ctx.db.select().from(scopedTable).where(predicates[0]);

      expect(rows).toHaveLength(4);
      const scopes = rows.map((row) => row.scope);
      expect(scopes.filter((s) => s === 'default')).toHaveLength(2);
      expect(scopes.filter((s) => s === 'project-1')).toHaveLength(2);
    });

    it('includes default scope entities', async () => {
      const predicates = buildScopePredicates(scopedTable, 'project-1');

      const rows = await ctx.db.select().from(scopedTable).where(predicates[0]);

      const defaultEntities = rows.filter((row) => row.scope === 'default');
      expect(defaultEntities).toHaveLength(2);
      expect(defaultEntities.map((e) => e.id)).toContain('default-1');
      expect(defaultEntities.map((e) => e.id)).toContain('default-2');
    });

    it('includes project-scoped entities for the specified project', async () => {
      const predicates = buildScopePredicates(scopedTable, 'project-1');

      const rows = await ctx.db.select().from(scopedTable).where(predicates[0]);

      const projectEntities = rows.filter((row) => row.scope === 'project-1');
      expect(projectEntities).toHaveLength(2);
      expect(projectEntities.map((e) => e.id)).toContain('project-1-a');
      expect(projectEntities.map((e) => e.id)).toContain('project-1-b');
    });

    it('excludes entities from other projects', async () => {
      const predicates = buildScopePredicates(scopedTable, 'project-1');

      const rows = await ctx.db.select().from(scopedTable).where(predicates[0]);

      const otherProjectEntities = rows.filter((row) => row.scope === 'project-2');
      expect(otherProjectEntities).toHaveLength(0);
    });

    it('excludes entities from other scopes', async () => {
      const predicates = buildScopePredicates(scopedTable, 'project-1');

      const rows = await ctx.db.select().from(scopedTable).where(predicates[0]);

      const otherScopeEntities = rows.filter((row) => row.scope === 'other-scope');
      expect(otherScopeEntities).toHaveLength(0);
    });

    it('handles different project IDs correctly', async () => {
      const predicates = buildScopePredicates(scopedTable, 'project-2');

      const rows = await ctx.db.select().from(scopedTable).where(predicates[0]);

      expect(rows).toHaveLength(3);
      const scopes = rows.map((row) => row.scope);
      expect(scopes).toContain('default');
      expect(scopes).toContain('project-2');
      expect(scopes).not.toContain('project-1');
    });

    it('returns only default entities when projectId has no matches', async () => {
      const predicates = buildScopePredicates(scopedTable, 'non-existent-project');

      const rows = await ctx.db.select().from(scopedTable).where(predicates[0]);

      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.scope === 'default')).toBe(true);
    });
  });

  describe('without projectId', () => {
    it('returns eq predicate for default scope only', async () => {
      const predicates = buildScopePredicates(scopedTable, undefined);

      expect(predicates).toHaveLength(1);

      const rows = await ctx.db.select().from(scopedTable).where(predicates[0]);

      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.scope === 'default')).toBe(true);
    });

    it('returns only default scope entities', async () => {
      const predicates = buildScopePredicates(scopedTable, undefined);

      const rows = await ctx.db.select().from(scopedTable).where(predicates[0]);

      const ids = rows.map((row) => row.id);
      expect(ids).toContain('default-1');
      expect(ids).toContain('default-2');
      expect(ids).not.toContain('project-1-a');
      expect(ids).not.toContain('project-2-a');
    });

    it('excludes all project-scoped entities', async () => {
      const predicates = buildScopePredicates(scopedTable, undefined);

      const rows = await ctx.db.select().from(scopedTable).where(predicates[0]);

      const projectEntities = rows.filter((row) => row.scope.startsWith('project-'));
      expect(projectEntities).toHaveLength(0);
    });

    it('excludes other scopes', async () => {
      const predicates = buildScopePredicates(scopedTable, undefined);

      const rows = await ctx.db.select().from(scopedTable).where(predicates[0]);

      const otherScopeEntities = rows.filter((row) => row.scope === 'other-scope');
      expect(otherScopeEntities).toHaveLength(0);
    });
  });

  describe('predicate structure', () => {
    it('returns array with single SQL predicate when projectId provided', () => {
      const predicates = buildScopePredicates(scopedTable, 'project-1');
      expect(Array.isArray(predicates)).toBe(true);
      expect(predicates).toHaveLength(1);
    });

    it('returns array with single SQL predicate when projectId is undefined', () => {
      const predicates = buildScopePredicates(scopedTable, undefined);
      expect(Array.isArray(predicates)).toBe(true);
      expect(predicates).toHaveLength(1);
    });
  });

  describe('edge cases', () => {
    it('handles empty projectId string', async () => {
      const predicates = buildScopePredicates(scopedTable, '');

      // Empty string is falsy, should use default-only logic
      const rows = await ctx.db.select().from(scopedTable).where(predicates[0]);

      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.scope === 'default')).toBe(true);
    });

    it('handles special characters in projectId', async () => {
      const specialProjectId = 'project-with-dashes_and_underscores.123';
      const now = Date.now();

      await ctx.db.insert(scopedTable).values({
        id: 'special-proj',
        name: 'Special Project',
        scope: specialProjectId,
        createdAt: now,
        updatedAt: now,
      });

      const predicates = buildScopePredicates(scopedTable, specialProjectId);

      const rows = await ctx.db.select().from(scopedTable).where(predicates[0]);

      expect(rows.length).toBeGreaterThan(2);
      const specialEntity = rows.find((row) => row.id === 'special-proj');
      expect(specialEntity).toBeDefined();
      expect(specialEntity?.scope).toBe(specialProjectId);
    });

    it('handles table with only default scope entities', async () => {
      await ctx.db.delete(scopedTable).where(sql`scope != 'default'`);

      const predicatesWithProject = buildScopePredicates(scopedTable, 'any-project');
      const rowsWithProject = await ctx.db.select().from(scopedTable).where(predicatesWithProject[0]);

      expect(rowsWithProject).toHaveLength(2);
      expect(rowsWithProject.every((row) => row.scope === 'default')).toBe(true);

      const predicatesDefault = buildScopePredicates(scopedTable, undefined);
      const rowsDefault = await ctx.db.select().from(scopedTable).where(predicatesDefault[0]);

      expect(rowsDefault).toHaveLength(2);
    });

    it('handles table with no default scope entities', async () => {
      await ctx.db.delete(scopedTable).where(sql`scope = 'default'`);

      const predicates = buildScopePredicates(scopedTable, undefined);
      const rows = await ctx.db.select().from(scopedTable).where(predicates[0]);

      expect(rows).toHaveLength(0);
    });
  });
});
