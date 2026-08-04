import type { IMakaioBus } from '@makaio/bus-core';
import { AgentSubjects, SessionSubjects, type SessionOwnershipClaimResult } from '@makaio/contracts';
import { SessionStorageSubjects } from './storage/namespace.js';
import { AgentStorageSubjects } from './storage/agent-namespace.js';
import { designateSessionLead } from './ownership/index.js';

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
 * Registers the `session.agent.added` event handler.
 *
 * The lead designation is **not** part of the whole-record write this handler
 * ends with. It goes through the keyless reserving transaction, which takes the
 * lead the handler read as its expectation, so a designation that landed between
 * the read and the write survives instead of being overwritten by a snapshot
 * that predates it. The whole-record `set` carries the remaining fields and no
 * longer decides who leads — both backends preserve the stored designation
 * across it.
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
      // **The re-read's expectation is derived per case, not shared.** Two
      // different facts lead here and they expect different leads:
      //
      // - `thisAgentLeads` — the compare-and-swap made *this* agent the lead, so
      //   the only reading that still speaks for the session is this agent's own
      //   id. A `session.agent.removed` landing between the designation and the
      //   re-read clears the designation under a swap naming the departing
      //   agent, and on a fresh session that leaves `leadAgentId` back at
      //   `undefined` — which is what this handler *observed*. Accepting the
      //   observed value here stamped the identity for an agent that had just
      //   been removed, and write-once left no later lead able to correct it.
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
 * **The one write here that still carries a whole record**, because the identity
 * triplet has no narrow operation: `storage:session.update` covers activity,
 * status and provenance, and deliberately not the adapter pair — so an
 * establishing lead has `set` or nothing.
 *
 * Two consequences, both narrowed as far as a handler can:
 *
 * - The row is **re-read immediately before the write**, so the record carried
 *   back is the freshest one this handler can obtain. A `session.close` that
 *   landed before that read is preserved; only one landing inside the gap
 *   between the read and the write is undone.
 * - The identity and the designation are **re-checked against that read**, so a
 *   lead that paused while another lead established the identity and replaced it
 *   writes nothing. The check is not atomic with the write, and cannot be made
 *   so from here: closing it needs the conditional identity write that
 *   `session.update` does not have — see the Wave-4 watchlist.
 * @param bus - Bus the read and the write are issued on.
 * @param payload - The announcement whose adapter identity is published.
 * @param expectedLeadAgentId - The lead the re-read must still name for this
 *   agent to speak for the session — derived from the designation's outcome by
 *   the caller, never from the snapshot it read.
 */
async function establishSessionAdapterIdentity(
  bus: IMakaioBus,
  payload: { sessionId: string; agentId: string; adapterId: string; adapterName: string; adapterSessionId?: string },
  expectedLeadAgentId: string | undefined,
): Promise<void> {
  const reread = await bus.requestOptional(SessionStorageSubjects.get, { sessionId: payload.sessionId });
  const session = reread.handled ? reread.data.session : undefined;
  if (!session) return;
  // Somebody established the identity while this handler worked, or the
  // designation this write rests on is no longer standing — a replacement, or a
  // removal that cleared it. Either way this agent no longer speaks for the
  // session's identity, and the activity write below is all that is left.
  if (session.adapterName || session.leadAgentId !== expectedLeadAgentId) {
    await bus.requestOptional(SessionStorageSubjects.update, {
      sessionId: payload.sessionId,
      lastActivityAt: Date.now(),
    });
    return;
  }

  session.adapterSessionId = payload.adapterSessionId;
  session.adapterName = payload.adapterName;
  session.adapterId = payload.adapterId;
  session.lastActivityAt = Date.now();
  await bus.request(SessionStorageSubjects.set, { sessionId: payload.sessionId, session });
}

