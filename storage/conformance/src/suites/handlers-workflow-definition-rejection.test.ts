/**
 * Dual-dialect conformance for stored-definition rejection and transactional rollback.
 *
 * The same four cases run against file-backed SQLite and, with
 * `MAKAIO_STORAGE_TEST_DIALECT=postgres` and `MAKAIO_STORAGE_TEST_URL`, against
 * live PostgreSQL: a mixed list with one unreadable row, a single get of an
 * unreadable identifier, a rejected upsert that retains the invalid stored
 * column untouched, and the same upsert succeeding once the retained column is
 * replaced. The unreadable row is seeded with a value that is valid JSON but
 * not a valid `WorkflowDefinition` schema fragment (`input_schema = 1`), which
 * both dialects can store.
 */
import { expect, it } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';
import { createBusInstance } from '@makaio/bus-core';
import { isDefinitionInvalidError, WorkflowNamespace, WorkflowSubjects } from '@makaio/contracts';
import {
  registerDrizzleWorkflowStorage,
  WorkflowStorageNamespace,
  WorkflowStorageSubjects,
} from '@makaio/subsystem-workflow-engine';
import type { MakaioDatabase, StorageDialect } from '@makaio/storage-drizzle';
import type { StorageDatabaseContext } from '../harness/config.js';
import { describeStorageConformance } from '../harness/env.js';
import { useSuiteDatabaseContext } from '../harness/suite-context.js';

const createdAt = 1_000;

/**
 * Create an isolated bus backed by one database handle.
 * @param db - Database handle used by the storage handlers.
 * @returns Bus, its own call context and cleanup.
 */
function createWorkflowStorageBus(db: MakaioDatabase) {
  const bus = createBusInstance();
  bus.registerNamespace(WorkflowNamespace);
  bus.registerNamespace(WorkflowStorageNamespace);
  const cleanup = registerDrizzleWorkflowStorage(bus, db);
  return { bus, call: bus.own('start'), cleanup };
}

/**
 * Bind a JSON value for the active dialect (`jsonb` on Postgres, text on SQLite).
 * @param dialect - Active dialect.
 * @param value - JSON-serializable value.
 * @returns SQL fragment.
 */
function jsonValue(dialect: StorageDialect, value: unknown): SQL {
  const text = JSON.stringify(value);
  return dialect === 'postgres' ? sql`${text}::jsonb` : sql`${text}`;
}

/**
 * Minimal valid root sequence tree for a storable workflow definition.
 * @param nodeId - Identifier of the sole code-step node.
 * @returns Root sequence JSON.
 */
function minimalRoot(nodeId: string) {
  return { type: 'sequence' as const, id: `${nodeId}__root`, nodes: [{ type: 'code-step' as const, id: nodeId }] };
}

/**
 * Build a minimal valid workflow definition for `WorkflowStorageSubjects.set`.
 * @param id - Workflow identifier.
 * @returns Workflow definition without an `inputSchema`.
 */
function minimalDefinition(id: string) {
  return { id, name: id, root: minimalRoot(`${id}-step`), scope: { type: 'global' as const } };
}

/**
 * Insert stored rows directly, including invalid schema fragments supported by both dialects.
 * @param ctx - Conformance database context.
 * @param dialect - Active dialect.
 * @param rows - Identifiers and optional input schema values to persist.
 */
async function insertRows(
  ctx: StorageDatabaseContext,
  dialect: StorageDialect,
  rows: readonly { id: string; inputSchema?: number }[],
): Promise<void> {
  for (const { id, inputSchema } of rows) {
    await ctx.executor.run(sql`
      INSERT INTO workflow_definitions (id, name, root, input_schema, scope_type, created_at, updated_at)
      VALUES (
        ${id}, ${id}, ${jsonValue(dialect, minimalRoot(`${id}-step`))},
        ${inputSchema === undefined ? sql`NULL` : jsonValue(dialect, inputSchema)},
        'global', ${createdAt}, ${createdAt}
      )
    `);
  }
}

/**
 * Read every persisted column, including timestamps, without definition decoding.
 * @param ctx - Conformance database context.
 * @param id - Workflow identifier.
 * @returns The single raw stored row.
 */
async function readRawRow(ctx: StorageDatabaseContext, id: string) {
  const rows = await ctx.executor.all<Record<string, unknown>>(
    sql`SELECT * FROM workflow_definitions WHERE id = ${id}`,
  );
  expect(rows).toHaveLength(1);
  return rows[0];
}

