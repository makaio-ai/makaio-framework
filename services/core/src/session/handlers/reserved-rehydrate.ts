import type { IMakaioBus } from '@makaio/bus-core';
import {
  SessionSubjects,
  SessionOwnershipStorageSubjects,
  type MakaioSessionAgent,
  type SessionOwnershipRecoveryReservation,
  type SessionOwnershipRecoveryPreimage,
  type SessionOwnershipRecoveryGuard,
  type SessionOwnershipReservation,
  type SessionOwnershipSettleMovementServiceResult,
  type RuntimeBinding,
} from '@makaio/contracts';
import { mintClaimToken } from '../ownership/claim-token.js';
import { reserveStartFor } from '../utils/start-reservation.js';
import { toMachineScopedAdapterInstance, type MachineScopedAdapterInstance } from '../utils/resolution.js';
import { acknowledgeCallerSettlement, failDispatchedStart } from './caller-owned-start.js';
import {
  abandonDispatchedStart,
  applySettlementOutcome,
  releaseUndispatchedStart,
  StartClaimTokens,
  stopStartedConnector,
  type StartCleanupPolicy,
} from './lead-start-cleanup.js';
import { dispatchAgentRehydrate } from './rehydrate-dispatch.js';
import { SessionStartError } from './session-start-error.js';
import { assertSessionActiveAfterStart } from './attach-turn-tracking.js';

/**
 * The reserved rehydrate owns the agent row it drives.
 *
 * The adapter's own `idle` write is suppressed by `callerOwnsAgentRow`, so the
 * `starting → idle` transition — and every terminal write a failure needs — is
 * this caller's. An unconditional adapter write would revive a row that was
 * removed mid-rehydrate and strand a live connector on it.
 */
const CALLER_OWNED_STATUS: StartCleanupPolicy = { writesAgentStatus: false, connectorOnlyTeardown: true };

/**
 * What a **pre-dispatch** exit lets the shared cleanup write: no status at all.
 *
 * The shared cleanup's only status write is the terminal `starting → dead`,
 * which is right for an attempt that may have reached the provider and wrong for
 * one that provably did not. A rollback restores the reservation's exact
 * preimage through the ownership finalizer, so this cleanup never writes the
 * recovery row itself.
 */
const PRE_DISPATCH_ROLLBACK: StartCleanupPolicy = { writesAgentStatus: false };

/**
 * How a reserved rehydrate ended.
 *
 * `rehydrated` is the only outcome that guarantees a live connector, and
 * `deferred` is the deliberate "no connector was created, and that is correct
 * here" answer — a distinct member precisely so every consumer has to say which
 * it wants.
 */
export type ReservedRehydrateOutcome =
  | {
      readonly kind: 'rehydrated';
      /** The agent, re-stamped with the instance this attempt bound it to. */
      readonly agent: MakaioSessionAgent;
      /** Whether the provider session was resumed natively. */
      readonly native: boolean;
    }
  | {
      /**
       * No connector was created, and none may be created here for this agent.
       *
       * The consumer must **not** retry with a different key: `occupied` is
       * durable evidence that a generation this runtime does not own holds the
       * agent's provider session (I23a). The sanctioned response is to drop the
       * agent from this attempt's targets and, if that empties the session's
       * usable agents, decide at the session level what the product does
       * without it.
       */
      readonly kind: 'deferred';
      readonly reason: 'occupied' | 'machine-identity-unavailable';
    }
  | {
      readonly kind: 'refused';
      /**
       * Which gate refused.
       *
       * The first four are the reservation's own modeled refusals.
       * `rehydrate-refused` is the adapter's — a disposed agent or a denied
       * in-process claim, answered as `dispatch: 'not-dispatched'`, which is
       * evidence that nothing reached the provider and the key was released
       * rather than retired.
       */
      readonly outcome: 'agent-disposed' | 'not-found' | 'lead-conflict' | 'session-not-active' | 'rehydrate-refused';
      /** Stored lifecycle status when the reservation's session gate refused. */
      readonly status?: 'closed' | 'archived' | 'discovered';
      /** What the refusing gate said, when it said anything beyond its outcome. */
      readonly message?: string;
    }
  | { readonly kind: 'lost' }
  | { readonly kind: 'stale-plan' };