/**
 * Registers the `session.agent.removed` event handler.
 *
 * Three acts, in an order the ownership seam is written around:
 * 1. the agent row is marked `disposed`, which is absorbing for ownership — from
 *    here on no reservation, settlement or takeover can give it authority again;
 * 2. every claim it still holds is given up cleanly, because a removal is a
 *    deliberate stop rather than a failure of unknown extent, and only a clean
 *    release frees the ownership key;
 * 3. its lead designation is cleared through the reserving transaction, under a
 *    compare-and-swap naming the departing agent — so a designation that has
 *    since moved to someone else is left standing, and removing a **non-lead**
 *    agent writes nothing at all.
 *
 * The clear runs last and is deliberately not refused for a disposed agent:
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

    await bus.requestOptional(AgentStorageSubjects.updateStatus, {
      agentId: ctx.payload.agentId,
      status: 'disposed',
    });
    // **Accepted residual — the release can outrun the connector it frees.**
    // `released` says this key is free for anyone to claim, and the evidence
    // behind it is that a caller asked `adapter.stopAgent` and it returned. That
    // return does not mean the connector is closed: the registry's disposal
    // schedules `agent.close()` and does not await it, and close hooks time out
    // and are swallowed, so the previous writer can still be speaking to the
    // provider session while the next claimant takes it.
    //
    // Not narrowed here, and deliberately not narrowed at all. Proving a
    // connector closed is the capability this aggregate does not have — it is
    // OQ-E, cut from this wave with the rest of the liveness complex (§17), and
    // every partial mitigation available here (a delay, a poll, a
    // stop-confirmation flag) rebuilds a piece of that proof from evidence that
    // is exactly as weak as the return value already is. Wave 4 closes it by
    // giving `stopAgent` a real completion contract — a close that reports
    // *observed* teardown — after which this release moves behind it.
    //
    // What bounds it today: the release is a deliberate teardown of an agent the
    // caller has stopped, and the next claimant is refused nothing — so the
    // exposure is a second writer on a provider session for as long as the old
    // connector's close takes, not an unbounded one.
    await bus.requestOptional(SessionSubjects.ownership.release, {
      agentId: ctx.payload.agentId,
      disposition: 'released',
    });
    await designateSessionLead(bus, {
      sessionId: ctx.payload.sessionId,
      agentId: ctx.payload.agentId,
      expectedLeadAgentId: ctx.payload.agentId,
      clear: true,
    });

    // Activity only, and through the narrow write for the reason the added
    // handler states: a whole record would carry this handler's pre-teardown
    // snapshot back over a `session.close` that landed while it worked.
    await bus.requestOptional(SessionStorageSubjects.update, {
      sessionId: ctx.payload.sessionId,
      lastActivityAt: Date.now(),
    });
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
 * the whole triplet at once, exactly as `registerAgentAddedHandler` does.
 *
 * Idempotent: only writes when the stored value is missing.
 * Write-once: the first qualifying `agent.started` event wins.
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

    // ── Session storage reconciliation ───────────────────────────────
    const sessionResult = await bus.requestOptional(SessionStorageSubjects.get, { sessionId });
    const session = sessionResult.handled ? sessionResult.data.session : null;
    if (!session) return;

    // **The session row's adapter identity and resume key are its lead's.** One
    // rule for both halves of this write, because three rounds of narrowing one
    // condition at a time each left the other half open:
    //
    // - *whose* — the lead's, and no one else's. Not the first agent observed,
    //   not a sibling instance, not a member that confirmed first. The column is
    //   what a resume targets while no settlement has published currency for the
    //   session, so an agent that is not the lead points the session at a
    //   conversation that is not its own.
    // - *when* — once, while it is unset, and never again.
    //
    // **An absent lead is not evidence of a host that cannot designate.** That
    // was the standing exception, and it does not hold: a start that carries an
    // initial message emits this event from inside its own start call, before
    // that start's `session.agent.added` announces the agent at all — so the
    // session legitimately has no lead yet, in a fully designated composition,
    // every time the first turn confirms a provider session. Reading `undefined`
    // as "nothing can designate here" therefore admits an ordinary start's
    // member, which is the case the guard exists for. A host that genuinely
    // cannot designate a lead cannot own a session either (see
    // {@link logRefusedDesignation}), and it gets no session-level identity from
    // here — its lead's own first turn establishes it, as every other session's
    // does.
    if (!session.adapterSessionId && session.leadAgentId === agentId) {
      // The instance, not only the adapter *type*: a provider session is minted
      // inside one instance, and two instances of one adapter name are two
      // machines. Checked only where the identity is already established —
      // where it is not, this agent *is* the identity, being the lead.
      if (session.adapterName !== undefined && (adapterName !== session.adapterName || adapterId !== session.adapterId))
        return;

      session.adapterSessionId = adapterSessionId;
      session.adapterName = adapterName;
      session.adapterId = adapterId;

      session.lastActivityAt = Date.now();
      await bus.requestOptional(SessionStorageSubjects.set, { sessionId, session });
    }
  });
}
