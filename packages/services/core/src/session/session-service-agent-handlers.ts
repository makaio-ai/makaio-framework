import type { IMakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
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
