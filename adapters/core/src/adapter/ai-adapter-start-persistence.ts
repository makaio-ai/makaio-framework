/**
 * The agent row an adapter-owned start writes for itself, and the lifecycle
 * events that announce it.
 *
 * Separated from the start handler because a reserved start writes the row
 * **twice** — once as `starting` before it may reserve, once as the whole
 * `idle` record once its connector is live — and the two must describe the same
 * agent. Keeping the record builder and both dispositions of the write in one
 * place is what makes that structural rather than a convention.
 */
import type { IMakaioBus, ScopedBus } from '@makaio/bus-core';
import type { AIAgent } from '../agent/ai-agent.js';
import type { AIAgentConnector } from '../agent/index.js';
import type { ActiveAgentRegistry } from './agent-registry.js';
import type { PlatformDefaults } from '../types/index.js';
import type { StartAgentRequestPayload } from './types.js';
import { publishedProviderKey, type ProviderKeyPublication } from './adapter-provider-key-publication.js';
import { AdapterSubjects, SessionSubjects, type MakaioSessionAgent, type ProviderContext } from '@makaio/contracts';
import { AgentStorageSubjects } from '@makaio/services-core/session';

/** A start payload whose provider context has already been restored. */
export type ResolvedStartPayload = StartAgentRequestPayload & { providerContext: ProviderContext };

/** Adapter identity and bus deps the agent row and its events are written from. */
export interface PersistEmitDeps {
  /** Adapter instance identifier. */
  adapterId: string;
  /** Adapter type name. */
  name: string;
  /** Client identifier for the application this adapter belongs to. */
  clientId: string | undefined;
  /** Resolve current platform-provided defaults (cwd, env). */
  getPlatformDefaults: () => PlatformDefaults | undefined;
  /** Global bus for cross-adapter communication. */
  globalBus: IMakaioBus;
}

/**
 * Whether the caller owns the agent row for this start.
 *
 * A caller that supplies `agentId` has already persisted the row — and, having
 * done so, owns its lifecycle columns for the duration of the start. The
 * adapter's own whole-record write would overwrite them, so it is suppressed.
 * It is also the predicate that decides who reserves (I16): the party that owns
 * the row reserves for it, which is the adapter exactly when this answers
 * `false`. Derived from the payload at every point that needs it rather than
 * threaded through, so the readings cannot drift apart.
 *
 * ## The claim is taken at its word, deliberately
 *
 * Supplying `agentId` *is* a statement: "I own this agent's row, I have reserved
 * the provider session this start resumes, and I will settle the key its
 * connector confirms." The adapter acts on that statement without verifying it,
 * so a caller that supplies an identity it never reserved for gets a live
 * connector on a provider session no durable generation holds.
 *
 * That is a trust boundary, not an oversight. `adapter.startAgent` is an
 * internal seam: the two callers that supply an identity are the reserved fresh
 * start and the reserved attach, both in `services-core/session`, and both take
 * their reservation *before* they dispatch — every other producer in the
 * framework and the product lets the adapter mint the identity and reads it back
 * from the response. Callers outside the runtime reach starts through the
 * orchestration and the SDK, never this subject.
 *
 * **And the verification that would matter is not available here.** What the
 * adapter would have to check is that a generation is held for this agent, and
 * the fresh start's reservation is *keyless* — a start that has no provider key
 * yet holds no claim row to find — so there is nothing to read for the very path
 * that most needs the guarantee. The reachable substitutes are proxies: a
 * `starting` row proves a caller wrote a row, not that it owns a key, and this
 * aggregate has learned twice over what happens when a proxy is read as the fact
 * it merely accompanies. Closing it honestly means the reserving caller *naming*
 * its reservation in the start — its claim token, which the adapter could then
 * verify against the authority — and that is adapter-contract surface this wave
 * does not open. Wave-4 watchlist.
 * @param payload - Validated startAgent request payload
 * @returns `true` when the caller states it minted and persisted the agent identity
 */
export function callerOwnsAgentRow(payload: StartAgentRequestPayload): boolean {
  return payload.agentId !== undefined;
}

/**
 * The working directory this start runs in.
 *
 * The request overrides the adapter's platform defaults. Resolved once per write
 * and handed to everything that reports it, because the defaults are a live
 * lookup: recomputing it for the row and again for the event this start emits
 * lets one describe a directory the other does not.
 * @param payload - Start payload with its provider context resolved
 * @param deps - Adapter identity and bus deps supplying the platform defaults
 * @returns The effective working directory, or `undefined` when neither names one
 */
function resolveStartCwd(payload: ResolvedStartPayload, deps: PersistEmitDeps): string | undefined {
  return payload.cwd ?? deps.getPlatformDefaults()?.cwd;
}

/**
 * Build the agent record an adapter-owned start writes for itself.
 *
 * Shared by the pre-dispatch `starting` row a reserved start needs before it can
 * reserve and the `idle` record every adapter-owned start writes once its
 * connector is live, so the two cannot drift into describing different agents.
 * The only difference between them is the status and the provider session, which
 * is why both are parameters.
 * @param params - Identity, lifecycle status and the request the record describes
 * @returns The whole record to store
 */
