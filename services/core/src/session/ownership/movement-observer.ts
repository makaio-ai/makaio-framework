import type { IMakaioBus } from '@makaio/bus-core';
import { AgentSubjects, SessionSubjects, type SessionOwnershipServiceMovement } from '@makaio/contracts';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import { enqueueAgentSettle } from './settle-queue.js';

/**
 * Registers the provider-session movement observer.
 *
 * `agent.adapterSession.moved` is an **observation**, not a write. The seam
 * reports where an agent's provider conversation went; what that implies for
 * durable currency — which generation may record it, whether it supersedes
 * anything, whether the session snapshot follows — is the ownership authority's
 * to decide, inside one transaction. This handler's whole job is to turn the
 * announcement into a settle request and to order the settles of one agent.
 *
 * **No lead guard.** A member's movement is now recorded on its own agent row,
 * and the mirror onto the session row is gated inside the settle by the stored
 * designation. The old handler had to drop a member's movement because the only
 * row it could write was the session's; it also had to drop every movement
 * announced during a start, because the designation did not exist yet. Both
 * windows close here: the agent row always exists, and the reservation
 * designates before the first dispatch.
 *
 * **No change guard.** Storage answers `idempotent` for a target that is
 * already settled, which is a decision made against the stored row rather than
 * against a snapshot this handler read a moment earlier.
 *
 * **The announcement is acknowledged, not absorbed.** `bus.emit` resolves when
 * its handlers do, and the producer's seam contract reads that resolution as
 * "the currency write already happened" — it is what lets a producer order the
 * dispatch that abandons the old provider session behind the write, and what
 * lets it hold an undelivered movement for re-announcement. So this handler
 * waits for its queued settlement and answers honestly: it resolves only when
 * the authority actually recorded the movement, and rejects with a
 * {@link MovementNotSettledError} otherwise. Resolving on a refusal would let
 * the producer retire a movement no row carries.
 *
 * Rejecting is the seam's negative acknowledgment, not an escaping failure: the
 * one modeled error is what the producer catches and turns into `false`, and no
 * other error leaves this handler unclassified.
 * @param bus - Message bus used by the session service.
 * @returns Cleanup function.
 */
export function registerAdapterSessionMovementObserver(bus: IMakaioBus): () => void {
  return bus.on(AgentSubjects.adapterSession.moved, async (ctx) => {
    const { agentId, adapterId, adapterName, sessionId, adapterSessionId, confirmed } = ctx.payload;
    if (sessionId === undefined) return;

    // The seam schema refines the flag/ID pairing, but that refinement is not a
    // guarantee at this point: the bus skips payload validation entirely in
    // production builds, and the exported protocol manifest drops refinements
    // (JSON Schema cannot express them), so an SDK publisher has no schema-level
    // signal that the combination is invalid. Both directions are ignored rather
    // than interpreted, because neither names a movement that could be settled:
    // a confirmed movement without an ID advertises currency it cannot name, and
    // an unconfirmed one carrying an ID advertises a successor the provider never
    // acknowledged. Reinterpreting the latter as a plain demotion would void a
    // live key on a payload whose intent is undefined.
    if (confirmed !== (adapterSessionId !== undefined)) return;
    const movement: SessionOwnershipServiceMovement =
      adapterSessionId === undefined ? { confirmed: false } : { confirmed: true, providerSessionId: adapterSessionId };

    // Enqueued synchronously, before any await, so the chain's order is the
    // order the announcements were received in — and awaited, so the emit that
    // carried this announcement stays pending until the settlement is durable.
    await enqueueAgentSettle(agentId, async () => {
      await settleObservedMovement(bus, { agentId, adapterId, adapterName, sessionId }, movement);
    });
  });
}

/**
 * The authority did not record an announced movement.
 *
 * Carries the outcome so an operator reading the producer's warning can tell a
 * refused settlement from a host that has no authority to settle against. It is
 * the observer's only failure mode by design: everything else is caught and
 * re-reported through this one type, so a producer never has to distinguish a
 * modeled refusal from a bug.
 */
