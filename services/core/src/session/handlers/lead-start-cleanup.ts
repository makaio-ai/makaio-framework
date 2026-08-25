import type { IMakaioBus } from '@makaio/bus-core';
import {
  AdapterSubjects,
  SessionSubjects,
  type AdapterSessionClaimDisposition,
  type SessionOwnershipReservation,
  type SessionOwnershipSettleMovementServiceResult,
} from '@makaio/contracts';
import { designateSessionLead } from '../ownership/index.js';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import { SessionStartError, type SessionStartFailureCode } from './session-start-error.js';

/**
 * Which side of the reserved-start phase table the caller stands on.
 *
 * The two start paths have different status writers. A fresh start owns the
 * agent row it created and drives it through `starting`, so its cleanup writes
 * the terminal status. A rehydrate does not: the adapter owns that row and
 * writes `idle` unconditionally, so the service writes no status there at all —
 * not on success, not on failure. Everything else about giving a failed start
 * back is identical, which is why this is a flag on the shared cleanup rather
 * than a second copy of it.
 */
export interface StartCleanupPolicy {
  /** Whether cleanup may close the connector but must not let the adapter write the row. */
  readonly connectorOnlyTeardown?: boolean;
  /**
   * Whether this caller owns `agents.status` for the start being cleaned up.
   *
   * `false` suppresses every status write; a caller that does not own the
   * column must not compare-and-swap it either, because losing that swap would
   * be read as an arbitration it never entered.
   */
  readonly writesAgentStatus: boolean;
  /**
   * The committed reservation, when this cleanup may undo its designation.
   *
   * Present only when the caller is authorized to reverse the concrete lead
   * transition it made. A replacement supplies its reservation so cleanup can
   * CAS-restore the transaction-read prior lead; a member supplies none because
   * it changed no designation. A fresh first lead also supplies none: its dead
   * row remains the canonical recovery target, whereas clearing it would make a
   * later default send create a second lead instead of recovering this one.
   *
   * Thus presence describes rollback authority, not merely whether the attempt
   * happened to write a designation.
   */
  readonly reservation?: SessionOwnershipReservation;
}

/**
 * The designation a keyless reservation may have committed before its response was lost.
 *
 * Unlike a returned reservation, this is reconstructed from the request: the
 * transaction could only install `agentId` after validating
 * `expectedLeadAgentId`, and the cleanup compare-and-swap proves that this
 * attempt still owns the designation before it restores that value.
 */
export interface UncertainKeylessDesignation {
  /** Session whose designation the uncertain reservation may have changed. */
  readonly sessionId: string;
  /** Minted agent the reservation may have designated. */
  readonly agentId: string;
  /** Transaction guard the reservation validated before it could designate. */
  readonly expectedLeadAgentId: string | null;
  /** Semantic transition the caller classified before it reserved. */
  readonly transition: 'fresh' | 'replace';
}

/** Evidence that pre-dispatch rollback removed the caller-minted agent row. */
export interface ReservedStartRollback {
  /** Whether deletion either answered or was verified by an exact row re-read. */
  readonly rowDeleted: boolean;
}

/**
 * The generations one start attempt is answerable for, as it learns them.
 *
 * A failed start releases **exactly** these and never fans out over the agent's
 * claims: a fan-out matches every generation of the `agent_id`, including one a
 * different process legitimately allocated for that agent in the meantime, and
 * destroying that is worse than leaving it.
 *
 * Mutable and owned by the attempt because the set is only complete once a
 * settlement answers. What is knowable before the dispatch — the reservation's
 * token, and the token a reserved caller mints for its own settlement — is
 * seeded; what only a response can name is recorded from that response the
 * moment it arrives, before anything else is done with it.
 */
export class StartClaimTokens {
  private readonly tokens = new Set<string>();

  /**
   * @param seed - Generations knowable before the start dispatches. Nullish
   *   members are dropped rather than branched on at every call site: a keyless
   *   reservation and an absent authority both mean the same thing here —
   *   this attempt has taken no generation of its own.
   */
  public constructor(seed: readonly (string | null | undefined)[] = []) {
    for (const token of seed) this.add(token);
  }

  /**
   * Record a generation this attempt has become answerable for.
   * @param token - Claim token, or a nullish value when there is none to record.
   */
  public add(token: string | null | undefined): void {
    if (token !== undefined && token !== null) this.tokens.add(token);
  }