function buildAgentRecord(params: {
  agentId: string;
  sessionId: string;
  adapterSessionId: string | undefined;
  status: 'starting' | 'idle';
  /**
   * When the row was first created, for a start that already wrote one.
   *
   * A reserved start writes this record **twice**, and the second write is a
   * whole record: recomputing the creation time there would move it forward to
   * the moment the connector came up, so the row would claim the agent was
   * created after the work it did. `undefined` is the honest answer for the
   * first write and for every start that only writes once.
   */
  createdAt: number | undefined;
  /** Effective working directory, resolved by the caller that also reports it. */
  resolvedCwd: string | undefined;
  payload: ResolvedStartPayload;
  deps: PersistEmitDeps;
}): MakaioSessionAgent {
  const { agentId, sessionId, adapterSessionId, status, resolvedCwd, payload, deps } = params;
  const now = Date.now();
  const createdAt = params.createdAt ?? now;
  // clientId: payload carries it from the caller; adapter definition is the authoritative fallback.
  const resolvedClientId = payload.clientId ?? deps.clientId;
  return {
    agentId,
    adapterId: deps.adapterId,
    adapterName: deps.name,
    sessionId,
    adapterSessionId,
    model: payload.model,
    cwd: resolvedCwd,
    allowedDirectories: payload.allowedDirectories,
    role: payload.role,
    status,
    createdAt,
    lastActivityAt: now,
    ...(resolvedClientId !== undefined && { clientId: resolvedClientId }),
    ...(payload.harnessId !== undefined && { harnessId: payload.harnessId }),
    ...(payload.providerContext.state === 'resolved' && {
      providerConfigId: payload.providerContext.providerConfigId,
    }),
  };
}

/**
 * Store the agent record of a start that owns its row.
 *
 * Two dispositions, because the write means two different things. For an
 * unreserved start the row is best-effort bookkeeping and lightweight hosts
 * legitimately have no agent storage at all, so a failure is logged and the
 * start continues. For a **reserved** start the row is what the reservation was
 * taken against: swallowing a failure there would report success while leaving
 * the row `starting`, and the next send would find a `starting` row with no
 * in-flight entry, mark it dead and open a second recovery for a live agent.
 *
 * `requestOptional` cannot express the guarded form: it resolves normally when
 * the subject is unhandled *and* when the handler answers a refusal, so awaiting
 * it changes nothing. The guarded write is a hard request whose response is
 * checked, and all three failure forms — a throw, an unhandled subject and a
 * refusing handler — produce the same answer, because all three mean the row
 * this reservation depends on was not written.
 * @param record - Whole record to store
 * @param deps - Adapter identity and bus deps
 * @param guarded - Whether a failure fails the start
 * @returns The failure to report, or `undefined` when the row is stored or the
 *   failure was tolerated
 */
async function persistAgentRecord(
  record: MakaioSessionAgent,
  deps: PersistEmitDeps,
  guarded: boolean,
): Promise<string | undefined> {
  if (!guarded) {
    try {
      await deps.globalBus.requestOptional(AgentStorageSubjects.set, { agentId: record.agentId, agent: record });
    } catch (error) {
      // Agent storage is best-effort in lightweight hosts; the lifecycle events
      // are the authoritative signal that a live agent exists.
      console.error(`[AIAdapter:${deps.name}] Optional agent persistence failed:`, {
        agentId: record.agentId,
        adapterId: deps.adapterId,
        sessionId: record.sessionId,
        error,
      });
    }
    return undefined;
  }
  try {
    const stored = await deps.globalBus.request(AgentStorageSubjects.set, {
      agentId: record.agentId,
      agent: record,
    });
    return stored.success ? undefined : `Agent row for ${record.agentId} was refused by storage`;
  } catch (error) {
    return `Agent row for ${record.agentId} could not be written: ${String(error)}`;
  }
}

/**
 * Write the pre-dispatch `starting` row a reserved start reserves against.
 *
 * Hard rather than best-effort, and written before the reservation because the
 * reservation verifies the agent and session rows it references against storage:
 * without the row it would answer `not-found` and the start would refuse for a
 * reason that describes the wrong thing.
 *
 * `starting` rather than `idle`: no connector is confirmed yet, and a consumer
 * that read `idle` here would use an agent that does not exist.
 *
 * The creation time is supplied rather than taken here, because the caller has
 * to keep it: the whole-record write that follows the dispatch restates this
 * row, and only a value the caller holds survives that.
 * @param params - Identity, resume target, creation time and the request the row describes
 * @param deps - Adapter identity and bus deps
 */
export async function writePreDispatchAgentRow(
  params: {
    agentId: string;
    sessionId: string;
    adapterSessionId: string;
    createdAt: number;
    payload: ResolvedStartPayload;
  },
  deps: PersistEmitDeps,
): Promise<void> {
  const record = buildAgentRecord({
    ...params,
    status: 'starting',
    resolvedCwd: resolveStartCwd(params.payload, deps),
    deps,
  });
  await deps.globalBus.request(AgentStorageSubjects.set, { agentId: params.agentId, agent: record });
}