/**
 * The error a consumer raises for an outcome that produced no connector.
 *
 * Written once because both service-owned consumers of a *self-run* attempt —
 * the send path's lazy recovery and the liveness-verification helper — have the
 * same two absorbable outcomes (`rehydrated`, `deferred`) and the same
 * unabsorbable rest. Two copies of the same three messages is exactly the shape
 * that drifts: the codes they carry are the caller's branch point, so a wording
 * change on one side is a silently different contract on the other.
 *
 * `undefined` is a member because it is the same fact in both places: the
 * exclusive-start seam handed back a joined attempt where the caller had
 * already established it registered its own, which cannot happen.
 * @param agentId - Agent whose recovery is being reported.
 * @param outcome - The outcome that built nothing, or `undefined` when none was recorded.
 * @returns The error the consumer throws, so its call site stays a single `throw`.
 */
export function failedRehydrateError(
  agentId: string,
  outcome: Extract<ReservedRehydrateOutcome, { kind: 'lost' | 'refused' | 'stale-plan' }> | undefined,
): SessionStartError {
  if (outcome === undefined) {
    // Unreachable: the caller registered the attempt, so its callback ran.
    return new SessionStartError('start-failed', `[session.start] recovery of agent ${agentId} produced no result`);
  }
  if (outcome.kind === 'lost') {
    return new SessionStartError(
      'agent-unavailable',
      `[session.start] agent ${agentId} was removed or claimed by another runtime while it was recovered`,
    );
  }
  if (outcome.kind === 'stale-plan') {
    return new SessionStartError(
      'start-unresolved',
      `[session.start] recovery plan for agent ${agentId} remained stale after its bounded retry`,
    );
  }
  return new SessionStartError(
    outcome.outcome === 'session-not-active'
      ? 'session-not-active'
      : outcome.outcome === 'agent-disposed' || outcome.outcome === 'not-found'
        ? 'agent-unavailable'
        : 'start-failed',
    `[session.start] recovery of agent ${agentId} was refused: ${outcome.message ?? outcome.outcome}`,
    undefined,
    undefined,
    outcome.status,
  );
}

/** Everything the reserved rehydrate needs, resolved for **this** attempt. */
export interface ReservedRehydrateRequest {
  /** Agent being recovered; its `adapterId` is re-stamped on success. */
  readonly agent: MakaioSessionAgent;
  /** Session the agent belongs to. */
  readonly sessionId: string;
  /**
   * Live instance resolved for THIS attempt — never the persisted one — and the
   * machine every ownership act of the attempt names.
   *
   * One value, because it is one key: the instance ID is derived from
   * `(machineId, adapterName)`, so an attempt holding the two halves separately
   * can reserve in one namespace and dispatch into another. A missing machine
   * is deferred by the resolver before this connector-producing seam runs.
   */
  readonly instance: MachineScopedAdapterInstance;
  /** Provider session to reserve and resume, or `null` for a keyless rehydrate. */
  readonly resumeProviderSessionId: string | null;
  /** Atomic plan snapshot, required by every keyed recovery. */
  readonly recoveryGuard?: SessionOwnershipRecoveryGuard;
  /** Working directory the replacement connector runs in. */
  readonly cwd?: string;
  /** Model the replacement connector runs. */
  readonly model?: string;
}

