import { createHash, timingSafeEqual } from 'node:crypto';
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
import { sameReference } from './dispatch-store.js';
import { bindDispatchProof, prepareDispatchProof, type PreparedDispatchProof } from './redemption-binding.js';
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
  readonly tokenDigest: Buffer;
  readonly runtimeDigest: Buffer;
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
const missingDigest = Buffer.alloc(32);
const maxTimerDelayMs = 2 ** 31 - 1;
const retryableStorageCodes = new Set([
  '40001',
  '40P01',
  'SQLITE_BUSY',
  'SQLITE_BUSY_RECOVERY',
  'SQLITE_BUSY_SNAPSHOT',
]);

/**
 * Recognize explicit database retry signals through a driver's error wrapper.
 * @param error - Failure raised during storage work.
 * @returns Whether the storage operation can be repeated.
 */
function isRetryableStorageFailure(error: unknown): boolean {
  const seen = new Set<Error>();
  while (error instanceof Error && !seen.has(error)) {
    if ('code' in error && typeof error.code === 'string' && retryableStorageCodes.has(error.code)) return true;
    seen.add(error);
    error = error.cause;
  }
  return false;
}

/**
 * Hash a credential before doing asynchronous work.
 * @param value - Secret presented on the connection.
 * @returns The fixed-width SHA-256 digest.
 */
function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * Check a credential digest against the canonical stored encoding.
 * @param stored - Hex-encoded SHA-256 at rest, if available.
 * @param presented - SHA-256 of the presented secret.
 * @returns Whether the two digests match.
 */
