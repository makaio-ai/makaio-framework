import type { HostTransaction, JobRunId, ProviderAllocationRef } from '@makaio/contracts';
import { defineDialectSchema, getTransactionQueryContext, resolveSchema } from '@makaio/storage-drizzle';
import { canonicalStringify } from '@makaio/utils';
import { eq, isNull, and } from 'drizzle-orm';
import { workerDispatch as postgres } from './storage/schema.postgres.js';
import { workerDispatch as sqlite, type LateAllocation } from './storage/schema.js';

const schema = defineDialectSchema({ dispatch: sqlite }, { dispatch: postgres });

type StoredDispatch = typeof sqlite.$inferSelect;

/** Durable, secret-free dispatch state. */
export type DispatchClaim = Omit<StoredDispatch, 'candidates'> & {
  candidates: ProviderAllocationRef[];
  /** The validated reference returned by the sole managed provision call. */
  senderReference?: ProviderAllocationRef;
  /** Positive termination evidence. Its presence opens reference-based shutdown cleanup. */
  shutdownEnded?: ProviderAllocationRef[];
};

/** New dispatch claim. */
export type NewDispatchClaim = Pick<DispatchClaim, 'jobRunId' | 'orderDigest' | 'binding'>;

/**
 * Decode the candidate list and its evidence. Legacy arrays carry no sender provenance.
 * @param row - Stored dispatch using the same JSON column for both representations.
 * @returns Dispatch decoded for supervision.
 */
function decodeDispatch({ candidates, ...row }: StoredDispatch): DispatchClaim {
  if (Array.isArray(candidates)) return { ...row, candidates };
  const { references, ...evidence } = candidates;
  return { ...row, candidates: references, ...evidence };
}

/**
 * Preserve independent evidence when replacing the stored candidate list.
 * @param references - All positively identified candidates.
 * @param evidence - Sender reference and managed shutdown evidence.
 * @returns The candidate data for the existing JSON column.
 */
function encodeCandidates(
  references: ProviderAllocationRef[],
  { senderReference, shutdownEnded }: Pick<DispatchClaim, 'senderReference' | 'shutdownEnded'>,
): StoredDispatch['candidates'] {
  return senderReference === undefined && shutdownEnded === undefined
    ? references
    : { references, senderReference, shutdownEnded };
}

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
  return row === undefined ? undefined : decodeDispatch(row);
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
  return row === undefined ? undefined : decodeDispatch(row);
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
  update: Partial<
    Pick<DispatchClaim, 'boundAllocation' | 'candidates' | 'senderReference' | 'sendSettled' | 'settled'>
  >,
): Promise<DispatchClaim> {
  const query = getTransactionQueryContext(tx);
  const { dispatch } = resolveSchema(query, schema);
  const { candidates, senderReference, ...fields } = update;
  const storedCandidates =
    candidates === undefined && senderReference === undefined
      ? undefined
      : encodeCandidates(candidates ?? claim.candidates, {
          senderReference: senderReference ?? claim.senderReference,
          shutdownEnded: claim.shutdownEnded,
        });
  const [row] = await query
    .update(dispatch)
    .set({ ...fields, candidates: storedCandidates })
    .where(and(eq(dispatch.jobRunId, claim.jobRunId), isNull(dispatch.settled)))
    .returning();
  return row === undefined ? claim : decodeDispatch(row);
}

/**
 * Confirm one candidate ended while keeping discovery and other cleanup duties open.
 * @param tx - Transaction holding the run lock.
 * @param claim - Current claim read under that lock.
 * @param reference - Exact candidate confirmed terminated.
 */
export async function recordShutdownTeardown(
  tx: HostTransaction,
  claim: DispatchClaim,
  reference: ProviderAllocationRef,
): Promise<void> {
  await saveShutdownCandidates(tx, claim, claim.candidates, mergeCandidates(claim.shutdownEnded ?? [], [reference]));
}

/**
 * Preserve a delayed positive observation independently of provider settlement.
 * @param tx - Transaction holding the run lock.
 * @param claim - Current managed dispatch.
 * @param observed - Positively correlated references from the completed observation.
 * @returns The claim with any added teardown duties.
 */
export async function recordShutdownObservation(
  tx: HostTransaction,
  claim: DispatchClaim,
  observed: readonly ProviderAllocationRef[],
): Promise<DispatchClaim> {
  if (claim.shutdownEnded === undefined) return claim;
  const references = mergeCandidates(claim.candidates, observed);
  if (references.length === claim.candidates.length) return claim;
  return saveShutdownCandidates(tx, claim, references, claim.shutdownEnded);
}

/**
 * Save only reference-scoped duties, leaving provider settlement and binding untouched.
 * @param tx - Transaction holding the run lock.
 * @param claim - Current managed dispatch.
 * @param references - All positively identified candidates.
 * @param shutdownEnded - Candidates with confirmed teardown.
 * @returns The claim with its updated teardown evidence.
 */
async function saveShutdownCandidates(
  tx: HostTransaction,
  claim: DispatchClaim,
  references: ProviderAllocationRef[],
  shutdownEnded: ProviderAllocationRef[],
): Promise<DispatchClaim> {
  const query = getTransactionQueryContext(tx);
  const { dispatch } = resolveSchema(query, schema);
  const [row] = await query
    .update(dispatch)
    .set({ candidates: encodeCandidates(references, { senderReference: claim.senderReference, shutdownEnded }) })
    .where(eq(dispatch.jobRunId, claim.jobRunId))
    .returning();
  return row === undefined ? claim : decodeDispatch(row);
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
  return row === undefined ? claim : decodeDispatch(row);
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
