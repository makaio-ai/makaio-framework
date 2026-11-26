import { isMintedCallContext } from '@makaio/bus-core';
import { ownCarrierOf } from '@makaio/bus-core/kernel-api';
import type { HostTransaction, JobRunId, ProviderAllocationRef } from '@makaio/contracts';
import type {
  ConnectionExchangeCommit,
  ConnectionExchangeRejected,
  ConnectionExchangeResult,
} from '@makaio/contracts/boundary';
import type { StartValueVisibility } from '@makaio/contracts/capabilities';
import { CorePartyKind, type CallContext } from '@makaio/core';
import { getHostTransactionQueryContext, markTransactionRollbackOnly } from '@makaio/storage-drizzle';
import { abortableWait, deepFreeze } from '@makaio/utils';
import type { ObservationWatch } from './allocation-observation-signal.js';
import {
  digestWorkerBootstrapToken,
  digestWorkerRuntimeSecret,
  matchesWorkerCredential,
  type WorkerCredentialDigest,
} from './credential-digest.js';
import { DispatchCandidateReadError, sameReference } from './dispatch-store.js';
import {
  bindDispatchProof,
  prepareDispatchProof,
  type PreparedDispatchProof,
  type UnresolvedDispatchCorrelation,
} from './redemption-binding.js';
import { hasOpenDeadline, lockDispatch } from './start-claim.js';
import type {
  CommittedWorkerOrder,
  LockedWorkerRedemption,
  StoredWorkerRedemption,
  WorkerStartOptions,
} from './start-order.js';

/** Presentation from the pre-session worker exchange. The secrets are never stored. */
export interface WorkerRedemptionPresentation {
  readonly jobRunId: JobRunId;
  readonly oneTimeToken: string;
  readonly runtimeSecret: string;
}

/** The dispatch host and its in-process authority for provider supervision. */
export interface WorkerRedemptionHost extends WorkerStartOptions {
  readonly supervisionCall: CallContext;
}

/** Safe failure from transaction work. The transport exposes only the exchange disposition. */
export class WorkerRedemptionError extends Error {
  /**
   * Report a failure without exposing proof or database details.
   * @param code - Disposition for the exchange caller.
   * @param message - Fixed, credential-free diagnosis.
   */
  public constructor(
    public readonly code: 'rejected' | 'retryable',
    message: string,
  ) {
    super(message);
    this.name = 'WorkerRedemptionError';
  }
}

interface RedemptionTarget {
  readonly generation: string;
  readonly orderDigest: string;
  readonly ownerKind: CommittedWorkerOrder['owner']['kind'];
  readonly ownerId: string;
}

interface RedemptionAttempt {
  readonly jobRunId: JobRunId;
  readonly tokenDigest: WorkerCredentialDigest;
  readonly runtimeDigest: WorkerCredentialDigest;
}

interface VerifiedOrder {
  readonly locked: NonNullable<Awaited<ReturnType<typeof lockDispatch>>>;
  readonly redemption: LockedWorkerRedemption;
}

type AllocationEvidence = {
  readonly ref: ProviderAllocationRef;
  readonly platformThrough?: number;
  readonly first?: PreparedDispatchProof;
};

const rejected: ConnectionExchangeRejected = Object.freeze({ reject: 'rejected' });
const maxTimerDelayMs = 2 ** 31 - 1;

interface PreparationLifetime {
  readonly signal: AbortSignal;
  readonly expiresAt: number;
  /** Tighten the active deadline without extending it. */
  shorten(deadline: number): void;
}

/**
 * Classify storage failures after proof, including wrapped driver errors.
 * Rejection is limited to unreadable candidates, SQLSTATE class 22 data errors, and constraint violations.
 * Infrastructure and programming errors remain retryable, even when typed.
 * @param error - Failure from the owner or dispatch store.
 * @returns Safe disposition for an exchange that has already proved its allocation.
 */
function storageDisposition(error: unknown): WorkerRedemptionError['code'] {
  const seen = new Set<Error>();
  while (error instanceof Error && !seen.has(error)) {
    if (error instanceof DispatchCandidateReadError) return 'rejected';
    const code = 'code' in error ? error.code : undefined;
    if (typeof code === 'string' && /^(?:2[23][0-9A-Z]{3}|SQLITE_CONSTRAINT(?:_[A-Z_]+)?)$/.test(code))
      return 'rejected';
    seen.add(error);
    error = error.cause;
  }
  return 'retryable';
}

