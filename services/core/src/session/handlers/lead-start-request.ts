import type {
  AdapterSelection,
  AgentRole,
  CompressionMode,
  MakaioSessionAgent,
  ResolvedProviderContext,
  SessionContext,
  StartAgentRequest,
  StartAgentResponse,
} from '@makaio/contracts';
import { buildDeterministicAdapterId } from '../../adapter-runtime/identity.js';
import type { MachineScopedAdapterInstance } from '../utils/resolution.js';

/** Fully-owned payload supplied to a host-specific lead-start dispatcher. */
export type LeadStartDispatchRequest = StartAgentRequest & {
  /** Framework-minted identity of this exact attempt. */
  readonly agentId: string;
  /** Runtime incarnation selected by the ownership reservation. */
  readonly ownerInstanceId: string;
};

/**
 * Host-specific transport policy for one already-reserved lead start.
 *
 * The callback may choose how the request reaches the selected adapter, but it
 * does not own identity, persistence, reservation, settlement, or cleanup.
 */
export type LeadStartDispatch = (request: LeadStartDispatchRequest) => Promise<StartAgentResponse>;

/** Whether this start creates the first lead or replaces an existing one. */
export type LeadTransition = { readonly kind: 'fresh' } | { readonly kind: 'replace' };

/** Everything a lead transition needs beyond the payload it dispatches. */
export interface LeadStartRequest {
  /** Session the agent is started into. */
  readonly sessionId: string;
  /** Machine-scoped adapter runtime selected for dispatch and ownership. */
  readonly instance: MachineScopedAdapterInstance;
  /** Adapter type name, carried onto the agent row and any claim. */
  readonly adapterName: string;
  /** Provider config to stamp on the agent's runtime row once the start lands. */
  readonly providerConfigId?: string;
  /** Persona identity persisted before the adapter can create a connector. */
  readonly personaId?: string;
  /** Profile identity persisted before the adapter can create a connector. */
  readonly profileId?: string;
  /** Explicit lifecycle transition; never inferred from designation identity. */
  readonly leadTransition: LeadTransition;
  /** Lead designation the caller observed before entering the reservation. */
  readonly expectedLeadAgentId: string | null;
  /** Adapter payload, complete except for the attempt identity minted by this service. */
  readonly startRequest: StartAgentRequest;
  /** Optional host transport policy; the bus request remains the default. */
  readonly dispatch?: LeadStartDispatch;
}

/** How a lead transition ended, for the caller that has a send to continue. */
export type LeadStartResult =
  | {
      /** The agent is live, owns its provider session and is `idle` in storage. */
      outcome: 'started';
      /** The agent row as it now stands, for the caller's in-memory session. */
      agent: MakaioSessionAgent;
    }
  | {
      /** Another start won the designation race and this attempt left nothing behind. */
      outcome: 'lead-conflict';
      /** Lead the session actually names, or `null` when it has none. */
      currentLeadAgentId: string | null;
    };

/** Identity and context a lead start carries independently of the selection. */
export interface LeadStartDispatchContext {
  /** Live adapter instance the start is dispatched to. */
  readonly adapterId: string;
  /** Session the agent is started into. */
  readonly sessionId: string;
  /** Resolved provider credentials, when the selection named a provider config. */
  readonly providerContext: ResolvedProviderContext | undefined;
  /** Session context passed through from the request. */
  readonly sessionContext: SessionContext | undefined;
}

/**
 * Compose the `adapter.startAgent` payload for a fresh lead start.
 *
 * Every field is forwarded only when the selection actually carries it: the
 * adapter distinguishes "not requested" from "requested as undefined", and a
 * blanket spread would turn the first into the second for every option the
 * caller left alone. The agent identity is deliberately absent — the reserving
 * start mints and persists it before dispatching.
 * @param selection - Direct adapter selection resolved for this start.
 * @param context - Identity and context the selection does not carry.
 * @returns The dispatch payload, complete but for the agent identity.
 */