/**
 * Persist agent record and emit lifecycle events.
 *
 * Ensures persistence completes before events fire to avoid race conditions.
 *
 * The persistence step is skipped entirely when the caller owns the agent row
 * (see {@link callerOwnsAgentRow}); the lifecycle emissions below are not, since
 * they are what tells the rest of the system a live agent exists. A **guarded**
 * persistence failure stops before them: they would announce an agent whose row
 * does not exist, for a start that is about to be torn down.
 * @param agentId - Agent identifier
 * @param sessionId - Makaio session ID
 * @param adapterSessionId - Provider session ID, or `undefined` for unconfirmed idle fork starts
 * @param payload - Start agent request payload with resolved providerContext
 * @param deps - Adapter identity and bus deps
 * @param row - Whether a persistence failure fails the start, and the creation time a
 *   pre-dispatch row already carries
 * @returns The persistence failure to report, or `undefined` when the start stands
 */
export async function persistAndEmitAgent(
  agentId: string,
  sessionId: string,
  adapterSessionId: string | undefined,
  payload: ResolvedStartPayload,
  deps: PersistEmitDeps,
  row: {
    readonly guarded: boolean;
    readonly createdAt: number | undefined;
    readonly publication: ProviderKeyPublication;
  },
): Promise<string | undefined> {
  const { adapterId, name, globalBus } = deps;
  const role = payload.role;
  const resolvedCwd = resolveStartCwd(payload, deps);
  // Skipped for a caller-owned row: the caller's record already carries this
  // agent's identity and its in-flight status, and this write is a whole record.
  if (!callerOwnsAgentRow(payload)) {
    const record = buildAgentRecord({
      agentId,
      sessionId,
      adapterSessionId,
      status: 'idle',
      createdAt: row.createdAt,
      resolvedCwd,
      payload,
      deps,
    });
    const failure = await persistAgentRecord(record, deps, row.guarded);
    if (failure !== undefined) return failure;
  }

  // Emit events AFTER agent is persisted to avoid race conditions

  // Notify global session service that an agent was added to the session.
  //
  // Awaited, not fired off: this event is what establishes the session row's
  // adapter identity and lead-agent designation, and service-tier handlers gate
  // on that designation (see the session currency handler). Returning from
  // `startAgent` before it lands would let the caller's next turn race the
  // designation. A failing consumer must still not undo a started agent, so the
  // failure is logged rather than propagated.
  //
  // **Both events take their provider session from the publication gate**, and
  // only that field. A consumer writes it onto the session row as its resume
  // identity, and these events land *before* the caller's settlement claims the
  // key — so a concurrent attach could read the session, resolve that key as
  // resumable, and reserve it out from under the start that is still completing.
  // Nothing is lost by withholding it: the settlement mirrors the lead's
  // confirmed currency onto the session row, and the caller records the agent
  // row's origin itself, both after the claim. The designation `agent.added`
  // exists for is decided by `role` and the session's lead, never by this field.
  const publishedAdapterSessionId = publishedProviderKey(row.publication, adapterSessionId);
  try {
    await globalBus.emit(SessionSubjects.agent.added, {
      sessionId,
      agentId,
      adapterId,
      adapterName: name,
      ...(publishedAdapterSessionId !== undefined && { adapterSessionId: publishedAdapterSessionId }),
      role,
      model: payload.model,
      cwd: resolvedCwd,
    });
  } catch (error) {
    console.error(`[AIAdapter:${name}] session.agent.added consumer failed:`, { agentId, sessionId, error });
  }

  // Emit provider session tracking event. Fire-and-forget, and through the same
  // gate: a tracking event is still a place the key becomes readable to anyone
  // subscribed, before the caller that settles it has claimed it.
  void globalBus.emit(AdapterSubjects.session.created, {
    adapterId,
    adapterName: name,
    ...(publishedAdapterSessionId !== undefined && { adapterSessionId: publishedAdapterSessionId }),
    sessionId,
    model: payload.model ?? 'unknown',
  });
  return undefined;
}

/**
 * Remove a registered-but-uncommitted agent after start-agent persistence fails.
 * @param registry - Active agent registry that owns close and status updates.
 * @param agentId - Agent identifier to remove.
 * @param adapterName - Adapter name for diagnostic context.
 * @param cause - Original persistence failure.
 */
export async function rollbackRegisteredAgent<
  TBus extends ScopedBus<string>,
  TConnector extends AIAgentConnector<TBus>,
  TAgent extends AIAgent<TBus, TConnector>,
>(
  registry: ActiveAgentRegistry<TBus, TConnector, TAgent>,
  agentId: string,
  adapterName: string,
  cause: unknown,
): Promise<void> {
  try {
    await registry.evict(agentId);
  } catch (evictionError) {
    throw new AggregateError(
      [cause, evictionError],
      `[AIAdapter:${adapterName}] startAgent persistence failed and live agent cleanup also failed.`,
      { cause: evictionError },
    );
  }
}