/**
 * Reload the binding and credential state while holding the owner row lock.
 * @param host - Host dispatch and order storage.
 * @param tx - Live host transaction.
 * @param attempt - Hashed presentation.
 * @returns The locked order if the token still authorizes this attempt.
 */
async function verifyOrder(
  host: WorkerStartOptions,
  tx: HostTransaction,
  attempt: RedemptionAttempt,
): Promise<VerifiedOrder | undefined> {
  const locked = await lockDispatch(tx, host, attempt.jobRunId);
  const redemption = locked?.order.redemption;
  const tokenMatches = matchesWorkerCredential(redemption?.tokenDigest, attempt.tokenDigest);
  const runtimeMatches = matchesWorkerCredential(redemption?.stored?.runtimeDigest, attempt.runtimeDigest);
  if (
    locked === undefined ||
    locked.claim.shutdownEnded !== undefined ||
    redemption === undefined ||
    redemption.tokenRevoked ||
    !tokenMatches
  )
    return undefined;
  if (
    locked.order.state === 'ordered' &&
    redemption.stored === undefined &&
    redemption.issuerActive &&
    hasOpenDeadline(locked.order.order.bootstrapDeadlineAt)
  ) {
    return { locked, redemption };
  }
  if (
    locked.order.state !== 'redeemed' ||
    redemption.stored === undefined ||
    !hasOpenDeadline(redemption.stored.accepted.expiresAt) ||
    !runtimeMatches ||
    locked.claim.boundAllocation === null ||
    locked.claim.settled !== null
  )
    return undefined;
  return { locked, redemption };
}

/**
 * Collect fresh platform proof for a replay using its committed allocation.
 * @param current - Owner row and durable allocation from the initial check.
 * @param policy - Trusted visibility policy for this connection.
 * @param signal - Lifetime of this preparation attempt.
 * @returns Replay evidence if the presentation meets the original and current policies.
 */
async function prepareReplay(
  current: VerifiedOrder,
  policy: StartValueVisibility,
  signal: AbortSignal,
): Promise<AllocationEvidence | undefined> {
  const allocation = current.locked.claim.boundAllocation;
  if (allocation === null) return undefined;
  const ref = deepFreeze(structuredClone(allocation));
  if (policy.kind === 'allocation-only') {
    return current.redemption.stored?.requiresPlatformProof ? undefined : { ref };
  }
  signal.throwIfAborted();
  const deadline = await policy.verifyPlatform(structuredClone(ref), signal);
  if (deadline === undefined || !hasOpenDeadline(deadline)) return undefined;
  return { ref, platformThrough: Date.parse(deadline) };
}

/**
 * Select first-use or replay evidence without holding an open transaction.
 * @param host - Worker start composition.
 * @param supervisionCall - Authorized host call for provider observation.
 * @param current - Initially authenticated owner order.
 * @param policy - Host-selected proof policy.
 * @param attempt - Hashed presentation used to reload a competing winner.
 * @param signal - Lifetime of this preparation attempt.
 * @returns Proof for the current or winning binding, pending correlation, or rejection.
 */
async function prepareEvidence(
  host: WorkerStartOptions,
  supervisionCall: CallContext,
  current: VerifiedOrder,
  policy: StartValueVisibility,
  attempt: RedemptionAttempt,
  signal: AbortSignal,
): Promise<AllocationEvidence | UnresolvedDispatchCorrelation | undefined> {
  if (current.redemption.stored !== undefined) return prepareReplay(current, policy, signal).catch(() => undefined);
  const first = await prepareDispatchProof(host, supervisionCall, current.locked.claim, policy, {
    useSenderReference: true,
    signal,
  }).catch(() => undefined);
  signal.throwIfAborted();
  if (typeof first === 'object') {
    return { ref: first.ref, platformThrough: first.platformThrough, first };
  }
  // First-use liveness can disappear after a competing exchange commits.
  const winner = await readVerifiedOrder(host, attempt, signal);
  if (winner === undefined) return undefined;
  return winner.redemption.stored === undefined ? first : prepareReplay(winner, policy, signal).catch(() => undefined);
}