/**
 * Recover one agent under the ownership authority — the one implementation.
 *
 * Every service-owned path that rebuilds a connector for an *existing* agent
 * identity runs this: the restart handler, the send path's lazy recovery and
 * the liveness-verification helper. They differ in what they do with the
 * outcome, never in what they do to the provider session, which is why the
 * reservation, the dispatch, the settlement and the commit live here once.
 *
 * The caller enters `runExclusiveStart` for the agent and calls this inside it:
 * the durable steps have to sit in the *same* attempt a concurrent consumer
 * would join, and a joiner runs none of them and writes nothing.
 *
 * **The order is load-bearing.** The row is claimed before the reservation, so
 * a second recovery of one dead agent is refused by the compare-and-swap rather
 * than by racing for the key; the reservation is taken before the dispatch, so
 * a provider session another generation holds is never spoken to; and the
 * settlement names the key the connector *confirmed*, not the one that was
 * requested, because the manager prefers the live connector's own identity.
 * @param bus - Bus every step is issued on.
 * @param request - Agent, session, live adapter identity and resume target.
 * @returns How the recovery ended, as the consumer's own decision input.
 * @throws A {@link SessionStartError} when a post-dispatch step failed, and whatever the
 *   reservation or the dispatch threw.
 */
export async function runReservedRehydrate(
  bus: IMakaioBus,
  request: ReservedRehydrateRequest,
): Promise<ReservedRehydrateOutcome> {
  if (toMachineScopedAdapterInstance(request.instance) === undefined) {
    return { kind: 'deferred', reason: 'machine-identity-unavailable' };
  }
  const { agent } = request;
  // No round trip: ownership is absorbing on `disposed`, so every operation
  // below would refuse it by predicate anyway.
  if (agent.status === 'disposed') return { kind: 'refused', outcome: 'agent-disposed' };
  if (request.recoveryGuard === undefined) {
    throw new Error(`[session.start] recovery of agent ${agent.agentId} omitted its atomic recovery guard`);
  }
  const reserved = await reserveRehydrate(bus, request);
  if (reserved.kind === 'settled') return reserved.outcome;
  return dispatchReservedRehydrate(bus, request, reserved.reservation);
}

/** Either a committed reservation, or the outcome the attempt ends on. */
type ReservationStep =
  | { readonly kind: 'reserved'; readonly reservation: SessionOwnershipReservation }
  | { readonly kind: 'settled'; readonly outcome: ReservedRehydrateOutcome };

/**
 * Reserve the provider session this rehydrate is about to resume.
 *
 * `role: 'member'` always: a restart re-attaches a conversation, it does not
 * re-decide who speaks for the session.
 *
 * Issued as a **hard** request. An absent authority is a broken composition,
 * not a lightweight host, and a rehydrate dispatched without one is the unowned
 * second writer this aggregate exists to prevent.
 *
 * **A throwing reservation rolls the claim back before it propagates**, and
 * that is not bookkeeping: the row is `starting` by the time this runs, and a
 * throw — an absent authority, a storage failure, or a shutdown mid-flight,
 * which is the likely one — would otherwise strand it there, where the send
 * path's consumer rule turns it into a phantom recovery on the next send.
 * @param bus - Bus the reservation is issued on.
 * @param request - The attempt's resolved identity and resume target.
 * @param claim - The recovery claim to give back on every refusal.
 * @returns The committed reservation, or the outcome the attempt ends on.
 */
