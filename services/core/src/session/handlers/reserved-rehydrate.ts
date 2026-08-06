import type { IMakaioBus } from '@makaio/bus-core';
import {
  SessionSubjects,
  type MakaioSessionAgent,
  type SessionOwnershipReservation,
  type SessionOwnershipSettleMovementServiceResult,
} from '@makaio/contracts';
import { mintClaimToken } from '../ownership/claim-token.js';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import { reserveStartFor } from '../utils/start-reservation.js';
import type { OwnedAdapterInstance } from '../utils/resolution.js';
import { failDispatchedStart, readCallerOwnedCommit } from './caller-owned-start.js';
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

/**
 * The reserved rehydrate owns the agent row it drives.
 *
 * The adapter's own `idle` write is suppressed by `callerOwnsAgentRow`, so the
 * `starting → idle` transition — and every terminal write a failure needs — is
 * this caller's. An unconditional adapter write would revive a row that was
 * removed mid-rehydrate and strand a live connector on it.
 */
const CALLER_OWNED_STATUS: StartCleanupPolicy = { writesAgentStatus: true };

/**
 * What a **pre-dispatch** exit lets the shared cleanup write: no status at all.
 *
 * The shared cleanup's only status write is the terminal `starting → dead`,
 * which is right for an attempt that may have reached the provider and wrong for
 * one that provably did not. A rollback restores what the claim replaced
 * instead — see {@link releaseRecoveryRow} — and that value lives with the
 * claim, where this module can reach it and the shared cleanup cannot.
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
       * The first three are the reservation's own modeled refusals.
       * `rehydrate-refused` is the adapter's — a disposed agent or a denied
       * in-process claim, answered as `dispatch: 'not-dispatched'`, which is
       * evidence that nothing reached the provider and the key was released
       * rather than retired.
       */
      readonly outcome: 'agent-disposed' | 'not-found' | 'lead-conflict' | 'rehydrate-refused';
      /** What the refusing gate said, when it said anything beyond its outcome. */
      readonly message?: string;
    }
  | { readonly kind: 'lost' };

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
  outcome: Extract<ReservedRehydrateOutcome, { kind: 'lost' | 'refused' }> | undefined,
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
  return new SessionStartError(
    outcome.outcome === 'agent-disposed' || outcome.outcome === 'not-found' ? 'agent-unavailable' : 'start-failed',
    `[session.start] recovery of agent ${agentId} was refused: ${outcome.message ?? outcome.outcome}`,
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
   * can reserve in one namespace and dispatch into another. `machineId` is absent
   * only for a caller that named no machine and is therefore acting for none.
   */
  readonly instance: OwnedAdapterInstance;
  /** Provider session to reserve and resume, or `null` for a keyless rehydrate. */
  readonly resumeProviderSessionId: string | null;
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
  const { agent } = request;
  // No round trip: ownership is absorbing on `disposed`, so every operation
  // below would refuse it by predicate anyway.
  if (agent.status === 'disposed') return { kind: 'refused', outcome: 'agent-disposed' };
  const claimed = await claimRecoveryRow(bus, agent);
  if (claimed === 'not-found') return { kind: 'refused', outcome: 'not-found' };
  if (claimed === 'lost') return { kind: 'lost' };

  const reserved = await reserveRehydrate(bus, request, claimed);
  if (reserved.kind === 'settled') return reserved.outcome;
  return dispatchReservedRehydrate(bus, request, reserved.reservation, claimed);
}