  /**
   * Record the generation a settlement reported it wrote through.
   *
   * Called on **every** outcome that returns, accepted or refused, because the
   * effective generation is not always the one the attempt reserved: a settle
   * that follows the movement observer onto the same key touches the observer's
   * row and reports *that* token, and an attempt which cannot name it would
   * leave it `held` on a later failure.
   * @param result - What the authority answered.
   */
  public record(result: SessionOwnershipSettleMovementServiceResult): void {
    // Only these two outcomes carry an effective generation; a refusal wrote
    // nothing this attempt could be answerable for.
    if (result.outcome === 'settled' || result.outcome === 'idempotent') this.add(result.claim?.claimToken);
  }

  /** @returns The generations this attempt may give back, in the order it learned them. */
  public toArray(): readonly string[] {
    return [...this.tokens];
  }
}

/**
 * Give up one generation of an agent's claims, best-effort.
 *
 * Always token-scoped: the ownership key of a generation this attempt never
 * took is not this attempt's to free.
 *
 * Failures are logged and swallowed: a release that does not land must never
 * mask the start failure that caused it.
 * @param bus - Bus the release is issued on.
 * @param agentId - Agent whose claim is given up.
 * @param disposition - The caller's evidence, never inferred here.
 * @param claimToken - The one generation the act is scoped to.
 */
async function releaseClaim(
  bus: IMakaioBus,
  agentId: string,
  disposition: AdapterSessionClaimDisposition,
  claimToken: string,
): Promise<void> {
  try {
    await bus.requestOptional(SessionSubjects.ownership.release, { agentId, disposition, claimToken });
  } catch (error) {
    console.debug(`[session.start] release for agent ${agentId} failed:`, error);
  }
}

/**
 * Give back every generation a failed attempt named — I15b, in one place.
 *
 * Sequential rather than concurrent: each release is its own storage
 * transaction on the same agent, and issuing them in parallel would have them
 * contend for the row this attempt is trying to leave in a clean state.
 * @param bus - Bus the releases are issued on.
 * @param agentId - Agent whose claims are given up.
 * @param disposition - The caller's evidence, never inferred here.
 * @param claimTokens - The generations this attempt is answerable for.
 */
async function releaseNamedClaims(
  bus: IMakaioBus,
  agentId: string,
  disposition: AdapterSessionClaimDisposition,
  claimTokens: StartClaimTokens,
): Promise<void> {
  for (const claimToken of claimTokens.toArray()) await releaseClaim(bus, agentId, disposition, claimToken);
}

/**
 * Put the session's lead designation back where the reservation found it.
 *
 * A compare-and-swap through the reserving transaction, never a plain write: the
 * expectation is always this reservation's own agent, so a designation that has
 * since moved on is left standing. `previousLeadAgentId` is the lead observed
 * *inside* the reserving transaction and is the only value a rollback may
 * restore — a lead read before the call is one another start may already have
 * replaced.
 * @param bus - Bus the designation is written on.
 * @param designation - The reservation-derived designation being rolled back.
 */
async function restoreLeadDesignation(
  bus: IMakaioBus,
  designation: Pick<SessionOwnershipReservation, 'sessionId' | 'agentId' | 'previousLeadAgentId'>,
): Promise<void> {
  const previous = designation.previousLeadAgentId;
  const result = await designateSessionLead(bus, {
    sessionId: designation.sessionId,
    // With no previous lead there is nothing to point the designation at, so the
    // restore is the sanctioned clear — which names the departing agent as its
    // expectation exactly as the promotion form does.
    agentId: previous ?? designation.agentId,
    expectedLeadAgentId: designation.agentId,
    ...(previous === null && { clear: true as const }),
    ...(previous !== null && { restore: true as const }),
  });
  if (result !== undefined && result.outcome === 'lead-conflict') {
    console.debug(
      `[session.start] lead restore for session ${designation.sessionId} abandoned: a newer designation stands`,
    );
  }
}

/**
 * Undo the designation this cleanup's own reservation made, when it made one.
 *
 * The seam a shared cleanup needs to reach the designation at all: the policy is
 * the only thing every caller already threads through, and a rule the shared
 * helper cannot execute would simply have been skipped by all of them. Absent a
 * reservation this is a no-op, which is exactly the behaviour of every caller
 * that does not designate.
 *
 * Failures are logged and swallowed, like every other step on the way out of a
 * failed start: a clear that does not land must not replace the error the caller
 * is about to report — and, on the pre-dispatch path, must not stop the row
 * deletion that follows it, which is the step that keeps a `starting` row from
 * being arbitrated over by every later send.
 *
 * Takes the reservation rather than the policy, so the one caller that has a
 * reservation without a policy uses the same guarded form instead of reaching
 * past it.
 * @param bus - Bus the designation is written on.
 * @param reservation - The reservation whose designation is undone, when there is one.
 */
