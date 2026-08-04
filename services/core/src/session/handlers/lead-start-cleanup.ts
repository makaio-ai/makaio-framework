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
  /**
   * Whether this caller owns `agents.status` for the start being cleaned up.
   *
   * `false` suppresses every status write; a caller that does not own the
   * column must not compare-and-swap it either, because losing that swap would
   * be read as an arbitration it never entered.
   */
  readonly writesAgentStatus: boolean;
}

/**
 * Give up claims for an agent, best-effort.
 *
 * Naming the token is the **rollback** form: it retires exactly the generation
 * the failed attempt took and never a second one the agent may hold from an
 * unrelated in-flight movement. Omitting it is the **teardown** form, which is
 * the only complete one once a dispatch has happened — the failed start may have
 * produced a generation this caller cannot name.
 *
 * Failures are logged and swallowed: a release that does not land must never
 * mask the start failure that caused it.
 * @param bus - Bus the release is issued on.
 * @param agentId - Agent whose claims are given up.
 * @param disposition - The caller's evidence, never inferred here.
 * @param claimToken - Scope the act to one generation; omit for the fan-out.
 */
async function releaseClaims(
  bus: IMakaioBus,
  agentId: string,
  disposition: AdapterSessionClaimDisposition,
  claimToken?: string,
): Promise<void> {
  try {
    await bus.requestOptional(SessionSubjects.ownership.release, {
      agentId,
      disposition,
      ...(claimToken !== undefined && { claimToken }),
    });
  } catch (error) {
    console.debug(`[session.start] release for agent ${agentId} failed:`, error);
  }
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
 * @param reservation - The reservation being rolled back.
 */
async function restoreLeadDesignation(bus: IMakaioBus, reservation: SessionOwnershipReservation): Promise<void> {
  if (!reservation.leadDesignated) return;
  const previous = reservation.previousLeadAgentId;
  const result = await designateSessionLead(bus, {
    sessionId: reservation.sessionId,
    // With no previous lead there is nothing to point the designation at, so the
    // restore is the sanctioned clear — which names the departing agent as its
    // expectation exactly as the promotion form does.
    agentId: previous ?? reservation.agentId,
    expectedLeadAgentId: reservation.agentId,
    ...(previous === null && { clear: true as const }),
  });
  if (result !== undefined && result.outcome === 'lead-conflict') {
    console.debug(
      `[session.start] lead restore for session ${reservation.sessionId} abandoned: a newer designation stands`,
    );
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
 */
export async function rollbackReservedStart(
  bus: IMakaioBus,
  agentId: string,
  reservation: SessionOwnershipReservation | undefined,
): Promise<void> {
  if (reservation !== undefined) {
    // A keyless reservation holds no claim, so the token-scoped release is a
    // no-op — issued anyway rather than branched on, because "the reservation's
    // own generation, and nothing else" is one rule at both ends.
    if (reservation.claim !== null) {
      await releaseClaims(bus, agentId, 'released', reservation.claim.claimToken);
    }
    await restoreLeadDesignation(bus, reservation);
  }
  await bus.requestOptional(AgentStorageSubjects.delete, { agentId });
}

/**
 * Retire a start whose dispatch may have reached the provider.
 *
 * The fan-out form, because the failed start may itself have produced a
 * generation the caller cannot name, and `abandoned` rather than `released`,
 * because only a failure of *known* extent may free an ownership key. The
 * designation is kept: the agent row survives as `dead`, so the session's lead
 * still names an agent it legitimately has.
 * @param bus - Bus the cleanup is issued on.
 * @param agentId - Agent whose claims are retired.
 * @param policy - Whether this caller owns the agent's status column.
 */
export async function abandonDispatchedStart(
  bus: IMakaioBus,
  agentId: string,
  policy: StartCleanupPolicy,
): Promise<void> {
  await releaseClaims(bus, agentId, 'abandoned');
  if (!policy.writesAgentStatus) return;
  try {
    // `transitioned: false` is accepted silently: another runtime already
    // claimed this row's recovery, which is a better outcome than the one being
    // written.
    await bus.requestOptional(AgentStorageSubjects.updateStatus, {
      agentId,
      status: 'dead',
      expectedStatus: ['starting'],
    });
  } catch (error) {
    // Swallowed for the same reason the release above is: this runs on the way
    // out of a failed start, and a cleanup step that throws would replace the
    // error the caller is about to report with one about the cleanup.
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
 * Apply §7.5 to a dispatched start's settlement outcome.
 *
 * Accepted outcomes return; every other one performs its tabulated teardown and
 * throws, because the caller must not go on to use a connector this runtime was
 * refused ownership of.
 * @param bus - Bus the cleanup is issued on.
 * @param adapterId - Adapter instance the connector lives on.
 * @param agentId - Agent the start was for.
 * @param outcome - What the authority answered.
 * @param policy - Whether this caller owns the agent's status column.
 */
export async function applySettlementOutcome(
  bus: IMakaioBus,
  adapterId: string,
  agentId: string,
  outcome: SessionOwnershipSettleMovementServiceResult['outcome'],
  policy: StartCleanupPolicy,
): Promise<void> {
  const cleanup = classifyRefusedSettlement(outcome);
  if (cleanup === undefined) return;

  if (cleanup.disposition !== null) await releaseClaims(bus, agentId, cleanup.disposition);
  if (cleanup.stopConnector) {
    try {
      await bus.requestOptional(AdapterSubjects.stopAgent, { adapterId, agentId });
    } catch (error) {
      console.debug(`[session.start] stopping refused agent ${agentId} failed:`, error);
    }
  }
  if (cleanup.markDead && policy.writesAgentStatus) {
    await bus.requestOptional(AgentStorageSubjects.updateStatus, {
      agentId,
      status: 'dead',
      expectedStatus: ['starting'],
    });
  }

  throw new SessionStartError(cleanup.code, `[session.start] settlement for agent ${agentId} was refused: ${outcome}`);
}