export class MovementNotSettledError extends Error {
  /** What the authority answered, or why nothing was asked. */
  public readonly outcome: string;

  /**
   * @param agentId - Agent whose movement was refused.
   * @param outcome - What the authority answered, or why nothing was asked.
   * @param options - Standard error options, carrying the cause when there is one.
   */
  public constructor(agentId: string, outcome: string, options?: ErrorOptions) {
    super(`[session.ownership] movement for agent ${agentId} was not settled: ${outcome}`, options);
    this.name = 'MovementNotSettledError';
    this.outcome = outcome;
  }
}

/** Principal an observed movement is settled for. */
interface ObservedMovementPrincipal {
  /** Agent that announced the movement. */
  readonly agentId: string;
  /** Live adapter instance the announcement came from. */
  readonly adapterId: string;
  /** Adapter type name the announcement came from. */
  readonly adapterName: string;
  /** Session the agent belongs to. */
  readonly sessionId: string;
}

/**
 * Settle one observed movement through the authority.
 *
 * The adapter-consistency guard is applied to the **agent row**, not the
 * session row: currency is agent-owned, so what must agree is the announcing
 * adapter and the adapter the agent is recorded under. Checking the session's
 * adapter identity instead would reject a member running a different adapter
 * within the same session, which is legitimate.
 *
 * The guard names the **instance**, not just the adapter type. An agent that was
 * rehydrated onto a new adapter instance leaves the old connector alive long
 * enough to announce; that announcement describes a provider session the agent
 * has stopped being current on, and settling it under the *old* instance's key
 * would write resume currency back over what the rehydrate just established.
 * The row is what says which instance the agent lives on, and the recovery paths
 * persist that before they settle — so an announcement whose instance the row
 * does not name is either superseded or has not been persisted yet, and in both
 * cases the honest answer is "not recorded". The seam re-announces, so the
 * second case resolves itself on the next event.
 *
 * Every way of not recording the movement — no agent row, a foreign adapter, no
 * authority, a refused settlement, a storage failure — is reported the same
 * way, because the producer needs exactly one bit back and every one of them
 * means the same thing to it: no row carries this movement, so keep it.
 * @param bus - Bus used for the agent read and the settle request.
 * @param principal - Who the movement is settled for.
 * @param movement - The observed movement.
 * @throws A {@link MovementNotSettledError} when nothing durable recorded the movement.
 */
async function settleObservedMovement(
  bus: IMakaioBus,
  principal: ObservedMovementPrincipal,
  movement: SessionOwnershipServiceMovement,
): Promise<void> {
  let outcome: string;
  try {
    const agentResult = await bus.requestOptional(AgentStorageSubjects.get, { agentId: principal.agentId });
    const agent = agentResult.handled ? agentResult.data.agent : null;
    if (agent === null) throw new MovementNotSettledError(principal.agentId, 'agent-row-unreadable');
    if (agent.adapterName !== principal.adapterName || agent.adapterId !== principal.adapterId) {
      throw new MovementNotSettledError(principal.agentId, 'adapter-mismatch');
    }

    const result = await bus.requestOptional(SessionSubjects.ownership.settleMovement, {
      sessionId: principal.sessionId,
      agentId: principal.agentId,
      adapterId: principal.adapterId,
      adapterName: principal.adapterName,
      movement,
    });
    if (!result.handled) throw new MovementNotSettledError(principal.agentId, 'authority-unavailable');
    if (result.data.outcome === 'settled' || result.data.outcome === 'idempotent') return;
    outcome = result.data.outcome;
  } catch (error) {
    if (error instanceof MovementNotSettledError) throw error;
    // A transport or storage failure is a non-settlement like any other, and is
    // re-reported as one so the producer has a single failure shape to read.
    throw new MovementNotSettledError(principal.agentId, 'settle-failed', { cause: error });
  }
  throw new MovementNotSettledError(principal.agentId, outcome);
}