async function clearReservedDesignation(
  bus: IMakaioBus,
  reservation: SessionOwnershipReservation | undefined,
): Promise<void> {
  if (reservation === undefined) return;
  try {
    if (!reservation.leadDesignated) return;
    await restoreLeadDesignation(bus, reservation);
  } catch (error) {
    console.debug(`[session.start] clearing the designation of agent ${reservation.agentId} failed:`, error);
  }
}

/**
 * Undo the designation an unacknowledged keyless reservation may have committed.
 *
 * The request guard is safe to restore only through the minted-agent CAS: if
 * the reservation rolled back, or another writer has already moved the lead,
 * this is a no-op. It deliberately uses the same clear/restore mutation as a
 * returned reservation so every designation reversal has one marker contract.
 * @param bus - Bus the designation is written on.
 * @param designation - Request evidence reconstructed after a lost response.
 */
async function clearUncertainKeylessDesignation(
  bus: IMakaioBus,
  designation: UncertainKeylessDesignation | undefined,
): Promise<void> {
  if (designation === undefined) return;
  try {
    await restoreLeadDesignation(bus, {
      sessionId: designation.sessionId,
      agentId: designation.agentId,
      previousLeadAgentId: designation.transition === 'replace' ? designation.expectedLeadAgentId : null,
    });
  } catch (error) {
    console.debug(`[session.start] clearing uncertain designation of agent ${designation.agentId} failed:`, error);
  }
}

/**
 * Roll a start back to the state it found — the pre-dispatch cleanup of §7.4.
 *
 * Admissible only on evidence that nothing reached the provider: the reservation
 * was refused, or the adapter reported `dispatch: 'not-dispatched'`. It is the
 * only cleanup that gives the ownership key back cleanly and deletes the agent
 * row, because it is the only one that can prove there is nothing live behind
 * either.
 * @param bus - Bus the cleanup is issued on.
 * @param agentId - Agent whose row is removed.
 * @param reservation - The committed reservation, when one was taken.
 * @param uncertainDesignation - Keyless reservation request whose response may have been lost after commit.
 * @returns Whether the caller-owned row was deleted or verified absent.
 */
export async function rollbackReservedStart(
  bus: IMakaioBus,
  agentId: string,
  reservation: SessionOwnershipReservation | undefined,
  uncertainDesignation?: UncertainKeylessDesignation,
): Promise<ReservedStartRollback> {
  if (reservation !== undefined) {
    // A keyless reservation holds no claim, so the token-scoped release is a
    // no-op — issued anyway rather than branched on, because "the reservation's
    // own generation, and nothing else" is one rule at both ends.
    if (reservation.claim !== null) {
      await releaseClaim(bus, agentId, 'released', reservation.claim.claimToken);
    }
    await clearReservedDesignation(bus, reservation);
  }
  await clearUncertainKeylessDesignation(bus, uncertainDesignation);
  try {
    const deletion = await bus.requestOptional(AgentStorageSubjects.delete, { agentId });
    return { rowDeleted: deletion.handled && deletion.data.success ? true : await isRollbackRowAbsent(bus, agentId) };
  } catch (error) {
    console.debug(`[session.start] deleting agent ${agentId} during rollback failed:`, error);
    return { rowDeleted: await isRollbackRowAbsent(bus, agentId) };
  }
}

/**
 * Verify whether a deletion that threw nevertheless committed.
 * @param bus - Bus the exact agent row is read on.
 * @param agentId - Caller-minted agent identity expected to be gone.
 * @returns Whether storage confirmed that the row is absent.
 */
async function isRollbackRowAbsent(bus: IMakaioBus, agentId: string): Promise<boolean> {
  try {
    const result = await bus.requestOptional(AgentStorageSubjects.get, { agentId });
    return result.handled && result.data.agent === null;
  } catch (error) {
    console.debug(`[session.start] verifying rollback deletion of agent ${agentId} failed:`, error);
    return false;
  }
}

/**
 * Retire a start whose dispatch may have reached the provider.
 *
 * `abandoned` rather than `released`, because only a failure of *known* extent
 * may free an ownership key — and token-scoped rather than a fan-out, because
 * an attempt may only give back what it took (I15b). The designation is kept
 * unless the policy names the reservation that made it: the agent row survives
 * as `dead`, so a session whose lead this attempt did *not* designate still
 * names an agent it legitimately has.
 * @param bus - Bus the cleanup is issued on.
 * @param agentId - Agent whose claims are retired.
 * @param policy - What this cleanup may write on the start's behalf.
 * @param claimTokens - The generations this attempt is answerable for.
 */
