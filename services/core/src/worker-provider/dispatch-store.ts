import type { HostTransaction, JobRunId, ProviderAllocationRef } from '@makaio/contracts';
import { defineDialectSchema, getTransactionQueryContext, resolveSchema } from '@makaio/storage-drizzle';
import { canonicalStringify } from '@makaio/utils';
import { eq, isNull, and } from 'drizzle-orm';
import { workerDispatch as postgres } from './storage/schema.postgres.js';
import { workerDispatch as sqlite, type LateAllocation } from './storage/schema.js';

const schema = defineDialectSchema({ dispatch: sqlite }, { dispatch: postgres });

/** Durable, secret-free dispatch state. */
export type DispatchClaim = typeof sqlite.$inferSelect;

/** New dispatch claim. */
export type NewDispatchClaim = Pick<DispatchClaim, 'jobRunId' | 'orderDigest' | 'binding'>;

/**
 * Load the claim in the run owner's transaction.
 * @param tx - Live host transaction.
 * @param jobRunId - Job run to read.
 * @returns The existing claim, if any.
 */
export async function readDispatch(tx: HostTransaction, jobRunId: JobRunId): Promise<DispatchClaim | undefined> {
  const query = getTransactionQueryContext(tx);
  const { dispatch } = resolveSchema(query, schema);
  const [row] = await query.select().from(dispatch).where(eq(dispatch.jobRunId, jobRunId));
  return row;
}

/**
 * Claim the only right to send for this run. The return value grants that right
 * only once the containing transaction is acknowledged.
 * @param tx - Transaction holding the run lock.
 * @param claim - Irrevocable dispatch identity.
 * @returns The inserted claim for the transaction winner.
 */
export async function insertDispatch(tx: HostTransaction, claim: NewDispatchClaim): Promise<DispatchClaim | undefined> {
  const query = getTransactionQueryContext(tx);
  const { dispatch } = resolveSchema(query, schema);
  const [row] = await query
    .insert(dispatch)
    .values({ ...claim, candidates: [] })
    .onConflictDoNothing({ target: dispatch.jobRunId })
    .returning();
  return row;
}

/**
 * Update a still-open claim while holding the run lock.
 * @param tx - Transaction holding the run lock.
 * @param claim - Current claim read under that lock.
 * @param update - Monotonic observation or cleanup evidence.
 * @returns The updated claim, or the already settled claim.
 */
export async function updateDispatch(
  tx: HostTransaction,
  claim: DispatchClaim,
  update: Partial<Pick<DispatchClaim, 'boundAllocation' | 'candidates' | 'sendSettled' | 'settled'>>,
): Promise<DispatchClaim> {
  const query = getTransactionQueryContext(tx);
  const { dispatch } = resolveSchema(query, schema);
  const [row] = await query
    .update(dispatch)
    .set(update)
    .where(and(eq(dispatch.jobRunId, claim.jobRunId), isNull(dispatch.settled)))
    .returning();
  return row ?? claim;
}

/**
 * Record a late allocation without changing the original settlement or binding.
 * @param tx - Transaction holding the run lock.
 * @param claim - Current claim read under that lock.
 * @param lateAllocation - Reference returned by the sender and its cleanup state.
 * @returns The claim with its independent cleanup diagnostic.
 */
export async function recordLateAllocation(
  tx: HostTransaction,
  claim: DispatchClaim,
  lateAllocation: LateAllocation,
): Promise<DispatchClaim> {
  if (claim.settled === null) return claim;
  const query = getTransactionQueryContext(tx);
  const { dispatch } = resolveSchema(query, schema);
  const [row] = await query
    .update(dispatch)
    .set({ sendSettled: true, settled: { ...claim.settled, lateAllocation } })
    .where(eq(dispatch.jobRunId, claim.jobRunId))
    .returning();
  return row ?? claim;
}

/**
 * Combine positive evidence without discarding previously observed candidates.
 * @param known - Durable candidate references.
 * @param observed - Newly observed references.
 * @returns The distinct references in observation order.
 */
export function mergeCandidates(
  known: readonly ProviderAllocationRef[],
  observed: readonly ProviderAllocationRef[],
): ProviderAllocationRef[] {
  return [...new Map([...known, ...observed].map((ref) => [canonicalStringify(ref), ref])).values()];
}

/**
 * Compare ordered provider references by their canonical JSON representation.
 * @param left - First reference.
 * @param right - Second reference.
 * @returns Whether both references have the same canonical representation.
 */
export function sameReference(left: ProviderAllocationRef, right: ProviderAllocationRef): boolean {
  return canonicalStringify(left) === canonicalStringify(right);
}
