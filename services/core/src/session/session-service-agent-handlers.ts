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

    const isFirstAgent = !session.adapterSessionId;
    if (isFirstAgent) {
      session.adapterSessionId = ctx.payload.adapterSessionId;
      session.adapterName = ctx.payload.adapterName;
      session.adapterId = ctx.payload.adapterId;
    }

    const resolvedRole = ctx.payload.role ?? (!session.leadAgentId ? 'lead' : 'member');
    if (resolvedRole === 'lead') {
      logRefusedDesignation(
        ctx.payload.agentId,
        await designateSessionLead(bus, {
          sessionId: ctx.payload.sessionId,
          agentId: ctx.payload.agentId,
          expectedLeadAgentId: session.leadAgentId ?? null,
        }),
      );
    }

    session.lastActivityAt = Date.now();
    await bus.request(SessionStorageSubjects.set, {
      sessionId: ctx.payload.sessionId,
      session,
    });
  });
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

    session.lastActivityAt = Date.now();
    await bus.request(SessionStorageSubjects.set, {
      sessionId: ctx.payload.sessionId,
      session,
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
 * **Session-level backfill** enforces ownership-match semantics:
 * - When `session.adapterName` is already set, the handler only writes
 *   `session.adapterSessionId` if the emitting agent's `adapterName`
 *   matches the session's adapter identity. A member agent on a different
 *   adapter confirming first is silently skipped — its provider session ID
 *   belongs to a foreign adapter and would create an inconsistent pair with
 *   `session.adapterName`.
 * - When `session.adapterName` is unset (legacy or pre-agent-added sessions),
 *   the handler sets the full adapter identity triplet (`adapterSessionId`,
 *   `adapterName`, `adapterId`) atomically, consistent with how
 *   `registerAgentAddedHandler` establishes the initial pair.
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

    // Write-once: only set session-level adapterSessionId when it is absent.
    if (!session.adapterSessionId) {
      if (session.adapterName) {
        // Session already has an adapter identity (set by agent.added). Only
        // backfill the provider session ID when the emitting agent belongs to
        // the same adapter — prevents a foreign adapter's provider ID from
        // being stored alongside the session's adapter identity.
        if (adapterName !== session.adapterName) return;

        session.adapterSessionId = adapterSessionId;
      } else {
        // Legacy / pre-agent-added session with no adapter identity.
        // Establish the full triplet atomically, matching the contract in
        // registerAgentAddedHandler.
        session.adapterSessionId = adapterSessionId;
        session.adapterName = adapterName;
        session.adapterId = adapterId;
      }

      session.lastActivityAt = Date.now();
      await bus.requestOptional(SessionStorageSubjects.set, { sessionId, session });
    }
  });
}