export async function abandonDispatchedStart(
  bus: IMakaioBus,
  agentId: string,
  policy: StartCleanupPolicy,
  claimTokens: StartClaimTokens,
): Promise<void> {
  await giveBackStart(bus, agentId, 'abandoned', policy, claimTokens);
}

/**
 * Give a start back whose dispatch provably never reached the provider.
 *
 * The twin of {@link abandonDispatchedStart}, and it differs in exactly one
 * value: the key is `released` rather than retired, because the adapter
 * answered `dispatch: 'not-dispatched'` and there is no provider session behind
 * it to protect. The agent row is **not** deleted — this caller found the row,
 * it did not create it, so unwinding its own `starting` transition is all it
 * may undo.
 * @param bus - Bus the cleanup is issued on.
 * @param agentId - Agent whose claims are given back.
 * @param policy - What this cleanup may write on the start's behalf.
 * @param claimTokens - The generations this attempt is answerable for.
 */
export async function releaseUndispatchedStart(
  bus: IMakaioBus,
  agentId: string,
  policy: StartCleanupPolicy,
  claimTokens: StartClaimTokens,
): Promise<void> {
  await giveBackStart(bus, agentId, 'released', policy, claimTokens);
}

/**
 * Give back a start's generations and, when this caller owns it, its row.
 *
 * The disposition is the caller's evidence and is never inferred here — it is
 * the whole difference between the two exported forms.
 * @param bus - Bus the cleanup is issued on.
 * @param agentId - Agent whose claims are given up.
 * @param disposition - The caller's evidence about how far the start got.
 * @param policy - What this cleanup may write on the start's behalf.
 * @param claimTokens - The generations this attempt is answerable for.
 */
async function giveBackStart(
  bus: IMakaioBus,
  agentId: string,
  disposition: AdapterSessionClaimDisposition,
  policy: StartCleanupPolicy,
  claimTokens: StartClaimTokens,
): Promise<void> {
  await releaseNamedClaims(bus, agentId, disposition, claimTokens);
  // Before the status write, never after: a designation clear demands the agent
  // still be a member of the session, and the row is only ever kept here — but
  // stating the order once keeps it true if a caller ever removes the row.
  await clearReservedDesignation(bus, policy.reservation);
  if (!policy.writesAgentStatus) return;
  await markFailedStartDead(bus, agentId);
}

/**
 * Write the terminal status a failed start leaves behind, best-effort.
 *
 * **Advisory, and swallowed for that reason.** What a failed start is answerable
 * for is its generations, and those are given back before this runs; the status
 * is not ownership evidence (I21′) and no consumer decides ownership from it. A
 * row that keeps saying `starting` because this did not land is resolved by the
 * send path's in-flight rule on the next send — the same mechanism the
 * `settlement-unresolved` outcome relies on deliberately, which keeps its row
 * for exactly that reason.
 *
 * So a throw here must not become the caller's error: every other step of these
 * teardowns swallows, and this one running last would otherwise replace a
 * precisely classified start failure with a storage error about the cleanup.
 *
 * `transitioned: false` is accepted silently for the same reason: another
 * runtime already claimed this row's recovery, which is a better outcome than
 * the one being written.
 * @param bus - Bus the compare-and-swap is issued on.
 * @param agentId - Agent whose failed start is marked.
 */
async function markFailedStartDead(bus: IMakaioBus, agentId: string): Promise<void> {
  try {
    await bus.requestOptional(AgentStorageSubjects.updateStatus, {
      agentId,
      status: 'dead',
      expectedStatus: ['starting'],
    });
  } catch (error) {
    console.debug(`[session.start] marking agent ${agentId} dead failed:`, error);
  }
}

/** What a dispatched start must do about a settlement that was not accepted. */
interface RefusedSettlementCleanup {
  /** The failure the caller reports. */
  readonly code: SessionStartFailureCode;
  /** How the agent's claims are given up, or `null` to keep them. */
  readonly disposition: AdapterSessionClaimDisposition | null;
  /** Whether the live connector is stopped. */
  readonly stopConnector: boolean;
  /** Whether the agent row is compare-and-swapped from `starting` to `dead`. */
  readonly markDead: boolean;
}

/**
 * Classify a settlement outcome into the cleanup §7.5 prescribes for it.
 *
 * The connector is already live at this point, so a refused settlement is not a
 * start failure — it is a statement that this runtime may not own what the
 * connector is talking to. Two runtimes writing one provider session is the
 * thing being prevented, which is why an ownership refusal stops the connector
 * while an *unresolved* settlement deliberately does not: nothing there proves
 * the connector is illegitimate, only that this settlement did not land.
 * @param outcome - What the authority answered.
 * @returns The cleanup, or `undefined` when the settlement is accepted.
 */
