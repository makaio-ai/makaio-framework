import type { IMakaioBus } from '@makaio/bus-core';
import { AgentSubjects, SessionSubjects, type SessionOwnershipClaimResult } from '@makaio/contracts';
import { SessionStorageSubjects } from './storage/namespace.js';
import { AgentStorageSubjects } from './storage/agent-namespace.js';
import { designateSessionLead } from './ownership/index.js';
import { retireTerminalAgentClaims } from './ownership/retire-agent-claims.js';

/**
 * Report a designation this handler asked for and did not get.
 *
 * Neither refusal is an error the event handler can act on: `lead-conflict`
 * means a designation this handler never observed is now standing, and leaving
 * it standing is the whole point of the compare-and-swap; `agent-disposed` means
 * the agent was removed between the event and the write, and a removed agent may
 * never be made lead. Both are recorded so an operator can see that a
 * designation was attempted and lost, and neither is retried — the value that
 * won is more current than the one this handler read.
 *
 * **`undefined` — no ownership storage answered — is deliberately not given a
 * fallback writer.** It would leave a session with agents and no lead, whose
 * next send fails resolving its target, so the temptation is to write
 * `leadAgentId` directly here instead. That is refused on two counts. It cannot
 * happen: this handler and the ownership authority are registered by one call,
 * in one array, so they cannot come apart, and the only composition that could
 * still strand them — the authority up, its storage down — is the same one the
 * reserved start path refuses loudly, and one the framework's package graph
 * forbids (the session service depends on the session-storage package, which
 * registers the ownership handlers in the same all-or-nothing block). And it
 * would cost the invariant the wave was built for: the designation has exactly
 * one writer, the reserving transaction, which is what makes it a
 * compare-and-swap. A second writer that runs precisely when the first is
 * unavailable is a writer with no expectation to check, reintroducing the
 * whole-record overwrite that the `session.set` narrowing removed. A host that
 * cannot designate a lead cannot own a session either; it should fail where it
 * is misconfigured, not be papered over here.
 * @param agentId - Agent the designation was attempted for.
 * @param result - What the reserving transaction answered, if anything.
 */
function logRefusedDesignation(agentId: string, result: SessionOwnershipClaimResult | undefined): void {
  if (result === undefined) return;
  if (result.outcome === 'lead-conflict') {
    console.debug(
      `[session.agent.added] lead designation for ${agentId} lost to ${result.currentLeadAgentId ?? 'no lead'}`,
    );
    return;
  }
  if (result.outcome !== 'claimed' && result.outcome !== 'idempotent') {
    console.debug(`[session.agent.added] lead designation for ${agentId} refused: ${result.outcome}`);
  }
}

/**
 * Error raised when the storage backend did not prove a terminal status transition.
 * @param agentId - Agent whose terminal transition was unproved.
 * @returns Error preserving the failed terminalization as the primary outcome.
 */
function terminalizationFailure(agentId: string): Error {
  return new Error(`[session.agent.removed] Failed to terminalize agent ${agentId}`);
}

/**
 * Attempt one removal act without preventing the remaining terminal cleanup.
 * @param action - One durable or runtime cleanup operation.
 * @returns The thrown error, if any, after the action has been attempted.
 */
async function attemptRemovalAct(action: () => Promise<void>): Promise<unknown | undefined> {
  try {
    await action();
    return undefined;
  } catch (error) {
    return error;
  }
}

/**
 * Registers the `session.agent.added` event handler.
 *
 * **This handler writes no record.** The lead designation goes through the
 * keyless reserving transaction, which takes the lead the handler read as its
 * expectation; the adapter identity goes through a conditional partial write
 * carrying its own predicate; and the ordinary path writes the single field this
 * announcement produces. Every one of the three states what it expects to be
 * true, so nothing here can carry a snapshot back over a decision taken after
 * the read it came from.
 * @param bus - Message bus used by the session service
 * @returns Cleanup function
 */