async function reserveRehydrate(bus: IMakaioBus, request: ReservedRehydrateRequest): Promise<ReservationStep> {
  const { agent, instance, resumeProviderSessionId, sessionId } = request;
  const recoveryGuard = request.recoveryGuard;
  if (recoveryGuard === undefined)
    throw new Error(`[session.start] recovery of agent ${agent.agentId} omitted its guard`);
  const claimToken = mintClaimToken();
  const recoveryAttemptId = mintClaimToken();
  let reserved;
  try {
    reserved = await reserveStartFor(bus, {
      sessionId,
      agentId: agent.agentId,
      adapterName: agent.adapterName,
      instance,
      role: 'member',
      resumeProviderSessionId,
      claimToken,
      recoveryGuard,
      recoveryAttemptId,
    });
  } catch (error) {
    await releaseUnknownReservation(bus, agent.agentId, claimToken);
    await finalizeUnknownRecovery(
      bus,
      agent.agentId,
      request.instance,
      recoveryAttemptId,
      recoveryGuard.expectedPreimage,
    );
    throw error;
  }

  if (reserved.outcome === 'reserved') return { kind: 'reserved', reservation: reserved.reservation };
  if (reserved.outcome === 'occupied' || reserved.outcome === 'machine-identity-unavailable') {
    // Terminal for this agent in this attempt (I23a): storage has said the key
    // is held by a generation this runtime does not own, and dispatching after
    // that is exactly the second driver the aggregate exists to prevent. There
    // is no keyless second stage — it would be a path with no gate, taken
    // precisely when the gate that exists has just refused.
    return { kind: 'settled', outcome: { kind: 'deferred', reason: reserved.outcome } };
  }
  if (reserved.outcome === 'currency-changed') return { kind: 'settled', outcome: { kind: 'stale-plan' } };
  if (reserved.outcome === 'recovery-conflict') {
    return {
      kind: 'settled',
      outcome: reserved.status === 'disposed' ? { kind: 'refused', outcome: 'agent-disposed' } : { kind: 'lost' },
    };
  }
  if (reserved.outcome === 'session-not-active') {
    return { kind: 'settled', outcome: { kind: 'refused', outcome: reserved.outcome, status: reserved.status } };
  }
  return { kind: 'settled', outcome: { kind: 'refused', outcome: reserved.outcome } };
}

/**
 * Release a reservation whose transaction may have committed before its reply
 * was lost.
 * @param bus - Bus carrying the token-scoped release.
 * @param agentId - Agent the reservation belonged to.
 * @param claimToken - Caller-minted reservation generation.
 * @returns Whether storage confirmed that exact generation was released.
 */
async function releaseUnknownReservation(bus: IMakaioBus, agentId: string, claimToken: string): Promise<boolean> {
  try {
    const released = await bus.request(SessionSubjects.ownership.release, {
      agentId,
      claimToken,
      disposition: 'released',
    });
    return released.releasedProviderSessionIds.length > 0 && !released.claimTokenNotFound;
  } catch {
    return false;
  }
}

/**
 * Dispatch the reserved rehydrate and settle what it confirmed.
 *
 * Split from {@link runReservedRehydrate} because everything from here on is
 * answerable for a generation: the token set is complete before the dispatch —
 * the reservation's, and the candidate this attempt mints for its own
 * settlement — so every failure below can give back exactly what it took, even
 * one whose settlement response never arrives.
 * @param bus - Bus every step is issued on.
 * @param request - The attempt's resolved identity and resume target.
 * @param reservation - The committed reservation.
 * @param claim - The recovery claim, for the one exit here that is still a rollback.
 * @returns How the recovery ended.
 */