/**
 * Claim this agent's recovery by compare-and-swap.
 *
 * `starting` is deliberately absent from the expectation: a row already in it
 * belongs to a recovery someone else claimed, and this attempt must lose rather
 * than open a second lifecycle beside it. What the swap does **not** prove is
 * that nobody is driving the agent — an `idle`/`active` row is exactly what a
 * live driver leaves behind. The reservation decides that, against the claim
 * row.
 *
 * **The swap requires the status the rollback would restore.** Accepting any of
 * `idle`/`active`/`dead` while the rollback restores what the *caller observed*
 * is two different facts pretending to be one: a peer that moved the row between
 * the caller's read and this swap — `restoreProbedLiveAgent` putting a live agent
 * back to `idle` is the standing example — would have this attempt claim from
 * `active` and, on a refused reservation, put `dead` back on an agent whose
 * connector answers. Naming the expectation makes the claim and its undo the same
 * statement, and a caller whose snapshot has been overtaken loses the claim
 * instead of writing a status it never saw.
 *
 * A **refused** swap and an **absent row** are reported apart, because they are
 * different facts: the first is a peer that got there first — including one that
 * moved the row out from under this caller's observation — and the second is a
 * removal that landed before this attempt started and is the same refusal the
 * reservation would have produced a round trip later.
 *
 * A host with no agent storage has no row to arbitrate over, so the claim is
 * treated as taken: refusing there would make the whole path unavailable to a
 * composition that never had the column in the first place.
 * @param bus - Bus the compare-and-swap is issued on.
 * @param agent - Agent whose recovery is being claimed, carrying the status the caller observed.
 * @returns The claim this attempt now holds, or why it holds none.
 */
async function claimRecoveryRow(
  bus: IMakaioBus,
  agent: MakaioSessionAgent,
): Promise<RecoveryRowClaim | 'lost' | 'not-found'> {
  // Captured **before** the swap, and never re-derived from the agent object
  // afterwards. The claim is what moved the status, so anything read from this
  // snapshot after it lands describes the claim's own work rather than what it
  // replaced — and the rollback needs what it replaced. The claim therefore
  // carries the value out with it (see {@link RecoveryRowClaim}) instead of
  // letting each exit ask the object again.
  //
  // What this snapshot must be is a status *this caller observed*: the swap
  // refuses when the row has moved on, which is the whole point, so a caller that
  // waited for someone else's attempt has to refresh before it gets here rather
  // than argue with the attempt it waited for.
  const priorStatus = rollbackTarget(agent.status);
  const claimed = await bus.requestOptional(AgentStorageSubjects.updateStatus, {
    agentId: agent.agentId,
    status: 'starting',
    expectedStatus: [priorStatus],
  });
  if (!claimed.handled || claimed.data.transitioned) return { agentId: agent.agentId, priorStatus };
  return claimed.data.success ? 'lost' : 'not-found';
}

/**
 * A recovery claim this attempt holds, and everything undoing it needs.
 *
 * The claim is the only thing that knows what it replaced, so it carries that
 * fact rather than letting each exit re-derive it from an agent object whose
 * status the claim itself has already moved on.
 */
interface RecoveryRowClaim {
  /** Agent whose recovery this attempt owns. */
  readonly agentId: string;
  /** Status the claim swapped out, captured before the swap. */
  readonly priorStatus: 'idle' | 'active' | 'dead';
}

/**
 * The status a claim would have to undo, given what the caller observed.
 *
 * The claim swaps in from `idle`, `active` or `dead`, so those three are the
 * only states it can be undoing. Anything else — a caller view stale enough to
 * name `starting` or `disposed` — is not a state this attempt could have swapped
 * out of, so it falls back to the one answer that is always safe to write over a
 * row this attempt put into `starting`.
 * @param observed - Status the caller read before it claimed the recovery.
 * @returns The status a rollback restores.
 */
function rollbackTarget(observed: MakaioSessionAgent['status']): 'idle' | 'active' | 'dead' {
  return observed === 'idle' || observed === 'active' ? observed : 'dead';
}

