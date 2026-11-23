import { expect, it, onTestFinished } from 'vitest';
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { createBusInstance } from '@makaio/bus-core';
import { createBusContext } from '@makaio/bus-core/kernel-api';
import { createBusNamespace, type Party } from '@makaio/core';
import { createTestCall } from '@makaio/test-utils';
import { createDbCleanup, createTempDb } from '@makaio/test-utils/drizzle-harness';
import { z } from 'zod';
import { createDrizzleCrudHandlers } from './crud-handlers';

const widgets = sqliteTable('widgets', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

const widgetInput = z.object({ id: z.string(), name: z.string() });
const widget = widgetInput.extend({ createdAt: z.number(), updatedAt: z.number() });
const byId = widgetInput.pick({ id: true });

it('forwards the mutation principal to lifecycle subscribers even when the caller cannot read the row', async () => {
  const bus = createBusInstance({ context: createBusContext() });
  const { subjects } = bus.registerNamespace(
    createBusNamespace('widget-storage-test', {
      get: { request: byId, response: z.object({ widget: widget.nullable() }) },
      set: { request: z.object({ widget: widgetInput }), response: byId },
      delete: { request: byId, response: z.object({ deleted: z.boolean() }) },
      created: widget,
      updated: widget,
      deleted: byId,
    }),
  );
  const registerCrud = createDrizzleCrudHandlers({
    table: widgets,
    subjects,
    idField: 'id',
    singularKey: 'widget',
    mapper: (row) => row,
    toDbValues: (input: z.infer<typeof widgetInput>) => input,
    lifecycle: subjects,
  });

  const db = await createTempDb('crud-handlers-call-context');
  onTestFinished(createDbCleanup(registerCrud(bus, db.db), db.close, db.dbPath));
  await db.exec(sql`
    CREATE TABLE widgets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  const created: Party[] = [];
  const updated: Party[] = [];
  const deleted: Party[] = [];
  bus.on(subjects.created, (ctx) => void created.push(ctx.call.principal));
  bus.on(subjects.updated, (ctx) => void updated.push(ctx.call.principal));
  bus.on(subjects.deleted, (ctx) => void deleted.push(ctx.call.principal));
  bus.on(
    subjects.get,
    () => {
      throw new Error('Read access denied');
    },
    { priority: 10 },
  );

  const call = createTestCall({ principal: { kind: 'example.user', id: 'widget-owner' } });
  await bus.request(call, subjects.set, { widget: { id: 'w1', name: 'original' } });
  await bus.request(call, subjects.set, { widget: { id: 'w1', name: 'updated' } });
  await expect
    .soft(bus.request(call, subjects.delete, { id: 'w1' }), 'delete result')
    .resolves.toEqual({ deleted: true });

  expect.soft(created, 'created event principal').toEqual([call.principal]);
  expect.soft(updated, 'updated event principal').toEqual([call.principal]);
  expect.soft(deleted, 'deleted event principal').toEqual([call.principal]);
});