async function dispatchReservedRehydrate(
  bus: IMakaioBus,
  request: ReservedRehydrateRequest,
  reservation: SessionOwnershipReservation,
): Promise<ReservedRehydrateOutcome> {
  const { agent, resumeProviderSessionId } = request;
  const { adapterId } = request.instance;
  const agentId = agent.agentId;
  const { ownerInstanceId } = reservation;
  const recovery = recoveryReservation(reservation);
  if (recovery === undefined) {
    throw new Error(`[session.start] recovery reservation for agent ${agentId} omitted its terminal authority`);
  }
  // Minted *before* the settle call and releasable from the moment it exists: a
  // settlement whose transaction commits and whose response is then lost leaves
  // the caller holding nothing else that names the successor generation, and a
  // set completable only from a response is empty exactly when it is needed.
  const settlementCandidate = mintClaimToken();
  const claimTokens = new StartClaimTokens([reservation.claim?.claimToken, settlementCandidate]);

  let response;
  try {
    response = await dispatchAgentRehydrate(bus, {
      agentId,
      adapterId,
      ownerInstanceId,
      resumeProviderSessionId,
      callerOwnsAgentRow: true,
      ...(request.cwd !== undefined && { cwd: request.cwd }),
      ...(request.model !== undefined && { model: request.model }),
    });
  } catch (error) {
    // A throw carries no disposition, so the key is retired rather than freed:
    // the provider may hold a live session behind it.
    await abandonDispatchedStart(bus, agentId, CALLER_OWNED_STATUS, claimTokens);
    await finalizeRecovery(bus, agentId, recovery, 'failed');
    // **And the connector is stopped, which the fresh-start paths do not do
    // here.** They can rely on the adapter unwinding its own dispatch: a
    // `startAgent` that throws after registering evicts the agent it registered.
    // A rehydrate has no such rollback — `swapConnector` replaces the connector
    // and there is no predecessor to restore, so a throw from anything after it
    // (the refreshed identity read, the adapter's own runtime write) leaves a
    // live replacement behind. Abandoning the generation without stopping it is
    // exactly the orphaned connector I23b forbids: an unowned writer on a
    // provider session no generation accounts for.
    //
    // Unconditional, because the alternative is unknowable. The throw may have
    // come from *before* the swap, in which case this stops a connector that was
    // healthy — a recoverable loss, since the row goes `dead` and the next send
    // recovers the agent, whereas an unowned writer is not recoverable at all.
    // The stop is best-effort and idempotent: an agent with no registry entry is
    // a no-op, and the response is never read as evidence (I15).
    await stopStartedConnector(bus, adapterId, agentId, ownerInstanceId, true);
    throw error;
  }
  if (!response.success) {
    // A **rollback**, not a retirement. The adapter proved nothing reached the
    // provider — a disposed agent, or a claim it declined before swapping
    // anything — so the connector this row describes is whatever it already was:
    // on the warm path, still live. The generations go back cleanly, and the row
    // goes back where the claim found it rather than to the `dead` the shared
    // cleanup writes for a start that did dispatch.
    await releaseUndispatchedStart(bus, agentId, PRE_DISPATCH_ROLLBACK, claimTokens);
    await finalizeRecovery(bus, agentId, recovery, 'rollback');
    return { kind: 'refused', outcome: 'rehydrate-refused', message: response.message };
  }
  if (response.ownerInstanceId !== ownerInstanceId) {
    throw await failPostDispatch(
      bus,
      adapterId,
      agentId,
      claimTokens,
      new Error(
        `Adapter owner mismatch for rehydrated agent ${agentId}: expected ${ownerInstanceId}, received ${response.ownerInstanceId ?? 'none'}`,
      ),
      ownerInstanceId,
      recovery,
    );
  }

  const confirmed = response.adapterSessionId ?? resumeProviderSessionId;
  // **First, because it is the act that claims the key the connector is on.**
  // The connector is live by now, and on a fresh rehydrate it is live on a key
  // the reservation never named. Anything fallible in front of this is a window
  // in which nothing holds that key, and a failure there retires a reservation
  // that never named it — the same rule the two caller-owned starts follow.
  //
  // The settle names the instance from the *request*, never the agent row, so
  // it is unaffected by the row write that now follows it.
  // Free and unfailable, so it stays in front: the connector is on this instance
  // now, and a failure below reports what happened rather than the instance the
  // agent used to live on. The *durable* write is what moves behind the
  // settlement, because it is the part that can fail.
  //
  // The instance is the only field re-stamped here, and the asymmetry with the
  // *joining* consumer is deliberate. A joiner has to take the whole row,
  // because it knows nothing about what the attempt it joined asked for. This
  // caller supplied `cwd` and `model` itself and the instance is the one value
  // it could not have known — so there is nothing else here that the caller's
  // own snapshot does not already agree with, and a post-commit re-read would
  // buy that agreement with a fallible round trip behind a live connector.
  agent.adapterId = adapterId;
  let settled: SessionOwnershipSettleMovementServiceResult | undefined;
  try {
    if (confirmed !== null) settled = await settleConfirmedKey(bus, request, confirmed, settlementCandidate);
  } catch (error) {
    throw await failPostDispatch(bus, adapterId, agentId, claimTokens, error, ownerInstanceId, recovery);
  }
  // Deliberately unguarded: this cleans and throws for itself, and a `try`
  // spanning it would clean a second time and relabel a precisely classified
  // ownership refusal as an unresolved settlement. The recovery finalizer is
  // separate from that cleanup: it terminalizes the row's exact attempt, but
  // never releases or stops a second time.
  if (settled !== undefined) {
    try {
      await applySettlementOutcome(bus, adapterId, agentId, ownerInstanceId, settled, CALLER_OWNED_STATUS, claimTokens);
    } catch (error) {
      await finalizeRecovery(bus, agentId, recovery, 'failed');
      throw error;
    }
  }

  try {
    return await commitRehydratedRow(bus, request, response.settlementAckToken, ownerInstanceId, recovery);
  } catch (error) {
    throw await failPostDispatch(bus, adapterId, agentId, claimTokens, error, ownerInstanceId, recovery);
  }
}