/**
 * Bound all preparation work, including the first credential lookup.
 * @param deadline - Trusted absolute connection deadline in milliseconds since the epoch.
 * @param hostSignal - Host operation lifetime.
 * @param work - Preparation work with access to the same deadline guard.
 * @returns Prepared work, or undefined when the attempt's lifetime ends.
 */
async function withinPreparationDeadline<T>(
  deadline: number,
  hostSignal: AbortSignal,
  work: (lifetime: PreparationLifetime) => Promise<T | undefined>,
): Promise<T | undefined> {
  const controller = new AbortController();
  const signal = AbortSignal.any([hostSignal, controller.signal]);
  let expiresAt = deadline;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Arm against the absolute deadline, including dates beyond the platform timer range. */
  function arm(): void {
    const remaining = expiresAt - Date.now();
    if (!(remaining > 0)) controller.abort();
    else timer = setTimeout(arm, Math.min(remaining, maxTimerDelayMs));
  }
  const lifetime: PreparationLifetime = {
    signal,
    get expiresAt() {
      return expiresAt;
    },
    shorten(bound) {
      signal.throwIfAborted();
      expiresAt = Math.min(expiresAt, bound);
      clearTimeout(timer);
      arm();
    },
  };
  arm();
  try {
    if (signal.aborted) return undefined;
    const prepared = await abortableWait(
      Promise.resolve().then(() => work(lifetime)),
      signal,
    );
    return !signal.aborted && expiresAt > Date.now() ? prepared : undefined;
  } catch (error) {
    if (!signal.aborted && expiresAt > Date.now()) throw error;
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Compute the result to persist using the booking's timing and reply.
 * @param order - Locked committed order.
 * @param redemption - Redemption fields of the locked order.
 * @param attempt - Hashed presentation.
 * @param requiresPlatformProof - Whether replay must verify platform proof.
 * @returns The initial identity and reply, if the timing is valid.
 */
function firstResult(
  order: CommittedWorkerOrder,
  redemption: LockedWorkerRedemption,
  attempt: RedemptionAttempt,
  requiresPlatformProof: boolean,
): StoredWorkerRedemption | undefined {
  const { maxRuntimeMs, cancellationWindowMs } = redemption;
  if (
    !Number.isSafeInteger(maxRuntimeMs) ||
    maxRuntimeMs <= 0 ||
    !Number.isSafeInteger(cancellationWindowMs) ||
    cancellationWindowMs < 0
  )
    return undefined;
  const redeemedAt = new Date();
  const expiresAt = new Date(redeemedAt.getTime() + maxRuntimeMs + cancellationWindowMs);
  if (!Number.isFinite(expiresAt.getTime())) return undefined;
  return {
    runtimeDigest: attempt.runtimeDigest,
    redeemedAt: redeemedAt.toISOString(),
    requiresPlatformProof,
    accepted: {
      party: { kind: CorePartyKind.jobRun, id: order.order.jobRunId },
      expiresAt: expiresAt.toISOString(),
      revocationKey: `worker-run:${order.order.jobRunId}`,
      payload: structuredClone(redemption.payload),
    },
  };
}

/**
 * Decide the exchange inside the owner transaction using only storage work.
 * @param tx - Borrowed transaction of the host.
 * @param current - Owner row reloaded under its lock.
 * @param attempt - Hashed presentation.
 * @param evidence - Proof prepared outside the transaction.
 * @returns The stored acceptance or a generic rejection.
 */
async function commitRedemption(
  tx: HostTransaction,
  current: VerifiedOrder,
  attempt: RedemptionAttempt,
  evidence: AllocationEvidence,
) {
  const { locked, redemption } = current;
  const { stored } = redemption;
  const { platformThrough } = evidence;
  if (platformThrough !== undefined && !(platformThrough > Date.now())) return rejected;
  if (stored !== undefined) {
    const ref = locked.claim.boundAllocation;
    return ref !== null &&
      sameReference(ref, evidence.ref) &&
      (!stored.requiresPlatformProof || platformThrough !== undefined)
      ? deepFreeze(structuredClone(stored.accepted))
      : rejected;
  }
  const result = firstResult(locked.order, redemption, attempt, platformThrough !== undefined);
  if (result === undefined || evidence.first === undefined || !(await bindDispatchProof(tx, locked, evidence.first)))
    return rejected;
  const committed = await redemption.accept(tx, result);
  if (committed === undefined) throw new Error('Run redemption update lost its lock condition');
  return deepFreeze(structuredClone(committed.accepted));
}

/**
 * Prepare the storage callback bound to the original connection and booking.
 * @param host - Host dispatch and order storage.
 * @param call - Original anonymous connection call.
 * @param attempt - Hashed presentation.
 * @param target - Booking identity captured before proof verification.
 * @param evidence - Frozen allocation evidence.
 * @param expiresAt - Effective exchange deadline in epoch milliseconds.
 * @returns A commit callback that rechecks authority under the run lock.
 */
function makeCommit(
  host: WorkerStartOptions,
  call: CallContext,
  attempt: RedemptionAttempt,
  target: RedemptionTarget,
  evidence: AllocationEvidence,
  expiresAt: number,
): ConnectionExchangeCommit {
  return Object.freeze<ConnectionExchangeCommit>({
    async commit(commitCall, tx) {
      if (commitCall !== call) return rejected;
      try {
        getHostTransactionQueryContext(host.database, tx);
      } catch {
        throw new WorkerRedemptionError('rejected', 'Run redemption requires the host transaction');
      }
      if (host.operationSignal.aborted) {
        throw new WorkerRedemptionError('rejected', 'Run redemption host stopped');
      }
      try {
        const locked = await verifyOrder(host, tx, attempt);
        if (locked === undefined || !matchesTarget(locked, target)) return rejected;
        return await commitRedemption(tx, locked, attempt, evidence);
      } catch (error) {
        const code = expiresAt > Date.now() ? storageDisposition(error) : 'rejected';
        const failure = new WorkerRedemptionError(code, 'Run redemption commit failed');
        markTransactionRollbackOnly(tx, failure);
        throw failure;
      }
    },
  });
}

/**
 * Screen the credentials without a write lock, then read the authoritative order.
 * @param host - Host dispatch and order storage.
 * @param attempt - Hashed presentation.
 * @param signal - Current preparation lifetime.
 * @param proof - Allocation proof from this exchange, if it has already passed.
 * @returns The verified snapshot, or undefined if the presentation is rejected.
 */
async function readVerifiedOrder(
  host: WorkerStartOptions,
  attempt: RedemptionAttempt,
  signal: AbortSignal,
  proof?: AllocationEvidence,
) {
  try {
    const { source } = host;
    if (signal.aborted || typeof source.readRedemptionCredentials !== 'function') return undefined;
    const { tokenDigest, runtimeDigest } = (await source.readRedemptionCredentials(attempt.jobRunId)) ?? {};
    const tokenMatches = matchesWorkerCredential(tokenDigest, attempt.tokenDigest);
    const runtimeMatches = matchesWorkerCredential(runtimeDigest, attempt.runtimeDigest);
    if (signal.aborted || !tokenMatches || (runtimeDigest !== undefined && !runtimeMatches)) return undefined;
    // Replay proof requires the stored runtime digest to remain present.
    // A matching digest that appeared after first-use proof can begin replay.
    if (proof !== undefined && proof.first === undefined && runtimeDigest === undefined) return undefined;
    return await host.database.transaction(async (tx) => (signal.aborted ? undefined : verifyOrder(host, tx, attempt)));
  } catch (error) {
    if (proof === undefined || storageDisposition(error) === 'rejected') return undefined;
    throw new WorkerRedemptionError('retryable', 'Run redemption storage read failed');
  }
}

/**
 * Check that preparation still targets the same booking and issuer.
 * @param current - Order and credentials read under the owner lock.
 * @param target - Booking captured before proof preparation.
 * @returns Whether the booking remained unchanged.
 */
function matchesTarget(current: VerifiedOrder, target: RedemptionTarget): boolean {
  const { owner, orderDigest } = current.locked.order;
  return (
    current.redemption.generation === target.generation &&
    orderDigest === target.orderDigest &&
    owner.kind === target.ownerKind &&
    owner.id === target.ownerId
  );
}

/**
 * Reread the booking after committed observations within the active preparation deadline.
 * @param host - Dispatch and supervision authority.
 * @param attempt - Hashed presentation.
 * @param target - Original booking being redeemed.
 * @param policy - Host-selected proof policy.
 * @param initial - Verified order and notification captured before reading it.
 * @param watch - Run-specific observation subscription.
 * @param signal - Shared preparation and observation lifetime.
 * @returns Proof for the original booking or rejection.
 */
async function prepareObservedEvidence(
  host: WorkerRedemptionHost,
  attempt: RedemptionAttempt,
  target: RedemptionTarget,
  policy: StartValueVisibility,
  initial: { order: VerifiedOrder; changed: Promise<void> },
  watch: ObservationWatch,
  signal: AbortSignal,
): Promise<AllocationEvidence | undefined> {
  let current: VerifiedOrder | undefined = initial.order;
  let changed = initial.changed;
  while (current !== undefined && matchesTarget(current, target)) {
    signal.throwIfAborted();
    const evidence = await prepareEvidence(host, host.supervisionCall, current, policy, attempt, signal);
    if (evidence === undefined) return undefined;
    if (typeof evidence === 'object') {
      const confirmed = await readVerifiedOrder(host, attempt, signal, evidence);
      if (confirmed === undefined || !matchesTarget(confirmed, target)) return undefined;
      if (evidence.first === undefined) return confirmed.redemption.stored === undefined ? undefined : evidence;
      if (confirmed.redemption.stored === undefined) return evidence;
      // A competing commit won with the same secret. Prove its durable allocation for replay.
      current = confirmed;
      continue;
    }
    if (changed === watch.changed()) {
      if (evidence === 'uncorrelated') break;
      await abortableWait(changed, signal);
    }
    signal.throwIfAborted();
    changed = watch.changed();
    current = await readVerifiedOrder(host, attempt, signal);
  }
  return undefined;
}

/**
 * Prepare a worker setup exchange without holding the run lock during proof
 * verification. Preparation performs no writes. Durable observations belong
 * to supervision and have effect independently of the exchange outcome.
 * The transport must release its session only after commit.
 * @param host - Host dispatch, order storage and in-process supervision authority.
 * @param call - Kernel-minted anonymous boundary call.
 * @param presentation - Worker credentials, used only to derive digests.
 * @param visibility - Host-selected allocation verification policy.
 * @param connectionDeadline - Trusted absolute deadline for connection setup, in epoch milliseconds.
 * The persisted bootstrap or replay deadline can tighten it once the order is readable.
 * @returns A rejection or storage work returning the final reply.
 */
export async function prepareWorkerRedemption(
  host: WorkerRedemptionHost,
  call: CallContext,
  presentation: WorkerRedemptionPresentation,
  visibility: StartValueVisibility,
  connectionDeadline: number,
): Promise<ConnectionExchangeResult> {
  const { supervisionCall } = host;
  if (
    !isMintedCallContext(call) ||
    call.caller.kind !== CorePartyKind.anonymous ||
    call.principal.kind !== CorePartyKind.anonymous ||
    call.caller.id !== call.principal.id ||
    call.attestedBy !== undefined ||
    ownCarrierOf(supervisionCall)?.kind !== CorePartyKind.host ||
    !presentation.oneTimeToken ||
    !presentation.runtimeSecret ||
    !Number.isFinite(connectionDeadline)
  )
    return rejected;
  const { jobRunId, oneTimeToken, runtimeSecret } = presentation;
  const attempt = Object.freeze({
    jobRunId,
    tokenDigest: digestWorkerBootstrapToken(oneTimeToken),
    runtimeDigest: digestWorkerRuntimeSecret(runtimeSecret),
  });
  const policy = Object.freeze({ ...visibility });
  const watch = host.allocationObservation.watch(jobRunId);
  try {
    const prepared = await withinPreparationDeadline(connectionDeadline, host.operationSignal, async (lifetime) => {
      const changed = watch.changed();
      const current = await readVerifiedOrder(host, attempt, lifetime.signal);
      if (current === undefined) return undefined;
      lifetime.shorten(
        Date.parse(current.redemption.stored?.accepted.expiresAt ?? current.locked.order.order.bootstrapDeadlineAt),
      );
      const { generation } = current.redemption;
      const { owner, orderDigest } = current.locked.order;
      const target = Object.freeze({ generation, orderDigest, ownerKind: owner.kind, ownerId: owner.id });
      const initial = { order: current, changed };
      const evidence = await prepareObservedEvidence(host, attempt, target, policy, initial, watch, lifetime.signal);
      return evidence === undefined ? undefined : makeCommit(host, call, attempt, target, evidence, lifetime.expiresAt);
    });
    return prepared ?? rejected;
  } finally {
    watch.dispose();
  }
}