export function buildLeadStartRequest(
  selection: AdapterSelection,
  context: LeadStartDispatchContext,
): StartAgentRequest {
  return {
    adapterId: context.adapterId,
    sessionId: context.sessionId,
    role: 'lead',
    ...(context.providerContext !== undefined && { providerContext: context.providerContext }),
    ...(context.sessionContext !== undefined && { sessionContext: context.sessionContext }),
    ...(selection.model !== undefined && { model: selection.model }),
    ...(selection.reasoningEffort !== undefined && { reasoningEffort: selection.reasoningEffort }),
    ...(selection.cwd !== undefined && { cwd: selection.cwd }),
    ...(selection.systemPrompt !== undefined && { systemPrompt: selection.systemPrompt }),
    ...(selection.allowedTools !== undefined && { allowedTools: selection.allowedTools }),
    ...(selection.disallowedTools !== undefined && { disallowedTools: selection.disallowedTools }),
    ...(selection.env !== undefined && { env: selection.env }),
    ...(selection.mcpSessionContext !== undefined && { mcpSessionContext: selection.mcpSessionContext }),
    ...(selection.allowedDirectories !== undefined && { allowedDirectories: selection.allowedDirectories }),
    ...(selection.adapterConfig !== undefined && { adapterConfig: selection.adapterConfig }),
  };
}

/** Identity and runtime facts a caller-owned agent row is built from. */
export interface CallerOwnedAgentRow {
  /** Caller-minted agent identity; the row's primary key. */
  readonly agentId: string;
  /** Exact runtime instance the row is reserved and dispatched against. */
  readonly instance: MachineScopedAdapterInstance;
  /** Adapter type name carried onto the row. */
  readonly adapterName: string;
  /** Session the agent is started into. */
  readonly sessionId: string;
  /** Role the agent takes in the session. */
  readonly role: AgentRole;
  /**
   * The runtime facts the request names.
   *
   * Read off the composed `startAgent` payload wherever the caller has one, so
   * the row and the dispatch cannot drift apart field by field.
   */
  readonly runtime: Pick<StartAgentRequest, 'model' | 'cwd' | 'allowedDirectories' | 'clientId' | 'harnessId'>;
  /** Provider config the runtime row is stamped with. */
  readonly providerConfigId?: string;
  /** Persona the agent was resolved from, when it was. */
  readonly personaId?: string;
  /** Profile the agent was resolved from, when it was. */
  readonly profileId?: string;
  /** Compression policy resolved for the agent. */
  readonly compressionMode?: CompressionMode;
}

/**
 * Build the agent row a caller-owned start persists before it dispatches.
 *
 * This is the **only** whole-record write for such a start: supplying `agentId`
 * transfers row ownership, and the adapter suppresses its own. So the row has to
 * carry what that suppressed write would have carried — the runtime facts the
 * request names (model, working directory, allowed directories, client and
 * harness) — or they simply never reach storage, and every reader of
 * `session.agents` sees an agent with no model and no cwd.
 *
 * One field is deliberately not mirrored: the adapter resolves an absent `cwd`
 * against its own platform defaults, which the service cannot see. A
 * caller-owned row therefore records the working directory the caller asked
 * for, and nothing when it asked for none.
 * @param input - Identity, role and runtime facts of the start being persisted.
 * @returns The row to persist before dispatching.
 */
export function buildCallerOwnedAgentRow(input: CallerOwnedAgentRow): MakaioSessionAgent {
  const now = Date.now();
  const { model, cwd, allowedDirectories, clientId, harnessId } = input.runtime;
  return {
    agentId: input.agentId,
    adapterId: input.instance.adapterId,
    adapterName: input.adapterName,
    runtimeOwner: {
      machineId: input.instance.machineId,
      instanceId: input.instance.ownerInstanceId,
    },
    sessionId: input.sessionId,
    role: input.role,
    // Not `idle`: no connector is confirmed yet, and a consumer that read `idle`
    // here would use the agent without rehydrating it. The origin identity is
    // deliberately absent — it is written after the dispatch reports one.
    status: 'starting',
    createdAt: now,
    lastActivityAt: now,
    ...(model !== undefined && { model }),
    ...(cwd !== undefined && { cwd }),
    ...(allowedDirectories !== undefined && { allowedDirectories }),
    ...(clientId !== undefined && { clientId }),
    ...(harnessId !== undefined && { harnessId }),
    ...(input.providerConfigId !== undefined && { providerConfigId: input.providerConfigId }),
    ...(input.personaId !== undefined && { personaId: input.personaId }),
    ...(input.profileId !== undefined && { profileId: input.profileId }),
    ...(input.compressionMode !== undefined && { compressionMode: input.compressionMode }),
  };
}