/**
 * Settle the currency on the key the connector actually landed on.
 *
 * Not necessarily the key that was reserved: the manager prefers the live
 * connector's own identity over the persisted one, so a provider that resumed
 * onto a different session leaves the connector there while the reservation
 * names the old key. Settling on the requested one would write back an identity
 * the provider has already moved off — and would do it *after* the adapter's
 * own announcement published the new one. Settling on the confirmed key instead
 * moves the reservation: the successor is allocated there and the predecessor
 * generation is deleted in the same transaction.
 * @param bus - Bus the settlement is issued on.
 * @param request - The attempt's resolved identity.
 * @param providerSessionId - Key the connector confirmed.
 * @param claimToken - Generation this attempt minted for its own settlement.
 * @returns What the authority answered.
 */
async function settleConfirmedKey(
  bus: IMakaioBus,
  request: ReservedRehydrateRequest,
  providerSessionId: string,
  claimToken: string,
): Promise<SessionOwnershipSettleMovementServiceResult> {
  const { agent, sessionId } = request;
  const { adapterId, machineId } = request.instance;
  return bus.request(SessionSubjects.ownership.settleMovement, {
    sessionId,
    agentId: agent.agentId,
    adapterId,
    adapterName: agent.adapterName,
    ownerInstanceId: request.instance.ownerInstanceId,
    movement: { confirmed: true, providerSessionId },
    claimToken,
    ...(machineId !== undefined && { machineId }),
  });
}

/**
 * Return the adapter-minted token after this rehydrate's durable settlement.
 * @param bus - Bus carrying the targeted acknowledgement RPC.
 * @param request - The attempt's resolved identity and resume target.
 * @param settlementAckToken - Adapter-minted token for the hosted generation.
 * @param ownerInstanceId - Runtime incarnation that hosted the generation.
 * @param recovery - Exact recovery attempt to finalize after acknowledgement.
 * @returns The recovered agent after the adapter accepts responsibility.
 */
async function commitRehydratedRow(
  bus: IMakaioBus,
  request: ReservedRehydrateRequest,
  settlementAckToken: string | undefined,
  ownerInstanceId: string,
  recovery: RecoveryTerminalReservation | undefined,
): Promise<ReservedRehydrateOutcome> {
  const { agent, resumeProviderSessionId } = request;
  const { adapterId } = request.instance;
  await assertSessionActiveAfterStart(bus, request.sessionId);
  await acknowledgeCallerSettlement(
    bus,
    { adapterId, agentId: agent.agentId },
    settlementAckToken,
    ownerInstanceId,
    true,
  );
  await finalizeRecovery(bus, agent.agentId, recovery, 'succeeded');
  return { kind: 'rehydrated', agent, native: resumeProviderSessionId !== null };
}

