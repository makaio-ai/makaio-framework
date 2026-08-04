import type { IMakaioBus } from '@makaio/bus-core';
import type { MakaioSessionAgent } from '@makaio/contracts';
import { AgentStorageSubjects } from './agent-namespace.js';
import { type SessionStorageMemoryState, createSessionStorageMemoryState, deleteClaimsWhere } from './memory-store.js';

/**
 * Named options for {@link applyRuntimeUpdate}.
 *
 * Every field is optional; omitting a field leaves the corresponding agent
 * property unchanged.
 */
interface RuntimeUpdateOptions {
  /** Current runtime adapter instance ID. */
  adapterId?: string;
  /** Provider-confirmed session ID. */
  adapterSessionId?: string;
  /** New working directory. */
  cwd?: string;
  /** New model identifier. */
  model?: string;
  /** Directory restrictions. */
  allowedDirectories?: string[];
  /** New provider config UUID; null clears the current selection. */
  providerConfigId?: string | null;
}

/**
 * Apply runtime field updates to an agent record.
 *
 * Returns `false` when none of the mutable fields are provided (no-op guard).
 * @param agent - Agent record to mutate in-place
 * @param options - Fields to update; omit a key to leave that field unchanged
 * @returns `true` if at least one field was updated, `false` otherwise
 */
function applyRuntimeUpdate(agent: MakaioSessionAgent, options: RuntimeUpdateOptions): boolean {
  const { adapterId, adapterSessionId, cwd, model, allowedDirectories, providerConfigId } = options;
  if (
    adapterId === undefined &&
    adapterSessionId === undefined &&
    cwd === undefined &&
    model === undefined &&
    allowedDirectories === undefined &&
    providerConfigId === undefined
  ) {
    return false;
  }
  if (adapterId !== undefined) agent.adapterId = adapterId;
  if (adapterSessionId !== undefined) agent.adapterSessionId = adapterSessionId;
  if (cwd !== undefined) agent.cwd = cwd;
  if (model !== undefined) agent.model = model;
  if (allowedDirectories !== undefined) agent.allowedDirectories = allowedDirectories;
  if (providerConfigId === null) {
    delete agent.providerConfigId;
  } else if (providerConfigId !== undefined) {
    agent.providerConfigId = providerConfigId;
  }
  return true;
}

/**
 * Carry the stored ownership columns across a whole-record `set`.
 *
 * Mirrors the Drizzle backend, whose conflict-update column list omits the
 * agent's currency pair, revision, fence and origin: `set` writes a caller-held
 * snapshot, so letting it carry the first four would allow a writer that read
 * the agent before a provider-session movement to resurrect the abandoned
 * provider session — and to reset the very counters that reject such a write.
 * They are owned exclusively by the `storage:sessionOwnership` seam.
 *
 * `adapterSessionId`, the agent's origin provider session, is preserved for a
 * different reason: it is the only resumable ID an agent whose currency is still
 * `inherited` has, and a caller that never read it (identity enrichment) would
 * otherwise erase it. The *previous row's* value wins whenever a previous row
 * exists — including a previous `undefined`, which is a stored "no origin yet"
 * rather than a gap the snapshot may fill. A first write has no previous row and
 * therefore takes the caller's origin, matching the SQL insert path. Changing it
 * on a live agent is `storage:agent.updateRuntime`'s job.
 * @param store - In-memory agent store
 * @param agentId - Agent being written
 * @param next - Incoming agent record about to be stored
 */
function storeAgentPreservingOwnership(
  store: Map<string, MakaioSessionAgent>,
  agentId: string,
  next: MakaioSessionAgent,
): void {
  const previous = store.get(agentId);
  store.set(agentId, {
    ...structuredClone(next),
    adapterSessionId: previous === undefined ? next.adapterSessionId : previous.adapterSessionId,
    currentAdapterSessionId: previous?.currentAdapterSessionId,
    currentAdapterSessionIdState: previous?.currentAdapterSessionIdState ?? 'inherited',
    revision: previous?.revision ?? 0,
    currencyFence: previous?.currencyFence ?? 0,
  });
}

