import { index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { index as pgIndex, uniqueIndex as pgUniqueIndex } from 'drizzle-orm/pg-core';
import { defineDualTable } from '@makaio/storage-drizzle';
import type { WorkflowFinalizationIntent } from '@makaio/contracts';
import { workflowExecutionsDual } from './schema.js';

/** Durable lifecycle-finalizer claim and settlement record. */
export const workflowFinalizationsDual = defineDualTable(
  'workflow_finalizations',
  (c) => ({
    executionId: c
      .text('execution_id')
      .primaryKey()
      .references(() => workflowExecutionsDual.columnPair('id'), { onDelete: 'cascade' }),
    workflowId: c.text('workflow_id').notNull(),
    finalizerId: c.text('finalizer_id').notNull(),
    transitionKey: c.text('transition_key').notNull(),
    claimToken: c.text('claim_token').notNull(),
    intent: c.jsonCol<WorkflowFinalizationIntent>('intent').notNull(),
    state: c.textEnum('state', { enum: ['claimed', 'acknowledged', 'failed'] as const }).notNull(),
    claimedAt: c.epochMs('claimed_at').notNull(),
    settledAt: c.epochMs('settled_at'),
    failure: c.text('failure'),
    /** Set only after the terminal lifecycle event has been emitted. */
    publishedAt: c.epochMs('published_at'),
  }),
  {
    sqlite: (t) => [
      uniqueIndex('uniq_workflow_finalizations_transition').on(t.transitionKey),
      index('idx_workflow_finalizations_recovery').on(t.finalizerId, t.state),
    ],
    postgres: (t) => [
      pgUniqueIndex('uniq_workflow_finalizations_transition').on(t.transitionKey),
      pgIndex('idx_workflow_finalizations_recovery').on(t.finalizerId, t.state),
    ],
  },
);

/** SQLite face of the workflow finalization table. */
export const workflowFinalizations = workflowFinalizationsDual.sqlite;
/** Postgres face of the workflow finalization table. */
export const workflowFinalizationsPostgres = workflowFinalizationsDual.postgres;

export type WorkflowFinalizationRow = typeof workflowFinalizations.$inferSelect;
