import type { BoundedRecoveryEvidence, JobRunId, ProviderAllocationRef } from '@makaio/contracts';
import type { DispatchBinding } from '@makaio/contracts/extension';
import { defineDualTable } from '@makaio/storage-drizzle';

/** A returned allocation that contradicted a settled dispatch. */
export type LateAllocation = { reference: ProviderAllocationRef; state: 'pending' | 'ended' };

/** Settlement evidence with an optional, independent cleanup duty. */
type DispatchSettlement = BoundedRecoveryEvidence & { lateAllocation?: LateAllocation };

/** Candidate references and independent evidence from the sender and managed shutdown. */
type DispatchCandidates =
  | ProviderAllocationRef[]
  | {
      references: ProviderAllocationRef[];
      senderReference?: ProviderAllocationRef;
      shutdownEnded?: ProviderAllocationRef[];
    };

/** The confirmed allocation scope and confirmation metadata for this installation. */
export const workerAllocationScopeBindingDual = defineDualTable('worker_allocation_scope_binding', (c) => ({
  installation: c.text('installation').primaryKey(),
  allocationScope: c.text('allocation_scope').notNull(),
  confirmedAt: c.text('confirmed_at').notNull(),
  confirmedBy: c.text('confirmed_by').notNull(),
}));

/** Canonical SQLite schema for the scope binding. */
export const workerAllocationScopeBinding = workerAllocationScopeBindingDual.sqlite;

/** Durable dispatch claims. One host database serves one installation. */
export const workerDispatchDual = defineDualTable('worker_dispatch', (c) => ({
  jobRunId: c.text('job_run_id').primaryKey().$type<JobRunId>(),
  orderDigest: c.text('order_digest').notNull(),
  binding: c.jsonCol<DispatchBinding>('binding').notNull(),
  boundAllocation: c.jsonCol<ProviderAllocationRef>('bound_allocation'),
  candidates: c.jsonCol<DispatchCandidates>('candidates').notNull(),
  sendSettled: c.bool('send_settled').notNull().default(false),
  settled: c.jsonCol<DispatchSettlement>('settled'),
}));

/** SQLite face of the dispatch claim table. */
export const workerDispatch = workerDispatchDual.sqlite;