export function registerAgentAddedHandler(bus: IMakaioBus): () => void {
  return bus.on(SessionSubjects.agent.added, async (ctx) => {
    const result = await bus.requestOptional(SessionStorageSubjects.get, {
      sessionId: ctx.payload.sessionId,
    });

    const session = result.handled ? result.data.session : undefined;
    if (!session) return;

    const resolvedRole = ctx.payload.role ?? (!session.leadAgentId ? 'lead' : 'member');
    // **The designation runs first, because its outcome is what answers "whose
    // identity is this".** The session row this handler read is a snapshot; the
    // lead it names is the lead as of the read, and the compare-and-swap below
    // is what decides who leads as of now. Deciding the identity from the
    // snapshot instead let a member arriving before its session's lead — two
    // processes, or two starts interleaved — establish the identity for good,
    // because nothing can reopen it afterwards.
    const designation =
      resolvedRole === 'lead'
        ? await designateSessionLead(bus, {
            sessionId: ctx.payload.sessionId,
            agentId: ctx.payload.agentId,
            expectedLeadAgentId: session.leadAgentId ?? null,
          })
        : undefined;
    if (resolvedRole === 'lead') logRefusedDesignation(ctx.payload.agentId, designation);

    // **Whether it is still open, and whose it is.** Both used to be answered by
    // `session.adapterSessionId`, and neither survives it: a reserved start
    // withholds the provider session from this event — the settlement that
    // claims the key publishes it — so an established identity read as
    // unestablished and the next agent restamped it. *Open* is `adapterName`,
    // the half that is always written when the identity is established.
    // *Whose* is the agent this event just made lead. A host where nothing can
    // designate answers neither question, and there the first agent observed
    // establishes it, exactly as before — the one composition that has no later
    // lead to be wrong about.
    const thisAgentLeads = designation?.outcome === 'claimed' || designation?.outcome === 'idempotent';
    const noDesignationWriter = resolvedRole === 'lead' && designation === undefined;
    if (!session.adapterName && (thisAgentLeads || noDesignationWriter)) {
      // **The predicate's expectation is derived per case, not shared.** Two
      // different facts lead here and they expect different leads:
      //
      // - `thisAgentLeads` — the compare-and-swap made *this* agent the lead, so
      //   the only reading that still speaks for the session is this agent's own
      //   id. A `session.agent.removed` landing between the designation and the
      //   write clears the designation under a swap naming the departing agent,
      //   and on a fresh session that leaves `leadAgentId` back at `undefined` —
      //   which is what this handler *observed*. Accepting the observed value
      //   here stamped the identity for an agent that had just been removed, and
      //   write-once left no later lead able to correct it.
      // - `noDesignationWriter` — nothing in this host can designate, so nothing
      //   can have changed the lead either; the expectation is the value this
      //   handler read, and it is the only case where that is a statement about
      //   anything.
      //
      // A replacement lead is the first case, not a third: its swap answers
      // `claimed` against the lead it replaced, so it expects itself.
      const expectedLeadAgentId = thisAgentLeads ? ctx.payload.agentId : session.leadAgentId;
      await establishSessionAdapterIdentity(bus, ctx.payload, expectedLeadAgentId);
      return;
    }

    // **The ordinary path writes one field, not the record.** A whole-record
    // write carries every column of a snapshot this handler read before the
    // designation, and a `session.close` that lands in between would be undone
    // by it: `status` would go back to what the read saw, reviving a session
    // whose connector may already be gone. Activity is the only thing this
    // agent's arrival changes, so it is the only thing written.
    await bus.requestOptional(SessionStorageSubjects.update, {
      sessionId: ctx.payload.sessionId,
      lastActivityAt: Date.now(),
    });
  });
}

/**
 * Publish the adapter identity a session's first lead establishes.
 *
 * **One conditional write, and no snapshot of the session at all.** The identity
 * triplet is a narrow operation on `storage:session.update`, guarded by
 * `expectIdentityOpenForLead` — the identity is still open and the row still
 * names this agent as its lead — so the check the write rests on is evaluated by
 * the same statement that writes. What this removes is the window a re-read left
 * behind it: a peer that established the identity, or a designation that moved,
 * after the read and before the write used to be overwritten by a record this
 * handler had already assembled. Now such a write matches nothing and reports
 * `success: false`.
 *
 * Activity travels **with** the guarded write, so a refusal withholds it too, and
 * the refusal path writes it separately: the announcement happened either way,
 * and the row's last activity is the one fact it produces unconditionally.
 * @param bus - Bus the writes are issued on.
 * @param payload - The announcement whose adapter identity is published.
 * @param expectedLeadAgentId - The designation the row must still carry for this
 *   agent to speak for the session — derived from the designation's outcome by
 *   the caller, never from the snapshot it read. `undefined` becomes an explicit
 *   "no designation" expectation, which is the state of a host that has no
 *   designation authority at all.
 */
async function establishSessionAdapterIdentity(
  bus: IMakaioBus,
  payload: { sessionId: string; agentId: string; adapterId: string; adapterName: string; adapterSessionId?: string },
  expectedLeadAgentId: string | undefined,
): Promise<void> {
  const established = await bus.requestOptional(SessionStorageSubjects.update, {
    sessionId: payload.sessionId,
    lastActivityAt: Date.now(),
    identity: {
      adapterName: payload.adapterName,
      adapterId: payload.adapterId,
      adapterSessionId: payload.adapterSessionId,
    },
    expectIdentityOpenForLead: expectedLeadAgentId ?? null,
  });
  if (!established.handled || established.data.success) return;

  // Refused, or the row is gone — storage does not distinguish them and this
  // handler does not need it to: neither leaves an identity for this agent to
  // publish, and an activity write against a missing row is a no-op.
  await bus.requestOptional(SessionStorageSubjects.update, {
    sessionId: payload.sessionId,
    lastActivityAt: Date.now(),
  });
}