describeStorageConformance('workflow definition rejection', (config) => {
  const getCtx = useSuiteDatabaseContext(config);

  it('lists readable definitions and reports an unreadable row without throwing or deleting it', async () => {
    const ctx = getCtx();
    const readableSeededId = `wfr-list-seeded-${crypto.randomUUID()}`;
    const readableSetId = `wfr-list-set-${crypto.randomUUID()}`;
    const unreadableId = `wfr-list-bad-${crypto.randomUUID()}`;
    await insertRows(ctx, config.dialect, [{ id: readableSeededId }, { id: unreadableId, inputSchema: 1 }]);
    const rawBefore = await readRawRow(ctx, unreadableId);
    const storage = createWorkflowStorageBus(ctx.db);
    try {
      await storage.bus.request(storage.call, WorkflowStorageSubjects.set, {
        workflow: minimalDefinition(readableSetId),
      });
      const response = await storage.bus.request(storage.call, WorkflowStorageSubjects.list, {});
      const ids = response.workflows.map((workflow) => workflow.id);
      expect(ids.sort()).toEqual([readableSeededId, readableSetId].sort());
      expect(response.rejected).toEqual([{ id: unreadableId, reason: expect.stringContaining('inputSchema') }]);
      // The raw row, not just the report, proves nothing was deleted.
      const rawAfterList = await readRawRow(ctx, unreadableId);
      expect(rawAfterList).toEqual(rawBefore);
    } finally {
      storage.cleanup();
    }
  });

  it('rejects a single get of the unreadable row and succeeds for a readable one', async () => {
    const ctx = getCtx();
    const readableId = `wfr-get-ok-${crypto.randomUUID()}`;
    const unreadableId = `wfr-get-bad-${crypto.randomUUID()}`;
    await insertRows(ctx, config.dialect, [{ id: readableId }, { id: unreadableId, inputSchema: 1 }]);
    const rawBefore = await readRawRow(ctx, unreadableId);
    const storage = createWorkflowStorageBus(ctx.db);
    try {
      await expect(
        storage.bus.request(storage.call, WorkflowStorageSubjects.get, { id: unreadableId }),
      ).rejects.toSatisfy(
        (error: unknown) =>
          isDefinitionInvalidError(error) &&
          error instanceof Error &&
          error.message.includes(unreadableId) &&
          error.message.includes('inputSchema'),
      );
      // The rejected get must not have deleted the raw row either.
      const rawAfterGet = await readRawRow(ctx, unreadableId);
      expect(rawAfterGet).toEqual(rawBefore);
      await expect(
        storage.bus.request(storage.call, WorkflowStorageSubjects.get, { id: readableId }),
      ).resolves.toMatchObject({ workflow: { id: readableId } });
    } finally {
      storage.cleanup();
    }
  });

  it('rejects a correction upsert that omits inputSchema and leaves the invalid stored column untouched', async () => {
    const ctx = getCtx();
    const id = `wfr-set-reject-${crypto.randomUUID()}`;
    await insertRows(ctx, config.dialect, [{ id, inputSchema: 1 }]);
    const before = await readRawRow(ctx, id);
    const storage = createWorkflowStorageBus(ctx.db);
    const events: string[] = [];
    const subscriptions = [
      ['created', WorkflowSubjects.definition.created],
      ['updated', WorkflowSubjects.definition.updated],
      ['deleted', WorkflowSubjects.definition.deleted],
    ] as const;
    const unsubscribe = subscriptions.map(([name, subject]) =>
      storage.bus.on(subject, () => {
        events.push(name);
      }),
    );
    try {
      await expect(
        storage.bus.request(storage.call, WorkflowStorageSubjects.set, { workflow: minimalDefinition(id) }),
      ).rejects.toSatisfy((error: unknown) => isDefinitionInvalidError(error));
      const after = await readRawRow(ctx, id);
      expect(after).toEqual(before);
      expect(events).toEqual([]);
    } finally {
      for (const off of unsubscribe) off();
      storage.cleanup();
    }
  });

  it('succeeds and heals the row once a valid inputSchema replaces the retained invalid column', async () => {
    const ctx = getCtx();
    const id = `wfr-set-heal-${crypto.randomUUID()}`;
    await insertRows(ctx, config.dialect, [{ id, inputSchema: 1 }]);
    const storage = createWorkflowStorageBus(ctx.db);
    try {
      const inputSchema = { type: 'object' as const, properties: {} };
      await expect(
        storage.bus.request(storage.call, WorkflowStorageSubjects.set, {
          workflow: { ...minimalDefinition(id), inputSchema },
        }),
      ).resolves.toEqual({ id });
      await expect(storage.bus.request(storage.call, WorkflowStorageSubjects.get, { id })).resolves.toMatchObject({
        workflow: { id, inputSchema },
      });
    } finally {
      storage.cleanup();
    }
  });
});
