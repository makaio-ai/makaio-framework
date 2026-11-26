import type { HostTransaction } from '@makaio/contracts';
import type { WorkerRunIdentityRequest } from '@makaio/contracts/boundary';
import { CorePartyKind } from '@makaio/core';
import { digestWorkerRuntimeSecret, matchesWorkerCredential } from './credential-digest.js';
import { readIssuerIdentityKey } from './issuer-identity-key.js';
import { hasOpenDeadline, lockDispatch } from './start-claim.js';
import type { WorkerStartOptions } from './start-order.js';

/**
 * Verify a previously issued identity in its owner's transaction.
 * @param host - Host access to the booked run and its dispatch.
 * @param presentation - Run identity received on the protected setup connection.
 * @param signal - Combined lifetime of the exchange and host.
 * @param markVerified - Permit transient failure reporting once the locked identity is verified.
 * @returns Admission metadata from the original redemption, without the order.
 */
export async function verifyWorkerRunIdentity(
  host: WorkerStartOptions,
  presentation: WorkerRunIdentityRequest,
  signal: AbortSignal,
  markVerified: (revocationKey: string) => void,
) {
  const { jobRunId, runtimeSecret } = presentation;
  const digest = digestWorkerRuntimeSecret(runtimeSecret);
  const advisory = await host.source.readRedemptionCredentials?.(jobRunId, signal);
  signal.throwIfAborted();
  if (!matchesWorkerCredential(advisory?.runtimeDigest, digest)) return undefined;

  return host.database.transaction(
    async (tx) => {
      const identity = await readLiveWorkerRunIdentity(tx, host, jobRunId, signal);
      if (!matchesWorkerCredential(identity?.runtimeDigest, digest) || identity === undefined) return undefined;
      const { party, expiresAt, revocationKey } = identity;
      markVerified(revocationKey);
      return { party, expiresAt, revocationKey };
    },
    { signal },
  );
}

/**
 * Resolve the same authoritative live identity for authentication and final promotion.
 * @param tx - Transaction holding the run and dispatch snapshot.
 * @param host - Authoritative source of the booked run.
 * @param jobRunId - Run to inspect.
 * @param signal - Lifetime of the worker exchange.
 * @returns The current identity and its acceptance metadata.
 */
export async function readLiveWorkerRunIdentity(
  tx: HostTransaction,
  host: Pick<WorkerStartOptions, 'source'>,
  jobRunId: string,
  signal: AbortSignal,
) {
  const locked = await lockDispatch(tx, host, jobRunId, signal);
  const redemption = locked?.order.redemption;
  const stored = redemption?.stored;
  if (
    locked?.order.state !== 'redeemed' ||
    locked.claim.shutdownEnded !== undefined ||
    locked.claim.boundAllocation === null ||
    locked.claim.settled !== null ||
    redemption?.tokenRevoked !== false ||
    stored === undefined
  ) {
    return undefined;
  }
  const { party, expiresAt } = stored.accepted;
  const revocationKey = readIssuerIdentityKey(redemption);
  if (
    party.kind !== CorePartyKind.jobRun ||
    party.id !== jobRunId ||
    revocationKey === undefined ||
    !hasOpenDeadline(expiresAt)
  ) {
    return undefined;
  }
  return { party: { kind: party.kind, id: party.id }, expiresAt, revocationKey, runtimeDigest: stored.runtimeDigest };
}