/**
 * Registers the `session.agent.removed` event handler.
 *
 * Three acts, in an order the ownership seam is written around:
 * 1. the agent row is marked `disposed`, which is absorbing for ownership — from
 *    here on no reservation, settlement or takeover can give it authority again;
 * 2. its lead designation is cleared through the reserving transaction, under a
 *    compare-and-swap naming the departing agent — so a designation that has
 *    since moved to someone else is left standing, and removing a **non-lead**
 *    agent writes nothing at all.
 * 3. every exact owner runtime is retired or stopped with observed evidence;
 *    claims are released only when the terminal row transition was proved.
 *
 * The clear runs before connector teardown and is deliberately not refused for a disposed agent:
 * giving authority up is the one ownership act a removed agent must still
 * perform, and a guard here would strand the designation this step exists to
 * unset. Its outcome is not inspected either, unlike the added handler's: a
 * refusal is the *expected* answer whenever the removed agent was not the lead,
 * so reporting one would be noise on the ordinary path.
 * @param bus - Message bus used by the session service
 * @returns Cleanup function
 */
export function registerAgentRemovedHandler(bus: IMakaioBus): () => void {
  return bus.on(SessionSubjects.agent.removed, async (ctx) => {
    const result = await bus.requestOptional(SessionStorageSubjects.get, {
      sessionId: ctx.payload.sessionId,
    });

    const session = result.handled ? result.data.session : undefined;
    if (!session) return;

    const terminalizationError = await attemptRemovalAct(async () => {
      const status = await bus.requestOptional(AgentStorageSubjects.updateStatus, {
        agentId: ctx.payload.agentId,
        status: 'disposed',
      });
      // With no expected predecessor, a successful non-transition means the
      // storage row was already disposed; that is an idempotently proved terminal state.
      if (!status.handled || !status.data.success) {
        throw terminalizationFailure(ctx.payload.agentId);
      }
    });
    const leadError = await attemptRemovalAct(async () => {
      await designateSessionLead(bus, {
        sessionId: ctx.payload.sessionId,
        agentId: ctx.payload.agentId,
        expectedLeadAgentId: ctx.payload.agentId,
        clear: true,
      });
    });
    const teardownError = await attemptRemovalAct(async () => {
      await retireTerminalAgentClaims(bus, ctx.payload.agentId, { releaseClaims: terminalizationError === undefined });
    });
    const activityError = await attemptRemovalAct(async () => {
      await bus.requestOptional(SessionStorageSubjects.update, {
        sessionId: ctx.payload.sessionId,
        lastActivityAt: Date.now(),
      });
    });

    if (terminalizationError !== undefined) throw terminalizationError;
    if (leadError !== undefined) throw leadError;
    if (teardownError !== undefined) throw teardownError;
    if (activityError !== undefined) throw activityError;
  });
}

/**
 * Registers the adapter-session-ID reconciliation handler.
 *
 * When a fork child is started idle, the adapter persists `adapterSessionId: undefined`
 * because the provider has not yet confirmed the session. On first message dispatch,
 * the enriched `agent.started` event carries the provider-confirmed ID. This handler
 * back-fills agent storage and session storage with that confirmed ID.
 *
 * **Agent-level backfill** is unconditional: each agent owns its own
 * `adapterSessionId` regardless of which adapter it belongs to.
 *
 * **Session-level backfill follows the lead, and only the lead.** The columns it
 * writes are what a resume targets while no settlement has published currency
 * for the session, so they describe the lead's conversation or nothing: a member
 * is skipped whichever adapter it runs, and so is a sibling *instance* of the
 * session's own adapter. Where the identity is already established the write
 * must also match it, name and instance; where it is not, the lead establishes
 * the whole triplet at once.
 *
 * Idempotent: only writes when the stored value is missing.
 * Write-once: the first qualifying `agent.started` event wins.
 *
 * **One atomic reconciliation write.** Storage owns the composite predicate:
 * provider session ID remains unset, this agent remains the lead, and identity is
 * fully open or exactly matches this announcement. This keeps the read used for
 * agent-level backfill from becoming authority for session-level storage.
 * @param bus - Message bus used by the session service
 * @returns Cleanup function
 */
export function registerAdapterSessionIdReconciliationHandler(bus: IMakaioBus): () => void {
  return bus.on(AgentSubjects.started, async (ctx) => {
    const { agentId, adapterSessionId, adapterName, adapterId, sessionId } = ctx.payload;
    // Nothing to reconcile if the event lacks a confirmed ID or session context.
    if (!adapterSessionId || !sessionId) return;

    // ── Agent storage reconciliation ─────────────────────────────────
    // Unconditional: each agent owns its own provider session ID.
    const agentResult = await bus.requestOptional(AgentStorageSubjects.get, { agentId });
    const agent = agentResult.handled ? agentResult.data.agent : null;

    if (agent && !agent.adapterSessionId) {
      await bus.requestOptional(AgentStorageSubjects.updateRuntime, {
        agentId,
        adapterSessionId,
      });
    }

    await bus.requestOptional(SessionStorageSubjects.update, {
      sessionId,
      reconcileAdapterSession: {
        agentId,
        adapterName,
        adapterId,
        adapterSessionId,
        lastActivityAt: Date.now(),
      },
    });
  });
}