function classifyRefusedSettlement(
  outcome: SessionOwnershipSettleMovementServiceResult['outcome'],
): RefusedSettlementCleanup | undefined {
  switch (outcome) {
    case 'settled':
    case 'idempotent':
      return undefined;
    case 'already-claimed':
    case 'superseded':
    case 'not-owner':
      return { code: 'ownership-refused', disposition: 'abandoned', stopConnector: true, markDead: true };
    case 'agent-disposed':
    case 'not-found':
      // A removal is a deliberate stop, so the key is freed cleanly. No status
      // write: the row is terminal or gone, and `starting → dead` would either
      // be refused or resurrect a row the removal deleted.
      return { code: 'agent-unavailable', disposition: 'released', stopConnector: true, markDead: false };
    case 'currency-changed':
    case 'machine-identity-unavailable':
      // Everything is kept, including the `starting` row: the send path's
      // in-flight rule resolves it, and the movement observer's next
      // announcement can still settle the currency.
      return { code: 'settlement-unresolved', disposition: null, stopConnector: false, markDead: false };
  }
}

/**
 * Stop a connector this runtime may no longer drive, best-effort.
 *
 * The response is deliberately not read: it reports only that an entry existed,
 * never that the connector closed, and treating it as evidence is what I15
 * forbids. A throw is logged and swallowed, because this runs on the way out of
 * a start that has already failed and a cleanup that threw would replace the
 * error the caller is about to see with one about the cleanup.
 * @param bus - Bus the stop is issued on.
 * @param adapterId - Adapter instance the connector lives on.
 * @param agentId - Agent whose connector is stopped.
 * @param ownerInstanceId - Exact runtime incarnation to address.
 * @param connectorOnly - Whether teardown must leave the caller-owned row untouched.
 */
export async function stopStartedConnector(
  bus: IMakaioBus,
  adapterId: string,
  agentId: string,
  ownerInstanceId: string,
  connectorOnly = false,
): Promise<void> {
  try {
    await bus.requestOptional(AdapterSubjects.stopAgent, {
      adapterId,
      agentId,
      ownerInstanceId,
      ...(connectorOnly && { teardown: 'connector-only' as const }),
    });
  } catch (error) {
    console.debug(`[session.start] stopping agent ${agentId} failed:`, error);
  }
}

/**
 * Apply §7.5 to a dispatched start's settlement outcome.
 *
 * Accepted outcomes return; every other one performs its tabulated teardown and
 * throws, because the caller must not go on to use a connector this runtime was
 * refused ownership of.
 * The result is taken whole, and its effective generation is recorded **before**
 * anything is decided from it — including on the accepted outcomes that return
 * straight away. That is the point of the ordering: a settlement can hand back
 * a generation the attempt did not reserve, and a later failure that could not
 * name it would strand it `held` on the key.
 * @param bus - Bus the cleanup is issued on.
 * @param adapterId - Adapter instance the connector lives on.
 * @param agentId - Agent the start was for.
 * @param ownerInstanceId - Exact runtime incarnation that hosted the start.
 * @param result - What the authority answered.
 * @param policy - What this cleanup may write on the start's behalf.
 * @param claimTokens - The generations this attempt is answerable for.
 */
export async function applySettlementOutcome(
  bus: IMakaioBus,
  adapterId: string,
  agentId: string,
  ownerInstanceId: string,
  result: SessionOwnershipSettleMovementServiceResult,
  policy: StartCleanupPolicy,
  claimTokens: StartClaimTokens,
): Promise<void> {
  claimTokens.record(result);
  const cleanup = classifyRefusedSettlement(result.outcome);
  if (cleanup === undefined) return;

  if (cleanup.disposition !== null) await releaseNamedClaims(bus, agentId, cleanup.disposition, claimTokens);
  // Part of this helper's own cleaning, not a second layer on top of it: this is
  // the one place that knows a *dispatched* start has failed for good, so it is
  // the only place a designation made for that start can honestly be undone.
  await clearReservedDesignation(bus, policy.reservation);
  if (cleanup.stopConnector)
    await stopStartedConnector(bus, adapterId, agentId, ownerInstanceId, policy.connectorOnlyTeardown);
  if (cleanup.markDead && policy.writesAgentStatus) await markFailedStartDead(bus, agentId);

  // The classification is what this helper exists to produce, and the teardown
  // above must not take it away: every step of it is best-effort, so the refusal
  // the authority named is what the caller sees.
  throw new SessionStartError(
    cleanup.code,
    `[session.start] settlement for agent ${agentId} was refused: ${result.outcome}`,
  );
}
