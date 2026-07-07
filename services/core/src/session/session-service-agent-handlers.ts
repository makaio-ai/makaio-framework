import type { IMakaioBus } from '@makaio/bus-core';
import { AgentSubjects, SessionSubjects } from '@makaio/contracts';
import { SessionStorageSubjects } from './storage/namespace.js';
import { AgentStorageSubjects } from './storage/agent-namespace.js';

/**
 * Registers the `session.agent.added` event handler.
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
      session.leadAgentId = ctx.payload.agentId;
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

    if (session.leadAgentId === ctx.payload.agentId) {
      session.leadAgentId = undefined;
    }

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
