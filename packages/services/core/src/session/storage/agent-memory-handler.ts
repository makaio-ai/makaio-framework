import type { IMakaioBus } from '@makaio/bus-core';
import type { MakaioSessionAgent } from '@makaio/contracts';
import { AgentStorageSubjects } from './agent-namespace.js';

/**
 * Apply runtime field updates to an agent record.
 *
 * Returns `false` when none of the mutable fields are provided (no-op guard).
 * @param agent - Agent record to mutate in-place
 * @param cwd - New working directory, or `undefined` to leave unchanged
 * @param model - New model identifier, or `undefined` to leave unchanged
 * @param providerConfigId - New provider config UUID, or `undefined` to leave unchanged
 * @returns `true` if at least one field was updated, `false` otherwise
 */
function applyRuntimeUpdate(
  agent: MakaioSessionAgent,
  cwd: string | undefined,
  model: string | undefined,
  providerConfigId: string | undefined,
): boolean {
  if (cwd === undefined && model === undefined && providerConfigId === undefined) return false;
  if (cwd !== undefined) agent.cwd = cwd;
  if (model !== undefined) agent.model = model;
  if (providerConfigId !== undefined) agent.providerConfigId = providerConfigId;
  return true;
}

/**
 * Register in-memory agent storage handlers.
 *
 * Suitable for development and testing. Data is lost when the process exits.
 * @param bus - The bus instance to register handlers on
 * @returns Cleanup function to unsubscribe all handlers
 */
export function registerMemoryAgentStorage(bus: IMakaioBus): () => void {
  const store = new Map<string, MakaioSessionAgent>();
  const unsubs: Array<() => void> = [];

  // storage:agent.get
  unsubs.push(
    bus.on(AgentStorageSubjects.get, (ctx) => {
      const agent = store.get(ctx.payload.agentId) ?? null;
      ctx.setResult({ agent });
    }),
  );

  // storage:agent.set
  unsubs.push(
    bus.on(AgentStorageSubjects.set, (ctx) => {
      store.set(ctx.payload.agentId, ctx.payload.agent);
      ctx.setResult({ success: true });
    }),
  );

  // storage:agent.delete
  unsubs.push(
    bus.on(AgentStorageSubjects.delete, (ctx) => {
      const deleted = store.delete(ctx.payload.agentId);
      ctx.setResult({ success: deleted });
    }),
  );

  // storage:agent.listByAdapter
  unsubs.push(
    bus.on(AgentStorageSubjects.listByAdapter, (ctx) => {
      const { adapterName, status } = ctx.payload;
      let agents = Array.from(store.values()).filter((a) => a.adapterName === adapterName);
      if (status && status !== 'all') {
        agents = agents.filter((a) => a.status === status);
      }
      ctx.setResult({ agents });
    }),
  );

  // storage:agent.listBySession
  unsubs.push(
    bus.on(AgentStorageSubjects.listBySession, (ctx) => {
      const agents = Array.from(store.values()).filter((a) => a.sessionId === ctx.payload.sessionId);
      ctx.setResult({ agents });
    }),
  );

  // storage:agent.updateStatus
  unsubs.push(
    bus.on(AgentStorageSubjects.updateStatus, (ctx) => {
      const agent = store.get(ctx.payload.agentId);
      if (!agent) {
        ctx.setResult({ success: false });
        return;
      }
      agent.status = ctx.payload.status;
      agent.lastActivityAt = Date.now();
      ctx.setResult({ success: true });
    }),
  );

  // storage:agent.updateActivity
  unsubs.push(
    bus.on(AgentStorageSubjects.updateActivity, (ctx) => {
      const agent = store.get(ctx.payload.agentId);
      if (!agent) {
        ctx.setResult({ success: false });
        return;
      }
      agent.lastActivityAt = ctx.payload.lastActivityAt;
      ctx.setResult({ success: true });
    }),
  );

  // storage:agent.updateRuntime
  unsubs.push(
    bus.on(AgentStorageSubjects.updateRuntime, (ctx) => {
      const agent = store.get(ctx.payload.agentId);
      if (!agent) {
        ctx.setResult({ success: false });
        return;
      }
      const { cwd, model, providerConfigId } = ctx.payload;
      if (!applyRuntimeUpdate(agent, cwd, model, providerConfigId)) {
        ctx.setResult({ success: false });
        return;
      }
      agent.lastActivityAt = Date.now();
      ctx.setResult({ success: true });
    }),
  );

  return () => unsubs.forEach((fn) => fn());
}