/**
 * Describe an agent as the selection that would recreate it.
 *
 * A session whose lead is owned by another generation still knows which adapter
 * and model that conversation ran on, and the replacement continues the same
 * conversation — so its identity comes from the agent being replaced, not from
 * a default the caller never asked for.
 *
 * **Two of these are inherited for a different reason than continuity.**
 * `allowedDirectories` is containment: a replacement that omits it is not "less
 * configured" — it is a connector with *no* directory restriction at all,
 * standing in for one that had them. `providerConfigId` is identity: credentials
 * and endpoint are resolved from it and from nothing else, so a replacement that
 * omits it does not fall back to the agent's account, it starts against an
 * unresolved provider context or the wrong one. Both are the invariant the
 * caller-owned row carries by name (case 83): a field the replacement omits is
 * written by nobody.
 *
 * **The adapter *instance* is inherited only with the machine that owns it, and
 * the row does not name one.** An instance ID is a one-way hash of
 * `(machineId, adapterName)`, so the row names an instance without naming its
 * owner, and a start that dispatched to an inherited instance while reserving and
 * settling under this runtime's identity would build an ownership key no other
 * actor computes — the mixed key the start paths were cleaned of. Half an
 * identity is worse than none.
 *
 * What *is* available is the derivation in the forward direction. Given a
 * candidate machine, the instance it would own is computable, so the caller's own
 * machine can be **checked** against the row rather than assumed for it — the
 * same proof the container runtime already requires of an adapter config before
 * it will act on it. The check is one-directional, which is what makes it safe:
 * a match proves the row's instance belongs to the caller's machine, and a
 * mismatch proves nothing beyond "not provably this one" — an adapter may carry
 * an explicitly configured instance ID that no derivation reproduces. So a
 * mismatch falls back to the substitution below rather than refusing.
 *
 * **When the pair cannot be proven, the replacement resolves `adapterName` on
 * the caller's machine**, and a conversation whose agent was pinned to another
 * host's instance continues on the local one. That is a real substitution and it
 * is stated here rather than left to be discovered: the degrade already replaces
 * the *agent*, and replacing the instance with one the caller can actually own is
 * the same decision carried through.
 *
 * **What else cannot be inherited, checked once against the row builder.** The
 * row also carries `clientId`, `harnessId`, `personaId`, `profileId` and
 * `compressionMode`, and none of them exists on `AgentSelectionBase` — there is
 * no field to put them in, so a replacement cannot carry them without widening
 * the selection contract. That is a known boundary of this degrade, recorded
 * here so the next reader does not have to re-derive it: everything the
 * selection *can* express and the row *does* hold is inherited above.
 * @param agent - The agent whose configuration is inherited.
 * @param machineId - Machine the replacement start will act under; the instance is
 *   inherited only when this machine provably owns it.
 * @returns A direct adapter selection naming the same adapter, model, cwd, provider config and
 *   directory limits — and the same instance when its machine can be proven.
 */
export function inheritAgentSelection(agent: MakaioSessionAgent, machineId: string): AdapterSelection {
  const ownsInstance = buildDeterministicAdapterId(machineId, agent.adapterName) === agent.adapterId;
  return {
    kind: 'adapter',
    adapterName: agent.adapterName,
    ...(ownsInstance && { adapterId: agent.adapterId, machineId }),
    ...(agent.model !== undefined && { model: agent.model }),
    ...(agent.cwd !== undefined && { cwd: agent.cwd }),
    ...(agent.allowedDirectories !== undefined && { allowedDirectories: agent.allowedDirectories }),
    ...(agent.providerConfigId !== undefined && { providerConfigId: agent.providerConfigId }),
  };
}