/**
 * Put the row back where the claim found it — the one rollback rule.
 *
 * \> **A claimed row returns to the status the claim swapped out, unless this
 * \> attempt has evidence it dispatched.**
 *
 * Both halves are load-bearing, and three separate defects came from having
 * neither stated in one place.
 *
 * *Where the claim found it, not `dead`.* A recovery is not only ever run for a
 * dead agent: the liveness-verification helper claims a row that still reads
 * `idle` because the *connector* is gone, and the restart handler claims live
 * agents by design. Writing `dead` on the way out tells every later consumer
 * that a running agent is recoverable, and nothing corrects it — the per-turn
 * activity stamp only moves a row between `idle` and `active`, so it cannot lift
 * one back out of `dead`.
 *
 * *Unless it dispatched.* Only an attempt that may have reached the provider
 * writes the terminal `dead`, because only then is "this agent has no connector
 * anyone accounts for" true. Every exit before the dispatch — a throwing
 * reservation, a refused reservation, and a modeled `not-dispatched` refusal
 * from the adapter — is a rollback and uses this. Everything from the dispatch
 * onward is a retirement and uses the shared cleanup's status write instead.
 *
 * Compare-and-swapped from `starting` so a peer that has since claimed the
 * recovery keeps it; a refusal is the better outcome and is accepted silently.
 * While this attempt holds `starting` no peer can claim the recovery — their own
 * swap excludes it — so the only writer this can lose to is the in-flight
 * consumer rule's `starting → dead`, which is exactly the arbitration that
 * should win (I21′: the status write is advisory, and this one yields).
 * @param bus - Bus the compare-and-swap is issued on.
 * @param claim - The claim being given back, carrying what it replaced.
 */
async function releaseRecoveryRow(bus: IMakaioBus, claim: RecoveryRowClaim): Promise<void> {
  await bus.requestOptional(AgentStorageSubjects.updateStatus, {
    agentId: claim.agentId,
    status: claim.priorStatus,
    expectedStatus: ['starting'],
  });
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
async function reserveRehydrate(
  bus: IMakaioBus,
  request: ReservedRehydrateRequest,
  claim: RecoveryRowClaim,
): Promise<ReservationStep> {
  const { agent, instance, resumeProviderSessionId, sessionId } = request;
  let reserved;
  try {
    reserved = await reserveStartFor(bus, {
      sessionId,
      agentId: agent.agentId,
      adapterName: agent.adapterName,
      instance,
      role: 'member',
      resumeProviderSessionId,
    });
  } catch (error) {
    await releaseRecoveryRow(bus, claim);
    throw error;
  }

  if (reserved.outcome === 'reserved') return { kind: 'reserved', reservation: reserved.reservation };
  await releaseRecoveryRow(bus, claim);
  if (reserved.outcome === 'occupied' || reserved.outcome === 'machine-identity-unavailable') {
    // Terminal for this agent in this attempt (I23a): storage has said the key
    // is held by a generation this runtime does not own, and dispatching after
    // that is exactly the second driver the aggregate exists to prevent. There
    // is no keyless second stage — it would be a path with no gate, taken
    // precisely when the gate that exists has just refused.
    return { kind: 'settled', outcome: { kind: 'deferred', reason: reserved.outcome } };
  }
  return { kind: 'settled', outcome: { kind: 'refused', outcome: reserved.outcome } };
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
  claim: RecoveryRowClaim,
): Promise<ReservedRehydrateOutcome> {
  const { agent, resumeProviderSessionId } = request;
  const { adapterId } = request.instance;
  const agentId = agent.agentId;
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
      resumeProviderSessionId,
      callerOwnsAgentRow: true,
      ...(request.cwd !== undefined && { cwd: request.cwd }),
      ...(request.model !== undefined && { model: request.model }),
    });
  } catch (error) {
    // A throw carries no disposition, so the key is retired rather than freed:
    // the provider may hold a live session behind it.
    await abandonDispatchedStart(bus, agentId, CALLER_OWNED_STATUS, claimTokens);
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
    await stopStartedConnector(bus, adapterId, agentId);
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
    await releaseRecoveryRow(bus, claim);
    return { kind: 'refused', outcome: 'rehydrate-refused', message: response.message };
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
    throw await failPostDispatch(bus, adapterId, agentId, claimTokens, error);
  }
  // Deliberately unguarded: this cleans and throws for itself, and a `try`
  // spanning it would clean a second time and relabel a precisely classified
  // ownership refusal as an unresolved settlement.
  if (settled !== undefined) {
    await applySettlementOutcome(bus, adapterId, agentId, settled, CALLER_OWNED_STATUS, claimTokens);
  }

  try {
    await persistLiveAdapterId(bus, agentId, adapterId);
    return await commitRehydratedRow(bus, request, claimTokens);
  } catch (error) {
    throw await failPostDispatch(bus, adapterId, agentId, claimTokens, error);
  }
}