/**
 * Unwind a post-dispatch failure of unknown extent — the Path-B twin of §7.5's
 * last row.
 *
 * The teardown itself is the shared one: what it does, and how it names what it
 * finds, is the same question on every caller-owned path, and this one is a
 * caller-owned path.
 * @param bus - Bus the cleanup is issued on.
 * @param adapterId - Adapter instance the connector lives on.
 * @param agentId - Agent whose start is unwound.
 * @param claimTokens - The generations this attempt is answerable for.
 * @param cause - Whatever the failing step threw.
 * @param ownerInstanceId - Exact runtime incarnation selected by the reservation.
 * @param recovery - Exact recovery attempt to finalize after cleanup.
 * @returns The error the caller reports, so the call site stays a single `throw`.
 */
async function failPostDispatch(
  bus: IMakaioBus,
  adapterId: string,
  agentId: string,
  claimTokens: StartClaimTokens,
  cause: unknown,
  ownerInstanceId: string,
  recovery?: RecoveryTerminalReservation,
): Promise<SessionStartError> {
  const failure = await failDispatchedStart(
    bus,
    {
      adapterId,
      ownerInstanceId,
      agentId,
      attemptKind: 'rehydrate',
      policy: CALLER_OWNED_STATUS,
      claimTokens,
    },
    cause,
  );
  await finalizeRecovery(bus, agentId, recovery, 'failed');
  return failure;
}

/** Exact recovery terminal authority created by a guarded reservation. */
interface RecoveryTerminalReservation extends SessionOwnershipRecoveryReservation {
  readonly binding: RuntimeBinding;
}

/**
 * Extract the exact terminal authority carried by a guarded reservation.
 * @param reservation - Reservation whose recovery authority is inspected.
 * @returns The terminal authority, or `undefined` for an ordinary reservation.
 */
function recoveryReservation(reservation: SessionOwnershipReservation): RecoveryTerminalReservation | undefined {
  if (reservation.recovery === undefined || reservation.machineId === undefined) return undefined;
  return {
    ...reservation.recovery,
    binding: {
      adapterId: reservation.adapterId,
      ownerMachineId: reservation.machineId,
      ownerInstanceId: reservation.ownerInstanceId,
    },
  };
}

/**
 * Apply one terminal action under the reservation's exact attempt and binding.
 * @param bus - Bus carrying the storage finalization request.
 * @param agentId - Agent whose recovery attempt is terminalized.
 * @param recovery - Exact attempt and binding captured by the reservation.
 * @param terminal - Terminal recovery outcome to apply.
 */
async function finalizeRecovery(
  bus: IMakaioBus,
  agentId: string,
  recovery: RecoveryTerminalReservation | undefined,
  terminal: 'rollback' | 'succeeded' | 'failed',
): Promise<void> {
  if (recovery === undefined) return;
  const action =
    terminal === 'rollback' ? { kind: 'rollback' as const, preimage: recovery.preimage } : { kind: terminal };
  const finalized = await bus.request(SessionOwnershipStorageSubjects.finalizeRecovery, {
    agentId,
    attemptId: recovery.attemptId,
    binding: recovery.binding,
    action,
  });
  if (terminal === 'succeeded' && !finalized.applied) {
    throw new Error(
      `[session.start] recovery ${recovery.attemptId} for agent ${agentId} was superseded before ${terminal}`,
    );
  }
}

/**
 * Terminalize a reservation whose commit succeeded but whose response was lost.
 * @param bus - Bus carrying the storage finalization request.
 * @param agentId - Agent whose response-lost attempt is rolled back.
 * @param instance - Exact adapter binding installed by the attempt.
 * @param attemptId - Durable recovery fence minted for the attempt.
 * @param preimage - Transaction-validated row state to restore.
 */
async function finalizeUnknownRecovery(
  bus: IMakaioBus,
  agentId: string,
  instance: MachineScopedAdapterInstance,
  attemptId: string,
  preimage: SessionOwnershipRecoveryPreimage,
): Promise<void> {
  await bus.request(SessionOwnershipStorageSubjects.finalizeRecovery, {
    agentId,
    attemptId,
    binding: {
      adapterId: instance.adapterId,
      ownerMachineId: instance.machineId,
      ownerInstanceId: instance.ownerInstanceId,
    },
    action: { kind: 'rollback', preimage },
  });
}
