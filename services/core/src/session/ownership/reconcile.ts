import {
  SessionOwnershipStorageSubjects,
  type AdapterSessionClaimRecord,
  type SessionOwnershipReconciledClaim,
  type SessionOwnershipReconcileServiceResult,
  type SessionOwnershipReleaseResult,
} from '@makaio/contracts';
import type { OwnershipAuthorityContext } from './context.js';
import { assessClaimOwner } from './owner-liveness.js';

/**
 * Inspect this machine's claims and file `abandoned` against the ones whose
 * owner is provably gone.
 *
 * **Diagnostic, and only diagnostic.** The marking confers no authority: it
 * does not free a key, it does not delete a row, and it does not authorize a
 * takeover — a takeover is a storage predicate over the incumbent's own agent
 * row, which never looks at a claim's status. In particular
 * `adapter-instance-gone`, the one reason that is not storage-provable, files
 * `abandoned` so an operator can see it, and nothing more.
 *
 * The cost of that conservatism, stated rather than hidden: a claim whose agent
 * and session rows are live but whose owning **process** died stays `abandoned`
 * and keeps blocking its key until process death is made provable, or a human
 * intervenes. That is the same rule as retaining on a non-answer, applied
 * consistently instead of only where it is convenient.
 *
 * Idempotent by construction — marking an already-`abandoned` claim is a no-op,
 * so a second run changes nothing.
 * @param context - Composed authority context.
 * @returns Every claim seen with its verdict, or `skipped` without an identity.
 */
export async function runReconcile(
  context: OwnershipAuthorityContext,
): Promise<SessionOwnershipReconcileServiceResult> {
  const { machineId } = context;
  if (machineId === undefined) return { outcome: 'skipped', reason: 'machine-identity-unavailable' };

  const listed = await context.bus.requestOptional(SessionOwnershipStorageSubjects.listClaims, { machineId });
  // No ownership storage is not a failure: a host without it owns no claims, so
  // the honest report is a completed run over an empty claim set.
  if (!listed.handled) return { outcome: 'reconciled', machineId, claims: [] };

  const claims: SessionOwnershipReconciledClaim[] = [];
  for (const claim of listed.data.claims) {
    const reason = await assessClaimOwner(context.bus, context.topology, claim);
    if (reason === null) {
      claims.push({ claim, verdict: 'retained' });
      continue;
    }
    // Wave-1's single-claim `release` rather than the fan-out: reconcile is
    // acting on a *foreign* agent's claim and may only touch the generation it
    // actually assessed.
    const marked = await context.bus.request(SessionOwnershipStorageSubjects.release, {
      agentId: claim.agentId,
      claimToken: claim.claimToken,
      disposition: 'abandoned',
    });
    claims.push({ ...classifyMarking(claim, marked), reason });
  }

  return { outcome: 'reconciled', machineId, claims };
}

/**
 * Report what filing a reason actually did to the claim.
 *
 * The assessment and the write are two statements about a row that a concurrent
 * takeover, release or deletion may change in between, and only one of the four
 * responses means the reason was filed. Reporting them all as `abandoned` would
 * name a marking that never happened and hand an operator a row that does not
 * carry it — which is exactly what a diagnostic must not do.
 * @param assessed - The claim as the run read it.
 * @param marked - What the release answered.
 * @returns The claim to report and the verdict it earned.
 */
function classifyMarking(
  assessed: AdapterSessionClaimRecord,
  marked: SessionOwnershipReleaseResult,
): Pick<SessionOwnershipReconciledClaim, 'claim' | 'verdict'> {
  // No `default: never` guard, deliberately: the declared return type is not
  // optional, so a release outcome added later leaves this function with a code
  // path that returns nothing and the compiler names it. A runtime guard would
  // report the same omission strictly later, and only if the new outcome ever
  // occurred.
  switch (marked.outcome) {
    case 'marked':
      // The post-write row: the report describes the store, not the pre-write
      // view the run started from.
      return { claim: marked.claim, verdict: 'abandoned' };
    case 'not-owner':
      // The generation moved to another agent after the assessment, so the
      // reason no longer describes anyone. The holder is reported because it is
      // what the store now says about this key.
      return { claim: marked.holder, verdict: 'vanished' };
    case 'released':
    case 'not-found':
      // The row was given up or deleted in between. Nothing was filed and there
      // is nothing to file it on.
      return { claim: assessed, verdict: 'vanished' };
  }
}