function matchesDigest(stored: string | undefined, presented: Buffer): boolean {
  const decoded = stored !== undefined && /^[a-f0-9]{64}$/.test(stored) ? Buffer.from(stored, 'hex') : missingDigest;
  return timingSafeEqual(decoded, presented) && decoded !== missingDigest;
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
  if (
    locked === undefined ||
    locked.claim.shutdownEnded !== undefined ||
    redemption === undefined ||
    redemption.tokenRevoked ||
    !matchesDigest(redemption.tokenDigest, attempt.tokenDigest)
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
    !matchesDigest(redemption.stored.runtimeDigest, attempt.runtimeDigest) ||
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
 * @returns Proof for the current or winning binding.
 */
async function prepareEvidence(
  host: WorkerStartOptions,
  supervisionCall: CallContext,
  current: VerifiedOrder,
  policy: StartValueVisibility,
  attempt: RedemptionAttempt,
  signal: AbortSignal,
): Promise<AllocationEvidence | undefined> {
  if (current.redemption.stored !== undefined) return prepareReplay(current, policy, signal).catch(() => undefined);
  const first = await prepareDispatchProof(host, supervisionCall, current.locked.claim, policy, {
    useSenderReference: true,
    signal,
  }).catch(() => undefined);
  signal.throwIfAborted();
  if (first !== undefined) return { ref: first.ref, platformThrough: first.platformThrough, first };
  // First-use liveness can disappear after a competing exchange commits.
  const winner = await readVerifiedOrder(host, attempt, signal);
  return winner?.redemption.stored === undefined
    ? undefined
    : prepareReplay(winner, policy, signal).catch(() => undefined);
}

/**
 * Bound asynchronous proof work by the applicable persisted deadline.
 * @param deadline - Bootstrap or replay expiry in milliseconds since the epoch.
 * @param hostSignal - Host operation lifetime.
 * @param work - Proof work to run outside the owner transaction.
 * @returns Proof, or undefined when the attempt's lifetime ends.
 */
async function withinPreparationDeadline(
  deadline: number,
  hostSignal: AbortSignal,
  work: (signal: AbortSignal) => Promise<AllocationEvidence | undefined>,
): Promise<AllocationEvidence | undefined> {
  const controller = new AbortController();
  const signal = AbortSignal.any([hostSignal, controller.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Arm against the absolute deadline, including dates beyond the platform timer range. */
  function arm(): void {
    const remaining = deadline - Date.now();
    if (remaining <= 0) controller.abort();
    else timer = setTimeout(arm, Math.min(remaining, maxTimerDelayMs));
  }
  arm();
  try {
    if (signal.aborted) return undefined;
    const evidence = await abortableWait(
      Promise.resolve().then(() => work(signal)),
      signal,
    );
    return !signal.aborted && deadline > Date.now() ? evidence : undefined;
  } catch (error) {
    if (!signal.aborted) throw error;
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
    runtimeDigest: attempt.runtimeDigest.toString('hex'),
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
 * @returns A commit callback that rechecks authority under the run lock.
 */
function makeCommit(
  host: WorkerStartOptions,
  call: CallContext,
  attempt: RedemptionAttempt,
  target: RedemptionTarget,
  evidence: AllocationEvidence,
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
        if (
          locked === undefined ||
          locked.redemption.generation !== target.generation ||
          locked.locked.order.orderDigest !== target.orderDigest ||
          locked.locked.order.owner.kind !== target.ownerKind ||
          locked.locked.order.owner.id !== target.ownerId
        )
          return rejected;
        return await commitRedemption(tx, locked, attempt, evidence);
      } catch (error) {
        const code = isRetryableStorageFailure(error) ? 'retryable' : 'rejected';
        const failure = new WorkerRedemptionError(code, 'Run redemption commit failed');
        markTransactionRollbackOnly(tx, failure);
        throw failure;
      }
    },
  });
}

/**
 * Read the authoritative order and normalize storage failures at preparation.
 * @param host - Host dispatch and order storage.
 * @param attempt - Hashed presentation.
 * @param signal - Current preparation lifetime.
 * @returns The verified snapshot, or undefined on permanent failure or rejection.
 */
async function readVerifiedOrder(host: WorkerStartOptions, attempt: RedemptionAttempt, signal = host.operationSignal) {
  try {
    const { source } = host;
    if (signal.aborted || source.readRedemptionCredentials === undefined) return undefined;
    const { tokenDigest, runtimeDigest } = (await source.readRedemptionCredentials(attempt.jobRunId)) ?? {};
    const tokenMatches = matchesDigest(tokenDigest, attempt.tokenDigest);
    const runtimeMatches = matchesDigest(runtimeDigest, attempt.runtimeDigest);
    if (signal.aborted || !tokenMatches || (runtimeDigest !== undefined && !runtimeMatches)) return undefined;
    return await host.database.transaction(async (tx) => (signal.aborted ? undefined : verifyOrder(host, tx, attempt)));
  } catch (error) {
    if (isRetryableStorageFailure(error)) {
      throw new WorkerRedemptionError('retryable', 'Run redemption storage temporarily unavailable');
    }
    return undefined;
  }
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
 * @returns A rejection or storage work returning the final reply.
 */
export async function prepareWorkerRedemption(
  host: WorkerRedemptionHost,
  call: CallContext,
  presentation: WorkerRedemptionPresentation,
  visibility: StartValueVisibility,
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
    !presentation.runtimeSecret
  )
    return rejected;
  const { jobRunId, oneTimeToken, runtimeSecret } = presentation;
  const attempt = Object.freeze({ jobRunId, tokenDigest: digest(oneTimeToken), runtimeDigest: digest(runtimeSecret) });
  const policy = Object.freeze({ ...visibility });
  const current = await readVerifiedOrder(host, attempt);
  if (current === undefined) return rejected;
  const { generation } = current.redemption;
  const { owner, orderDigest } = current.locked.order;
  const target = Object.freeze({ generation, orderDigest, ownerKind: owner.kind, ownerId: owner.id });
  const deadline = Date.parse(
    current.redemption.stored?.accepted.expiresAt ?? current.locked.order.order.bootstrapDeadlineAt,
  );
  const evidence = await withinPreparationDeadline(deadline, host.operationSignal, (signal) =>
    prepareEvidence(host, supervisionCall, current, policy, attempt, signal),
  );
  // The storage exchange treats missing evidence as rejection. A transport
  // may wait for correlation only after identifying a pending observation.
  return evidence === undefined ? rejected : makeCommit(host, call, attempt, target, evidence);
}