/**
 * Apply a mutation to a stored agent, reporting whether it happened.
 *
 * The three mutating subjects all answer the same two questions — does the agent
 * exist, and did the requested change apply — so the lookup and its `false`
 * answer live here rather than being restated in each handler.
 * @param store - In-memory agent store
 * @param agentId - Agent to mutate
 * @param mutate - Mutation to apply; returns `false` when it changes nothing
 * @returns `true` when the agent exists and the mutation applied
 */
function mutateAgent(
  store: Map<string, MakaioSessionAgent>,
  agentId: string,
  mutate: (agent: MakaioSessionAgent) => boolean,
): boolean {
  const agent = store.get(agentId);
  return agent === undefined ? false : mutate(agent);
}

/**
 * Delete an agent together with the claims it owned.
 *
 * The cascade the SQL backends get from their foreign keys: a deleted agent must
 * not keep blocking an ownership key.
 * @param state - Shared in-memory state
 * @param agentId - Agent to delete
 * @returns `true` when an agent row was removed
 */
function deleteAgentCascading(state: SessionStorageMemoryState, agentId: string): boolean {
  deleteClaimsWhere(state, (claim) => claim.agentId === agentId);
  return state.agents.delete(agentId);
}

/**
 * Register in-memory agent storage handlers.
 *
 * Suitable for development and testing. Data is lost when the process exits.
 *
 * Pass a shared `SessionStorageMemoryState` to make this handler operate on the
 * same rows as `registerMemorySessionStorage` and
 * `registerMemorySessionOwnershipStorage`. Omit it (or pass `undefined`) to get
 * an isolated, private store — the default, which preserves backward
 * compatibility for callers that do not need cross-handler state sharing.
 * @param bus - The bus instance to register handlers on
 * @param state - Shared in-memory state; defaults to a new isolated instance
 * @returns Cleanup function to unsubscribe all handlers
 */
export function registerMemoryAgentStorage(
  bus: IMakaioBus,
  state: SessionStorageMemoryState = createSessionStorageMemoryState(),
): () => void {
  const store = state.agents;
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
      storeAgentPreservingOwnership(store, ctx.payload.agentId, ctx.payload.agent);
      ctx.setResult({ success: true });
    }),
  );

  // storage:agent.delete
  unsubs.push(
    bus.on(AgentStorageSubjects.delete, (ctx) => {
      ctx.setResult({ success: deleteAgentCascading(state, ctx.payload.agentId) });
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
      const success = mutateAgent(store, ctx.payload.agentId, (agent) => {
        agent.status = ctx.payload.status;
        agent.lastActivityAt = Date.now();
        return true;
      });
      ctx.setResult({ success });
    }),
  );

  // storage:agent.updateActivity
  unsubs.push(
    bus.on(AgentStorageSubjects.updateActivity, (ctx) => {
      const success = mutateAgent(store, ctx.payload.agentId, (agent) => {
        agent.lastActivityAt = ctx.payload.lastActivityAt;
        return true;
      });
      ctx.setResult({ success });
    }),
  );

  // storage:agent.updateRuntime
  unsubs.push(
    bus.on(AgentStorageSubjects.updateRuntime, (ctx) => {
      const { adapterId, adapterSessionId, cwd, model, allowedDirectories, providerConfigId } = ctx.payload;
      const success = mutateAgent(store, ctx.payload.agentId, (agent) => {
        const options = { adapterId, adapterSessionId, cwd, model, allowedDirectories, providerConfigId };
        if (!applyRuntimeUpdate(agent, options)) return false;
        agent.lastActivityAt = Date.now();
        return true;
      });
      ctx.setResult({ success });
    }),
  );

  return () => unsubs.forEach((fn) => fn());
}
