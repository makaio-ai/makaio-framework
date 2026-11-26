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
      const locked = await lockDispatch(tx, host, jobRunId, signal);
      const redemption = locked?.order.redemption;
      const stored = redemption?.stored;
      const matches = matchesWorkerCredential(stored?.runtimeDigest, digest);
      if (
        locked?.order.state !== 'redeemed' ||
        locked.claim.shutdownEnded !== undefined ||
        locked.claim.boundAllocation === null ||
        locked.claim.settled !== null ||
        redemption?.tokenRevoked !== false ||
        stored === undefined ||
        !matches
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
      markVerified(revocationKey);
      return { party: { kind: party.kind, id: party.id }, expiresAt, revocationKey };
    },
    { signal },
  );
}