/**
 * Record the instance the agent now lives on, and refuse to proceed silently
 * when the write does not land.
 *
 * A hard request whose response is checked, because the movement observer drops
 * every announcement whose `agent.adapterId` differs from the principal's: a
 * row left on a stale instance makes the connector's own movements
 * unrecordable, and the currency silently stops tracking a session that is very
 * much alive. Both failure forms — a refusal and an unhandled subject — are
 * post-dispatch failures of the attempt, not warnings.
 *
 * It runs *after* the settlement, which briefly leaves the row naming the old
 * instance. An announcement landing in that window is dropped by the observer as
 * a mismatch — and parked, not lost: the tracker holds an unacknowledged
 * movement and re-drives it on the agent's next event. A window the seam already
 * heals is the cheaper of the two, against a window in which the confirmed key
 * is held by nobody.
 * @param bus - Bus the write is issued on.
 * @param agentId - Agent whose runtime binding is written.
 * @param adapterId - Live adapter instance the connector lives on.
 */
async function persistLiveAdapterId(bus: IMakaioBus, agentId: string, adapterId: string): Promise<void> {
  const written = await bus.request(AgentStorageSubjects.updateRuntime, { agentId, adapterId });
  if (!written.success) {
    throw new Error(`[session.start] binding agent ${agentId} to adapter instance ${adapterId} was refused`);
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
    movement: { confirmed: true, providerSessionId },
    claimToken,
    ...(machineId !== undefined && { machineId }),
  });
}

/**
 * Close this attempt's own start through the binding I21′ table.
 *
 * The table itself lives with the other caller-owned start — a rehydrate that
 * carries `callerOwnsAgentRow` *is* one — because a refused `starting → idle` is
 * one fact with one classification, and two copies of it are two chances to
 * decide differently whether a peer's status write costs a healthy connector.
 * Only what a `lost` verdict means for *this* consumer is decided here.
 * @param bus - Bus the commit and the re-read are issued on.
 * @param request - The attempt's resolved identity and resume target.
 * @param claimTokens - The generations this attempt is answerable for.
 * @returns The recovered agent, or `lost` when the row was removed under it.
 */
async function commitRehydratedRow(
  bus: IMakaioBus,
  request: ReservedRehydrateRequest,
  claimTokens: StartClaimTokens,
): Promise<ReservedRehydrateOutcome> {
  const { agent, resumeProviderSessionId } = request;
  const { adapterId } = request.instance;
  if ((await readCallerOwnedCommit(bus, agent.agentId)) !== 'lost') {
    return { kind: 'rehydrated', agent, native: resumeProviderSessionId !== null };
  }

  await abandonDispatchedStart(bus, agent.agentId, CALLER_OWNED_STATUS, claimTokens);
  await stopStartedConnector(bus, adapterId, agent.agentId);
  return { kind: 'lost' };
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
 * @returns The error the caller reports, so the call site stays a single `throw`.
 */
async function failPostDispatch(
  bus: IMakaioBus,
  adapterId: string,
  agentId: string,
  claimTokens: StartClaimTokens,
  cause: unknown,
): Promise<SessionStartError> {
  return failDispatchedStart(
    bus,
    { adapterId, agentId, attemptKind: 'rehydrate', policy: CALLER_OWNED_STATUS, claimTokens },
    cause,
  );
}
